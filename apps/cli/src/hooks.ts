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
import type { LifecycleEndState, QuestionT, ReplyView } from '@raidiant/notifai-protocol'
import type { ApiClient } from './client.js'
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
import type { Logger } from './logging.js'

/**
 * Harness hook handlers.
 *
 * The supported harnesses expose the same useful lifecycle joints: a turn-end
 * event and an event that fires when the user submits a prompt. Claude Code,
 * Codex, and Cursor can continue directly from a turn-end answer. OpenCode
 * preserves the pending answer at turn end and injects it on the next prompt.
 * No question detection or context-window state is needed in either path.
 *
 * The load-bearing constraint is that these hooks are synchronous: while one
 * blocks, the harness cannot show its own prompt either. So a hook may only
 * take over when the user is demonstrably absent. Present user, or no evidence
 * either way, means exit immediately and let the terminal do its job.
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
  /** Tracks bounded Stop continuations so a follow-up ask is delivered once. */
  continuation?: {
    answered_at: number
    count: number
  }
}

/** A delivered question awaiting its retirement push. */
export interface RetiringQuestion {
  request_id: string
  collapse_key: string
  /** The Device Installations that actually received the question. */
  device_ids: string[]
  /** Shown if the companion has no history entry to correlate against. */
  question: string
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
  /** Label of the session that asked, so the retirement sync matches its badge. */
  session?: string
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
  /** Long-form markdown context, shown in the companion's detail view. */
  detail?: string
  /** Set once the question has actually been pushed, so it can be retired. */
  request_id?: string
  collapse_key?: string
  /** Exact fanout of the live question; routing config may change afterwards. */
  device_ids?: string[]
}

/** How often the grace window rechecks whether the user has come back. */
const GRACE_POLL_MS = 5_000

/**
 * Total seconds a Stop hook may spend blocking. Both harnesses kill a command
 * hook at 600s, and a killed hook loses an answer the user has already given,
 * so the grace window yields to the reply wait rather than the other way round.
 */
const STOP_BUDGET_SECONDS = 480

export type GraceOutcome =
  /** The window elapsed with the user still gone; escalate. */
  | 'absent'
  /** The user touched the machine; the terminal is theirs. */
  | 'user-returned'
  /** No idle source, so waiting would hold a terminal we cannot monitor. */
  | 'no-signal'

/**
 * The terminal-first wait: the question sits in the terminal for
 * `ask_grace_seconds` from when it was sent, and only then reaches companion
 * devices.
 *
 * Holding a blocking Stop hook open is normally hostile — while it blocks, the
 * harness cannot show its prompt either, so a user wanting to answer locally is
 * locked out. What makes it safe is that the wait is abandoned the moment the
 * user touches the keyboard or mouse. The block therefore only ever persists
 * while they are demonstrably not using the machine, which costs them nothing.
 *
 * That safety depends entirely on the idle signal, so with no idle source this
 * refuses to wait at all rather than holding a terminal it cannot monitor.
 *
 * With `require_idle` off the whole calculus changes: the user has said they
 * want the question to reach them whether or not they are at the keyboard, so
 * there is nothing to watch for and this becomes what its name always claimed —
 * a plain timer. It then works on machines with no idle source too.
 */
export async function awaitGrace(ctx: HookContext, askedAt: number): Promise<GraceOutcome> {
  const threshold = ctx.config.away_after_seconds.value
  // Never let the grace window eat the reply wait's share of the hook budget.
  const graceSeconds = Math.min(
    ctx.config.ask_grace_seconds.value,
    Math.max(0, STOP_BUDGET_SECONDS - ctx.config.hook_reply_timeout_seconds.value),
  )
  // `asked_at` is wall-clock too, and the same jumps apply: a stamp from the
  // future would wait far past the hook's budget, one from the distant past
  // would skip the terminal-first window the user asked for entirely. Anything
  // outside a plausible range restarts the window from now.
  const elapsed = ctx.now() - askedAt
  const start = elapsed >= 0 && elapsed <= MAX_PLAUSIBLE_SILENCE_MS ? askedAt : ctx.now()
  const deadline = start + graceSeconds * 1000

  for (;;) {
    if (ctx.config.require_idle.value) {
      const idle = ctx.idleSeconds()
      if (idle === null) return 'no-signal'
      if (idle < threshold) return 'user-returned'
    }
    if (ctx.now() >= deadline) return 'absent'
    await ctx.sleep(Math.min(GRACE_POLL_MS, Math.max(0, deadline - ctx.now())))
  }
}

