import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type {
  LifecycleEndState,
  ListRepliesResponse,
  MediaItemT,
  NotificationDraftT,
  QuestionT,
  ReplyView,
  SourceContextT,
  SubmissionReceipt,
} from '@raidiant/notifai-protocol'
import {
  ApiCallError,
  isRetryableReplyPollError,
  type ApiClient,
} from './client.js'
import {
  loadConfig,
  projectSessionPointerPath,
  sanitizeSessionId,
  sessionConfigPath,
  stateDir,
  type CliConfig,
} from './config.js'
import { buildDraft } from './send.js'
import { atomicWriteFileSync } from './atomic-file.js'
import { withFileLock } from './file-lock.js'
import type { Logger } from './logging.js'
import {
  HARNESS_CAPABILITIES,
  HARNESSES,
  type DeliveryRoute,
  type Harness,
} from './harnesses.js'

/**
 * Harness hook handlers.
 *
 * The supported harnesses expose the same useful lifecycle joints: a turn-end
 * event and an event that fires when the user submits a prompt. Claude Code
 * and Codex can continue directly from a turn-end answer. Harnesses without a
 * proven exact-session continuation fail closed at question admission.
 *
 * Where the user is standing no longer decides anything here. It used to: the
 * turn-end hook held the terminal for as long as it waited, so waiting was
 * only defensible while the person was demonstrably not at the keyboard. On
 * Claude Code the handler now returns instantly and the waiter runs out of
 * band, and nothing is monopolised in the first place — so the question is
 * simply whether the user wants to be reached, which they answer once in
 * configuration rather than implicitly with every keystroke.
 */

/** Fields we read from harness hook JSON. Everything else is passed through. */
export interface HookEnvelope {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  /** Set by the harness when this Stop follows a previous Stop continuation. */
  stop_hook_active?: boolean
  /** Cursor's stable per-conversation identifier. */
  conversation_id?: string
  /** Cursor's project roots; the first is the hook's configuration root. */
  workspace_roots?: string[]
  /** Cursor increments this after each stop-hook automatic follow-up. */
  loop_count?: number
}

export interface SessionState {
  /** Epoch ms of the user's last prompt in this session — our presence signal. */
  last_prompt_at?: number
  /** Epoch ms of the last observed Stop hook, distinct from prompt routing. */
  last_stop_at?: number
  /**
   * Questions registered by `notifai ask`, in registration order, each
   * awaiting escalation or its answer. A list, deliberately: registering a
   * question never ends an earlier one. Superseding is reply semantics — a
   * later reply corrects an earlier reply to the same question — never
   * question semantics; the single-slot model silently discarded a live
   * question the moment a second was registered (2026-08-09).
   */
  pending?: PendingQuestion[]
  /**
   * Questions that have been delivered to the user's devices and are now dead,
   * but whose retirement has not been confirmed yet.
   *
   * A retirement needs a network call and the moment we learn a question is
   * dead is not always a moment we can make one — the user's return to the
   * terminal is observed by a bare hook, and the machine may be offline.
   * Dropping the ids there is how a delivered question becomes permanently
   * unretirable, so they are parked here instead and every later hook with a
   * client drains them. Retirement is idempotent, so a duplicate attempt
   * costs nothing and a missed one costs a stale notification for ever.
   */
  retiring?: RetiringQuestion[]
  /**
   * Tracks bounded Stop continuations so a follow-up ask is delivered once.
   * `count` is how many answer generations have run consecutively without the
   * user taking a turn themselves; their next prompt starts it over.
   */
  continuation?: {
    answered_at: number
    count: number
  }
  /**
   * A phone answer durably captured but not yet acknowledged. It stays here
   * until a delivery is acknowledged — by the route's own write, or by the
   * successor Stop of a blocking continuation — so a crash before the answer
   * reaches the harness replays it instead of erasing it.
   */
  accepted?: AcceptedAnswerDelivery
  /**
   * Required Agent Acknowledgements that the resumed agent still owes. This is
   * separate from answer delivery: the answer journal may settle as soon as a
   * harness accepts the continuation, while this obligation must survive until
   * the service confirms the agent-authored follow-up exists.
   */
  acknowledgement_due?: AcknowledgementDue[]
}

export interface AcknowledgementDue {
  request_id: string
  recorded_at: number
}

interface AcceptedAnswerDelivery {
  answers: AnsweredPending[]
  remaining: number
  recorded_at: number
  /**
   * Epoch ms when a route's own write handed this answer to the harness, with
   * the route that performed it. Recorded so that "this answer was delivered"
   * is a fact on the journal rather than something inferred from a harness flag
   * that only one route ever sets.
   */
  delivered_at?: number
  delivered_route?: string
  /**
   * How many times this answer has been handed to any route. The route-agnostic
   * loop backstop: bounded by `MAX_CONTINUATION_COUNT` in one place every route
   * passes through.
   */
  delivery_attempts?: number
}

/** A delivered question awaiting its retirement push. */
export interface RetiringQuestion {
  request_id: string
  collapse_key: string
  /** The Device Installations that actually received the question. */
  device_ids: string[]
  /** Shown if the companion has no history entry to correlate against. */
  question: string
  project?: string
  source?: SourceContextT
  state: LifecycleEndState
}

/**
 * A retirement that outlived its session.
 *
 * Per-session parking assumes some later hook in the SAME session will hold a
 * client, and `SessionEnd` is exactly where that assumption breaks: it may not
 * touch the network, and no hook for that session ever fires again. Deleting
 * the state there lost the only copy of the delivered question's ids, so the
 * phone kept an answerable question nobody was listening to. These entries are
 * moved to a machine-global queue instead, drained by whichever session's hook
 * next holds a client.
 */
export interface OrphanRetirement extends RetiringQuestion {
  /** Epoch ms when the entry was orphaned; entries beyond the TTL are dropped. */
  enqueued_at: number
}

/**
 * Past this, the question's reply window (3600s) has long expired server-side
 * and the companion shows it as dead on next open anyway; pushing a retirement
 * sync for it is noise. Also the backstop that keeps an unreachable server
 * from growing the queue for ever.
 */
const ORPHAN_TTL_MS = 24 * 3600 * 1000

/** More orphans than this means something is looping; keep the newest. */
const ORPHAN_QUEUE_CAP = 50

export interface PendingQuestion {
  /** Stable local identity across racing state writers and submit recovery. */
  question_id?: string
  /** One-line summary: the single question's text, or the set's first. */
  question: string
  /**
   * Epoch ms when `notifai ask` registered this. The grace window runs from
   * here, not from the turn's end: a question the agent asked five minutes ago
   * while it kept working has already served its wait in the terminal.
   */
  asked_at?: number
  /**
   * The full question set as `notifai ask` validated it: generated ids,
   * texts, choices, multi flags. What actually rides the push.
   */
  questions?: QuestionT[]
  /** Canonical Markdown body composed when the question was registered. */
  body?: string
  /** Final ordered media collection; uploads complete before registration. */
  media?: MediaItemT[]
  /** Final Project and Source Context frozen at registration. */
  project?: string
  source?: SourceContextT
  /** Set once the question has actually been pushed, so it can be retired. */
  request_id?: string
  collapse_key?: string
  /** Exact fanout of the live question; routing config may change afterwards. */
  device_ids?: string[]
  /** Absolute end of the server reply window and its local continuation owner. */
  reply_deadline_at?: number
  /** Frozen before the first network byte, so an ambiguous submit is replayable. */
  submission?: PendingSubmissionIntent
}

interface PendingSubmissionIntent {
  request_id: string
  idempotency_key: string
  collapse_key: string
  device_ids: string[]
  draft: NotificationDraftT
  owner_deadline_at: number
}

function summarizeRequestIds(entries: readonly PendingQuestion[]): {
  ids: string[]
  display: string
} {
  const ids = entries.flatMap((entry) =>
    entry.request_id === undefined ? [] : [entry.request_id],
  )
  return { ids, display: ids.join(', ') }
}

/**
 * The waiter's whole wall clock: the terminal-first timer, submission, and the
 * wait for an answer, from the moment the turn-end hook starts.
 *
 * One plain ceiling, deliberately not a budget carved into reserves. The
 * reserves existed to fit every phase inside a *held* turn; on Claude Code the
 * turn is not held any more, and on a host that still holds one the useful
 * question is only how long that host is willing to wait in total.
 */
export const WAITER_CEILING_SECONDS = 480

/**
 * The wire contract's shortest reply window. A question submitted with less
 * than this is rejected outright, and accepting one would in any case let the
 * server go on taking an answer after the waiter that owns it has returned.
 */
const MIN_REPLY_WINDOW_SECONDS = 60

/**
 * The terminal-first wait: the question sits in the terminal for
 * `ask_grace_seconds` from when it was sent, and only then reaches companion
 * devices.
 *
 * A plain timer, and nothing else. It once polled an idle signal so it could
 * abandon the wait the moment the user touched the keyboard — necessary while
 * the wait blocked the terminal, because a user wanting to answer locally was
 * otherwise locked out of their own prompt. Nothing is monopolised now, so
 * there is nothing to watch for and no machine this cannot run on.
 *
 * The window is measured from registration, not from the turn's end: a
 * question the agent asked five minutes ago while it kept working has already
 * served its wait. A stamp from the future would otherwise consume the whole
 * ceiling and leave no room to answer, so it starts no later than now.
 */
async function awaitTerminalFirstWindow(
  ctx: HookContext,
  askedAt: number,
  ceilingAt: number,
): Promise<void> {
  const graceSeconds = ctx.config.ask_grace_seconds.value
  if (graceSeconds <= 0) return
  const until = Math.min(Math.min(askedAt, ctx.now()) + graceSeconds * 1000, ceilingAt)
  const remaining = until - ctx.now()
  if (remaining > 0) await ctx.sleep(remaining)
}

export interface HookOutcome {
  /** Written to stdout verbatim — the harness parses this as the decision. */
  stdout?: string
  /** Diagnostics; harnesses surface hook stderr in the transcript. */
  notes: string[]
  /** Structured lifecycle detail that belongs on hook.end without user text. */
  log?: Record<string, unknown>
}

/** An accepted continuation ready for whichever host owns the last meter. */
export interface ContinuationEvent {
  context: string
  answers: number
  remaining: number
  request_ids: string[]
  journal_recorded_at: number
}

/**
 * How much a route's own return proves about where the answer ended up.
 *
 * Acknowledgement belongs to the delivery, not to the harness envelope: routes
 * end in different places, so no single field on a hook payload can speak for
 * all of them. `stop_hook_active` is the harness confirming that a *blocking
 * continuation* was admitted; it stays false for ever on a route that starts a
 * brand-new turn instead of continuing this one, so a journal keyed to it alone
 * never settles and every later turn-end redelivers the same answer.
 *
 * - `delivered` — the route completed a write to the harness itself (an inbox
 *   socket, a cold resume). Delivery is not consumption: the write proves the
 *   harness accepted the message, never that the model acted on it. But nothing
 *   later will ever prove more, and redelivering an answer without end is
 *   strictly worse than settling on the write, so the journal settles here.
 * - `stdout` — the answer is this process's stdout, which the harness reads only
 *   after this process exits. Nothing this process can write is proof, so the
 *   journal waits for the successor Stop's `stop_hook_active`, and a crash
 *   before stdout replays the answer instead of losing it.
 * - `held` — the route handed nothing over; the journal replays the answer.
 */
export type DeliveryAcknowledgement = 'delivered' | 'stdout' | 'held'

/** What a route returns: the hook's outcome plus what the attempt proved. */
export interface DeliveryOutcome {
  stdout?: string
  notes?: string[]
  log?: Record<string, unknown>
  acknowledgement: DeliveryAcknowledgement
}

/** Host adapter injected into the waiter; no route is implemented by the waiter. */
export interface EscalationDeliveryRoute {
  kind: Exclude<DeliveryRoute, 'unsupported'>
  deliver(event: ContinuationEvent): Promise<DeliveryOutcome>
}

export interface EscalationWaiterOptions {
  sessionId: string
  envelope: HookEnvelope
  route: EscalationDeliveryRoute
  processDeadlineAt?: number
}

