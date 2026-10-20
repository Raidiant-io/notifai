/**
 * SessionEnd where no hub decides it: Windows, which has no hub, and a macOS
 * or Linux session whose child never registered with one.
 *
 * SessionEnd is not always a close (a reload, a handoff to another place), so
 * the hook does not end a session that still has something to lose. It writes
 * a durable end candidate and starts this short-lived detached process, which
 * waits out the same end confirmation the hub uses, looks for the same
 * conversation running again, and then keeps it or ends it as SessionEnd
 * would have.
 *
 * A signal that cannot be read counts as no restart: where nothing is
 * readable (a Codex writer lock on Windows) the session ends after the
 * confirmation, as it did at once before. A candidate whose process died is
 * resolved by the next one, or by daily maintenance: late, never early.
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { claudeDescriptorDir, parseDescriptor } from './claude-wake.js'
import { codexThreadHolders } from './codex-session-end.js'
import type { CommandDeps } from './commands-core.js'
import { reportCodexSessionEnded } from './commands-hook-attend.js'
import { withFileLock } from './file-lock.js'
import { closeDiscardsWork, handleSessionEnd } from './hook-lifecycle.js'
import {
  endCandidatePath,
  endCandidatesDir,
  lifecycleStamp,
  readSessionIncarnation,
  readSessionState,
  sessionStatePath,
  withdrawEndCandidate,
  type LifecycleStamp,
} from './hook-session-state.js'
import { notifyHubSessionEnded, shutdownUnderway } from './hub-client.js'
import type { Logger } from './logging.js'
import { systemMonotonicNs } from './monotonic-clock.js'
import { descriptorStartMatches, pidExists, processStartTime } from './process-identity.js'
import type { DeliveryLease } from './session-delivery.js'

/** The hub's end confirmation (`END_CONFIRM_MS` in `hub.ts`). */
export const END_CONFIRMATION_MS = 10_000
/** One process serves the candidates it finds for at most this long; a later one takes the rest. */
const RESOLVER_LIFETIME_MS = 60_000

export interface EndCandidate {
  sessionId: string
  harness: 'codex' | 'claude-code'
  since: LifecycleStamp
  /** The incarnation current at SessionEnd; another one since is a restart. */
  incarnation: string | null
  /** The harness process that ran SessionEnd, when known. */
  harnessPid: number | null
  cwd: string | null
  /** Where the Codex writer lock lives (`CODEX_HOME`), or the default home. */
  codexHome: string | null
  /** Where Claude Code publishes session descriptors. */
  claudeSessions: string | null
  /** The Codex attendant's fencing identity, captured before it was killed. */
  endingLease: DeliveryLease | null
}

export interface EndConfirmationSeams {
  /** Production waits `END_CONFIRMATION_MS`. */
  confirmationMs?: number
  codexThreadHolders?: (codexHome: string | null, threadId: string) => number[] | 'unknown'
  /** Whether `pid` is the live process a Claude Code descriptor names. */
  claudeProcessLive?: (pid: number, procStart: string) => boolean
  shutdownUnderway?: (env: NodeJS.ProcessEnv) => boolean
}

function serialize(candidate: EndCandidate): string {
  return `${JSON.stringify({
    session_id: candidate.sessionId, harness: candidate.harness, since: candidate.since,
    incarnation: candidate.incarnation, harness_pid: candidate.harnessPid, cwd: candidate.cwd,
    codex_home: candidate.codexHome, claude_sessions: candidate.claudeSessions, ending_lease: candidate.endingLease,
  })}\n`
}

const text = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null

function parse(raw: string): EndCandidate | null {
  let value: Record<string, unknown>
  try { value = JSON.parse(raw) as Record<string, unknown> } catch { return null }
  if (typeof value !== 'object' || value === null) return null
  const since = value['since'] as Record<string, unknown> | undefined
  const sessionId = text(value['session_id'])
  const harness = value['harness']
  if (sessionId === null || (harness !== 'codex' && harness !== 'claude-code') || typeof since !== 'object' || since === null ||
      typeof since['wall'] !== 'number' || typeof since['mono'] !== 'string' || !/^\d{1,30}$/.test(since['mono'])) return null
  const pid = value['harness_pid']
  const lease = value['ending_lease'] as Record<string, unknown> | null | undefined
  return {
    sessionId, harness,
    since: { wall: since['wall'], mono: since['mono'] },
    incarnation: text(value['incarnation']),
    harnessPid: typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    cwd: text(value['cwd']) !== null && path.isAbsolute(value['cwd'] as string) ? value['cwd'] as string : null,
    codexHome: text(value['codex_home']),
    claudeSessions: text(value['claude_sessions']),
    endingLease: typeof lease === 'object' && lease !== null && typeof lease['incarnation'] === 'string' &&
      typeof lease['generation'] === 'number' ? { incarnation: lease['incarnation'], generation: lease['generation'] } : null,
  }
}