export interface HookOutcome {
  /** Written to stdout verbatim — the harness parses this as the decision. */
  stdout?: string
  /** Diagnostics; harnesses surface hook stderr in the transcript. */
  notes: string[]
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
 * Serialize a short read-modify-write without ever exposing partial JSON.
 * A crashed holder is recoverable after 30 seconds; releases compare their
 * random token under the same cooperating lock discipline before unlinking.
 */
const FILE_LOCK_STALE_MS = 30_000
const FILE_LOCK_WAIT_MS = 1_000
const FILE_LOCK_POLL_MS = 5
const lockSleep = new Int32Array(new SharedArrayBuffer(4))

function withFileLock<T>(file: string, action: () => T): T {
  mkdirSync(path.dirname(file), { recursive: true })
  const token = randomBytes(12).toString('base64url')
  const deadline = Date.now() + FILE_LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = openSync(file, 'wx', 0o600)
      try {
        writeFileSync(handle, `${JSON.stringify({ token, at: Date.now() })}\n`)
      } finally {
        closeSync(handle)
      }
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      let stale = false
      try {
        const held = JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown }
        stale = typeof held.at !== 'number' || Date.now() - held.at >= FILE_LOCK_STALE_MS
      } catch {
        stale = true
      }
      if (stale) rmSync(file, { force: true })
      else if (Date.now() >= deadline) throw new Error(`timed out waiting for state lock ${file}`)
      else Atomics.wait(lockSleep, 0, 0, FILE_LOCK_POLL_MS)
    }
  }
  try {
    return action()
  } finally {
    try {
      const held = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown }
      if (held.token === token) rmSync(file, { force: true })
    } catch {
      // A replaced or externally removed lock is no longer ours to release.
    }
  }
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
 * unlinking its replacement. A claim older than the hook budget is a crashed
 * process rather than a live one and is broken, avoiding permanent suppression.
 */
const CLAIM_TTL_MS = STOP_BUDGET_SECONDS * 1000
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
        const held = JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown }
        const age = typeof held.at === 'number' ? now - held.at : Number.POSITIVE_INFINITY
        if (age >= 0 && age < CLAIM_TTL_MS) return false
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

/** Records which session is working in a directory, for `notifai ask`. */
export function writeProjectSession(
  cwd: string,
  env: NodeJS.ProcessEnv,
  sessionId: string,
  now: number,
  harness: HookHarness,
): void {
  const file = projectSessionPointerPath(cwd, env)
  withFileLock(`${file}.lock`, () => {
    atomicWriteFileSync(
      file,
      `${JSON.stringify({ session_id: sessionId, updated_at: now, harness })}\n`,
    )
  })
}

export interface ProjectSessionPointer {
  sessionId: string
  harness: HookHarness
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

export function readProjectSessionPointer(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: number,
  maxAgeMs = 24 * 3600 * 1000,
): ProjectSessionPointer | null {
  const file = projectSessionPointerPath(cwd, env)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      session_id?: unknown
      updated_at?: unknown
      harness?: unknown
    }
    if (typeof parsed.session_id !== 'string' || parsed.session_id === '') return null
    if (typeof parsed.updated_at !== 'number' || now - parsed.updated_at > maxAgeMs) return null
    if (!(HOOK_HARNESSES as readonly unknown[]).includes(parsed.harness)) return null
    // A pointer is routing evidence only while its session state still exists
    // and parses. SessionEnd and explicit cleanup therefore invalidate it even
    // when a crash prevented the pointer file itself from being removed.
    const sessionFile = sessionStatePath(parsed.session_id, env)
    if (!existsSync(sessionFile)) return null
    const state: unknown = JSON.parse(readFileSync(sessionFile, 'utf8'))
    if (typeof state !== 'object' || state === null || Array.isArray(state)) return null
    return { sessionId: parsed.session_id, harness: parsed.harness as HookHarness }
  } catch {
    return null
  }
}

const HOOK_HARNESSES = ['claude-code', 'codex', 'cursor', 'opencode'] as const

function clearMatchingProjectSession(
  cwd: string,
  env: NodeJS.ProcessEnv,
  sessionId: string,
): void {
  const file = projectSessionPointerPath(cwd, env)
  withFileLock(`${file}.lock`, () => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { session_id?: unknown }
      if (parsed.session_id === sessionId) rmSync(file, { force: true })
    } catch {
      // Missing/corrupt is already not a live pointer.
    }
  })
}

/**
 * Absent means the user is not at this machine's keyboard.
 *
 * OS idle time answers that directly, so where it exists it decides alone.
 * Silence since the user's last prompt is only ever a proxy for it, and a poor
 * one — it is wrong in both directions:
 *
 *   - Too long: it counts the agent's own turn, so a user watching a build was
 *     read as absent and had the question pushed at them.
 *   - Too short: a session that has just been spawned always has a fresh
 *     prompt, so its FIRST question could never escalate however long its
 *     owner had been gone. That is the "kick off some agents and
 *     walk away" case this feature mainly exists for, and requiring both
 *     signals to agree is what broke it.
 *
 * The proxy therefore survives only as the fallback for machines with no idle
 * source. There, never having seen a prompt is not evidence of absence — it is
 * a missing `UserPromptSubmit` hook — so it resolves to "present".
 *
 * Answering from a companion device does not make the user present; only touching this
 * machine does. Answering on a device is evidence of being away from it.
 *
 * All of which only matters if presence is being consulted at all. With
 * `require_idle` off the user has said their whereabouts are not a
 * precondition, so this stops guessing and answers yes.
 */
