/**
 * Hand one message into a running Agent Session, in place.
 *
 * The one harness write every hand-off shares: the answer waiter's wake routes
 * and the Session Attendant's Session Messages both end here. It never cold
 * resumes: a stopped session is reported as stopped, and only the answer route
 * decides what to do about that (Session Messages never resume a session).
 *
 * `begin` is the commit point. It is called immediately before the
 * irreversible write, after every check that can refuse without writing; when
 * it returns false nothing is handed over. A `failed` result after `begin`
 * means the write may or may not have reached the harness.
 */
import {
  CLAUDE_POST_SEND_LIVENESS_MS,
  observeClaudeSession,
  parseDescriptor,
  type ClaudeSessionDescriptor,
  type ClaudeWakeAdapters,
} from './claude-wake.js'
import { inspectCodexQueue, type CodexWakeAdapters } from './codex-wake.js'
import { WriteAbortedError, WriteDeadlineError, type WriteGuard } from './wake-support.js'

export type SessionWriteResult =
  | {
      status: 'written'
      route: 'inbox-socket' | 'session-queue'
      /** Claude only: whether the session was idle or busy when the message was posted. */
      sessionState?: 'live-idle' | 'live-busy'
    }
  /** Nothing was written: the exact session could not be proven reachable in place. */
  | { status: 'unavailable'; reason: string }
  /** Claude only: no process hosts the session any more; nothing was written. */
  | { status: 'stopped' }
  /** `begin` refused (SessionEnd won, a claim lapsed, the lease cannot cover the write). */
  | { status: 'cancelled' }
  /** `begin` succeeded, then the write guard stopped the write before any byte left. */
  | { status: 'aborted'; reason: string }
  /** The write started and failed; it may or may not have reached the harness. */
  | { status: 'failed'; reason: string; error: unknown }

/**
 * The Claude session descriptor of the process that will post, when it names
 * this exact session. Read once, when the writer starts: a descriptor that
 * appears later is not evidence that this process is that session's child.
 */
export function claudeSourceDescriptor(
  sessionId: string,
  sourcePid: number,
  adapters: Pick<ClaudeWakeAdapters, 'readDescriptor'>,
): ClaudeSessionDescriptor | null {
  try {
    const parsed = parseDescriptor(adapters.readDescriptor(sourcePid))
    return parsed !== null && parsed.sessionId === sessionId && parsed.pid === sourcePid
      ? parsed
      : null
  } catch {
    // Delivery fails closed below; a missing descriptor must never break the caller.
    return null
  }
}

/**
 * Claude Code's own-child inbox route. Claude delivers an inbox-socket line
 * only from a verified descendant of the receiving process, so the writer must
 * be that exact session's child: `sourcePid` is its harness process, observed
 * again right before the write.
 *
 * `holdAfterSend` keeps the posting process alive while macOS verifies the
 * sender's ancestry. A resident writer (the Session Attendant) stays alive
 * anyway and skips the wait.
 */
export async function deliverIntoClaudeSession(options: {
  sessionId: string
  sourcePid: number
  sourceDescriptor: ClaudeSessionDescriptor | null
  adapters: ClaudeWakeAdapters
  text: string
  begin(): boolean
  holdAfterSend?: boolean
  /** Checked at the socket itself, after it connects and before its first byte. */
  guard?: WriteGuard
  /** Names the posting process in refusal reasons, which logs keep verbatim. */
  writer: string
}): Promise<SessionWriteResult> {
  const { adapters, writer } = options
  const observation = await observeClaudeSession(options.sessionId, adapters)
  if (observation.state === 'unknown') return { status: 'unavailable', reason: observation.reason }
  if (options.sourceDescriptor === null) {
    return {
      status: 'unavailable',
      reason: `the ${writer} cannot prove exact Claude session ownership`,
    }
  }
  if (observation.state === 'stopped') return { status: 'stopped' }
  if (
    observation.descriptor.pid !== options.sourcePid ||
    options.sourceDescriptor.startedAt !== observation.descriptor.startedAt
  ) {
    return {
      status: 'unavailable',
      reason: `the ${writer} is not the observed exact Claude session child`,
    }
  }
  if (!options.begin()) return { status: 'cancelled' }
  try {
    await adapters.sendSocket(observation.descriptor.messagingSocketPath, claudeSocketLine(options.text), options.guard)
  } catch (err) {
    if (err instanceof WriteAbortedError) return { status: 'aborted', reason: err.message }
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err), error: err }
  }
  if (options.holdAfterSend !== false) await adapters.sleep(CLAUDE_POST_SEND_LIVENESS_MS)
  return { status: 'written', route: 'inbox-socket', sessionState: observation.state }
}

/**
 * Codex's durable per-thread inbox. Exit 0 proves the queue stored the
 * message, never that the thread consumed it, and a stopped thread drains it
 * the next time it opens.
 */
export async function deliverIntoCodexThread(options: {
  threadId: string
  cwd: string
  env: NodeJS.ProcessEnv
  adapters: CodexWakeAdapters
  text: string
  begin(): boolean
  /**
   * A claimed write's bound: checked after `begin`, immediately before the
   * queue writer starts, and its `remainingMs` then bounds the writer's whole
   * life. A writer still running at that deadline has its process group
   * killed and is reported `failed`: it may have written.
   */
  guard?: WriteGuard
  /** Receives the queue writer's process group as soon as it exists. */
  onSpawn?: (pgid: number) => void
}): Promise<SessionWriteResult> {
  const readiness = inspectCodexQueue(options.threadId, options.env)
  if (readiness.state === 'unavailable') return { status: 'unavailable', reason: readiness.reason }
  if (!options.begin()) return { status: 'cancelled' }
  if (options.guard !== undefined && !options.guard.writable()) {
    return { status: 'aborted', reason: 'the claim or lease lapsed before the queue writer started' }
  }
  const budget = options.guard?.remainingMs() ?? Number.POSITIVE_INFINITY
  const deadline = new AbortController()
  const timer = Number.isFinite(budget) ? setTimeout(() => deadline.abort(), Math.max(0, budget)) : undefined
  try {
    await options.adapters.queue(readiness.threadId, options.cwd, options.text, options.onSpawn, deadline.signal)
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err), error: err }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (deadline.signal.aborted) {
    // The writer finished, but only after its claim's write boundary.
    const error = new WriteDeadlineError('the queue writer finished after its claim deadline')
    return { status: 'failed', reason: error.message, error }
  }
  return { status: 'written', route: 'session-queue' }
}

export function claudeSocketLine(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
  })}\n`
}
