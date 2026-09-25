/** Durable per-Agent-Session state, activation bookkeeping, and pruning. */
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { sanitizeSessionId, sessionConfigPath, stateDir } from './config.js'
import { withFileLock } from './file-lock.js'
import type { HookHarness, PendingQuestion, SessionState } from './hook-types.js'
import type { ProcessIdentity } from './process-identity.js'
export function sessionStatePath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.json`)
}

/**
 * Durable cancellation for observers that can outlive the harness process.
 *
 * Absence of session state is not enough: SessionEnd deliberately deletes it,
 * and an in-flight submit/fence could otherwise recreate it afterwards. The
 * marker shares the session-state lock, giving every racing writer one total
 * order: either its state lands before SessionEnd and is cleaned up there, or
 * it observes this marker and must not write or deliver into the ended session.
 */
function sessionEndMarkerPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.ended`)
}

export function sessionHasEnded(sessionId: string, env: NodeJS.ProcessEnv): boolean {
  return existsSync(sessionEndMarkerPath(sessionId, env))
}

/**
 * When a lifecycle edge happened, in an order no wall-clock change can alter.
 *
 * `mono` is the system-wide monotonic clock (`process.hrtime`), shared by
 * every process on this machine within one boot. Wall time is kept for people
 * reading the files, never for ordering: an NTP step or a manual change moved
 * it backwards far enough to end a resumed session with its own earlier end.
 */
export interface LifecycleStamp {
  wall: number
  mono: string
}

export function lifecycleStamp(wall: number = Date.now()): LifecycleStamp {
  return { wall, mono: process.hrtime.bigint().toString() }
}

function parseStamp(value: unknown): LifecycleStamp | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  return typeof record['wall'] === 'number' &&
    typeof record['mono'] === 'string' &&
    /^\d{1,30}$/.test(record['mono'])
    ? { wall: record['wall'], mono: record['mono'] }
    : null
}

/**
 * Whether `edge` happened before `reference`, a stamp taken by this process.
 * A monotonic value ahead of this process's own clock can only come from an
 * earlier boot, so it is earlier too; an edge without a stamp (an older
 * build's marker) is treated as earlier.
 */
export function happenedBefore(edge: LifecycleStamp | null, reference: LifecycleStamp): boolean {
  if (edge === null) return true
  const mono = BigInt(edge.mono)
  return mono < BigInt(reference.mono) || mono > process.hrtime.bigint()
}

/** What SessionEnd recorded: when, and which incarnation it ended. */
export interface SessionEndMarker {
  stamp: LifecycleStamp | null
  /** `key` of the incarnation current when the session ended, when there was one. */
  ends: string | null
}

export function markSessionEnded(sessionId: string, env: NodeJS.ProcessEnv, now: number): void {
  const stateFile = sessionStatePath(sessionId, env)
  withFileLock(`${stateFile}.lock`, () => {
    const current = readSessionIncarnation(sessionId, env)
    atomicWriteFileSync(
      sessionEndMarkerPath(sessionId, env),
      `${JSON.stringify({ stamp: lifecycleStamp(now), ends: current?.key ?? null })}\n`,
    )
  })
}

/** The end marker, or null when the session carries none. */
export function readSessionEndMarker(sessionId: string, env: NodeJS.ProcessEnv): SessionEndMarker | null {
  let raw: string
  try {
    raw = readFileSync(sessionEndMarkerPath(sessionId, env), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed === 'object' && parsed !== null) {
      return {
        stamp: parseStamp(parsed['stamp']),
        ends: typeof parsed['ends'] === 'string' ? parsed['ends'] : null,
      }
    }
  } catch {
    // An older build wrote bare milliseconds.
  }
  return { stamp: null, ends: null }
}

/** Whether this marker ended exactly this incarnation. */
export function endsIncarnation(marker: SessionEndMarker | null, incarnation: SessionIncarnation): boolean {
  return marker !== null && marker.ends === incarnation.key
}

/**
 * One start of one Agent Session: the edge from which its end is judged.
 *
 * A harness may start the same session id again — `/resume` in the same
 * process, or `--resume` in a new one — after SessionEnd already marked it
 * ended. SessionEnd names the incarnation it ended, so an end recorded for an
 * earlier incarnation can never end a later one, whatever the wall clock did.
 */