export function isUserAway(
  state: SessionState,
  config: CliConfig,
  now: number,
  idleSeconds: number | null,
): boolean {
  if (!config.require_idle.value) return true
  const threshold = config.away_after_seconds.value
  if (idleSeconds !== null) return idleSeconds >= threshold
  if (state.last_prompt_at === undefined) return false
  const silence = now - state.last_prompt_at
  // Both signs of a clock jump produce a wrong answer here, and the fallback
  // path has no monotonic reference to check against: a forward jump (NTP
  // correction, VM resume) hijacks a terminal whose user is sitting right
  // there, and a backward one suppresses escalation for someone genuinely
  // gone. Neither delta is evidence of anything, so it resolves the way every
  // other absence of evidence does — present.
  if (silence < 0 || silence > MAX_PLAUSIBLE_SILENCE_MS) return false
  return silence >= threshold * 1000
}

/**
 * Beyond this, silence says more about the clock or an abandoned session file
 * than about the user. Matches the project pointer's staleness horizon.
 */
const MAX_PLAUSIBLE_SILENCE_MS = 24 * 3600 * 1000

export interface HookContext {
  client: ApiClient
  config: CliConfig
  env: NodeJS.ProcessEnv
  now: () => number
  /** Seconds since the last keyboard/mouse event, or null if unknowable. */
  idleSeconds: () => number | null
  /** Injected so tests advance a virtual clock instead of sleeping. */
  sleep: (milliseconds: number) => Promise<void>
  /** Bounded wait for the first reply; injected so tests do not sleep. */
  waitForFirstReply: (
    requestId: string,
    timeoutSeconds: number,
  ) => Promise<{ replies: ReplyView[]; timedOut: boolean; degraded?: boolean }>
  /** OpenCode cannot consume Stop stdout, so its adapter must never wait there. */
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
  | 'notifications-off'
  | 'user-present'
  | 'claimed-elsewhere'
  | 'user-returned'
  | 'no-devices'
  | 'proceeding'

function gate(
  ctx: HookContext,
  verdict: 'held' | 'proceeding',
  reason: GateReason,
  data: Record<string, unknown> = {},
): void {
  ctx.log?.info('hook.gate', { verdict, reason, ...data })
}

export type HookHarness = 'claude-code' | 'codex' | 'cursor' | 'opencode'

interface SubmittedQuestion {
  requestId: string
  collapseKey: string
  /** The devices the question went to; retirement must not reach any other. */
  devices: string[]
}

/** Re-check local presence at this cadence while a pushed question is waiting. */
const REPLY_PRESENCE_POLL_SECONDS = 5

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
async function submitQuestion(
  ctx: HookContext,
  options: {
    title: string
    body: string
    questions: QuestionT[]
    detail?: string | undefined
    event: string
    /** Which agent is asking; two of them must not look alike. */
    session?: string | undefined
    /** How long the server keeps accepting an answer. */
    windowSeconds: number
  },
): Promise<SubmittedQuestion | { error: string }> {
  const collapseKey = `notifai-hook-${randomBytes(8).toString('base64url')}`
  // A draft carrying `reply` is rejected outright if it targets a device that
  // cannot answer, so resolve the healthy companion platforms explicitly.
  const answerable = await answerableDevices(ctx)
  if (answerable.length === 0) {
    return { error: 'no device can answer a question yet; leaving this to the terminal' }
  }
  const build = buildDraft(ctx.config, {
    title: options.title,
    body: options.body,
    event: options.event,
    lifecycle: { tier: 'needs_you' },
    ...(options.session !== undefined ? { session: options.session } : {}),
    device: answerable,
    reply: true,
    replyWindow: Math.max(60, options.windowSeconds),
    questions: options.questions,
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
    collapseKey,
  })
  if (!build.ok) return { error: build.error }

  const receipt = await ctx.client.submit(
    { idempotency_key: `hook-${randomBytes(12).toString('base64url')}`, draft: build.draft },
    0,
  )
  return { requestId: receipt.request_id, collapseKey, devices: answerable }
}

/**
 * One blocking wait across every live question. Each round polls all of them
 * concurrently, so several questions cost the same wall clock as one; the
 * first round that finds any reply returns everything found in that round, and
 * whatever was not answered stays registered.
 */
async function waitForAnyReplyWhileAway(
  ctx: HookContext,
  requestIds: string[],
  timeoutSeconds: number,
): Promise<{ byRequest: Map<string, ReplyView[]>; degraded: boolean; userReturned: boolean }> {
  const deadline = ctx.now() + timeoutSeconds * 1000
  let degraded = false
  let firstPoll = true

  for (;;) {
    if (ctx.config.require_idle.value) {
      const idle = ctx.idleSeconds()
      if (idle !== null && idle < ctx.config.away_after_seconds.value) {
        return { byRequest: new Map(), degraded, userReturned: true }
      }
    }

    const remainingMs = Math.max(0, deadline - ctx.now())
    if (!firstPoll && remainingMs === 0) {
      return { byRequest: new Map(), degraded, userReturned: false }
    }
    firstPoll = false
    const pollSeconds = Math.min(
      REPLY_PRESENCE_POLL_SECONDS,
      Math.max(0, Math.ceil(remainingMs / 1000)),
    )
    const results = await Promise.all(
      requestIds.map(async (requestId) => {
        try {
          return { requestId, ...(await ctx.waitForFirstReply(requestId, pollSeconds)) }
        } catch {
          return { requestId, replies: [] as ReplyView[], degraded: true }
        }
      }),
    )
    const byRequest = new Map<string, ReplyView[]>()
    for (const result of results) {
      degraded ||= result.degraded === true
      if (result.replies.length > 0) byRequest.set(result.requestId, result.replies)
    }
    if (byRequest.size > 0) return { byRequest, degraded, userReturned: false }
  }
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
        device.registration_healthy,
    )
    .filter((device) => configured === null || configured.includes(device.device_id))
    .map((device) => device.device_id)
}