function sessionStatePath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.json`)
}

export function readSessionState(sessionId: string, env: NodeJS.ProcessEnv): SessionState {
  const file = sessionStatePath(sessionId, env)
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as SessionState) : {}
  } catch {
    // A corrupt marker must not wedge the harness; treat it as "no evidence",
    // which fails closed onto ordinary terminal behaviour.
    return {}
  }
}

export function writeSessionState(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  state: SessionState,
): void {
  const file = sessionStatePath(sessionId, env)
  withFileLock(`${file}.lock`, () => writeSessionStateUnlocked(file, state))
}

export function clearSessionState(sessionId: string, env: NodeJS.ProcessEnv): void {
  const file = sessionStatePath(sessionId, env)
  withFileLock(`${file}.lock`, () => {
    rmSync(file, { force: true })
    // The session override lives in a sibling file; leaving it behind meant a
    // later session reusing the id silently inherited `ask_notifications = false`.
    rmSync(sessionConfigPath(sessionId, env), { force: true })
  })
}

function writeSessionStateUnlocked(file: string, state: SessionState): void {
  atomicWriteFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
}

function updateSessionState(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  update: (current: SessionState) => SessionState,
): SessionState {
  const file = sessionStatePath(sessionId, env)
  return withFileLock(`${file}.lock`, () => {
    const next = update(readSessionState(sessionId, env))
    writeSessionStateUnlocked(file, next)
    return next
  })
}

/**
 * Session state a crashed harness left behind.
 *
 * `SessionEnd` removes both the marker and the session override, but a harness
 * that crashes or is killed never reaches it. At roughly a hundred sessions a
 * day that is tens of thousands of files a year, none of which anything reads.
 *
 * Opportunistic rather than scheduled: hooks are the only thing that runs, so
 * a hook is where this has to live. It is rate-limited by its own stamp file
 * so the common case costs one `stat`, not a directory walk — a Stop hook is
 * on the critical path of every turn.
 */
const SESSION_PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000
const SESSION_PRUNE_INTERVAL_MS = 24 * 3600 * 1000

export function pruneAbandonedSessions(
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
  maxAgeMs: number = SESSION_PRUNE_AFTER_MS,
): number {
  const directory = path.join(stateDir(env), 'sessions')
  const stamp = path.join(stateDir(env), 'last-prune')
  try {
    if (existsSync(stamp) && now - statSync(stamp).mtimeMs < SESSION_PRUNE_INTERVAL_MS) return 0
    mkdirSync(path.dirname(stamp), { recursive: true })
    writeFileSync(stamp, '', { mode: 0o600 })
    if (!existsSync(directory)) return 0

    let removed = 0
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name)
      try {
        const age = now - statSync(file).mtimeMs
        // A negative age means the clock moved, not that the file is old.
        // Deleting live session state on an NTP correction would lose a
        // question already on the user's phone.
        if (age <= maxAgeMs) continue
        rmSync(file, { force: true })
        removed += 1
      } catch {
        // A file that vanished under us, or one we may not read. Neither is
        // worth failing a hook for, and the next pass will see it again.
      }
    }
    return removed
  } catch {
    // Housekeeping must never be the reason a turn fails.
    return 0
  }
}

/**
 * One question, one push, even with two Stop hooks racing.
 *
 * Path-independent hook ownership stops the *usual* cause of two handlers
 * firing, but it cannot stop every one — two harnesses in one directory, or an
 * install this build does not recognise. Both processes would read the same
 * pending question, see no `request_id`, and both escalate: one question, two
 * notifications.
 *
 * Exclusive create is atomic on POSIX, so exactly one process gets the claim
 * and the other steps aside. A short guard serializes stale replacement with
 * contenders and releases; random ownership tokens keep an old holder from
 * unlinking its replacement. A live PID owns the claim regardless of age; a
 * known-dead PID is recoverable immediately. Only legacy/corrupt claims with
 * no trustworthy PID fall back to an age limit.
 */
const CLAIM_TTL_MS = WAITER_CEILING_SECONDS * 1000
const heldClaims = new Map<string, string>()

export function claimQuestionPush(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
  beforeStaleReplace?: () => void,
): boolean {
  const file = claimPath(sessionId, env)
  const guard = `${file}.guard`
  const token = randomBytes(12).toString('base64url')
  mkdirSync(path.dirname(file), { recursive: true })
  if (!acquireClaimGuard(guard)) return false
  try {
    try {
      writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: now, token })}\n`, {
        mode: 0o600,
        flag: 'wx',
      })
      heldClaims.set(file, token)
      return true
    } catch {
      // Held. Break it only if whoever holds it cannot still be running.
      try {
        const held = JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown; pid?: unknown }
        const age = typeof held.at === 'number' ? now - held.at : Number.POSITIVE_INFINITY
        if (typeof held.pid === 'number') {
          if (processIsAlive(held.pid)) return false
        } else if (age >= 0 && age < CLAIM_TTL_MS) {
          return false
        }
      } catch {
        // Unreadable or corrupt: treat as abandoned.
      }
      beforeStaleReplace?.()
      rmSync(file, { force: true })
      try {
        writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: now, token })}\n`, {
          mode: 0o600,
          flag: 'wx',
        })
        heldClaims.set(file, token)
        return true
      } catch {
        return false
      }
    }
  } finally {
    rmSync(guard, { force: true })
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function releaseQuestionPush(sessionId: string, env: NodeJS.ProcessEnv): void {
  const file = claimPath(sessionId, env)
  const token = heldClaims.get(file)
  if (token === undefined) return
  const guard = `${file}.guard`
  if (!acquireClaimGuard(guard)) {
    heldClaims.delete(file)
    return
  }
  try {
    try {
      const held = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown }
      if (held.token === token) rmSync(file, { force: true })
    } catch {
      // Missing or replaced claims are not ours to release.
    }
  } finally {
    heldClaims.delete(file)
    rmSync(guard, { force: true })
  }
}

/** The guard serializes stale replacement and release; recover a crashed guard. */
function acquireClaimGuard(file: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(file, 'wx', 0o600)
      closeSync(handle)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false
      try {
        if (Date.now() - statSync(file).mtimeMs < CLAIM_TTL_MS) return false
      } catch {
        // A vanished/corrupt guard is safe to retry once.
      }
      rmSync(file, { force: true })
    }
  }
  return false
}

function claimPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.claim`)
}

/**
 * A question is stored so a later hook can push it, and it reaches us from a
 * shell command, so its size is whatever the agent typed. The push itself is
 * bounded by the 4096-byte APNs envelope; this bounds what sits on disk in the
 * meantime, and keeps one runaway agent from writing megabytes per session.
 */
const MAX_STORED_QUESTION_CHARS = 2000

interface StoredProjectSessionPointer extends ProjectSessionPointer {
  updatedAt: number
}

/** Records every live session working in a directory, for `notifai ask`. */
export function writeProjectSession(
  cwd: string,
  env: NodeJS.ProcessEnv,
  sessionId: string,
  now: number,
  harness: HookHarness,
): void {
  const file = projectSessionPointerPath(cwd, env)
  withFileLock(`${file}.lock`, () => {
    const existing = readStoredProjectSessionPointers(file).filter(
      (entry) => entry.sessionId !== sessionId && now - entry.updatedAt <= 24 * 3600 * 1000,
    )
    atomicWriteFileSync(
      file,
      `${JSON.stringify({
        sessions: [
          ...existing.map((entry) => ({
            session_id: entry.sessionId,
            updated_at: entry.updatedAt,
            harness: entry.harness,
          })),
          { session_id: sessionId, updated_at: now, harness },
        ],
      })}\n`,
    )
  })
}

export interface ProjectSessionPointer {
  sessionId: string
  harness: HookHarness
}

function readStoredProjectSessionPointers(file: string): StoredProjectSessionPointer[] {
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { sessions?: unknown }
    if (!Array.isArray(parsed.sessions)) return []
    return parsed.sessions.flatMap((candidate): StoredProjectSessionPointer[] => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return []
      const entry = candidate as {
        session_id?: unknown
        updated_at?: unknown
        harness?: unknown
      }
      if (typeof entry.session_id !== 'string' || entry.session_id === '') return []
      if (typeof entry.updated_at !== 'number') return []
      if (!(HARNESSES as readonly unknown[]).includes(entry.harness)) return []
      return [
        {
          sessionId: entry.session_id,
          updatedAt: entry.updated_at,
          harness: entry.harness as HookHarness,
        },
      ]
    })
  } catch {
    return []
  }
}

/**
 * Resolves the session working in `cwd`. Stale pointers are ignored rather than
 * trusted: an id left by a session that ended days ago would send the question
 * into state nothing is watching.
 */
export function readProjectSession(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: number,
  maxAgeMs = 24 * 3600 * 1000,
): string | null {
  return readProjectSessionPointer(cwd, env, now, maxAgeMs)?.sessionId ?? null
}

/** A live pointer keeps when it was last written, so callers can rank by it. */
export interface LiveProjectSessionPointer extends ProjectSessionPointer {
  updatedAt: number
}

/**
 * Every session that has fired a hook in this directory recently, newest first.
 *
 * This is the only local record of which harness sessions are actually alive
 * here, which makes it the tiebreaker when the environment alone cannot say
 * which harness owns the current shell.
 */
