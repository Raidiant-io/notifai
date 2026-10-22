/** Cross-process ownership for exactly-once question escalation. */
import { currentRuntimeBuild } from './launch-self.js'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import path from 'node:path'
import { sanitizeSessionId, stateDir } from './config.js'
import { formerHubPids } from './hub-ipc.js'
import { pendingList, readSessionState } from './hook-session-state.js'
import type { PendingQuestion } from './hook-types.js'
import { currentProcessIdentity, pidExists, processIdentityLiveness } from './process-identity.js'
import { LEGACY_QUESTION_CLAIM_TTL_SECONDS, QUESTION_STOP_TEARDOWN_HEADROOM_SECONDS } from './question-timing.js'
import { atomicWriteFileSync } from './atomic-file.js'
import { FILE_LOCK_WAIT_MS } from './file-lock.js'
import { packageVersion } from './release.js'
import { compareVersions } from './version.js'
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
const CLAIM_TTL_MS = LEGACY_QUESTION_CLAIM_TTL_SECONDS * 1000

/**
 * How long a crashed claim *guard* whose holder cannot be proved gone blocks
 * the next hook.
 *
 * The claim itself may legitimately be held for the whole waiter, so it takes
 * that ceiling. The guard is a short lock around the claim's own bookkeeping —
 * a few file operations — and borrowing the waiter's ceiling for it meant a
 * hook killed at exactly the wrong moment wedged this session's Stop path for
 * eight minutes, for a critical section that never runs longer than a second.
 * A guard names its holder, so one left by a process that died is recovered at
 * once; this age limit is only the backstop for a holder that cannot be named
 * or checked.
 */
export const CLAIM_GUARD_TTL_MS = 30_000

const heldClaims = new Map<string, string>()

/**
 * Who owns a session's questions: a Stop hook (which may be holding the
 * harness's turn end), a detached owner process, or the hub in-process.
 */
export type QuestionOwnerRole = 'stop' | 'detached' | 'hub'

export function claimQuestionPush(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
  beforeStaleReplace?: () => void,
  ownerDeadlineAt?: number,
  role: QuestionOwnerRole = 'stop',
): boolean {
  const file = claimPath(sessionId, env)
  const pendingQuestionIds = pendingList(readSessionState(sessionId, env)).map(
    claimQuestionIdentity,
  )
  const version = packageVersion()
  const token = acquireClaimFile(
    file,
    {
      pending_question_ids: pendingQuestionIds,
      ...(ownerDeadlineAt === undefined ? {} : { owner_deadline_at: ownerDeadlineAt }),
      owner_role: role,
      ...(version === null ? {} : { runtime_version: version }),
      // This owner watches its claim and steps aside when asked (`questionPushHeld`).
      yields: true,
    },
    now,
    beforeStaleReplace,
  )
  if (token === null) return false
  heldClaims.set(file, token)
  return true
}

/**
 * Whether this process still holds the question claim it took. False once a
 * successor asked it to step aside (or the claim was otherwise replaced): the
 * owner then stops without consuming, closing or retiring anything, and the
 * successor observes the same questions from where it left them.
 */
export function questionPushHeld(sessionId: string, env: NodeJS.ProcessEnv): boolean {
  const file = claimPath(sessionId, env)
  const token = heldClaims.get(file)
  return token !== undefined && readClaimFile(file)?.['token'] === token
}

/** How long a background owner waits for an older owner to give way. */
export const QUESTION_OWNER_SUPERSEDE_WAIT_MS = 45_000

export type QuestionOwnerSupersession =
  | { action: 'none' }
  | { action: 'asked' | 'signalled'; pid: number; reason: 'older-runtime' | 'outlived-window' | 'hub-owns-sessions' | 'hub-replaced' }
  /** The holder is a hub this one replaced: it is on its way out, so wait for its claim to go. */
  | { action: 'waiting'; pid: number; reason: 'hub-replaced' }

/**
 * A background owner (`detached` or `hub`) meets a live holder of the
 * session's question claim. One current owner per session is the rule, so it
 * takes over from a holder that is
 * - from an older runtime (any holder that predates this field is older);
 * - past its own owner deadline plus teardown, i.e. outlived its window; or
 * - a detached owner, when the hub itself asks (the hub owns questions where
 *   it runs, and wakes the session through its child); or
 * - a hub this hub replaced (one hub runs at a time, so any other live hub
 *   owner is leaving): asked when it can be, otherwise waited out, never
 *   signalled.
 *
 * A holder that honours hand-off requests is asked: its token changes, it
 * notices before or after its next reply poll and stops without touching the
 * questions. An older holder cannot be asked, so it is stopped with SIGTERM,
 * only when it is provably a detached `hook question-settlement` process
 * (never a Stop hook holding a turn) and no accepted answer is mid-delivery;
 * the successor then continues exactly as after a crash of that process.
 * A Stop hook is never superseded: it may be holding the harness's turn end.
 */
