/** Durable per-Agent-Session state, activation bookkeeping, and pruning. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { sanitizeSessionId, sessionConfigPath, stateDir } from './config.js'
import { withFileLock } from './file-lock.js'
import type { HookHarness, PendingQuestion, SessionState } from './hook-types.js'
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

export function markSessionEnded(sessionId: string, env: NodeJS.ProcessEnv, now: number): void {
  const stateFile = sessionStatePath(sessionId, env)
  withFileLock(`${stateFile}.lock`, () => {
    atomicWriteFileSync(sessionEndMarkerPath(sessionId, env), `${now}\n`)
  })
}

function clearSessionEndMarker(sessionId: string, env: NodeJS.ProcessEnv): void {
  const stateFile = sessionStatePath(sessionId, env)
  withFileLock(`${stateFile}.lock`, () => {
    rmSync(sessionEndMarkerPath(sessionId, env), { force: true })
  })
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
    if (pendingMatch || retiringMatch || historyMatch || acknowledgementMatch || acceptedMatch) {
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
): void {
  // Harnesses may reuse a session id only by explicitly starting that session
  // again. That lifecycle edge is the sole authority for clearing cancellation.
  clearSessionEndMarker(sessionId, env)
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