export function readLiveProjectSessionPointers(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: number,
  maxAgeMs = 24 * 3600 * 1000,
): LiveProjectSessionPointer[] {
  const file = projectSessionPointerPath(cwd, env)
  return readStoredProjectSessionPointers(file)
    .filter((entry) => now - entry.updatedAt <= maxAgeMs)
    .filter((entry) => {
      try {
        // A pointer is routing evidence only while its session state still
        // exists and parses. SessionEnd and explicit cleanup therefore
        // invalidate it even when a crash prevented removal from this index.
        const sessionFile = sessionStatePath(entry.sessionId, env)
        if (!existsSync(sessionFile)) return false
        const state: unknown = JSON.parse(readFileSync(sessionFile, 'utf8'))
        return typeof state === 'object' && state !== null && !Array.isArray(state)
      } catch {
        return false
      }
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((entry) => ({
      sessionId: entry.sessionId,
      harness: entry.harness,
      updatedAt: entry.updatedAt,
    }))
}

export function readProjectSessionPointer(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: number,
  maxAgeMs = 24 * 3600 * 1000,
): ProjectSessionPointer | null {
  const latest = readLiveProjectSessionPointers(cwd, env, now, maxAgeMs)[0]
  return latest === undefined ? null : { sessionId: latest.sessionId, harness: latest.harness }
}

export function readMatchingProjectSessionPointer(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: number,
  sessionId: string,
  harness: HookHarness,
  maxAgeMs = 24 * 3600 * 1000,
): ProjectSessionPointer | null {
  const match = readLiveProjectSessionPointers(cwd, env, now, maxAgeMs).find(
    (entry) => entry.sessionId === sessionId && entry.harness === harness,
  )
  return match === undefined ? null : { sessionId: match.sessionId, harness: match.harness }
}

function clearMatchingProjectSession(
  cwd: string,
  env: NodeJS.ProcessEnv,
  sessionId: string,
): void {
  const file = projectSessionPointerPath(cwd, env)
  withFileLock(`${file}.lock`, () => {
    const remaining = readStoredProjectSessionPointers(file).filter(
      (entry) => entry.sessionId !== sessionId,
    )
    if (remaining.length === 0) {
      rmSync(file, { force: true })
      return
    }
    atomicWriteFileSync(
      file,
      `${JSON.stringify({
        sessions: remaining.map((entry) => ({
          session_id: entry.sessionId,
          updated_at: entry.updatedAt,
          harness: entry.harness,
        })),
      })}\n`,
    )
  })
}

export interface HookContext {
  client: ApiClient
  config: CliConfig
  env: NodeJS.ProcessEnv
  now: () => number
  /** Injected so tests advance a virtual clock instead of sleeping. */
  sleep: (milliseconds: number) => Promise<void>
  /** Bounded wait for the first reply; injected so tests do not sleep. */
  waitForFirstReply: (
    requestId: string,
    timeoutSeconds: number,
  ) => Promise<{ replies: ReplyView[]; timedOut: boolean; degraded?: boolean }>
  /** The active harness selects the native continuation output adapter. */
  harness?: HookHarness
  /**
   * The local record. A hook's decisions are invisible from everywhere else —
   * its stderr belongs to the harness and its usual outcome is to do nothing —
   * so this is the only account of why a question did or did not travel.
   */
  log?: Logger
}

/**
 * Record one gate decision.
 *
 * `verdict` is what happened to the question and `reason` is the closed-set
 * name of the rule that decided it, so an agent can ask "why was it held" with
 * a filter rather than by matching on prose. The prose still exists — it is what
 * the user sees in the terminal — but it is free to be rewritten, and a log a
 * filter cannot rely on is a log nobody filters.
 */
export type GateReason =
  | 'no-session'
  | 'no-question'
  | 'answered'
  | 'already-asked'
  | 'continuation-repeat'
  | 'continuation-limit'
  | 'delivery-limit'
  | 'acknowledgement-required'
  | 'notifications-off'
  | 'claimed-elsewhere'
  | 'no-devices'
  | 'proceeding'

function gate(
  ctx: HookContext,
  verdict: 'held' | 'proceeding',
  reason: GateReason,
  data: Record<string, unknown> = {},
): void {
  ctx.log?.info('hook.gate', { verdict, reason, stage: 'queued', ...data })
}

export type HookHarness = Harness

/**
 * One round of the waiter's reply poll. Short enough that several questions
 * still share one wall clock, long enough not to hammer the server.
 */
const REPLY_POLL_SECONDS = 5

/**
 * Push a question and block for the answer.
 *
 * An answered question is closed the moment this wait sees the answer: the
 * first device to answer claims the question and the others are told. Until
 * that close, a later reply is a correction — so what this returns as "the"
 * answer is always the latest reply, with the full stream alongside for
 * free-text answers given in parts. An unanswered question stays open,
 * because nobody has acted on the silence yet and the next turn can still
 * collect the answer with `notifai replies`.
 */
/**
 * Put one registered question on the user's devices. Submission only — the
 * wait happens once, across every live question, in the caller.
 */
async function prepareQuestionSubmission(
  ctx: HookContext,
  options: {
    title: string
    body: string
    questions: QuestionT[]
    media?: MediaItemT[] | undefined
    project?: string | undefined
    source?: SourceContextT | undefined
    event: string
    /** How long the server keeps accepting an answer. */
    windowSeconds: number
    /** Absolute owner deadline persisted before submit. */
    ownerDeadlineAt: number
  },
): Promise<PendingSubmissionIntent | { error: string }> {
  const collapseKey = `notifai-hook-${randomBytes(8).toString('base64url')}`
  // A draft carrying `reply` is rejected outright if it targets a device that
  // cannot answer, so resolve the healthy companion platforms explicitly.
  const answerable = await answerableDevices(ctx)
  if (answerable.length === 0) {
    return { error: 'no device can answer a question yet; leaving this to the terminal' }
  }
  const build = buildDraft(
    ctx.config,
    {
      title: options.title,
      body: options.body,
      event: options.event,
      lifecycle: { tier: 'needs_you' },
      ...(options.project !== undefined ? { project: options.project } : {}),
      ...(options.media !== undefined ? { media: options.media } : {}),
      device: answerable,
      reply: true,
      replyWindow: Math.max(60, options.windowSeconds),
      questions: options.questions,
      collapseKey,
    },
    options.source === undefined ? {} : { source: options.source },
  )
  if (!build.ok) return { error: build.error }

  return {
    request_id: `req_${randomBytes(18).toString('base64url')}`,
    idempotency_key: `hook-${randomBytes(12).toString('base64url')}`,
    collapse_key: collapseKey,
    device_ids: answerable,
    draft: build.draft,
    owner_deadline_at: options.ownerDeadlineAt,
  }
}

async function submitQuestion(
  ctx: HookContext,
  intent: PendingSubmissionIntent,
): Promise<SubmissionReceipt> {
  const receipt = await ctx.client.submit(
    {
      request_id: intent.request_id,
      idempotency_key: intent.idempotency_key,
      draft: intent.draft,
    },
    0,
  )
  if (receipt.request_id !== intent.request_id) {
    throw new Error(
      `server replay returned ${receipt.request_id}, expected reserved ${intent.request_id}`,
    )
  }
  return receipt
}

/**
 * The waiter's wait: one bounded poll across every live question at once.
 *
 * Each round polls all of them concurrently, so several questions cost the
 * same wall clock as one; the first round that finds any reply returns
 * everything found in that round, and whatever was not answered stays
 * registered. A question whose polling is permanently rejected drops out of
 * the round rather than failing the whole wait.
 */
async function waitForAnyReply(
  ctx: HookContext,
  requestIds: string[],
  timeoutSeconds: number,
): Promise<{
  byRequest: Map<string, ReplyView[]>
  degraded: boolean
  permanentFailures: Map<string, string>
}> {
  const deadline = ctx.now() + timeoutSeconds * 1000
  let degraded = false
  let firstPoll = true
  const permanentFailures = new Map<string, string>()

  for (;;) {
    const remainingMs = Math.max(0, deadline - ctx.now())
    if (!firstPoll && remainingMs === 0) {
      return { byRequest: new Map(), degraded, permanentFailures }
    }
    firstPoll = false
    const pollSeconds = Math.min(REPLY_POLL_SECONDS, Math.max(0, Math.ceil(remainingMs / 1000)))
    const results = await Promise.all(
      requestIds
        .filter((requestId) => !permanentFailures.has(requestId))
        .map(async (requestId) => {
          try {
            return { requestId, ...(await ctx.waitForFirstReply(requestId, pollSeconds)) }
          } catch (err) {
            if (isRetryableReplyPollError(err)) {
              return { requestId, replies: [] as ReplyView[], degraded: true }
            }
            return {
              requestId,
              replies: [] as ReplyView[],
              degraded: false,
              permanentFailure: replyPollFailure(err),
            }
          }
        }),
    )
    const byRequest = new Map<string, ReplyView[]>()
    for (const result of results) {
      degraded ||= result.degraded === true
      if (result.permanentFailure !== undefined) {
        permanentFailures.set(result.requestId, result.permanentFailure)
      }
      if (result.replies.length > 0) byRequest.set(result.requestId, result.replies)
    }
    if (byRequest.size > 0 || permanentFailures.size === requestIds.length) {
      return { byRequest, degraded, permanentFailures }
    }
  }
}

/** A non-retryable replies fault, with enough server identity to act on it. */
function replyPollFailure(err: unknown): string {
  return err instanceof ApiCallError
    ? `${err.code} (HTTP ${err.status}): ${err.message}`
    : String(err)
}

function permanentReplyFailureNote(failures: Map<string, string>): string | null {
  if (failures.size === 0) return null
  const details = [...failures].map(([requestId, failure]) => `${requestId}: ${failure}`).join('; ')
  return `reply polling stopped after a permanent server rejection (${details}); the affected question will be retired before its continuation owner exits`
}

/**
 * Healthy companion devices that implement replies. Both the iOS app and the
 * macOS app register reply categories and submit answers directly.
 */
async function answerableDevices(ctx: HookContext): Promise<string[]> {
  const configured = ctx.config.devices.value
  const { devices } = await ctx.client.listDevices()
  return devices
    .filter(
      (device) =>
        (device.platform === 'ios' || device.platform === 'macos') &&
        device.registration_healthy &&
        device.reply_protocol_version === 2,
    )
    .filter((device) => configured === null || configured.includes(device.device_id))
    .map((device) => device.device_id)
}

/**
 * Everything retirement needs. Narrower than a HookContext on purpose:
 * `notifai ask` supersedes the previous question and it is a plain command with
 * no hook payload, no idle probe and nothing to sleep for.
 */
export type RetireDeps = Pick<HookContext, 'client' | 'config'>

/**
 * Close is a server-side serialization fence: a successful response contains
 * every reply that committed before the window closed. `null` is deliberately
 * different from an empty reply set — it means ownership could not be proven
 * final and the local record must stay recoverable.
 */
async function finalizeReplies(
  ctx: RetireDeps,
  requestId: string,
): Promise<ListRepliesResponse | null> {
  try {
    return await ctx.client.closeReplies(requestId)
  } catch {
    return null
  }
}

/** Best effort only for already-journaled retirement debt. */
async function closeQuietly(ctx: RetireDeps, requestId: string): Promise<void> {
  await finalizeReplies(ctx, requestId)
}

/**
 * Retire the question on every device it reached. A state change is not news
 * (D-B): the retirement rides as a background state sync — no alert, no
 * sound — carrying the shared collapse key so the companion removes the
 * delivered question and marks it done. If the app cannot run, the stale
 * question simply waits until next open, which beats a tombstone banner
 * announcing what the user just did.
 */
async function retire(
  ctx: RetireDeps,
  collapseKey: string,
  title: string,
  body: string,
  endState: LifecycleEndState,
  retiresRequestId: string,
  devices?: string[],
  project?: string | undefined,
  source?: SourceContextT | undefined,
): Promise<boolean> {
  const build = buildDraft(
    ctx.config,
    {
      title,
      body,
      event: 'question_retired',
      lifecycle: { tier: 'done', state: endState, retires_request_id: retiresRequestId },
      ...(project !== undefined ? { project } : {}),
      ...(devices !== undefined && devices.length > 0 ? { device: devices } : {}),
      collapseKey,
      level: 'passive',
    },
    source === undefined ? {} : { source },
  )
  if (!build.ok) return false
  try {
    await ctx.client.submit(
      { idempotency_key: `retire-${randomBytes(12).toString('base64url')}`, draft: build.draft },
      0,
    )
    return true
  } catch {
    // Same reasoning as closeQuietly: the window is already closed server-side.
    return false
  }
}

/**
 * The title a retirement carries. It is never rendered as a banner — the push
 * is `content-available` only — but it is what a companion with no matching
 * history entry has to fall back on, and it is what shows in server-side logs.
 */
const RETIREMENT_TITLES: Record<LifecycleEndState, string> = {
  answered: 'Answered',
  answered_elsewhere: 'Answered in the terminal',
  expired: 'Question expired',
  superseded: 'Replaced by a newer question',
}

/**
 * Park a delivered question for retirement. Called at the moment we learn it is
 * dead, which is frequently not a moment we can reach the network.
 *
 * Nothing is parked for a question that never reached a device: with no
 * request_id there is nothing on any device to retire.
 */
export function parkForRetirement(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  pending: PendingQuestion,
  state: LifecycleEndState,
): void {
  const retirement = retiringQuestion(pending, state)
  if (retirement === null) return
  updateSessionState(sessionId, env, (current) => {
    const already = current.retiring ?? []
    const existing = already.findIndex((entry) => entry.request_id === retirement.request_id)
    if (existing < 0) return { ...current, retiring: [...already, retirement] }
    const retiring = [...already]
    // An observed answer is final truth and upgrades an earlier supersession
    // parked while the submission callback was racing a newer question.
    if (retirement.state === 'answered' && retiring[existing]!.state !== 'answered') {
      retiring[existing] = retirement
    }
    return { ...current, retiring }
  })
}

/**
 * Convert live question state into a complete retirement instruction.
 *
 * A request/collapse pair without the original Delivery targets is not safe to
 * send: re-resolving today's routing can miss a device that still shows the
 * question or retire a device that never received it. Fail explicitly and keep
 * the pending record instead of silently broadening or narrowing the fanout.
 */
function retiringQuestion(
  pending: PendingQuestion,
  state: LifecycleEndState,
): RetiringQuestion | null {
  const hasRequest = pending.request_id !== undefined
  const hasCollapse = pending.collapse_key !== undefined
  const hasDevices = pending.device_ids !== undefined && pending.device_ids.length > 0
  if (!hasRequest && !hasCollapse && !hasDevices) return null
  if (!hasRequest || !hasCollapse || !hasDevices) {
    throw new Error(
      'live question state is incomplete; refusing to retire it without request, collapse, and device identifiers',
    )
  }
  return {
    request_id: pending.request_id!,
    collapse_key: pending.collapse_key!,
    device_ids: [...pending.device_ids!],
    question: pending.question,
    ...(pending.project !== undefined ? { project: pending.project } : {}),
    ...(pending.source !== undefined ? { source: pending.source } : {}),
    state,
  }
}

function retirementDeviceIds(entry: RetiringQuestion): string[] {
  if (!Array.isArray(entry.device_ids) || entry.device_ids.length === 0) {
    throw new Error(
      `retirement for ${entry.request_id} is missing its device identifiers; refusing to re-resolve routing`,
    )
  }
  return entry.device_ids
}

/**
 * Send every parked retirement, and forget the ones that landed. A failure
 * leaves the entry in place for the next hook rather than losing it, which is
 * the whole reason the queue exists.
 */
export async function drainRetirements(
  ctx: RetireDeps,
  sessionId: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const queue = readSessionState(sessionId, env).retiring ?? []
  if (queue.length === 0) return []

  const retired: string[] = []
  for (const entry of queue) {
    await closeQuietly(ctx, entry.request_id)
    const sent = await retire(
      ctx,
      entry.collapse_key,
      RETIREMENT_TITLES[entry.state],
      entry.question,
      entry.state,
      entry.request_id,
      retirementDeviceIds(entry),
      entry.project,
      entry.source,
    )
    if (sent) {
      retired.push(entry.request_id)
      // Persist each success before touching the next entry. A later corrupt
      // record or interrupted process must not resurrect work already done.
      updateSessionState(sessionId, env, (current) => ({
        ...current,
        retiring: (current.retiring ?? []).filter(
          (candidate) => candidate.request_id !== entry.request_id,
        ),
      }))
    }
  }
  return retired
}

function orphanQueuePath(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'retire-queue.json')
}

function readOrphanQueue(env: NodeJS.ProcessEnv): OrphanRetirement[] {
  const file = orphanQueuePath(env)
  if (!existsSync(file)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as OrphanRetirement[]) : []
  } catch {
    // Same stance as session state: corruption fails closed to "nothing queued".
    return []
  }
}