export function supersedeQuestionOwner(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  role: Exclude<QuestionOwnerRole, 'stop'>,
  now: number = Date.now(),
  seams: { commandLine?: (pid: number) => string | null; signal?: (pid: number) => void } = {},
): QuestionOwnerSupersession {
  const file = claimPath(sessionId, env)
  const holder = readClaimFile(file)
  if (holder === null || typeof holder['pid'] !== 'number' || typeof holder['start'] !== 'string' ||
      typeof holder['token'] !== 'string' || holder['pid'] === process.pid || holder['owner_role'] === 'stop') return { action: 'none' }
  const pid = holder['pid']
  if (processIdentityLiveness({ pid, start: holder['start'] }) !== 'alive') return { action: 'none' }
  const ours = packageVersion()
  const theirs = typeof holder['runtime_version'] === 'string' ? holder['runtime_version'] : null
  const order = theirs === null || ours === null ? 'unparseable' : compareVersions(theirs, ours)
  const cooperative = holder['yields'] === true
  const deadline = holder['owner_deadline_at']
  if (role === 'hub' && (holder['owner_role'] === 'hub' || formerHubPids(env).has(pid))) {
    if (!cooperative) return { action: 'waiting', pid, reason: 'hub-replaced' }
    if (holder['handoff'] === true || requestQuestionOwnerHandoff(file, holder['token'])) return { action: 'asked', pid, reason: 'hub-replaced' }
    return { action: 'waiting', pid, reason: 'hub-replaced' }
  }
  const reason = !cooperative || order === 'before' ? 'older-runtime' as const
    : typeof deadline === 'number' && now > deadline + QUESTION_STOP_TEARDOWN_HEADROOM_SECONDS * 1000 ? 'outlived-window' as const
      : role === 'hub' && holder['owner_role'] === 'detached' && order !== 'after' ? 'hub-owns-sessions' as const
        : null
  if (reason === null) return { action: 'none' }
  if (cooperative) {
    if (holder['handoff'] === true || requestQuestionOwnerHandoff(file, holder['token'])) return { action: 'asked', pid, reason }
    return { action: 'none' }
  }
  // An older runtime has no way to be asked. Stop it only when it is a
  // detached answer owner and stopping it cannot cut an answer in half.
  if (readSessionState(sessionId, env).accepted !== undefined) return { action: 'none' }
  const command = (seams.commandLine ?? processCommandLine)(pid)
  if (command === null || !/\bhook question-settlement\b/.test(command)) return { action: 'none' }
  const guard = `${file}.guard`
  if (!acquireClaimGuard(guard)) return { action: 'none' }
  try {
    const current = readClaimFile(file)
    if (current?.['token'] !== holder['token'] || current['pid'] !== pid ||
        processIdentityLiveness({ pid, start: holder['start'] }) !== 'alive') return { action: 'none' }
    try {
      (seams.signal ?? ((target: number) => process.kill(target, 'SIGTERM')))(pid)
    } catch {
      return { action: 'none' }
    }
    return { action: 'signalled', pid, reason }
  } finally {
    rmSync(guard, { force: true })
  }
}

/**
 * A hub that is handing over: ask every question owner running in this
 * process to step aside. Each stops at its next check (before or after its
 * reply poll) without consuming, closing or retiring anything, and releases
 * its claim; the next hub continues the same questions. Returns how many were asked.
 */
export function standDownQuestionOwners(): number {
  let asked = 0
  for (const [file, token] of heldClaims) {
    try { if (requestQuestionOwnerHandoff(file, token)) asked += 1 } catch { /* The owner keeps its claim; it dies with this process. */ }
  }
  return asked
}

/** Ask a live, hand-off-aware question owner to step aside. */
function requestQuestionOwnerHandoff(file: string, expectedToken: string): boolean {
  const guard = `${file}.guard`
  if (!acquireClaimGuard(guard)) return false
  try {
    const holder = readClaimFile(file)
    if (holder?.['token'] !== expectedToken || holder['yields'] !== true) return false
    atomicWriteFileSync(file, `${JSON.stringify({ ...holder, token: randomBytes(12).toString('base64url'),
      handoff: true, handoff_from: expectedToken })}\n`)
    return true
  } finally {
    rmSync(guard, { force: true })
  }
}

/** The full command line of a process (POSIX `ps`), or null. */
function processCommandLine(pid: number): string | null {
  if (process.platform === 'win32') return null
  try {
    const output = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '/bin:/usr/bin', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim()
    return output === '' ? null : output
  } catch {
    return null
  }
}