export interface SessionIncarnation {
  /** Stable local identity of this start; end markers name it. */
  key: string
  /** Opaque identity shown to the service by the Session Attendant. Never a PID. */
  incarnation: string
  start: LifecycleStamp
  /** The harness process hosting this incarnation, when the starter knew it. */
  harness_process?: ProcessIdentity
}

function sessionIncarnationPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.incarnation.json`)
}

export function readSessionIncarnation(
  sessionId: string,
  env: NodeJS.ProcessEnv,
): SessionIncarnation | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(sessionIncarnationPath(sessionId, env), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const start = parseStamp(record['start'])
    if (
      typeof record['key'] !== 'string' ||
      typeof record['incarnation'] !== 'string' ||
      !/^inc_[A-Za-z0-9_-]{10,64}$/.test(record['incarnation']) ||
      start === null
    ) {
      return null
    }
    const harness = record['harness_process'] as Record<string, unknown> | undefined
    return {
      key: record['key'],
      incarnation: record['incarnation'],
      start,
      ...(harness !== undefined &&
      typeof harness['pid'] === 'number' &&
      typeof harness['start'] === 'string'
        ? { harness_process: { pid: harness['pid'], start: harness['start'] } }
        : {}),
    }
  } catch {
    return null
  }
}

export function newIncarnationId(): string {
  return `inc_${randomBytes(12).toString('base64url')}`
}

/**
 * The one shared, idempotent start of an Agent Session incarnation.
 *
 * Every SessionStart handler calls it before anything reads the end marker,
 * stamped with the moment its own invocation began.
 *
 * - The recorded incarnation is joined when it runs in the same harness
 *   process and has not ended — the second handler of one start — or when its
 *   end came *after* this handler began: that end is this start's own, seen by
 *   a delayed handler, and it must stay ended.
 * - Otherwise a new incarnation is minted: no record, another harness
 *   process, or the recorded incarnation ended before this handler began
 *   (in-process `/resume` after `/clear`).
 * - An end marker from before this handler, for any incarnation but the one
 *   joined, is dropped; a later one is kept.
 */
export function beginSessionIncarnation(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  options: {
    stamp: LifecycleStamp
    harnessProcess?: ProcessIdentity
    /**
     * Only a SessionStart may drop an earlier end marker. A re-arm (a later
     * hook finding no incarnation for its harness process) mints one without
     * touching the marker, so shared cancellation stays intact.
     */
    clearEarlierEnd?: boolean
  },
): SessionIncarnation {
  const stateFile = sessionStatePath(sessionId, env)
  return withFileLock(`${stateFile}.lock`, () => {
    const marker = readSessionEndMarker(sessionId, env)
    const current = readSessionIncarnation(sessionId, env)
    const differentHarness =
      options.harnessProcess !== undefined &&
      current?.harness_process !== undefined &&
      (current.harness_process.pid !== options.harnessProcess.pid ||
        current.harness_process.start !== options.harnessProcess.start)
    const endedEarlier =
      current !== null && endsIncarnation(marker, current) && happenedBefore(marker!.stamp, options.stamp)
    let next: SessionIncarnation
    if (current !== null && !differentHarness && !endedEarlier) {
      next =
        current.harness_process === undefined && options.harnessProcess !== undefined
          ? { ...current, harness_process: options.harnessProcess }
          : current
    } else {
      next = {
        key: randomBytes(12).toString('base64url'),
        incarnation: newIncarnationId(),
        start: options.stamp,
        ...(options.harnessProcess === undefined ? {} : { harness_process: options.harnessProcess }),
      }
    }
    if (
      options.clearEarlierEnd !== false &&
      marker !== null &&
      !endsIncarnation(marker, next) &&
      happenedBefore(marker.stamp, options.stamp)
    ) {
      rmSync(sessionEndMarkerPath(sessionId, env), { force: true })
    }
    if (next !== current) {
      atomicWriteFileSync(sessionIncarnationPath(sessionId, env), `${JSON.stringify(next)}\n`)
    }
    return next
  })
}

/**
 * Replace this incarnation's service identity after the service refused it,
 * keeping its local key and start. Only the holder of `expected` may rotate it.
 */
export function rotateSessionIncarnation(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  expected: string,
): SessionIncarnation | null {
  const stateFile = sessionStatePath(sessionId, env)
  return withFileLock(`${stateFile}.lock`, () => {
    const current = readSessionIncarnation(sessionId, env)
    if (current === null || current.incarnation !== expected) return null
    const next = { ...current, incarnation: newIncarnationId() }
    atomicWriteFileSync(sessionIncarnationPath(sessionId, env), `${JSON.stringify(next)}\n`)
    return next
  })
}

/**
 * Whether this Agent Session ever had a Notification Request accepted on this
 * machine. Its Session Attendant makes no network call before this marker
 * exists, so sessions that never notified are never reported.
 */
function sessionNotifiedPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.notified`)
}