function writeOrphanQueueUnlocked(file: string, queue: OrphanRetirement[]): void {
  atomicWriteFileSync(file, `${JSON.stringify(queue, null, 2)}\n`)
}

function updateOrphanQueue(
  env: NodeJS.ProcessEnv,
  update: (current: OrphanRetirement[]) => OrphanRetirement[],
): OrphanRetirement[] {
  const file = orphanQueuePath(env)
  return withFileLock(`${file}.lock`, () => {
    const next = update(readOrphanQueue(env))
    writeOrphanQueueUnlocked(file, next)
    return next
  })
}

/** Move retirements into the global queue; deduped so a retry costs nothing. */
export function orphanRetirements(
  env: NodeJS.ProcessEnv,
  entries: RetiringQuestion[],
  now: number,
): void {
  if (entries.length === 0) return
  updateOrphanQueue(env, (queue) => {
    const known = new Set(queue.map((entry) => entry.request_id))
    const added = entries
      .filter((entry) => !known.has(entry.request_id))
      .map((entry) => ({ ...entry, enqueued_at: now }))
    return [...queue, ...added].slice(-ORPHAN_QUEUE_CAP)
  })
}

/**
 * Retire everything a dead session left behind. Failures stay queued for the
 * next holder of a client; entries past the TTL are dropped as already dead.
 */