/**
 * Exclusive ownership of one claim file, shared by every per-session owner.
 *
 * The holder is named by PID *and* process start time, so a PID the OS reused
 * for an unrelated process can never keep a dead owner's claim alive. A live
 * holder owns the claim regardless of age; a holder proven gone is replaced at
 * once. Claims without a trustworthy PID fall back to the legacy age limit,
 * and claims without a start time (written by older builds) to PID alone.
 *
 * Returns the new holder's random token, or null when someone else holds it.
 */
export function acquireClaimFile(
  file: string,
  fields: Record<string, unknown>,
  now: number = Date.now(),
  beforeStaleReplace?: () => void,
): string | null {
  const guard = `${file}.guard`
  const token = randomBytes(12).toString('base64url')
  const self = currentProcessIdentity()
  const runtimeBuild = currentRuntimeBuild()
  const body = `${JSON.stringify({
    pid: process.pid,
    ...(self === null ? {} : { start: self.start }),
    at: now,
    token,
    ...fields,
    ...(runtimeBuild === null ? {} : { runtime_build: runtimeBuild }),
  })}\n`
  mkdirSync(path.dirname(file), { recursive: true })
  if (!acquireClaimGuard(guard)) return null
  try {
    try {
      writeFileSync(file, body, { mode: 0o600, flag: 'wx' })
      return token
    } catch {
      // Held. Break it only if whoever holds it cannot still be running.
      if (claimHolderMayRun(readClaimFile(file), now)) return null
      beforeStaleReplace?.()
      rmSync(file, { force: true })
      try {
        writeFileSync(file, body, { mode: 0o600, flag: 'wx' })
        return token
      } catch {
        return null
      }
    }
  } finally {
    rmSync(guard, { force: true })
  }
}

