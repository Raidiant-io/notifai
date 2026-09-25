/** Cross-process ownership for exactly-once question escalation. */
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { sanitizeSessionId, stateDir } from './config.js'
import { pendingList, readSessionState } from './hook-session-state.js'
import type { PendingQuestion } from './hook-types.js'
import { currentProcessIdentity, pidExists, processIdentityLiveness } from './process-identity.js'
import { LEGACY_QUESTION_CLAIM_TTL_SECONDS } from './question-timing.js'
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
 * How long a crashed claim *guard* blocks the next hook.
 *
 * The claim itself may legitimately be held for the whole waiter, so it takes
 * that ceiling. The guard is a short lock around the claim's own bookkeeping —
 * a few file operations — and borrowing the waiter's ceiling for it meant a
 * hook killed at exactly the wrong moment wedged this session's Stop path for
 * eight minutes, for a critical section that never runs longer than a second.
 */
const CLAIM_GUARD_TTL_MS = 30_000

const heldClaims = new Map<string, string>()

export function claimQuestionPush(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
  beforeStaleReplace?: () => void,
  ownerDeadlineAt?: number,
): boolean {
  const file = claimPath(sessionId, env)
  const pendingQuestionIds = pendingList(readSessionState(sessionId, env)).map(
    claimQuestionIdentity,
  )
  const token = acquireClaimFile(
    file,
    {
      pending_question_ids: pendingQuestionIds,
      ...(ownerDeadlineAt === undefined ? {} : { owner_deadline_at: ownerDeadlineAt }),
    },
    now,
    beforeStaleReplace,
  )
  if (token === null) return false
  heldClaims.set(file, token)
  return true
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
  const body = `${JSON.stringify({
    pid: process.pid,
    ...(self === null ? {} : { start: self.start }),
    at: now,
    token,
    ...fields,
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
  if (!acquireClaimGuard(guard)) return
  try {
    if (readClaimFile(file)?.['token'] === token) rmSync(file, { force: true })
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
  const unasked = pendingList(readSessionState(sessionId, env)).filter(
    (entry) => entry.request_id === undefined,
  )
  if (unasked.length === 0) return { hasNewQuestion: false }
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
      hasNewQuestion: unasked.some(
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
  // Missing or replaced claims are not ours to release.
  releaseClaimFile(file, token)
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
        if (Date.now() - statSync(file).mtimeMs < CLAIM_GUARD_TTL_MS) return false
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