export async function drainOrphanRetirements(
  ctx: RetireDeps,
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<string[]> {
  const queue = readOrphanQueue(env)
  if (queue.length === 0) return []

  const done: string[] = []
  for (const entry of queue) {
    const age = now - entry.enqueued_at
    // A negative age is a clock jump, not a fresh entry; retiring is idempotent
    // and cheap, so treat it as due rather than letting it linger for ever.
    if (age > ORPHAN_TTL_MS) {
      done.push(entry.request_id)
      updateOrphanQueue(env, (current) =>
        current.filter((candidate) => candidate.request_id !== entry.request_id),
      )
      continue
    }
    await closeQuietly(ctx, entry.request_id)
    const sent = await retire(
      ctx,
      entry.collapse_key,
      RETIREMENT_TITLES[entry.state],
      entry.question,
      entry.state,
      entry.request_id,
      retirementDeviceIds(entry),
      entry.project,
      entry.source,
    )
    if (sent) {
      done.push(entry.request_id)
      updateOrphanQueue(env, (current) =>
        current.filter((candidate) => candidate.request_id !== entry.request_id),
      )
    }
  }
  return done
}

const LATE_STOP_POLL_SECONDS = 4
const LATE_PROMPT_POLL_SECONDS = 3
/**
 * The one bound on answer deliveries, for every route.
 *
 * It caps two things that both used to be able to run away: how many times a
 * single accepted answer may be handed to a route before the journal gives up
 * on it, and how many answer-driven continuation generations one chain may
 * produce.
 */
export const MAX_CONTINUATION_COUNT = 3

interface PendingPoll {
  /** The answer to act on: the latest reply, because a later one corrects. */
  reply: ReplyView | null
  /** Every reply in arrival order, for free-text answers given in parts. */
  replies: ReplyView[]
  degraded: boolean
  permanentFailure: string | null
}

/** One bounded recovery poll for a question that outlived its original wait. */
async function pollPendingReply(
  ctx: HookContext,
  pending: PendingQuestion,
  timeoutSeconds: number,
): Promise<PendingPoll> {
  if (pending.request_id === undefined) {
    return { reply: null, replies: [], degraded: false, permanentFailure: null }
  }
  try {
    const result = await ctx.waitForFirstReply(pending.request_id, timeoutSeconds)
    return {
      reply: result.replies.at(-1) ?? null,
      replies: result.replies,
      degraded: result.degraded === true,
      permanentFailure: null,
    }
  } catch (err) {
    return isRetryableReplyPollError(err)
      ? { reply: null, replies: [], degraded: true, permanentFailure: null }
      : { reply: null, replies: [], degraded: false, permanentFailure: replyPollFailure(err) }
  }
}

/** One answered registered question, with everything the agent needs to read it. */
interface AnsweredPending {
  pending: PendingQuestion
  reply: ReplyView
  replies: ReplyView[]
  /** Immutable server snapshot for this request, known after a replies/close response. */
  agent_acknowledgement_required?: boolean | undefined
}

interface FinalizedPending {
  pending: PendingQuestion
  response: ListRepliesResponse | null
}

/** Close several windows concurrently without confusing failure with silence. */
async function finalizePendings(
  ctx: HookContext,
  pending: PendingQuestion[],
): Promise<FinalizedPending[]> {
  return Promise.all(
    pending.map(async (entry) => ({
      pending: entry,
      response: await finalizeReplies(ctx, entry.request_id!),
    })),
  )
}

/** Convert a fenced final reply set into the exact answer handed to the model. */
function finalizedAnswer(finalized: FinalizedPending): AnsweredPending | null {
  const replies = finalized.response?.replies ?? []
  const reply = replies.at(-1)
  return reply === undefined
    ? null
    : {
        pending: finalized.pending,
        reply,
        replies,
        agent_acknowledgement_required:
          finalized.response?.agent_acknowledgement_required,
      }
}

/** Persist and surface one answer without letting the two representations drift. */
function reportAnswer(
  ctx: HookContext,
  notes: string[],
  answered: AnsweredPending,
  late: boolean,
): void {
  ctx.log?.info('hook.answer', {
    answered: true,
    stage: 'queued',
    ...(late ? { late: true } : {}),
    request_id: answered.pending.request_id,
    device: answered.reply.device_name,
    text: answered.reply.text,
  })
  notes.push(`${late ? 'late ' : ''}answer from ${answered.reply.device_name}: ${answered.reply.text}`)
}

/**
 * One bounded recovery poll across every delivered question, concurrently —
 * N questions must not multiply the hook's latency budget by N.
 */
async function pollPendingReplies(
  ctx: HookContext,
  live: PendingQuestion[],
  timeoutSeconds: number,
): Promise<{
  answered: AnsweredPending[]
  transientTrouble: boolean
  permanentFailures: Map<string, string>
}> {
  const polls = await Promise.all(
    live.map((entry) => pollPendingReply(ctx, entry, timeoutSeconds)),
  )
  const answered: AnsweredPending[] = []
  let transientTrouble = false
  const permanentFailures = new Map<string, string>()
  for (const [index, poll] of polls.entries()) {
    if (poll.reply !== null) {
      answered.push({ pending: live[index]!, reply: poll.reply, replies: poll.replies })
    }
    if (poll.degraded) transientTrouble = true
    if (poll.permanentFailure !== null) {
      permanentFailures.set(live[index]!.request_id!, poll.permanentFailure)
    }
  }
  return { answered, transientTrouble, permanentFailures }
}

/** The registered-question queue. Anything but the current shape reads as empty. */
function pendingList(state: SessionState): PendingQuestion[] {
  return Array.isArray(state.pending) ? state.pending : []
}

/** Registration identity — the convention every racing writer compares by. */
function isSamePending(a: PendingQuestion, b: PendingQuestion): boolean {
  if (a.question_id !== undefined || b.question_id !== undefined) {
    return a.question_id !== undefined && a.question_id === b.question_id
  }
  return a.question === b.question && a.asked_at === b.asked_at
}

/**
 * The frozen draft itself will never be accepted. Replaying it forever hides a
 * contract-skew (deleted fields, unexpected properties) as a recoverable wait.
 * Auth, conflicts, and timeouts are not this class.
 */
function isTerminalDraftRejection(err: ApiCallError): boolean {
  return err.status === 422 || (err.status === 400 && err.code === 'invalid_request')
}

function dropPendingQuestion(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  entry: PendingQuestion,
): void {
  updateSessionState(sessionId, env, (current) => {
    const pending = pendingList(current).filter((candidate) => !isSamePending(candidate, entry))
    const next: SessionState = { ...current }
    if (pending.length > 0) next.pending = pending
    else delete next.pending
    return next
  })
}

function clearFrozenSubmission(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  entry: PendingQuestion,
): void {
  updateSessionState(sessionId, env, (current) => {
    const list = pendingList(current)
    const index = list.findIndex((candidate) => isSamePending(candidate, entry))
    if (index < 0) return current
    const next = [...list]
    const copy = { ...next[index]! }
    delete copy.submission
    next[index] = copy
    return { ...current, pending: next }
  })
}

/** The question set this pending record pushes, however it was registered. */
function pendingQuestions(pending: PendingQuestion): QuestionT[] {
  return pending.questions ?? [{ id: 'q1', text: pending.question }]
}

/** Did any question in the set offer choices? Decides how replies combine. */
function pendingHasChoices(pending: PendingQuestion): boolean {
  return pendingQuestions(pending).some((question) => question.choices !== undefined)
}

/**
 * The answer as the agent should read it. For a question with choices the
 * latest reply IS the answer — an earlier conflicting one was corrected by
 * it. Free-text answers can arrive in parts, and every part reaches the
 * agent in the order it was written, so it can tell expansion from
 * correction itself.
 *
 * The continuation repeats only identity the agent actually registered and
 * the answer the server accepted. It never invents trust, urgency, permission,
 * or approval claims for the transport to assert.
 */
function answerContext(answered: AnsweredPending): string {
  const { pending, replies } = answered
  const latest = replies.at(-1)
  if (latest === undefined) return 'Notifai — no answer was recorded.'
  const answeredQuestionIds = [...new Set(latest.answers.map((answer) => answer.question_id))]
  const identity =
    answeredQuestionIds.length === 0
      ? ''
      : `question_id${answeredQuestionIds.length === 1 ? '' : 's'} ${answeredQuestionIds.join(', ')}, `
  const question = `question ${JSON.stringify(pending.question)}`
  if (replies.length === 1 || pendingHasChoices(pending)) {
    return `Notifai — ${identity}${question}; the user answered ${JSON.stringify(latest.text)}.`
  }
  const parts = replies.map((reply) => JSON.stringify(reply.text)).join(', then ')
  return (
    `Notifai — ${identity}${question}; the user answered in ${replies.length} parts, ` +
    `in the order written: ${parts}. Later parts extend or correct earlier ones.`
  )
}

/**
 * Every answer that has arrived, as one message. Several registered questions
 * may resolve in one hook pass; the agent reads them together, each answer
 * tied to the question that asked it, with a truthful note about anything
 * still waiting.
 */
function acknowledgementCommand(requestId: string): string {
  return `notifai acknowledge ${requestId} --text <text>`
}

function acknowledgementContext(answered: AnsweredPending[]): string {
  const due = answered.filter(
    (entry) =>
      entry.agent_acknowledgement_required === true && entry.pending.request_id !== undefined,
  )
  if (due.length === 0) {
    return ' Agent Acknowledgement is not required for the answered request(s).'
  }
  if (due.length === 1) {
    const requestId = due[0]!.pending.request_id!
    return (
      ` Agent Acknowledgement is required for request ${requestId}. Immediately, before doing the resumed work or ending this turn, run ` +
      `\`${acknowledgementCommand(requestId)}\` with non-empty text saying what concrete work you will do because of the reply; a bare acknowledgement is insufficient.`
    )
  }
  const commands = due
    .map((entry) => {
      const requestId = entry.pending.request_id!
      return `- ${requestId}: \`${acknowledgementCommand(requestId)}\``
    })
    .join('\n')
  return (
    ` Agent Acknowledgement is required for ${due.length} requests. Immediately, before doing the resumed work or ending this turn, run every command below with non-empty text saying what concrete work you will do because of that reply; a bare acknowledgement is insufficient:\n` +
    commands
  )
}

function answersContext(answered: AnsweredPending[], remaining: number): string {
  const tail =
    remaining > 0
      ? ` (${remaining} more registered question${remaining === 1 ? ' is' : 's are'} still waiting for an answer.)`
      : ''
  const guidance = acknowledgementContext(answered)
  if (answered.length === 1) {
    return answerContext(answered[0]!) + tail + guidance
  }
  const lines = answered.map(({ pending, replies }) => {
    const latest = replies.at(-1)!
    const answer =
      replies.length === 1 || pendingHasChoices(pending)
        ? JSON.stringify(latest.text)
        : `${replies.map((reply) => JSON.stringify(reply.text)).join(', then ')} (parts in the order written; later parts extend or correct earlier ones)`
    const ids = [...new Set(latest.answers.map((entry) => entry.question_id))]
    const identity = ids.length === 0 ? '' : `question_id${ids.length === 1 ? '' : 's'} ${ids.join(', ')}: `
    return `- ${identity}${JSON.stringify(pending.question)} → ${answer}`
  })
  return `Notifai — the user answered ${answered.length} questions:\n${lines.join('\n')}${tail}${guidance}`
}

function stopAnswerOutput(context: string): string {
  return JSON.stringify({
    decision: 'block',
    reason: context,
  })
}

/**
 * Close, truthfully retire, and forget every answered pending question in one
 * state write, without dropping any other retirement debt or any question
 * still waiting. Stop answers also open one bounded continuation generation;
 * UserPromptSubmit answers ride the user's new turn.
 */
function stageAcceptedAnswers(
  ctx: HookContext,
  sessionId: string,
  answered: AnsweredPending[],
  remaining: number,
): AcceptedAnswerDelivery {
  const accepted: AcceptedAnswerDelivery = {
    answers: answered,
    remaining,
    recorded_at: ctx.now(),
  }
  updateSessionState(sessionId, ctx.env, (current) => {
    const pendingRemaining = pendingList(current).filter(
      (entry) => !answered.some(({ pending }) => isSamePending(entry, pending)),
    )
    const acknowledgementDue = [...(current.acknowledgement_due ?? [])]
    for (const answer of answered) {
      const requestId = answer.pending.request_id
      if (
        answer.agent_acknowledgement_required === true &&
        requestId !== undefined &&
        !acknowledgementDue.some((entry) => entry.request_id === requestId)
      ) {
        acknowledgementDue.push({ request_id: requestId, recorded_at: accepted.recorded_at })
      }
    }
    const next: SessionState = {
      ...current,
      accepted,
    }
    if (pendingRemaining.length > 0) next.pending = pendingRemaining
    else delete next.pending
    if (acknowledgementDue.length > 0) next.acknowledgement_due = acknowledgementDue
    else delete next.acknowledgement_due
    return next
  })
  return accepted
}

/** Amend the live accepted record in place, without resurrecting a settled one. */
function amendAcceptedAnswers(
  ctx: HookContext,
  sessionId: string,
  amend: (accepted: AcceptedAnswerDelivery) => AcceptedAnswerDelivery,
): void {
  updateSessionState(sessionId, ctx.env, (current) =>
    current.accepted === undefined ? current : { ...current, accepted: amend(current.accepted) },
  )
}

export function clearAcknowledgementObligation(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  requestId: string,
): boolean {
  let cleared = false
  updateSessionState(sessionId, env, (current) => {
    const due = current.acknowledgement_due ?? []
    const remaining = due.filter((entry) => entry.request_id !== requestId)
    cleared = remaining.length !== due.length
    if (!cleared) return current
    const next = { ...current }
    if (remaining.length > 0) next.acknowledgement_due = remaining
    else delete next.acknowledgement_due
    return next
  })
  return cleared
}

function acknowledgementBlockContext(due: readonly AcknowledgementDue[]): string {
  const commands = due
    .map((entry) => `- ${entry.request_id}: \`${acknowledgementCommand(entry.request_id)}\``)
    .join('\n')
  return (
    `Notifai — required Agent Acknowledgement${due.length === 1 ? '' : 's'} still missing for request${due.length === 1 ? '' : 's'} ${due.map((entry) => entry.request_id).join(', ')}. ` +
    `Before doing more resumed work or ending this turn, run ${due.length === 1 ? 'this command' : 'every command'} with non-empty text saying what concrete work you will do because of the reply; a bare acknowledgement is insufficient:\n${commands}`
  )
}

async function reconcileAcknowledgementObligations(
  ctx: HookContext,
  sessionId: string,
  due: readonly AcknowledgementDue[],
): Promise<AcknowledgementDue[]> {
  const unresolved: AcknowledgementDue[] = []
  for (const obligation of due) {
    try {
      const snapshot = await ctx.client.agentAcknowledgement(obligation.request_id, {
        waitSeconds: 0,
      })
      if (
        snapshot.agent_acknowledgement_required === false ||
        snapshot.agent_acknowledgement !== null
      ) {
        clearAcknowledgementObligation(sessionId, ctx.env, obligation.request_id)
      } else {
        unresolved.push(obligation)
      }
    } catch (err) {
      unresolved.push(obligation)
      ctx.log?.error('hook.gate', {
        verdict: 'held',
        reason: 'acknowledgement-required',
        stage: 'reconcile-failed',
        request_id: obligation.request_id,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return unresolved
}

/**
 * Retire the answered questions and close the journal.
 *
 * Called once an answer's delivery is acknowledged — by the route's own write,
 * or by the successor Stop of a blocking continuation. The continuation counter
 * grows with each settled generation, so the cap that bounds chained
 * answer-to-question loops is a real count rather than a constant 1.
 */
function settleAcceptedAnswers(
  ctx: HookContext,
  sessionId: string,
  accepted: AcceptedAnswerDelivery,
): void {
  const retirements = accepted.answers
    .map(({ pending }) => retiringQuestion(pending, 'answered'))
    .filter((entry): entry is RetiringQuestion => entry !== null)
  updateSessionState(sessionId, ctx.env, (current) => {
    const retiring = [...(current.retiring ?? [])]
    for (const retirement of retirements) {
      const existing = retiring.findIndex((entry) => entry.request_id === retirement.request_id)
      if (existing < 0) retiring.push(retirement)
      else retiring[existing] = retirement
    }
    const next: SessionState = { ...current, retiring }
    delete next.accepted
    next.continuation = {
      answered_at: accepted.recorded_at,
      count: (current.continuation?.count ?? 0) + 1,
    }
    return next
  })
}

async function retirePendings(
  ctx: HookContext,
  envelope: HookEnvelope,
  sessionId: string,
  entries: PendingQuestion[],
  state: LifecycleEndState,
): Promise<void> {
  updateSessionState(sessionId, ctx.env, (current) => {
    const retiring = [...(current.retiring ?? [])]
    for (const entry of entries) {
      const retirement = retiringQuestion(entry, state)
      if (retirement !== null && !retiring.some((item) => item.request_id === retirement.request_id)) {
        retiring.push(retirement)
      }
    }
    const pending = pendingList(current).filter(
      (candidate) => !entries.some((entry) => isSamePending(candidate, entry)),
    )
    const next: SessionState = { ...current }
    if (pending.length > 0) next.pending = pending
    else delete next.pending
    if (retiring.length > 0) next.retiring = retiring
    else delete next.retiring
    return next
  })
  // Network retirement is deliberately deferred to a later no-question hook.
  // The state write above is the durable operation; blocking here creates a
  // crash window before an answer can reach harness stdout.
}

// ---------------------------------------------------------------------------
// UserPromptSubmit — the user is at the keyboard
// ---------------------------------------------------------------------------

/**
 * Records presence and retires anything still asking on companion devices. This is the
 * "answered in the terminal" case from the original design: we cannot tell
 * whether the new prompt answers the question, but we do not need to — the
 * user being here is what makes the notification noise.
 */
export async function handleUserPromptSubmit(
  ctx: HookContext,
  envelope: HookEnvelope,
): Promise<HookOutcome> {
  const notes: string[] = []
  const sessionId = envelope.session_id
  if (!sessionId) return { notes }

  const state = readSessionState(sessionId, ctx.env)
  if (state.accepted !== undefined) {
    updateSessionState(sessionId, ctx.env, (current) => ({
      ...current,
      last_prompt_at: ctx.now(),
    }))
    if (envelope.cwd !== undefined && ctx.harness !== undefined) {
      writeProjectSession(envelope.cwd, ctx.env, sessionId, ctx.now(), ctx.harness)
    }
    notes.push(
      state.accepted.delivered_at === undefined
        ? 'a device answer is safely journaled; the next Stop will deliver it'
        : 'a device answer has already been delivered; the next Stop will close it out',
    )
    return { notes }
  }
  const live = pendingList(state).filter((entry) => entry.request_id !== undefined)
  let lateAnswers: AnsweredPending[] = []
  if (live.length > 0) {
    const { answered, transientTrouble, permanentFailures } = await pollPendingReplies(
      ctx,
      live,
      LATE_PROMPT_POLL_SECONDS,
    )
    const finalized = await finalizePendings(
      ctx,
      answered.map((entry) => entry.pending),
    )
    lateAnswers = answered.map((entry) => {
      const response = finalized.find((candidate) =>
        isSamePending(candidate.pending, entry.pending),
      )?.response
      const replies = response?.replies.length ? response.replies : entry.replies
      if (response === null) {
        notes.push(
          `could not confirm the close fence for ${entry.pending.request_id}; preserving the durable answer already observed`,
        )
      }
      return {
        ...entry,
        replies,
        reply: replies.at(-1)!,
        agent_acknowledgement_required:
          response?.agent_acknowledgement_required ??
          entry.agent_acknowledgement_required,
      }
    })
    if (answered.length > 0) {
      stageAcceptedAnswers(
        ctx,
        sessionId,
        lateAnswers,
        0,
      )
      for (const answer of lateAnswers) reportAnswer(ctx, notes, answer, true)
    }
    if (transientTrouble) {
      notes.push('could not check every pending question for a late answer before the prompt')
    }
    const permanentFailure = permanentReplyFailureNote(permanentFailures)
    if (permanentFailure !== null) notes.push(permanentFailure)
  }
  // Park before dropping `pending`. If the process dies between these writes,
  // the next hook sees both copies and dedupes them; the old order could die in
  // the gap after erasing the only request/collapse/device identifiers.
  updateSessionState(sessionId, ctx.env, (current) => {
    const retiring = [...(current.retiring ?? [])]
    const unasked = pendingList(current).filter((entry) => entry.request_id === undefined)
    for (const entry of pendingList(current).filter((entry) => entry.request_id !== undefined)) {
      const retirement = retiringQuestion(entry, 'answered_elsewhere')
      if (
        retirement !== null &&
        !retiring.some((parked) => parked.request_id === retirement.request_id)
      ) {
        retiring.push(retirement)
      }
    }
    return {
      last_prompt_at: ctx.now(),
      ...(current.last_stop_at === undefined ? {} : { last_stop_at: current.last_stop_at }),
      ...(unasked.length > 0 ? { pending: unasked } : {}),
      ...(retiring.length > 0 ? { retiring } : {}),
      ...(current.accepted === undefined ? {} : { accepted: current.accepted }),
      // The user typed, so whatever chain of answer-driven continuations was
      // running, a human has taken the turn and the consecutive count starts
      // over. Only a real prompt reaches here: the journal branch above returns
      // first, and a wake route's injected message always arrives while its own
      // answer is still journaled, so it can never pass for the user's presence.
      ...(current.continuation === undefined
        ? {}
        : { continuation: { ...current.continuation, count: 0 } }),
    }
  })
  // The bridge that lets a plain `notifai ask` find the hook's canonical
  // session: an agent shell command gets no hook payload, and not every
  // harness exports an id in the same shape.
  if (envelope.cwd !== undefined && ctx.harness !== undefined) {
    writeProjectSession(envelope.cwd, ctx.env, sessionId, ctx.now(), ctx.harness)
  }

  if (lateAnswers.length > 0) {
    // UserPromptSubmit has no later hook field proving its stdout reached the
    // model. Keep the journal and let the next Stop use its acknowledged
    // continuation channel instead of recreating the crash-before-stdout gap.
    notes.push('the late device answer will continue the agent at this turn’s Stop')
    return { notes }
  }
  const retired = await drainRetirements(ctx, sessionId, ctx.env)
  const orphaned = await drainOrphanRetirements(ctx, ctx.env, ctx.now())
  const swept = [...retired, ...orphaned]
  if (swept.length > 0) {
    notes.push(`retired question${swept.length > 1 ? 's' : ''} ${swept.join(', ')}`)
  }
  return { notes }
}

// ---------------------------------------------------------------------------
// Stop — the turn ended; escalate a registered question
// ---------------------------------------------------------------------------

/**
 * Only engages for a question the agent explicitly registered with
 * `notifai ask`. Guessing from the last assistant message was the alternative
 * and it is not worth it: a false positive here hijacks the terminal.
 */
export async function handleStop(
  ctx: HookContext,
  envelope: HookEnvelope,
  processDeadlineAt = ctx.now() + WAITER_CEILING_SECONDS * 1000,
  route: EscalationDeliveryRoute = hookContinuationRoute(),
): Promise<HookOutcome> {
  const sessionId = envelope.session_id
  if (!sessionId) {
    gate(ctx, 'held', 'no-session', { stage: 'queued' })
    return { notes: [] }
  }
  return runEscalationWaiter(ctx, {
    sessionId,
    envelope,
    route,
    processDeadlineAt,
  })
}

/**
 * Own one registered question pipeline from its terminal-first timer through
 * its final delivery or retirement. Hosts differ only in the injected route.
 */
export async function runEscalationWaiter(
  ctx: HookContext,
  options: EscalationWaiterOptions,
): Promise<HookOutcome> {
  const notes: string[] = []
  const { sessionId, envelope } = options
  const hardDeadlineAt =
    options.processDeadlineAt ?? ctx.now() + WAITER_CEILING_SECONDS * 1000

  // This event marker is diagnostic evidence in its own right. Record it
  // before every early return so doctor can distinguish a working Stop route
  // from the prompt-only state that previously looked healthy.
  updateSessionState(sessionId, ctx.env, (current) => ({
    ...current,
    last_stop_at: ctx.now(),
  }))

  // The waiter, not its host, owns this lease. It spans grace, submission,
  // polling, close fencing, route delivery, and every retirement path.
  // Real clock, deliberately, not `ctx.now` — the claim answers whether
  // another process is alive right now, which an injected clock cannot know.
  if (!claimQuestionPush(sessionId, ctx.env)) {
    gate(ctx, 'held', 'claimed-elsewhere', { stage: 'queued' })
    notes.push('another hook is already handling this question')
    return { notes }
  }
  let settledAnswerThisPass = false
  try {
    let state = readSessionState(sessionId, ctx.env)
    if (state.accepted !== undefined) {
      const accepted = state.accepted
      if (envelope.stop_hook_active === true && pendingList(state).length > 0) {
        const due = await reconcileAcknowledgementObligations(
          ctx,
          sessionId,
          state.acknowledgement_due ?? [],
        )
        if (due.length > 0) {
          gate(ctx, 'held', 'acknowledgement-required', {
            request_ids: due.map((entry) => entry.request_id),
          })
          return {
            stdout: stopAnswerOutput(acknowledgementBlockContext(due)),
            notes,
            log: {
              stage: 'acknowledgement-required',
              request_ids: due.map((entry) => entry.request_id),
            },
          }
        }
        state = readSessionState(sessionId, ctx.env)
      }
      // Acknowledgement is per route, because routes end in different places.
      //
      // A blocking continuation ends at this process's stdout, which the
      // harness reads only after the process exits: the recursive Stop's
      // `stop_hook_active` is the acknowledgement, and persisting a separate
      // "offered" bit before stdout would recreate the crash gap this journal
      // exists to close. An out-of-band route ends at a write this process made
      // itself and recorded here. A socket write is not proof the model acted
      // on the answer — delivery is not consumption — but nothing later can
      // prove more, and an answer redelivered without end is strictly worse
      // than one settled on delivery. So a recorded delivery settles.
      const deliveryProven =
        accepted.delivered_at !== undefined || envelope.stop_hook_active === true
      if (!deliveryProven) {
        for (const answer of accepted.answers) reportAnswer(ctx, notes, answer, true)
        return await deliverAcceptedAnswers(ctx, sessionId, options.route, accepted, notes)
      }
      settleAcceptedAnswers(ctx, sessionId, accepted)
      settledAnswerThisPass = true
      state = readSessionState(sessionId, ctx.env)
      const currentAcceptedIds = new Set(
        accepted.answers.flatMap(({ pending }) =>
          pending.request_id === undefined ? [] : [pending.request_id],
        ),
      )
      const due = await reconcileAcknowledgementObligations(
        ctx,
        sessionId,
        (state.acknowledgement_due ?? []).filter((entry) =>
          currentAcceptedIds.has(entry.request_id),
        ),
      )
      if (due.length > 0) {
        gate(ctx, 'held', 'acknowledgement-required', {
          request_ids: due.map((entry) => entry.request_id),
        })
        return {
          stdout: stopAnswerOutput(acknowledgementBlockContext(due)),
          notes,
          log: {
            stage: 'acknowledgement-required',
            request_ids: due.map((entry) => entry.request_id),
          },
        }
      }
      state = readSessionState(sessionId, ctx.env)
    }

    if (state.accepted === undefined && (state.acknowledgement_due?.length ?? 0) > 0) {
      const due = await reconcileAcknowledgementObligations(
        ctx,
        sessionId,
        state.acknowledgement_due!,
      )
      if (due.length > 0) {
        gate(ctx, 'held', 'acknowledgement-required', {
          request_ids: due.map((entry) => entry.request_id),
        })
        return {
          stdout: stopAnswerOutput(acknowledgementBlockContext(due)),
          notes,
          log: {
            stage: 'acknowledgement-required',
            request_ids: due.map((entry) => entry.request_id),
          },
        }
      }
      state = readSessionState(sessionId, ctx.env)
    }

    const pending = pendingList(state)
    if (pending.length === 0) {
      const swept = [
        ...(await drainRetirements(ctx, sessionId, ctx.env)),
        ...(await drainOrphanRetirements(ctx, ctx.env, ctx.now())),
      ]
      if (swept.length > 0) {
        notes.push(`retired question${swept.length > 1 ? 's' : ''} ${swept.join(', ')}`)
      }
      gate(ctx, 'held', 'no-question', { stage: 'queued' })
      return { notes }
    }

    return await handleClaimedStop(
      ctx,
      envelope,
      sessionId,
      state,
      pending,
      notes,
      hardDeadlineAt,
      options.route,
      // Every route's successor turn-end, named the same way: the harness flag
      // for a blocking continuation, and the settle above for a route that woke
      // a brand-new turn out of band.
      envelope.stop_hook_active === true || settledAnswerThisPass,
    )
  } finally {
    releaseQuestionPush(sessionId, ctx.env)
  }
}

/**
 * The blocking Stop hook's own last meter: the answer becomes this process's
 * stdout, and the harness admits it as a new user turn. Exported because a
 * host adapter that has other routes still falls back to this one.
 */
export function hookContinuationRoute(): EscalationDeliveryRoute {
  return {
    kind: 'hook-continuation',
    deliver: async (event) => ({
      stdout: stopAnswerOutput(event.context),
      notes: [],
      // The harness reads this stdout after the process exits, so only the
      // successor Stop can acknowledge it.
      acknowledgement: 'stdout',
    }),
  }
}

/**
 * Hand one accepted answer to a route and record what the attempt proved.
 *
 * Every delivery on every route passes through here, which is what makes the
 * cap below a backstop rather than a suggestion. A guard only one route
 * consults is not a backstop: that is how a single answer once reached a
 * session 250 times.
 */
async function deliverAcceptedAnswers(
  ctx: HookContext,
  sessionId: string,
  route: EscalationDeliveryRoute,
  accepted: AcceptedAnswerDelivery,
  notes: string[],
): Promise<HookOutcome> {
  const { answers: answered, remaining } = accepted
  const requestIds = summarizeRequestIds(answered.map((entry) => entry.pending)).ids
  const attempt = (accepted.delivery_attempts ?? 0) + 1
  if (attempt > MAX_CONTINUATION_COUNT) {
    gate(ctx, 'held', 'delivery-limit', {
      route: route.kind,
      attempts: accepted.delivery_attempts ?? 0,
      limit: MAX_CONTINUATION_COUNT,
      request_ids: requestIds,
    })
    // Settle rather than journal for ever. The answer has been offered as often
    // as any working route could need, it is already in the notes of each of
    // those turns, and the questions it answered still deserve retirement.
    settleAcceptedAnswers(ctx, sessionId, accepted)
    notes.push(
      `the user's answer reached the ${route.kind} route ${MAX_CONTINUATION_COUNT} times without being acknowledged; not delivering it again`,
    )
    return { notes }
  }
  // Count the attempt before making it: an attempt that dies mid-delivery still
  // happened, and a counter written afterwards could be evaded by crashing.
  amendAcceptedAnswers(ctx, sessionId, (current) => ({
    ...current,
    delivery_attempts: attempt,
  }))
  ctx.log?.info('hook.gate', {
    verdict: 'proceeding',
    reason: 'answered',
    stage: 'routed',
    route: route.kind,
    answers: answered.length,
    request_ids: requestIds,
    journal_recorded_at: accepted.recorded_at,
    delivery_attempt: attempt,
  })
  const delivered = await route.deliver({
    context: answersContext(answered, remaining),
    answers: answered.length,
    remaining,
    request_ids: requestIds,
    journal_recorded_at: accepted.recorded_at,
  })
  const deliveredRoute =
    typeof delivered.log?.['route'] === 'string' ? delivered.log['route'] : route.kind
  const deliveredStage =
    typeof delivered.log?.['stage'] === 'string' ? delivered.log['stage'] : 'delivered'
  if (delivered.acknowledgement === 'delivered') {
    amendAcceptedAnswers(ctx, sessionId, (current) => ({
      ...current,
      delivered_at: ctx.now(),
      delivered_route: deliveredRoute,
    }))
  }
  ctx.log?.info('hook.answer', {
    answered: true,
    stage: deliveredStage,
    route: deliveredRoute,
    acknowledgement: delivered.acknowledgement,
    delivery_attempt: attempt,
    request_ids: requestIds,
    answers: answered.length,
    journal_recorded_at: accepted.recorded_at,
    ...(delivered.log?.['reason'] === undefined ? {} : { reason: delivered.log['reason'] }),
  })
  const outcome: HookOutcome = { notes: [...notes, ...(delivered.notes ?? [])] }
  if (delivered.stdout !== undefined) outcome.stdout = delivered.stdout
  if (delivered.log !== undefined) outcome.log = delivered.log
  return outcome
}

/** The complete per-session Stop decision, after this process owns the claim. */
async function handleClaimedStop(
  ctx: HookContext,
  envelope: HookEnvelope,
  sessionId: string,
  state: SessionState,
  pending: PendingQuestion[],
  notes: string[],
  hardDeadlineAt: number,
  route: EscalationDeliveryRoute,
  continuingFromAnswer: boolean,
): Promise<HookOutcome> {
  const live = pending.filter((entry) => entry.request_id !== undefined)
  const unasked = pending.filter((entry) => entry.request_id === undefined)
  let liveToEscalate = live

  if (
    ctx.harness !== undefined &&
    HARNESS_CAPABILITIES[ctx.harness].stopContinuation === 'unsupported'
  ) {
    for (const entry of live) await closeQuietly(ctx, entry.request_id!)
    await retirePendings(ctx, envelope, sessionId, pending, 'expired')
    gate(ctx, 'held', 'no-question')
    notes.push(`${HARNESS_CAPABILITIES[ctx.harness].deliveryContract}; use a blocking \`notifai send --reply\` question`)
    return { notes }
  }

  if (live.length > 0) {
    const { answered, permanentFailures } = await pollPendingReplies(
      ctx,
      live,
      LATE_STOP_POLL_SECONDS,
    )
    const permanentFailure = permanentReplyFailureNote(permanentFailures)
    if (permanentFailure !== null) notes.push(permanentFailure)
    const permanentlyRejected = live.filter((entry) =>
      permanentFailures.has(entry.request_id!),
    )
    await Promise.all(permanentlyRejected.map((entry) => closeQuietly(ctx, entry.request_id!)))
    if (permanentlyRejected.length > 0) {
      await retirePendings(ctx, envelope, sessionId, permanentlyRejected, 'expired')
    }
    if (answered.length > 0) {
      const finalized = await finalizePendings(
        ctx,
        answered.map((entry) => entry.pending),
      )
      const authoritative = answered.map((entry) => {
        const response = finalized.find((candidate) =>
          isSamePending(candidate.pending, entry.pending),
        )?.response
        const replies = response?.replies.length ? response.replies : entry.replies
        if (response === null) {
          notes.push(
            `could not confirm the close fence for ${entry.pending.request_id}; delivering the durable answer already observed`,
          )
        }
        return {
        ...entry,
        replies,
        reply: replies.at(-1)!,
        agent_acknowledgement_required:
          response?.agent_acknowledgement_required ??
          entry.agent_acknowledgement_required,
      }
      })
      const accepted = stageAcceptedAnswers(
        ctx,
        sessionId,
        authoritative,
        pending.length - authoritative.length - permanentlyRejected.length,
      )
      for (const answer of authoritative) reportAnswer(ctx, notes, answer, true)
      // Anything still unasked rides the next Stop: the agent is being resumed
      // with answers right now, and may not even need the rest afterwards.
      return deliverAcceptedAnswers(ctx, sessionId, route, accepted, notes)
    }
    const recoverableLive = live.filter(
      (entry) => !permanentFailures.has(entry.request_id!),
    )
    liveToEscalate = recoverableLive
    if (unasked.length === 0) {
      if (recoverableLive.length === 0) return { notes }
      // A previous answer may have resumed the model while independent
      // questions remain. The next Stop is their successor owner: keep waiting
      // to the original absolute deadline instead of polling for four seconds
      // and abandoning them.
      return await escalate(
        ctx,
        envelope,
        sessionId,
        [],
        recoverableLive,
        notes,
        hardDeadlineAt,
        route,
      )
    }
    // Questions registered after the earlier push still owe the user their
    // notification; fall through and escalate just those.
  }

  // A Stop answer may immediately produce a legitimate follow-up question.
  // Allow that new generation, but never re-run an old pending question and
  // never let answer continuations become an unbounded agent loop.
  if (envelope.stop_hook_active === true) {
    const continuation = state.continuation
    const isNew =
      continuation !== undefined &&
      unasked.some(
        (entry) => entry.asked_at !== undefined && entry.asked_at > continuation.answered_at,
      )
    if (!isNew) {
      gate(ctx, 'held', 'continuation-repeat')
      notes.push('already continuing from an answer; not asking again this turn')
      return { notes }
    }
  }
  // The cap is deliberately not keyed to `stop_hook_active`. That flag names one
  // route's continuation; a route that wakes a brand-new turn never sets it, and
  // a limit only one route consults bounds only that route. `continuingFromAnswer`
  // is the same event named for every route, so the chain of answer → follow-up
  // question → answer is bounded whatever delivered it.
  if (
    continuingFromAnswer &&
    state.continuation !== undefined &&
    state.continuation.count >= MAX_CONTINUATION_COUNT
  ) {
    gate(ctx, 'held', 'continuation-limit', {
      count: state.continuation.count,
      limit: MAX_CONTINUATION_COUNT,
      route: route.kind,
    })
    notes.push(
      `answer continuation limit (${MAX_CONTINUATION_COUNT}) reached; leaving the question in the terminal`,
    )
    return { notes }
  }
  // Silent to the user by design — they switched routing off, so saying so on
  // every turn would be nagging about their own setting. That silence is also
  // why it belongs in the log: from outside, "ask_notifications = false" and "a
  // bug ate my question" look exactly the same.
  if (!ctx.config.ask_notifications.value) {
    gate(ctx, 'held', 'notifications-off', { source: ctx.config.ask_notifications.source })
    return { notes }
  }
  gate(ctx, 'proceeding', 'proceeding', {
    unasked: unasked.length,
    already_live: liveToEscalate.length,
    grace_seconds: ctx.config.ask_grace_seconds.value,
  })
  return await escalate(
    ctx,
    envelope,
    sessionId,
    unasked,
    liveToEscalate,
    notes,
    hardDeadlineAt,
    route,
  )
}

/** The escalation itself, split out so the claim is released on every path. */
async function escalate(
  ctx: HookContext,
  envelope: HookEnvelope,
  sessionId: string,
  unasked: PendingQuestion[],
  alreadyLive: PendingQuestion[],
  notes: string[],
  hardDeadlineAt: number,
  route: EscalationDeliveryRoute,
): Promise<HookOutcome> {
  // The questions still owe the user their terminal-first window before
  // anything reaches their devices — measured from the oldest registration,
  // because that is the question that has waited longest.
  const startedAt = ctx.now()
  const existingDeadlines = alreadyLive.flatMap((entry) =>
    entry.reply_deadline_at === undefined || entry.reply_deadline_at <= startedAt
      ? []
      : [entry.reply_deadline_at],
  )
  const ceilingAt = Math.min(
    hardDeadlineAt,
    ...(existingDeadlines.length === 0 ? [] : existingDeadlines),
  )
  if (unasked.length > 0 && alreadyLive.length === 0) {
    const oldest = Math.min(...unasked.map((entry) => entry.asked_at ?? ctx.now()))
    await awaitTerminalFirstWindow(ctx, oldest, ceilingAt)
    ctx.log?.debug('hook.gate', {
      verdict: 'grace',
      reason: 'elapsed',
      waited_from: oldest,
      grace_seconds: ctx.config.ask_grace_seconds.value,
    })
  }
  // Phase one: every registered question reaches the user's devices, each as
  // its own notification — one ask never stands in for another.
  const submitted: PendingQuestion[] = []
  for (const entry of unasked) {
    // The reply window is the question's own: whatever is left of the waiter's
    // ceiling, granted to the server so it stops accepting answers at the same
    // moment this owner stops listening for them.
    const replyWindowSeconds = Math.floor((ceilingAt - ctx.now()) / 1000)
    if (replyWindowSeconds < MIN_REPLY_WINDOW_SECONDS) {
      notes.push(
        'too little of the waiter ceiling is left for a reply window the server would accept; leaving this question in the terminal',
      )
      continue
    }
    const ownerDeadlineAt = ceilingAt
    const questions = pendingQuestions(entry)
    let intent = entry.submission
    if (intent === undefined) {
      if (entry.body === undefined) {
        notes.push('registered question has no canonical body; register it again with this CLI')
        continue
      }
      const prepared = await prepareQuestionSubmission(ctx, {
        // Type and Project have their own fields; the title is only substance.
        title: questions[0]!.text,
        body: entry.body,
        questions,
        ...(entry.media !== undefined ? { media: entry.media } : {}),
        ...(entry.project !== undefined ? { project: entry.project } : {}),
        ...(entry.source !== undefined ? { source: entry.source } : {}),
        event: 'agent_question',
        windowSeconds: replyWindowSeconds,
        ownerDeadlineAt,
      })
      if ('error' in prepared) {
        ctx.log?.error('hook.pushed', { ok: false, message: prepared.error })
        notes.push(prepared.error)
        continue
      }
      intent = prepared
      // Durable before submit. If the server commits and the response is lost,
      // the reserved request id still lets this owner poll and finalize the
      // exact card; a successor can also replay the frozen draft/key.
      updateSessionState(sessionId, ctx.env, (current) => {
        const list = pendingList(current)
        const index = list.findIndex((candidate) => isSamePending(candidate, entry))
        if (index < 0) return current
        const next = [...list]
        next[index] = { ...next[index]!, submission: prepared }
        return { ...current, pending: next }
      })
    } else if (intent.owner_deadline_at <= ctx.now()) {
      // The frozen wire identity survives a crashed owner, but its local owner
      // lease does not. Re-arm only the local deadline; request id, key,
      // targets, and draft remain byte-identical for idempotent replay.
      intent = { ...intent, owner_deadline_at: ceilingAt }
      const rearmed = intent
      updateSessionState(sessionId, ctx.env, (current) => {
        const list = pendingList(current)
        const index = list.findIndex((candidate) => isSamePending(candidate, entry))
        if (index < 0) return current
        const next = [...list]
        next[index] = { ...next[index]!, submission: rearmed }
        return { ...current, pending: next }
      })
    }
    if (ctx.now() >= intent.owner_deadline_at) {
      notes.push('the waiter ceiling ended before submission; preserving the frozen intent')
      continue
    }
    const beforeSubmitSeconds = Math.floor((intent.owner_deadline_at - ctx.now()) / 1000)
    if (beforeSubmitSeconds < MIN_REPLY_WINDOW_SECONDS) {
      notes.push(
        'device resolution consumed the reply window; preserving the frozen intent instead of shrinking it below what the server accepts',
      )
      continue
    }
    let receipt: SubmissionReceipt | undefined
    let admissionConfirmed = false
    try {
      receipt = await submitQuestion(ctx, intent)
      admissionConfirmed = true
    } catch (caught) {
      let err: unknown = caught
      if (err instanceof ApiCallError && isTerminalDraftRejection(err)) {
        ctx.log?.error('hook.pushed', {
          ok: false,
          request_id: intent.request_id,
          status: err.status,
          code: err.code,
          message: err.message,
        })
        if (entry.submission !== undefined) {
          notes.push(
            `question submission was rejected (${err.code}, HTTP ${err.status}); reminting the draft in the current contract instead of replaying the frozen one`,
          )
          clearFrozenSubmission(sessionId, ctx.env, entry)
          if (entry.body === undefined) {
            dropPendingQuestion(sessionId, ctx.env, entry)
            notes.push('registered question has no canonical body; retired the frozen draft instead of retrying it')
            continue
          }
          const reminted = await prepareQuestionSubmission(ctx, {
            title: questions[0]!.text,
            body: entry.body,
            questions,
            ...(entry.media !== undefined ? { media: entry.media } : {}),
            ...(entry.project !== undefined ? { project: entry.project } : {}),
            ...(entry.source !== undefined ? { source: entry.source } : {}),
            event: 'agent_question',
            windowSeconds: replyWindowSeconds,
            ownerDeadlineAt,
          })
          if ('error' in reminted) {
            dropPendingQuestion(sessionId, ctx.env, entry)
            notes.push(reminted.error)
            continue
          }
          intent = reminted
          updateSessionState(sessionId, ctx.env, (current) => {
            const list = pendingList(current)
            const index = list.findIndex((candidate) => isSamePending(candidate, entry))
            if (index < 0) return current
            const next = [...list]
            next[index] = { ...next[index]!, submission: reminted }
            return { ...current, pending: next }
          })
          try {
            receipt = await submitQuestion(ctx, intent)
            admissionConfirmed = true
          } catch (retryErr) {
            if (retryErr instanceof ApiCallError && isTerminalDraftRejection(retryErr)) {
              dropPendingQuestion(sessionId, ctx.env, entry)
              notes.push(
                `reminted draft was also rejected (${retryErr.code}, HTTP ${retryErr.status}); retiring the question so it is not retried forever`,
              )
              ctx.log?.error('hook.pushed', {
                ok: false,
                request_id: intent.request_id,
                status: retryErr.status,
                code: retryErr.code,
                message: retryErr.message,
              })
              continue
            }
            err = retryErr
          }
        } else {
          dropPendingQuestion(sessionId, ctx.env, entry)
          notes.push(
            `question submission was rejected (${err.code}, HTTP ${err.status}); retiring it because the current draft will never be accepted`,
          )
          continue
        }
      }
      if (!admissionConfirmed && err instanceof ApiCallError && err.status < 500 && err.status !== 408) {
        notes.push(
          `question submission was rejected (${err.code}, HTTP ${err.status}); preserving it for recovery`,
        )
        ctx.log?.error('hook.pushed', {
          ok: false,
          request_id: intent.request_id,
          status: err.status,
          code: err.code,
          message: err.message,
        })
        continue
      }
      if (!admissionConfirmed) {
        notes.push(`question submission response was ambiguous; recovering ${intent.request_id}`)
        ctx.log?.error('hook.pushed', { ok: false, request_id: intent.request_id, message: String(err) })
      }
    }
    if (admissionConfirmed) {
      ctx.log?.info('hook.pushed', {
        ok: true,
        request_id: intent.request_id,
        devices: intent.device_ids.length,
        questions: questions.length,
        text: questions[0]!.text,
      })
    }
    const committedReplyDeadline =
      receipt?.reply_expires_at === null || receipt?.reply_expires_at === undefined
        ? intent.owner_deadline_at
        : Date.parse(receipt.reply_expires_at)
    const live: PendingQuestion = {
      ...entry,
      request_id: intent.request_id,
      collapse_key: intent.collapse_key,
      device_ids: intent.device_ids,
      // Submission and every later poll share one wall-clock owner. The
      // server may start its relative window a little later while the submit
      // response is in flight; closing at this deadline is therefore the
      // authoritative backstop against accepting an answer into a void.
      reply_deadline_at: Math.min(
        intent.owner_deadline_at,
        Number.isFinite(committedReplyDeadline)
          ? committedReplyDeadline
          : intent.owner_deadline_at,
      ),
    }
    delete live.submission
    submitted.push(live)
    // Record what is now live on the user's devices BEFORE any wait. If we
    // only learned these ids afterwards, a question that timed out would
    // leave no trace, and the user returning to the terminal could never
    // retire it — the notification would stay answerable for an hour with
    // nobody listening.
    if (admissionConfirmed) {
      updateSessionState(sessionId, ctx.env, (current) => {
        const list = pendingList(current)
        const index = list.findIndex(
          (candidate) => isSamePending(candidate, entry) && candidate.request_id === undefined,
        )
        if (index >= 0) {
          const next = [...list]
          next[index] = live
          return { ...current, pending: next }
        }
        // The entry vanished while the submit was in flight (the user's prompt
        // wiped the queue). The delivered notification must still be retirable,
        // so park it rather than lose its only identifiers.
        const retirement = retiringQuestion(live, 'answered_elsewhere')!
        const retiring = [...(current.retiring ?? [])]
        if (!retiring.some((parked) => parked.request_id === retirement.request_id)) {
          retiring.push(retirement)
        }
        return { ...current, retiring }
      })
    }
  }

  const staleLive = alreadyLive.filter(
    (entry) =>
      entry.reply_deadline_at === undefined || entry.reply_deadline_at <= ctx.now(),
  )
  const finalizedStale = await finalizePendings(ctx, staleLive)
  const staleAnswers = finalizedStale
    .map(finalizedAnswer)
    .filter((entry): entry is AnsweredPending => entry !== null)
  const staleSilence = finalizedStale
    .filter((entry) => entry.response !== null && entry.response.replies.length === 0)
    .map((entry) => entry.pending)
  const staleUnproven = finalizedStale.filter((entry) => entry.response === null)
  if (staleSilence.length > 0) {
    await retirePendings(ctx, envelope, sessionId, staleSilence, 'expired')
    notes.push(
      `expired ${staleSilence.length} question${staleSilence.length === 1 ? '' : 's'} whose continuation owner had ended`,
    )
  }
  if (staleUnproven.length > 0) {
    notes.push(
      `could not finalize ${staleUnproven.length} expired question${staleUnproven.length === 1 ? '' : 's'}; preserving ownership for recovery`,
    )
  }
  if (staleAnswers.length > 0) {
    const remaining = Math.max(
      0,
      pendingList(readSessionState(sessionId, ctx.env)).length - staleAnswers.length,
    )
    const accepted = stageAcceptedAnswers(ctx, sessionId, staleAnswers, remaining)
    for (const answer of staleAnswers) reportAnswer(ctx, notes, answer, true)
    return deliverAcceptedAnswers(ctx, sessionId, route, accepted, notes)
  }
  const waitingOn = [
    ...alreadyLive.filter(
      (entry) => entry.reply_deadline_at !== undefined && entry.reply_deadline_at > ctx.now(),
    ),
    ...submitted,
  ]
  if (waitingOn.length === 0) return { notes }

  // Phase two: one wait across everything live, old and new alike.
  const ownerDeadline = Math.min(
    ceilingAt,
    Math.max(...waitingOn.map((entry) => entry.reply_deadline_at!)),
  )
  const timeoutSeconds = Math.max(0, Math.ceil((ownerDeadline - ctx.now()) / 1000))
  const waited = await waitForAnyReply(
    ctx,
    waitingOn.map((entry) => entry.request_id!),
    timeoutSeconds,
  )
  const permanentFailure = permanentReplyFailureNote(waited.permanentFailures)
  if (permanentFailure !== null) notes.push(permanentFailure)

  if (waited.byRequest.size === 0) {
    // Once this owner returns, no shipped command-hook harness can guarantee
    // a later answer reaches the same agent turn. Close first, then retire the
    // local records, so the Companion never accepts an answer into a void.
    const finalized = await finalizePendings(ctx, waitingOn)
    const finalAnswers = finalized
      .map(finalizedAnswer)
      .filter((entry): entry is AnsweredPending => entry !== null)
    const confirmedSilent = finalized
      .filter((entry) => entry.response !== null && entry.response.replies.length === 0)
      .map((entry) => entry.pending)
    const unproven = finalized.filter((entry) => entry.response === null)
    if (confirmedSilent.length > 0) {
      await retirePendings(ctx, envelope, sessionId, confirmedSilent, 'expired')
    }
    if (unproven.length > 0) {
      notes.push(
        `could not finalize ${unproven.length} question${unproven.length === 1 ? '' : 's'}; preserving ownership rather than risking a lost late answer`,
      )
    }
    if (finalAnswers.length > 0) {
      const remaining = Math.max(
        0,
        pendingList(readSessionState(sessionId, ctx.env)).length - finalAnswers.length,
      )
      const accepted = stageAcceptedAnswers(ctx, sessionId, finalAnswers, remaining)
      for (const answer of finalAnswers) reportAnswer(ctx, notes, answer, false)
      return deliverAcceptedAnswers(ctx, sessionId, route, accepted, notes)
    }
    const requestIdSummary = summarizeRequestIds(waitingOn)
    ctx.log?.info('hook.answer', {
      answered: false,
      stage: 'queued',
      request_ids: requestIdSummary.ids,
      degraded: waited.degraded,
      permanent_failures: waited.permanentFailures.size,
      waited_seconds: timeoutSeconds,
    })
    if (waited.permanentFailures.size === 0) {
      notes.push(
        waited.degraded
          ? 'could not reach the server before the owner deadline; the question was retired so no answer can be lost later'
          : 'no answer in time; the question expired with its continuation owner',
      )
    }
    return { notes }
  }

  const polledAnswered = waitingOn.filter((entry) => waited.byRequest.has(entry.request_id!))
  const finalizedAnswered = await finalizePendings(ctx, polledAnswered)
  const answered: AnsweredPending[] = []
  for (const finalized of finalizedAnswered) {
    const entry = finalized.pending
    const replies = waited.byRequest.get(entry.request_id!)
    if (replies === undefined) continue
    // The fenced set wins because it includes corrections that committed
    // while close was waiting for earlier writers. If finalization itself was
    // unreachable, never discard the durable reply already observed.
    const finalReplies = finalized.response?.replies ?? []
    const authoritative = finalReplies.length > 0 ? finalReplies : replies
    answered.push({
      pending: entry,
      reply: authoritative.at(-1)!,
      replies: authoritative,
      agent_acknowledgement_required:
        finalized.response?.agent_acknowledgement_required,
    })
    if (finalized.response === null) {
      notes.push(
        `could not confirm the close fence for ${entry.request_id}; delivering the durable answer already observed`,
      )
    }
  }
  const accepted = stageAcceptedAnswers(
    ctx,
    sessionId,
    answered,
    waitingOn.length - answered.length,
  )
  for (const answer of answered) reportAnswer(ctx, notes, answer, false)
  return deliverAcceptedAnswers(ctx, sessionId, route, accepted, notes)
}

// ---------------------------------------------------------------------------
// SessionEnd — local cleanup only
// ---------------------------------------------------------------------------

/**
 * Claude Code gives SessionEnd hooks a 1.5-second shared budget and Codex 1
 * second, so this cannot make a network call. It drops the local marker — but
 * first moves anything still live on the user's devices into the global
 * retirement queue, because this file was the only record of those ids and no
 * hook for this session will ever run again. A question whose
 * agent just exited can receive no answer, so it is orphaned as `expired`.
 */
export function handleSessionEnd(
  env: NodeJS.ProcessEnv,
  envelope: HookEnvelope,
  now: number = Date.now(),
): HookOutcome {
  const notes: string[] = []
  const sessionId = envelope.session_id
  if (!sessionId) return { notes, log: { outcome: 'ignored', reason: 'missing-session-id' } }
  if (envelope.cwd !== undefined) clearMatchingProjectSession(envelope.cwd, env, sessionId)

  const state = readSessionState(sessionId, env)
  const orphans: RetiringQuestion[] = [...(state.retiring ?? [])]
  for (const entry of pendingList(state)) {
    try {
      const orphan = retiringQuestion(entry, 'expired')
      if (orphan !== null) orphans.push(orphan)
    } catch (err) {
      notes.push(err instanceof Error ? err.message : String(err))
      // Preserve the only identifiers instead of turning an explicit corrupt
      // state into an unretirable question during SessionEnd cleanup.
      return {
        notes,
        log: { outcome: 'preserved', reason: 'incomplete-question-identifiers' },
      }
    }
  }
  if (orphans.length > 0) {
    orphanRetirements(env, orphans, now)
    notes.push(
      `queued ${orphans.length} question${orphans.length > 1 ? 's' : ''} for retirement on the next hook`,
    )
  }
  if (state.accepted !== undefined || (state.acknowledgement_due?.length ?? 0) > 0) {
    const preserved: SessionState = {}
    if (state.accepted !== undefined) preserved.accepted = state.accepted
    if (state.acknowledgement_due !== undefined && state.acknowledgement_due.length > 0) {
      preserved.acknowledgement_due = state.acknowledgement_due
    }
    if (state.last_prompt_at !== undefined) preserved.last_prompt_at = state.last_prompt_at
    if (state.last_stop_at !== undefined) preserved.last_stop_at = state.last_stop_at
    if (state.continuation !== undefined) preserved.continuation = state.continuation
    writeSessionState(sessionId, env, preserved)
    notes.push(
      state.accepted !== undefined
        ? 'preserved an accepted device answer for this exact session to resume'
        : 'preserved required Agent Acknowledgement obligations for this exact session',
    )
    return {
      notes,
      log: {
        outcome: state.accepted !== undefined ? 'answer-preserved' : 'acknowledgement-preserved',
        queued_retirements: orphans.length,
        accepted_answers: state.accepted?.answers.length ?? 0,
        acknowledgement_due: state.acknowledgement_due?.length ?? 0,
      },
    }
  }
  clearSessionState(sessionId, env)
  return { notes, log: { outcome: 'cleaned', queued_retirements: orphans.length } }
}

// ---------------------------------------------------------------------------
// ask — register a question for the turn's end
// ---------------------------------------------------------------------------

/**
 * More pending questions than this means an agent is looping, not asking.
 * Related questions belong in one `ask --form` (the wire carries up to four
 * questions per notification); four separate pushes is already a lot of lock
 * screen.
 */
export const MAX_PENDING_QUESTIONS = 4

/**
 * A session may hold several registered questions at once: a new `ask` never
 * ends an earlier one. Each reaches the user as its own notification and is
 * answerable independently. Superseding is reply semantics — a later reply
 * corrects an earlier reply to the same question (that correction model lives
 * server-side) — never question semantics: the old single-slot model silently
 * discarded a question the moment a second was registered, and the user was
 * pointed at a notification that never existed (2026-08-09).
 *
 * The queue is keyed on the session, not the project: several agents may be
 * running in one project at once, and their questions must never interfere.
 */
export function registerQuestion(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  question: PendingQuestion,
  now: number = Date.now(),
): void {
  let full = false
  updateSessionState(sessionId, env, (state) => {
    const pending = pendingList(state)
    if (pending.length >= MAX_PENDING_QUESTIONS) {
      full = true
      return state
    }
    return {
      ...state,
      pending: [
        ...pending,
        {
          question_id: `q_${randomBytes(12).toString('base64url')}`,
          asked_at: now,
          ...question,
          question: question.question.slice(0, MAX_STORED_QUESTION_CHARS),
        },
      ],
    }
  })
  if (full) {
    throw new Error(
      `${MAX_PENDING_QUESTIONS} questions are already waiting to be asked. ` +
        'Combine related questions into one `notifai ask --form` instead of registering more.',
    )
  }
}

/** Parses hook JSON from stdin, tolerating an empty or malformed body. */
export function parseHookInput(raw: string): HookEnvelope {
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as HookEnvelope) : {}
  } catch {
    return {}
  }
}

export function resolveHookConfig(
  cwd: string,
  env: NodeJS.ProcessEnv,
  sessionId: string | undefined,
): CliConfig {
  return loadConfig({ cwd, env, sessionId })
}
