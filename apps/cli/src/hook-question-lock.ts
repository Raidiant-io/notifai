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
  const guard = `${file}.guard`
  const token = randomBytes(12).toString('base64url')
  const pendingQuestionIds = pendingList(readSessionState(sessionId, env)).map(
    claimQuestionIdentity,
  )
  mkdirSync(path.dirname(file), { recursive: true })
  if (!acquireClaimGuard(guard)) return false
  try {
    try {
      writeFileSync(
        file,
        `${JSON.stringify({ pid: process.pid, at: now, token, pending_question_ids: pendingQuestionIds, ...(ownerDeadlineAt === undefined ? {} : { owner_deadline_at: ownerDeadlineAt }) })}\n`,
        {
        mode: 0o600,
        flag: 'wx',
        },
      )
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
        writeFileSync(
          file,
          `${JSON.stringify({ pid: process.pid, at: now, token, pending_question_ids: pendingQuestionIds, ...(ownerDeadlineAt === undefined ? {} : { owner_deadline_at: ownerDeadlineAt }) })}\n`,
          {
          mode: 0o600,
          flag: 'wx',
          },
        )
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