export function sessionNotified(sessionId: string, env: NodeJS.ProcessEnv): boolean {
  return existsSync(sessionNotifiedPath(sessionId, env))
}

/** Record the first accepted Notification Request of an Agent Session. Never throws. */
export function recordSessionNotified(sessionId: string, env: NodeJS.ProcessEnv, now: number): void {
  try {
    const file = sessionNotifiedPath(sessionId, env)
    if (existsSync(file)) return
    mkdirSync(path.dirname(file), { recursive: true })
    atomicWriteFileSync(file, `${now}\n`)
  } catch {
    // The marker only wakes a dormant attendant; the notification already left.
  }
}

/**
 * Keep a long-running session's small files younger than the abandoned-state
 * prune, including any extra files its owner names (the attendant's claim).
 */
export function refreshSessionMarkers(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  now: number,
  extra: readonly string[] = [],
): void {
  const at = new Date(now)
  for (const file of [sessionIncarnationPath(sessionId, env), sessionNotifiedPath(sessionId, env), ...extra]) {
    try {
      utimesSync(file, at, at)
    } catch {
      // Missing is fine; the prune only removes what is old.
    }
  }
}

export function readSessionState(sessionId: string, env: NodeJS.ProcessEnv): SessionState {
  const file = sessionStatePath(sessionId, env)
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const state = { ...(parsed as SessionState & { session_id?: unknown }) }
    delete state.session_id
    return state
  } catch {
    // A corrupt marker must not wedge the harness; treat it as "no evidence",
    // which fails closed onto ordinary terminal behaviour.
    return {}
  }
}

/**
 * Resolve a stable question or request id to the one exact session that owns it.
 *
 * This deliberately searches lifecycle state, not checkout pointers: question
 * identity is global on this machine, while a linked worktree is only where a
 * command happened to run. Ambiguous or corrupt matches fail closed.
 */
export function findOwningSession(
  id: string,
  env: NodeJS.ProcessEnv,
): { sessionId: string | null; ambiguous: boolean } {
  const directory = path.join(stateDir(env), 'sessions')
  if (!existsSync(directory)) return { sessionId: null, ambiguous: false }
  const matches: string[] = []
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue
    let persisted: (SessionState & { session_id?: unknown }) | null = null
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(directory, name), 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        persisted = parsed as SessionState & { session_id?: unknown }
      }
    } catch {
      // Corrupt lifecycle state is not identity evidence.
    }
    if (persisted === null || typeof persisted.session_id !== 'string') continue
    const sessionId = persisted.session_id
    const state = persisted
    const pendingMatch = pendingList(state).some(
      (entry) => entry.question_id === id || entry.request_id === id,
    )
    const retiringMatch = (state.retiring ?? []).some(
      (entry) => entry.question_id === id || entry.request_id === id,
    )
    const historyMatch = (state.question_history ?? []).some(
      (entry) => entry.question_id === id || entry.request_id === id,
    )
    const acknowledgementMatch = (state.acknowledgement_due ?? []).some(
      (entry) => entry.request_id === id,
    )
    const acceptedMatch = state.accepted?.answers.some(
      ({ pending }) => pending.question_id === id || pending.request_id === id,
    ) ?? false
    const deliveredMatch = state.delivered_answers?.some(
      ({ pending }) => pending.question_id === id || pending.request_id === id,
    ) ?? false
    if (pendingMatch || retiringMatch || historyMatch || acknowledgementMatch || acceptedMatch || deliveredMatch) {
      matches.push(sessionId)
      if (matches.length > 1) return { sessionId: null, ambiguous: true }
    }
  }
  return { sessionId: matches[0] ?? null, ambiguous: false }
}