/**
 * The session id this push is attributed to — the same one `send` carries.
 *
 * The hook has always known `session_id` and never passed it on, so two agents
 * in separate worktrees produced identical notifications and the user could
 * answer the wrong one's question. An exported `NOTIFAI_SESSION`
 * still wins, for coherence rather than vanity: it is THE session id wherever
 * it is set, so a session that exported one before launching must carry
 * the same on its own sends and on the questions its hooks push. A name the
 * user chose also outlives harness restarts, which a per-launch UUID cannot.
 */
function sessionLabel(ctx: HookContext, envelope: HookEnvelope): string | undefined {
  const explicit = ctx.env['NOTIFAI_SESSION']
  if (explicit !== undefined && explicit !== '') return explicit
  return envelope.session_id
}

/**
 * Everything retirement needs. Narrower than a HookContext on purpose:
 * `notifai ask` supersedes the previous question and it is a plain command with
 * no hook payload, no idle probe and nothing to sleep for.
 */
export type RetireDeps = Pick<HookContext, 'client' | 'config'>

/** Best effort: a question that outlives its hook is a nuisance, not a failure. */
async function closeQuietly(ctx: RetireDeps, requestId: string): Promise<void> {
  try {
    await ctx.client.closeReplies(requestId)
  } catch {
    // The window expires on its own; nothing here is worth failing a hook for.
  }
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
  session?: string | undefined,
): Promise<boolean> {
  const build = buildDraft(ctx.config, {
    title,
    body,
    event: 'question_retired',
    lifecycle: { tier: 'done', state: endState, retires_request_id: retiresRequestId },
    ...(session !== undefined ? { session } : {}),
    ...(devices !== undefined && devices.length > 0 ? { device: devices } : {}),
    collapseKey,
    level: 'passive',
  })
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
  session?: string | undefined,
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
      session,
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
  session: string | undefined,
  now: number,
): void {
  if (entries.length === 0) return
  updateOrphanQueue(env, (queue) => {
    const known = new Set(queue.map((entry) => entry.request_id))
    const added = entries
      .filter((entry) => !known.has(entry.request_id))
      .map((entry) => ({
        ...entry,
        ...(session !== undefined ? { session } : {}),
        enqueued_at: now,
      }))
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
      entry.session,
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
const MAX_CONTINUATION_COUNT = 3

interface PendingPoll {
  /** The answer to act on: the latest reply, because a later one corrects. */
  reply: ReplyView | null
  /** Every reply in arrival order, for free-text answers given in parts. */
  replies: ReplyView[]
  degraded: boolean
  failed: boolean
}

/** One bounded recovery poll for a question that outlived its original wait. */
async function pollPendingReply(
  ctx: HookContext,
  pending: PendingQuestion,
  timeoutSeconds: number,
): Promise<PendingPoll> {
  if (pending.request_id === undefined) {
    return { reply: null, replies: [], degraded: false, failed: false }
  }
  try {
    const result = await ctx.waitForFirstReply(pending.request_id, timeoutSeconds)
    return {
      reply: result.replies.at(-1) ?? null,
      replies: result.replies,
      degraded: result.degraded === true,
      failed: false,
    }
  } catch {
    return { reply: null, replies: [], degraded: true, failed: true }
  }
}

/** One answered registered question, with everything the agent needs to read it. */
interface AnsweredPending {
  pending: PendingQuestion
  reply: ReplyView
  replies: ReplyView[]
}

/**
 * One bounded recovery poll across every delivered question, concurrently —
 * N questions must not multiply the hook's latency budget by N.
 */
async function pollPendingReplies(
  ctx: HookContext,
  live: PendingQuestion[],
  timeoutSeconds: number,
): Promise<{ answered: AnsweredPending[]; troubled: boolean }> {
  const polls = await Promise.all(
    live.map((entry) => pollPendingReply(ctx, entry, timeoutSeconds)),
  )
  const answered: AnsweredPending[] = []
  let troubled = false
  for (const [index, poll] of polls.entries()) {
    if (poll.reply !== null) {
      answered.push({ pending: live[index]!, reply: poll.reply, replies: poll.replies })
    }
    if (poll.failed || poll.degraded) troubled = true
  }
  return { answered, troubled }
}

/** The registered-question queue. Anything but the current shape reads as empty. */
function pendingList(state: SessionState): PendingQuestion[] {
  return Array.isArray(state.pending) ? state.pending : []
}

/** Registration identity — the convention every racing writer compares by. */
function isSamePending(a: PendingQuestion, b: PendingQuestion): boolean {
  return a.question === b.question && a.asked_at === b.asked_at
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
 */
function answerContext(replies: ReplyView[], hadChoices: boolean): string {
  const latest = replies.at(-1)
  if (latest === undefined) return 'Notifai — no answer was recorded.'
  if (replies.length === 1 || hadChoices) {
    return `Notifai — the user answered from ${latest.device_name}: "${latest.text}". Continue with that answer.`
  }
  const parts = replies.map((reply) => `"${reply.text}"`).join(', then ')
  return (
    `Notifai — the user answered from ${latest.device_name} in ${replies.length} parts, ` +
    `in the order written: ${parts}. Later parts extend or correct earlier ones. ` +
    'Continue with that answer.'
  )
}

/**
 * Every answer that has arrived, as one message. Several registered questions
 * may resolve in one hook pass; the agent reads them together, each answer
 * tied to the question that asked it, with a truthful note about anything
 * still waiting.
 */
function answersContext(answered: AnsweredPending[], remaining: number): string {
  const tail =
    remaining > 0
      ? ` (${remaining} more registered question${remaining === 1 ? ' is' : 's are'} still waiting for an answer.)`
      : ''
  if (answered.length === 1) {
    const only = answered[0]!
    return answerContext(only.replies, pendingHasChoices(only.pending)) + tail
  }
  const lines = answered.map(({ pending, replies }) => {
    const latest = replies.at(-1)!
    const answer =
      replies.length === 1 || pendingHasChoices(pending)
        ? `"${latest.text}"`
        : `${replies.map((reply) => `"${reply.text}"`).join(', then ')} (parts in the order written; later parts extend or correct earlier ones)`
    return `- "${pending.question}" → ${answer} (from ${latest.device_name})`
  })
  return `Notifai — the user answered ${answered.length} questions:\n${lines.join('\n')}\nContinue with these answers.${tail}`
}

function userPromptAnswerOutput(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  })
}

function stopAnswerOutput(context: string): string {
  return JSON.stringify({ decision: 'block', reason: context })
}

/**
 * Close, truthfully retire, and forget every answered pending question in one
 * state write, without dropping any other retirement debt or any question
 * still waiting. Stop answers also open one bounded continuation generation;
 * UserPromptSubmit answers ride the user's new turn.
 */
async function finishAnsweredPendings(
  ctx: HookContext,
  envelope: HookEnvelope,
  sessionId: string,
  answered: AnsweredPending[],
  continuation: boolean,
): Promise<void> {
  const retirements = answered
    .map(({ pending }) => retiringQuestion(pending, 'answered'))
    .filter((entry): entry is RetiringQuestion => entry !== null)
  updateSessionState(sessionId, ctx.env, (current) => {
    const retiring = [...(current.retiring ?? [])]
    for (const retirement of retirements) {
      const existing = retiring.findIndex((entry) => entry.request_id === retirement.request_id)
      if (existing < 0) retiring.push(retirement)
      else retiring[existing] = retirement
    }
    const remaining = pendingList(current).filter(
      (entry) => !answered.some(({ pending }) => isSamePending(entry, pending)),
    )
    const next: SessionState = { ...current, retiring }
    if (remaining.length > 0) next.pending = remaining
    else delete next.pending
    if (continuation) {
      next.continuation = {
        answered_at: ctx.now(),
        count:
          (envelope.stop_hook_active === true ? current.continuation?.count ?? 0 : 0) + 1,
      }
    } else {
      next.last_prompt_at = ctx.now()
    }
    return next
  })
  await drainRetirements(ctx, sessionId, ctx.env, sessionLabel(ctx, envelope))
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
  const live = pendingList(state).filter((entry) => entry.request_id !== undefined)
  let lateAnswers: AnsweredPending[] = []
  if (live.length > 0) {
    const { answered, troubled } = await pollPendingReplies(ctx, live, LATE_PROMPT_POLL_SECONDS)
    lateAnswers = answered
    if (answered.length > 0) {
      await finishAnsweredPendings(ctx, envelope, sessionId, answered, false)
      for (const { reply } of answered) {
        notes.push(`late answer from ${reply.device_name}: ${reply.text}`)
      }
    }
    if (troubled) {
      notes.push('could not check every pending question for a late answer before the prompt')
    }
  }
  // Park before dropping `pending`. If the process dies between these writes,
  // the next hook sees both copies and dedupes them; the old order could die in
  // the gap after erasing the only request/collapse/device identifiers.
  updateSessionState(sessionId, ctx.env, (current) => {
    const retiring = [...(current.retiring ?? [])]
    for (const entry of pendingList(current)) {
      const retirement = retiringQuestion(entry, 'answered_elsewhere')
      if (
        retirement !== null &&
        !retiring.some((parked) => parked.request_id === retirement.request_id)
      ) {
        retiring.push(retirement)
      }
    }
    return { last_prompt_at: ctx.now(), ...(retiring.length > 0 ? { retiring } : {}) }
  })
  // The bridge that lets a plain `notifai ask` find the hook's canonical
  // session: an agent shell command gets no hook payload, and not every
  // harness exports an id in the same shape.
  if (envelope.cwd !== undefined && ctx.harness !== undefined) {
    writeProjectSession(envelope.cwd, ctx.env, sessionId, ctx.now(), ctx.harness)
  }

  const retired = await drainRetirements(ctx, sessionId, ctx.env, sessionLabel(ctx, envelope))
  const orphaned = await drainOrphanRetirements(ctx, ctx.env, ctx.now())
  const swept = [...retired, ...orphaned]
  if (swept.length > 0) {
    notes.push(`retired question${swept.length > 1 ? 's' : ''} ${swept.join(', ')}`)
  }
  if (lateAnswers.length > 0) {
    // Whatever the user did not answer was just retired above — they are at
    // the keyboard now, so nothing is "still waiting" from their side.
    return { stdout: userPromptAnswerOutput(answersContext(lateAnswers, 0)), notes }
  }
  return { notes }
}

// ---------------------------------------------------------------------------
// Stop — the turn ended; escalate a registered question
// ---------------------------------------------------------------------------

/**
 * How long an escalated question keeps accepting an answer after the turn
 * ended. Long enough to survive a walk away from the desk, short enough that a
 * forgotten question does not resurface days later as a live prompt.
 */
const QUESTION_WINDOW_SECONDS = 3600

/**
 * Only engages for a question the agent explicitly registered with
 * `notifai ask`. Guessing from the last assistant message was the alternative
 * and it is not worth it: a false positive here hijacks the terminal.
 */
export async function handleStop(ctx: HookContext, envelope: HookEnvelope): Promise<HookOutcome> {
  const notes: string[] = []
  const sessionId = envelope.session_id
  if (!sessionId) {
    gate(ctx, 'held', 'no-session')
    return { notes }
  }

  // Anything retired since the last hook is still live on the devices. This
  // runs before every early return below, including the nagging guard: a queued
  // retirement has nothing to do with whether *this* turn has a question to
  // escalate, and the turn that supersedes a question is very often the one
  // continuing from the previous answer.
  const swept = [
    ...(await drainRetirements(ctx, sessionId, ctx.env, sessionLabel(ctx, envelope))),
    ...(await drainOrphanRetirements(ctx, ctx.env, ctx.now())),
  ]
  if (swept.length > 0) {
    notes.push(`retired superseded question${swept.length > 1 ? 's' : ''} ${swept.join(', ')}`)
  }

  const state = readSessionState(sessionId, ctx.env)
  const pending = pendingList(state)
  if (pending.length === 0) {
    gate(ctx, 'held', 'no-question')
    return { notes }
  }

  // Claim before any reply poll, not only before the grace window. Two racing
  // Stops can both observe the same live request and both receive its answer;
  // an atomic state update prevents corruption but cannot retract the duplicate
  // block output the loser already built. One session claim therefore owns the
  // complete Stop decision: late-answer collection, continuation checks, and
  // any new escalation.
  //
  // Real clock, deliberately, not `ctx.now` — the claim answers "is another
  // process alive right now", which the injectable clock cannot speak to. It
  // is also the only clock the *other* process shares.
  if (!claimQuestionPush(sessionId, ctx.env)) {
    gate(ctx, 'held', 'claimed-elsewhere')
    notes.push('another hook is already handling this question')
    return { notes }
  }
  try {
    return await handleClaimedStop(ctx, envelope, sessionId, state, pending, notes)
  } finally {
    releaseQuestionPush(sessionId, ctx.env)
  }
}

/** The complete per-session Stop decision, after this process owns the claim. */
async function handleClaimedStop(
  ctx: HookContext,
  envelope: HookEnvelope,
  sessionId: string,
  state: SessionState,
  pending: PendingQuestion[],
  notes: string[],
): Promise<HookOutcome> {
  const live = pending.filter((entry) => entry.request_id !== undefined)
  const unasked = pending.filter((entry) => entry.request_id === undefined)

  if (live.length > 0) {
    const { answered, troubled } = await pollPendingReplies(ctx, live, LATE_STOP_POLL_SECONDS)
    if (answered.length > 0) {
      await finishAnsweredPendings(ctx, envelope, sessionId, answered, true)
      gate(ctx, 'proceeding', 'answered', { answers: answered.length })
      for (const { pending: entry, reply } of answered) {
        ctx.log?.info('hook.answer', {
          answered: true,
          late: true,
          request_id: entry.request_id,
          device: reply.device_name,
          text: reply.text,
        })
        notes.push(`late answer from ${reply.device_name}: ${reply.text}`)
      }
      // Anything still unasked rides the next Stop: the agent is being resumed
      // with answers right now, and may not even need the rest afterwards.
      return {
        stdout: stopAnswerOutput(answersContext(answered, pending.length - answered.length)),
        notes,
      }
    }
    if (unasked.length === 0) {
      // Already live on the user's devices from an earlier Stop; asking twice
      // for one question is the nagging failure this feature exists to avoid.
      const ids = live.map((entry) => entry.request_id).join(', ')
      gate(ctx, 'held', 'already-asked', { request_ids: ids, poll_troubled: troubled })
      notes.push(
        troubled
          ? `already asked (${ids}); could not check whether ${live.length === 1 ? 'its answer' : 'their answers'} arrived`
          : `already asked (${ids}); waiting for ${live.length === 1 ? 'that answer' : 'those answers'}`,
      )
      return { notes }
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
    if (continuation.count >= MAX_CONTINUATION_COUNT) {
      gate(ctx, 'held', 'continuation-limit', {
        count: continuation.count,
        limit: MAX_CONTINUATION_COUNT,
      })
      notes.push(
        `answer continuation limit (${MAX_CONTINUATION_COUNT}) reached; leaving the question in the terminal`,
      )
      return { notes }
    }
  }
  // Silent to the user by design — they switched routing off, so saying so on
  // every turn would be nagging about their own setting. That silence is also
  // why it belongs in the log: from outside, "ask_notifications = false" and "a
  // bug ate my question" look exactly the same.
  if (!ctx.config.ask_notifications.value) {
    gate(ctx, 'held', 'notifications-off', { source: ctx.config.ask_notifications.source })
    return { notes }
  }
  const idle = ctx.idleSeconds()
  if (!isUserAway(state, ctx.config, ctx.now(), idle)) {
    gate(ctx, 'held', 'user-present', {
      idle_seconds: idle,
      away_after_seconds: ctx.config.away_after_seconds.value,
      require_idle: ctx.config.require_idle.value,
      last_prompt_at: state.last_prompt_at ?? null,
    })
    notes.push('you are at the keyboard; leaving the question in the terminal')
    return { notes }
  }
  gate(ctx, 'proceeding', 'proceeding', {
    unasked: unasked.length,
    already_live: live.length,
    idle_seconds: idle,
    grace_seconds: ctx.config.ask_grace_seconds.value,
  })
  return await escalate(ctx, envelope, sessionId, unasked, live, notes)
}

/** The escalation itself, split out so the claim is released on every path. */
async function escalate(
  ctx: HookContext,
  envelope: HookEnvelope,
  sessionId: string,
  unasked: PendingQuestion[],
  alreadyLive: PendingQuestion[],
  notes: string[],
): Promise<HookOutcome> {
  // Away right now, but the questions still owe the user their terminal-first
  // window before anything reaches their devices — measured from the oldest
  // registration, because that is the question that has waited longest.
  const oldest = Math.min(...unasked.map((entry) => entry.asked_at ?? ctx.now()))
  const grace = await awaitGrace(ctx, oldest)
  ctx.log?.debug('hook.gate', { verdict: 'grace', reason: grace, waited_from: oldest })
  if (grace === 'user-returned') {
    gate(ctx, 'held', 'user-returned', { grace_seconds: ctx.config.ask_grace_seconds.value })
    notes.push('you came back before the wait elapsed; leaving the questions in the terminal')
    return { notes }
  }
  if (grace === 'no-signal') {
    notes.push('no idle signal on this machine; asking now rather than holding the terminal')
  }

  // Phase one: every registered question reaches the user's devices, each as
  // its own notification — one ask never stands in for another.
  const submitted: PendingQuestion[] = []
  for (const entry of unasked) {
    const questions = pendingQuestions(entry)
    const sent = await submitQuestion(ctx, {
      title:
        ctx.config.project.value === null
          ? 'Question'
          : `Question · ${ctx.config.project.value}`,
      // A set is answered on the expanded card; the banner leads with the
      // first question and says how much more is waiting behind it.
      body:
        questions.length > 1
          ? `${questions[0]!.text} (+${questions.length - 1} more)`
          : entry.question,
      questions,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      event: 'agent_question',
      session: sessionLabel(ctx, envelope),
      // Outlives the block, and stays open on purpose: the answer is still
      // useful to the next turn, which collects it with `notifai replies`.
      windowSeconds: QUESTION_WINDOW_SECONDS,
    })
    if ('error' in sent) {
      ctx.log?.error('hook.pushed', { ok: false, message: sent.error })
      notes.push(sent.error)
      continue
    }
    ctx.log?.info('hook.pushed', {
      ok: true,
      request_id: sent.requestId,
      devices: sent.devices.length,
      questions: questions.length,
      text: questions[0]!.text,
    })
    const live: PendingQuestion = {
      ...entry,
      request_id: sent.requestId,
      collapse_key: sent.collapseKey,
      device_ids: sent.devices,
    }
    submitted.push(live)
    // Record what is now live on the user's devices BEFORE any wait. If we
    // only learned these ids afterwards, a question that timed out would
    // leave no trace, and the user returning to the terminal could never
    // retire it — the notification would stay answerable for an hour with
    // nobody listening.
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

  const waitingOn = [...alreadyLive, ...submitted]
  if (waitingOn.length === 0) return { notes }

  if (ctx.harness === 'opencode') {
    notes.push(
      `question${submitted.length === 1 ? '' : 's'} sent without blocking OpenCode; retrieve answers on the next prompt or with: notifai replies --pending`,
    )
    return { notes }
  }

  // Phase two: one blocking wait across everything live, old and new alike.
  const timeoutSeconds = ctx.config.hook_reply_timeout_seconds.value
  const waited = await waitForAnyReplyWhileAway(
    ctx,
    waitingOn.map((entry) => entry.request_id!),
    timeoutSeconds,
  )

  if (waited.byRequest.size === 0) {
    // Keep the pending records so a returning user's UserPromptSubmit can
    // retire the notifications still live on their devices. `request_id`
    // being set is also what stops the next Stop pushing them again.
    const ids = waitingOn.map((entry) => entry.request_id).join(', ')
    ctx.log?.info('hook.answer', {
      answered: false,
      request_ids: ids,
      user_returned: waited.userReturned,
      degraded: waited.degraded,
      waited_seconds: timeoutSeconds,
    })
    if (waited.userReturned) {
      notes.push(
        `you came back after the question${waitingOn.length === 1 ? ' was' : 's were'} sent; returning the terminal while ${waitingOn.length === 1 ? 'it stays' : 'they stay'} answerable (${ids}). ` +
          'Retrieve answers with: notifai replies --pending',
      )
    } else {
      notes.push(
        waited.degraded
          ? 'could not reach the server to find out whether you answered; check with: notifai replies --pending'
          : 'no answer in time; retrieve it later with: notifai replies --pending',
      )
    }
    return { notes }
  }

  const answered: AnsweredPending[] = []
  for (const entry of waitingOn) {
    const replies = waited.byRequest.get(entry.request_id!)
    if (replies === undefined) continue
    // First answer claims the question across devices; the close is what
    // enforces that, and the latest reply within the window is the answer.
    await closeQuietly(ctx, entry.request_id!)
    answered.push({ pending: entry, reply: replies.at(-1)!, replies })
  }
  await finishAnsweredPendings(ctx, envelope, sessionId, answered, true)
  for (const { pending: entry, reply } of answered) {
    ctx.log?.info('hook.answer', {
      answered: true,
      request_id: entry.request_id,
      device: reply.device_name,
      text: reply.text,
    })
    notes.push(`answer from ${reply.device_name}: ${reply.text}`)
  }
  return {
    stdout: stopAnswerOutput(answersContext(answered, waitingOn.length - answered.length)),
    notes,
  }
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
  if (!sessionId) return { notes }
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
      return { notes }
    }
  }
  if (orphans.length > 0) {
    const label = env['NOTIFAI_SESSION']
    orphanRetirements(env, orphans, label !== undefined && label !== '' ? label : sessionId, now)
    notes.push(
      `queued ${orphans.length} question${orphans.length > 1 ? 's' : ''} for retirement on the next hook`,
    )
  }
  clearSessionState(sessionId, env)
  return { notes }
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