/** The parsed holder of a claim file, or null when it is missing or corrupt. */
export function readClaimFile(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Whether a recorded holder could still be running. Unknown liveness counts as running. */
export function claimHolderMayRun(
  held: Record<string, unknown> | null,
  now: number = Date.now(),
): boolean {
  if (held === null) return false
  if (typeof held['pid'] === 'number') {
    if (typeof held['start'] === 'string') {
      return processIdentityLiveness({ pid: held['pid'], start: held['start'] }) !== 'gone'
    }
    return pidExists(held['pid'])
  }
  const age = typeof held['at'] === 'number' ? now - held['at'] : Number.POSITIVE_INFINITY
  return age >= 0 && age < CLAIM_TTL_MS
}

/** Remove a claim file only while it still carries this holder's token. */
export function releaseClaimFile(file: string, token: string): void {
  const guard = `${file}.guard`
  if (!acquireClaimGuard(guard, FILE_LOCK_WAIT_MS)) return
  try {
    if (readClaimFile(file)?.['token'] === token) rmSync(file, { force: true })
  } finally {
    rmSync(guard, { force: true })
  }
}

/** Fence the exact resident writer; its ordinary claim-lost path cancels writes.
 * Keep its process identity until it exits, so a successor cannot overlap it.
 */
export function requestClaimHandoff(file: string, expectedToken: string, incarnation: string): boolean {
  const guard = `${file}.guard`
  if (!acquireClaimGuard(guard)) return false
  try {
    const holder = readClaimFile(file)
    if (holder?.['token'] !== expectedToken || holder['incarnation'] !== incarnation ||
        typeof holder['pid'] !== 'number' || typeof holder['start'] !== 'string' ||
        processIdentityLiveness({ pid: holder['pid'], start: holder['start'] }) !== 'alive') return false
    atomicWriteFileSync(file, `${JSON.stringify({ ...holder, token: randomBytes(12).toString('base64url'), handoff: true })}\n`)
    return true
  } finally {
    rmSync(guard, { force: true })
  }
}

function claimQuestionIdentity(entry: PendingQuestion): string {
  return entry.question_id ?? `${entry.asked_at ?? 'legacy'}\u0000${entry.question}`
}

/** True only when the live owner could not have snapshotted this unpushed ask. */
export function claimHandoffState(
  sessionId: string,
  env: NodeJS.ProcessEnv,
): { hasNewQuestion: boolean; ownerDeadlineAt?: number } {
  const pending = pendingList(readSessionState(sessionId, env))
  if (pending.length === 0) return { hasNewQuestion: false }
  try {
    const held = JSON.parse(readFileSync(claimPath(sessionId, env), 'utf8')) as {
      pending_question_ids?: unknown
      owner_deadline_at?: unknown
    }
    if (!Array.isArray(held.pending_question_ids)) return { hasNewQuestion: false }
    const snapshotted = new Set(
      held.pending_question_ids.filter((entry): entry is string => typeof entry === 'string'),
    )
    return {
      hasNewQuestion: pending.some(
        (entry) => !snapshotted.has(claimQuestionIdentity(entry)),
      ),
      ...(typeof held.owner_deadline_at === 'number' &&
      Number.isFinite(held.owner_deadline_at)
        ? { ownerDeadlineAt: held.owner_deadline_at }
        : {}),
    }
  } catch {
    return { hasNewQuestion: false }
  }
}

export function releaseQuestionPush(sessionId: string, env: NodeJS.ProcessEnv): void {
  const file = claimPath(sessionId, env)
  const token = heldClaims.get(file)
  if (token === undefined) return
  heldClaims.delete(file)
  // Missing or replaced claims are not ours to release; a claim a successor
  // asked this owner to hand over is, so the successor can take it now.
  const guard = `${file}.guard`
  if (!acquireClaimGuard(guard, FILE_LOCK_WAIT_MS)) return
  try {
    const holder = readClaimFile(file)
    if (holder?.['token'] === token || (holder?.['handoff'] === true && holder['handoff_from'] === token &&
        holder['pid'] === process.pid)) rmSync(file, { force: true })
  } finally {
    rmSync(guard, { force: true })
  }
}

const CLAIM_GUARD_POLL_MS = 5
const guardSleep = new Int32Array(new SharedArrayBuffer(4))

/**
 * The guard serializes stale replacement and release. It appears already
 * naming its holder, so a guard left by a process that died inside its few
 * file operations is recovered at once instead of refusing every owner until
 * it ages out. Only a guard whose holder cannot be named or checked waits for
 * `CLAIM_GUARD_TTL_MS`.
 *
 * A contender that finds the guard busy retries on its own schedule. A release
 * has no later retry: giving up would leave a live process holding the claim
 * it meant to let go, and every contender polling for it would wait out its
 * deadline. Releases therefore wait out a live holder's few file operations.
 */
function acquireClaimGuard(file: string, waitMs = 0): boolean {
  const deadline = Date.now() + waitMs
  for (let attempt = 0; attempt < 3;) {
    if (createClaimGuard(file)) return true
    if (removeDeadClaimGuard(file)) attempt += 1
    else if (Date.now() >= deadline) return false
    else Atomics.wait(guardSleep, 0, 0, CLAIM_GUARD_POLL_MS)
  }
  return false
}

function createClaimGuard(file: string): boolean {
  const self = currentProcessIdentity()
  const body = `${JSON.stringify({ pid: process.pid, ...(self === null ? {} : { start: self.start }) })}\n`
  const staged = `${file}.${process.pid}.${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(staged, body, { mode: 0o600, flag: 'wx' })
    // Linking is atomic and refuses an existing guard, so no guard is ever seen without its holder.
    linkSync(staged, file)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    // No directory (nothing to guard), or a file system without hard links: create it in place.
    try {
      writeFileSync(file, body, { mode: 0o600, flag: 'wx' })
      return true
    } catch {
      return false
    }
  } finally {
    rmSync(staged, { force: true })
  }
}

/**
 * Remove a guard whose holder is gone (or, unnamed, aged out). True when the
 * caller should try to take the guard again; false when a holder may be running.
 */
function removeDeadClaimGuard(file: string): boolean {
  let judged: Stats
  let holder: Record<string, unknown> | null = null
  try {
    const handle = openSync(file, 'r')
    try {
      judged = fstatSync(handle)
      try {
        const parsed: unknown = JSON.parse(readFileSync(handle, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) holder = parsed as Record<string, unknown>
      } catch {
        // An older build's empty guard, or one cut short: it can only age out.
      }
    } finally {
      closeSync(handle)
    }
  } catch {
    // Released meanwhile.
    return true
  }
  const gone = holder !== null && typeof holder['pid'] === 'number' && !claimHolderMayRun(holder)
  if (!gone && Date.now() - judged.mtimeMs < CLAIM_GUARD_TTL_MS) return false
  // Remove exactly the guard judged, never one a contender recovered and took since.
  const moved = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.stale`
  try {
    renameSync(file, moved)
  } catch {
    return true
  }
  try {
    const taken = statSync(moved)
    if (taken.ino !== judged.ino || taken.dev !== judged.dev) {
      try { linkSync(moved, file) } catch { /* Its holder releases a guard that is already gone. */ }
      return false
    }
    return true
  } finally {
    rmSync(moved, { force: true })
  }
}

/**
 * Whether a session's claim guard is still there: a holder in the middle of
 * its few file operations, or one that crashed and cannot be proved gone,
 * whose guard ages out within `CLAIM_GUARD_TTL_MS`.
 */
export function questionClaimGuardPresent(sessionId: string, env: NodeJS.ProcessEnv): boolean {
  return existsSync(`${claimPath(sessionId, env)}.guard`)
}

function claimPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.claim`)
}