/**
 * Write the end candidate for a SessionEnd no hub took, when closing now would
 * expire or drop anything. Null when nothing would be lost: the session then
 * ends at once, as before.
 */
export function openEndCandidate(env: NodeJS.ProcessEnv, details: {
  sessionId: string
  harness: 'codex' | 'claude-code'
  harnessPid?: number | undefined
  cwd?: string | undefined
  endingLease: DeliveryLease | null
}, now: number): EndCandidate | null {
  return withFileLock(`${sessionStatePath(details.sessionId, env)}.lock`, () => {
    if (!closeDiscardsWork(readSessionState(details.sessionId, env))) return null
    const candidate: EndCandidate = {
      sessionId: details.sessionId,
      harness: details.harness,
      since: lifecycleStamp(now),
      incarnation: readSessionIncarnation(details.sessionId, env)?.key ?? null,
      harnessPid: details.harnessPid ?? null,
      cwd: details.cwd !== undefined && path.isAbsolute(details.cwd) ? details.cwd : null,
      codexHome: details.harness === 'codex' ? text(env['CODEX_HOME']) : null,
      claudeSessions: details.harness === 'claude-code' ? claudeDescriptorDir(env) : null,
      endingLease: details.endingLease,
    }
    atomicWriteFileSync(endCandidatePath(details.sessionId, env), serialize(candidate), { requireCurrentUserOwner: true })
    return candidate
  })
}

/**
 * Hand a SessionEnd to the end confirmation: open its candidate and start the
 * detached process. False when there is nothing to wait for or the process
 * could not start; the caller then ends the session at once.
 */
export function awaitEndConfirmation(env: NodeJS.ProcessEnv, details: Parameters<typeof openEndCandidate>[1],
  now: number, launch: () => void): boolean {
  let candidate: EndCandidate | null
  try {
    candidate = openEndCandidate(env, details, now)
  } catch {
    return false
  }
  if (candidate === null) return false
  try {
    launch()
    return true
  } catch {
    withdrawEndCandidate(details.sessionId, env, candidate.since)
    return false
  }
}

function listEndCandidates(env: NodeJS.ProcessEnv): EndCandidate[] {
  let names: string[]
  try { names = readdirSync(endCandidatesDir(env)).filter((name) => name.endsWith('.json')) } catch { return [] }
  const candidates: EndCandidate[] = []
  for (const name of names) {
    const file = path.join(endCandidatesDir(env), name)
    let raw: string
    try { raw = readFileSync(file, 'utf8') } catch { continue }
    const candidate = parse(raw)
    // An unreadable candidate names no session to end; it waits for nothing.
    if (candidate === null || endCandidatePath(candidate.sessionId, env) !== file) rmSync(file, { force: true })
    else candidates.push(candidate)
  }
  return candidates
}

/** Milliseconds since the end was signalled; a stamp from an earlier boot has waited long enough. */
function waitedMs(since: LifecycleStamp): number {
  const at = BigInt(since.mono)
  const now = systemMonotonicNs()
  return at > now ? Number.POSITIVE_INFINITY : Number((now - at) / 1_000_000n)
}

function claudeProcessLive(pid: number, procStart: string): boolean {
  if (!pidExists(pid)) return false
  const start = processStartTime(pid)
  return start !== null && descriptorStartMatches(procStart, { pid, start })
}

/** Another live Claude Code process whose own descriptor names this conversation. */
function claudeHostElsewhere(candidate: EndCandidate, seams: EndConfirmationSeams): boolean {
  if (candidate.claudeSessions === null) return false
  let names: string[]
  try { names = readdirSync(candidate.claudeSessions).filter((name) => /^\d+\.json$/.test(name)) } catch { return false }
  for (const name of names) {
    const pid = Number(name.slice(0, -'.json'.length))
    if (pid === candidate.harnessPid || pid === process.pid) continue
    let descriptor: ReturnType<typeof parseDescriptor>
    try { descriptor = parseDescriptor(JSON.parse(readFileSync(path.join(candidate.claudeSessions, name), 'utf8'))) } catch { continue }
    if (descriptor === null || descriptor.pid !== pid || descriptor.sessionId !== candidate.sessionId) continue
    // Without the ending process's identity, only a process opened since the end is another place.
    if (candidate.harnessPid === null && descriptor.startedAt < candidate.since.wall) continue
    if ((seams.claudeProcessLive ?? claudeProcessLive)(pid, descriptor.procStart)) return true
  }
  return false
}