export function writeSessionState(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  state: SessionState,
): void {
  const file = sessionStatePath(sessionId, env)
  withFileLock(`${file}.lock`, () => writeSessionStateUnlocked(file, sessionId, state))
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

export function writeSessionStateUnlocked(file: string, sessionId: string, state: SessionState): void {
  atomicWriteFileSync(file, `${JSON.stringify({ ...state, session_id: sessionId }, null, 2)}\n`)
}

export function updateSessionState(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  update: (current: SessionState) => SessionState,
): SessionState {
  const file = sessionStatePath(sessionId, env)
  return withFileLock(`${file}.lock`, () => {
    const current = readSessionState(sessionId, env)
    // SessionEnd and every asynchronous writer share this lock. Once the
    // durable marker exists, no observer may recreate state for that session.
    if (sessionHasEnded(sessionId, env)) return current
    const next = update(current)
    writeSessionStateUnlocked(file, sessionId, next)
    return next
  })
}

/** Record the current installation when an owner session starts. */
export function recordSessionStart(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  harness?: HookHarness,
  cwd?: string,
  codexStopDefinitionFingerprint?: string,
  stamp: LifecycleStamp = lifecycleStamp(),
): void {
  // Harnesses may reuse a session id only by explicitly starting that session
  // again. That lifecycle edge is the sole authority for clearing cancellation,
  // and it clears only an end recorded before this handler started.
  beginSessionIncarnation(sessionId, env, { stamp })
  updateSessionState(sessionId, env, (current) => {
    const next: SessionState = {
      ...current,
      ...(harness === undefined ? {} : { harness }),
      ...(cwd === undefined
        ? {}
        : { activation_cwd: harness === 'codex' ? cwd : current.activation_cwd ?? cwd }),
    }
    // A Codex SessionStart materializes one new runtime generation. Absence of
    // singular proof must replace prior proof too; retaining it would let a
    // resumed session borrow the definition loaded by an earlier runtime.
    if (harness === 'codex') {
      delete next.codex_stop_definition_fingerprint
      if (codexStopDefinitionFingerprint !== undefined) {
        next.codex_stop_definition_fingerprint = codexStopDefinitionFingerprint
      }
    }
    return next
  })
}

/** Atomically claim Cursor's first-Stop activation fallback once per conversation. */
export function claimCursorStopActivation(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  now: number,
): boolean {
  const claimGuardMs = 30_000
  let claimed = false
  updateSessionState(sessionId, env, (current) => {
    if (current.cursor_activation_confirmed_at !== undefined) return current
    if (
      current.cursor_activation_claimed_at !== undefined &&
      now - current.cursor_activation_claimed_at < claimGuardMs
    ) {
      return current
    }
    claimed = true
    return { ...current, cursor_activation_claimed_at: now }
  })
  return claimed
}

/** Cursor's loop_count proves the previous Stop follow-up reached the host. */
export function confirmCursorStopActivation(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  now: number,
): boolean {
  let owned = false
  updateSessionState(sessionId, env, (current) => {
    if (current.cursor_activation_confirmed_at !== undefined) {
      owned = true
      return current
    }
    if (current.cursor_activation_claimed_at === undefined) return current
    owned = true
    return { ...current, cursor_activation_confirmed_at: now }
  })
  return owned
}

/** A fresh/cleared Cursor lifecycle makes its next Stop the fallback owner again. */
export function resetCursorStopActivation(sessionId: string, env: NodeJS.ProcessEnv): void {
  updateSessionState(sessionId, env, (current) => {
    if (
      current.cursor_activation_claimed_at === undefined &&
      current.cursor_activation_confirmed_at === undefined
    ) {
      return current
    }
    const next = { ...current }
    delete next.cursor_activation_claimed_at
    delete next.cursor_activation_confirmed_at
    return next
  })
}

/**
 * Session state a crashed harness left behind.
 *
 * `SessionEnd` removes session state and leaves a short-lived cancellation
 * marker; a harness that crashes or is killed never reaches it. At roughly a
 * hundred sessions a day that is tens of thousands of files a year, none of
 * which anything reads.
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

/** The registered-question queue. Anything but the current shape reads as empty. */
export function pendingList(state: SessionState): PendingQuestion[] {
  return Array.isArray(state.pending) ? state.pending : []
}