/** Positive evidence that the same conversation runs again, or null. */
function cameBack(env: NodeJS.ProcessEnv, candidate: EndCandidate, seams: EndConfirmationSeams): string | null {
  const current = readSessionIncarnation(candidate.sessionId, env)?.key ?? null
  if (current !== null && current !== candidate.incarnation) return 'restarted'
  if (candidate.harness === 'claude-code') return claudeHostElsewhere(candidate, seams) ? 'hosted-elsewhere' : null
  const holders = (seams.codexThreadHolders ?? codexThreadHolders)(candidate.codexHome, candidate.sessionId)
  return holders !== 'unknown' && holders.some((pid) => pid !== process.pid && pidExists(pid)) ? 'reloaded' : null
}

/** `superseded`: the end no longer waited, cancelled by a start or decided by another process. */
type Resolution = 'ended' | 'kept' | 'deferred' | 'superseded'

async function resolveEndCandidate(deps: CommandDeps, candidate: EndCandidate, seams: EndConfirmationSeams,
  logger: Logger | undefined): Promise<Resolution> {
  const env = deps.env
  const log = (outcome: Resolution, data: Record<string, unknown> = {}): Resolution => {
    logger?.info('hook.gate', { stage: 'end-confirmation', session: candidate.sessionId, harness: candidate.harness, outcome, ...data })
    return outcome
  }
  const reason = cameBack(env, candidate, seams)
  if (reason !== null) {
    return withdrawEndCandidate(candidate.sessionId, env, candidate.since) ? log('kept', { reason }) : log('superseded')
  }
  // The machine is going down: whoever runs next decides.
  if ((seams.shutdownUnderway ?? shutdownUnderway)(env)) return log('deferred', { reason: 'shutdown-in-progress' })
  const outcome = handleSessionEnd(env, { session_id: candidate.sessionId, ...(candidate.cwd === null ? {} : { cwd: candidate.cwd }) },
    (deps.now ?? Date.now)(), candidate.since)
  const result = outcome.log ?? {}
  if (result['reason'] === 'end-superseded') return log('superseded')
  const ended: Record<string, unknown> = { ...result }
  if (candidate.harness === 'codex') ended['lease_report'] = await reportCodexSessionEnded(deps, candidate.sessionId, candidate.endingLease)
  // As at SessionEnd: a running hub retires what was queued; otherwise a detached process does.
  const handed = await notifyHubSessionEnded(env, candidate.sessionId)
  const queued = result['queued_retirements']
  if (!handed && typeof queued === 'number' && queued > 0) {
    try {
      deps.spawnRetirement?.({ cwd: candidate.cwd ?? deps.cwd, harness: candidate.harness })
    } catch (err) {
      ended['retirement_spawn'] = err instanceof Error ? err.message : String(err)
    }
  }
  return log('ended', ended)
}

/**
 * Resolve every end candidate whose confirmation has passed. With `wait`, the
 * process also waits for those still inside it, up to its own lifetime.
 */
export async function confirmSessionEnds(deps: CommandDeps, options: { wait: boolean; logger?: Logger },
  seams: EndConfirmationSeams = {}): Promise<Record<Resolution, number>> {
  const confirmationMs = seams.confirmationMs ?? END_CONFIRMATION_MS
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const startedAt = systemMonotonicNs()
  const lived = (): number => Number((systemMonotonicNs() - startedAt) / 1_000_000n)
  const counts: Record<Resolution, number> = { ended: 0, kept: 0, deferred: 0, superseded: 0 }
  const settled = new Set<string>()
  for (;;) {
    let nextDue = Number.POSITIVE_INFINITY
    for (const candidate of listEndCandidates(deps.env)) {
      const key = `${candidate.sessionId}\0${candidate.since.mono}`
      if (settled.has(key)) continue
      const left = confirmationMs - waitedMs(candidate.since)
      if (left > 0) {
        nextDue = Math.min(nextDue, left)
        continue
      }
      settled.add(key)
      try {
        counts[await resolveEndCandidate(deps, candidate, seams, options.logger)] += 1
      } catch (err) {
        counts.deferred += 1
        options.logger?.error('hook.gate', { stage: 'end-confirmation', session: candidate.sessionId, outcome: 'failed',
          message: err instanceof Error ? err.message : String(err) })
      }
    }
    if (!options.wait || nextDue === Number.POSITIVE_INFINITY || lived() + nextDue > RESOLVER_LIFETIME_MS) return counts
    await sleep(Math.ceil(nextDue))
  }
}
