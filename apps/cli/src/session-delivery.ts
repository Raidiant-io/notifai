/**
 * The per-session delivery sequencer: every claimed hand-off into an Agent
 * Session — the answer waiter's fenced answers and the Session Attendant's
 * Session Messages — passes through one local lock and one ordered journal.
 *
 * A hand-off is claim → journal → write → journal → report:
 *
 * 1. Under the session's delivery lock, claim a Delivery Attempt bound to the
 *    lease generation the attendant holds. The service refuses claims from a
 *    fenced generation and holds an Answer Edit until its fenced answer has an
 *    outcome.
 * 2. Journal the attempt (`claimed`) with this writer's PID and start time.
 * 3. Immediately before the irreversible write, re-check the claim deadline by
 *    this process's monotonic clock and journal `writing`. After the deadline
 *    nothing is written, ever.
 * 4. Journal how the write ended, release the lock, and report the outcome.
 *
 * A missing report is pending, never inferred. When a writer dies before
 * reporting, whichever process next holds the lock reports for it from the
 * journal: `claimed` wrote nothing (`released`), `writing` may have written
 * (`unconfirmed`), `written` did (`handed_off`). Harnesses have no dedup key,
 * so an `unconfirmed` hand-off is never retried.
 *
 * Every claimed write is made in-process (the inbox-socket line). A writer that
 * spawns a harness subprocess to write must run it in its own process group,
 * wait for it, and record that group here before it may claim: the Answer Edit
 * release rule relies on "writer gone" meaning nothing it started can write.
 *
 * Local only: PIDs and process start times never leave this machine.
 */
import type {
  ClaimDeliveryAttemptRequestT,
  DeliveryAttemptOutcome,
  DeliveryClaimRefusalReason,
} from '@raidiant/notifai-protocol'
import { DELIVERY_CLAIM_REFUSAL_REASONS } from '@raidiant/notifai-protocol'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { ApiCallError, NetworkError, type ApiClient } from './client.js'
import { sanitizeSessionId, stateDir } from './config.js'
import { withFileLock } from './file-lock.js'
import { acquireClaimFile, releaseClaimFile } from './hook-question-lock.js'
import type { Logger } from './logging.js'
import {
  normalizeProcessStart,
  processIdentityLiveness,
  type ProcessIdentity,
  type ProcessLiveness,
} from './process-identity.js'

/** How long a writer waits for another writer's hand-off into the same session. */
export const DELIVERY_LOCK_WAIT_MS = 30_000

/** A write must start at least this long before its claim deadline. */
export const DELIVERY_WRITE_MARGIN_MS = 2_000

/** Settled attempts stay readable as long as an Answer Edit may still need them. */
const JOURNAL_KEEP_MS = 7 * 24 * 3600 * 1000
const JOURNAL_CAP = 200
const LOCK_POLL_MS = 100

export type HandOffSubject = ClaimDeliveryAttemptRequestT['subject']

/**
 * - `claimed`: claimed, nothing written.
 * - `writing`: the irreversible write may have started.
 * - `written`: the write completed.
 * - `failed`: the write started and failed; it may have reached the harness.
 * - `released`: nothing was written and nothing will be.
 */
export type DeliveryJournalStage = 'claimed' | 'writing' | 'written' | 'failed' | 'released'

export interface DeliveryJournalEntry {
  attempt_id: string
  subject: HandOffSubject
  stage: DeliveryJournalStage
  writer: ProcessIdentity
  /** Wall-clock epoch ms, for people reading the file; never used for ordering. */
  claimed_at: number
  reported?: DeliveryAttemptOutcome
  reported_at?: number
}

export interface DeliveryLease {
  incarnation: string
  generation: number
}

export interface SequencerDeps {
  sessionId: string
  env: NodeJS.ProcessEnv
  client: ApiClient
  monotonic(): number
  wall(): number
  sleep(milliseconds: number): Promise<void>
  /** This writer, recorded on every attempt before any write. */
  writer: ProcessIdentity
  log?: Logger
  /** Test seam: whether a recorded writer still runs. */
  liveness?: (identity: ProcessIdentity) => ProcessLiveness
}

export type ClaimRefusal = DeliveryClaimRefusalReason | 'not_found' | 'unavailable'

export interface ClaimedAttempt {
  attemptId: string
  subject: HandOffSubject
  /** Monotonic ms after which this writer never begins a write. */
  deadline: number
}

/** One claimed batch, held under the session's delivery lock until `finish`. */
export interface HandOff {
  readonly claimed: readonly ClaimedAttempt[]
  readonly refused: ReadonlyArray<{ subject: HandOffSubject; reason: ClaimRefusal }>
  /**
   * Call immediately before the irreversible write. False means write nothing:
   * a claim deadline is too close, `mayWrite` refused, or `commit` (the
   * caller's own last fence, run after every check) refused. True with no
   * claims leaves the choice to write unclaimed with the caller.
   */
  begin(commit?: () => boolean): boolean
  /** Journal how the write ended, release the lock, then report every attempt. */
  finish(result: 'written' | 'not-written' | 'failed'): Promise<void>
}

export function deliveryJournalPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.deliveries`)
}

export function deliveryLockPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.delivering`)
}

/** What an attempt's journal stage lets anyone report for it once its writer is gone. */
export function recoveredOutcome(stage: DeliveryJournalStage): DeliveryAttemptOutcome {
  switch (stage) {
    case 'claimed':
    case 'released':
      return 'released'
    case 'written':
      return 'handed_off'
    case 'writing':
    case 'failed':
      return 'unconfirmed'
  }
}

export function readDeliveryJournal(sessionId: string, env: NodeJS.ProcessEnv): DeliveryJournalEntry[] {
  const file = deliveryJournalPath(sessionId, env)
  if (!existsSync(file)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const entries = (parsed as { entries?: unknown } | null)?.entries
    return Array.isArray(entries) ? entries.filter(isJournalEntry) : []
  } catch {
    // A corrupt journal is no evidence: nothing is reported from it and no
    // writer is proven gone by it.
    return []
  }
}

function updateDeliveryJournal(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  update: (entries: DeliveryJournalEntry[]) => DeliveryJournalEntry[],
): void {
  const file = deliveryJournalPath(sessionId, env)
  withFileLock(`${file}.lock`, () => {
    const next = update(readDeliveryJournal(sessionId, env))
    atomicWriteFileSync(file, `${JSON.stringify({ session_id: sessionId, entries: next }, null, 2)}\n`)
  })
}

function setStage(
  deps: SequencerDeps,
  attemptIds: ReadonlySet<string>,
  stage: DeliveryJournalStage,
): void {
  updateDeliveryJournal(deps.sessionId, deps.env, (entries) =>
    entries.map((entry) => (attemptIds.has(entry.attempt_id) ? { ...entry, stage } : entry)),
  )
}

/** Attempts this process is between claim and report; recovery never reports them. */
const inFlight = new Set<string>()

/**
 * Exclusive right to hand off into one session, held by PID and start time so
 * a writer that died never keeps it. Null when another writer kept it longer
 * than `waitMs`.
 */
export async function acquireDeliveryLock(
  deps: Pick<SequencerDeps, 'sessionId' | 'env' | 'monotonic' | 'wall' | 'sleep'>,
  waitMs: number = DELIVERY_LOCK_WAIT_MS,
): Promise<{ release(): void } | null> {
  const file = deliveryLockPath(deps.sessionId, deps.env)
  const deadline = deps.monotonic() + waitMs
  for (;;) {
    const token = acquireClaimFile(file, { purpose: 'delivery' }, deps.wall())
    if (token !== null) {
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          releaseClaimFile(file, token)
        },
      }
    }
    if (deps.monotonic() >= deadline) return null
    await deps.sleep(LOCK_POLL_MS)
  }
}

function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && normalizeProcessStart(a.start) === normalizeProcessStart(b.start)
}

/**
 * Report every unreported attempt whose writer can no longer report it: one
 * that is gone, or this process's own attempt whose report failed earlier.
 * A live writer's attempt is its own to report. Settled entries are pruned.
 */
export async function recoverDeliveryJournal(deps: SequencerDeps): Promise<number> {
  const liveness = deps.liveness ?? ((identity: ProcessIdentity) => processIdentityLiveness(identity))
  let reported = 0
  for (const entry of readDeliveryJournal(deps.sessionId, deps.env)) {
    if (entry.reported !== undefined || inFlight.has(entry.attempt_id)) continue
    const own = sameProcess(entry.writer, deps.writer)
    if (!own && liveness(entry.writer) !== 'gone') continue
    const outcome = recoveredOutcome(entry.stage)
    if (await reportAttempt(deps, entry.attempt_id, outcome, own ? 'retry' : 'recovered')) reported += 1
  }
  const cutoff = deps.wall() - JOURNAL_KEEP_MS
  updateDeliveryJournal(deps.sessionId, deps.env, (entries) =>
    entries
      .filter((entry) => entry.reported === undefined || (entry.reported_at ?? entry.claimed_at) >= cutoff)
      .slice(-JOURNAL_CAP),
  )
  return reported
}

/** Report one outcome and record it; false leaves the entry for a later recovery. */
async function reportAttempt(
  deps: SequencerDeps,
  attemptId: string,
  outcome: DeliveryAttemptOutcome,
  source: 'writer' | 'retry' | 'recovered',
): Promise<boolean> {
  let stored: DeliveryAttemptOutcome
  try {
    stored = (await deps.client.reportDeliveryAttempt(attemptId, { outcome })).outcome
  } catch (err) {
    if (!(err instanceof ApiCallError && err.status === 404)) {
      deps.log?.error('delivery.handoff', {
        attempt_id: attemptId,
        outcome,
        source,
        reported: false,
        message: err instanceof Error ? err.message : String(err),
      })
      return false
    }
    // The service keeps no such attempt from this machine; nothing is owed.
    stored = outcome
  }
  const at = deps.wall()
  updateDeliveryJournal(deps.sessionId, deps.env, (entries) =>
    entries.map((entry) =>
      entry.attempt_id === attemptId ? { ...entry, reported: stored, reported_at: at } : entry,
    ),
  )
  deps.log?.info('delivery.handoff', {
    attempt_id: attemptId,
    outcome,
    source,
    reported: true,
    ...(stored === outcome ? {} : { stored }),
  })
  return true
}

/**
 * The Answer Edit release proof: this machine's journal names the writer of
 * the fenced answer's latest attempt, and that process is gone. Claimed writes
 * are in-process, so a gone writer leaves nothing that can still write.
 * Deadline expiry alone is never proof.
 */
export function answerWriterGone(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  requestId: string,
  liveness: (identity: ProcessIdentity) => ProcessLiveness = (identity) => processIdentityLiveness(identity),
): boolean {
  const entry = readDeliveryJournal(sessionId, env)
    .filter((candidate) => candidate.subject.type === 'answer' && candidate.subject.request_id === requestId)
    .at(-1)
  return entry !== undefined && !inFlight.has(entry.attempt_id) && liveness(entry.writer) === 'gone'
}

async function claimOne(
  deps: SequencerDeps,
  lease: DeliveryLease,
  subject: HandOffSubject,
  earlierAnswerWriterGone: boolean,
): Promise<{ attempt: ClaimedAttempt } | { reason: ClaimRefusal }> {
  const body: ClaimDeliveryAttemptRequestT = {
    incarnation: lease.incarnation,
    generation: lease.generation,
    subject,
    ...(earlierAnswerWriterGone ? { earlier_answer_writer_gone: true as const } : {}),
  }
  // One retry on transport failure: the service replays the same attempt to
  // the same claimant while its deadline stands, so a lost response costs
  // nothing.
  for (let attempt = 1; ; attempt += 1) {
    const sentAt = deps.monotonic()
    try {
      const claimed = await deps.client.claimDeliveryAttempt(deps.sessionId, body)
      return {
        attempt: {
          attemptId: claimed.attempt_id,
          subject,
          deadline: sentAt + claimed.claim_remaining_ms,
        },
      }
    } catch (err) {
      if (err instanceof ApiCallError) {
        if (err.status === 404) return { reason: 'not_found' }
        if (err.status === 409 && err.code === 'claim_refused') return { reason: refusalReason(err.details) }
        if (err.status < 500 && err.status !== 408 && err.status !== 429) return { reason: 'unavailable' }
      } else if (!(err instanceof NetworkError)) {
        return { reason: 'unavailable' }
      }
      if (attempt >= 2) return { reason: 'unavailable' }
    }
  }
}

function refusalReason(details: unknown): ClaimRefusal {
  const reason = (details as { reason?: unknown } | null)?.reason
  return typeof reason === 'string' && (DELIVERY_CLAIM_REFUSAL_REASONS as readonly string[]).includes(reason)
    ? (reason as DeliveryClaimRefusalReason)
    : 'not_claimable'
}

/**
 * Claim `subjects` for one write under the session's delivery lock. Null when
 * the lock stayed with another writer past `lockWaitMs`; the caller writes
 * nothing claimed then.
 */
export async function beginHandOff(
  deps: SequencerDeps,
  request: {
    lease: DeliveryLease
    subjects: readonly HandOffSubject[]
    /** Answer Edits: attach the writer-gone proof for this subject's fenced answer. */
    earlierAnswerWriterGone?: (subject: HandOffSubject) => boolean
    /** Re-checked at `begin`, after the claim deadlines. */
    mayWrite?: () => boolean
    lockWaitMs?: number
  },
): Promise<HandOff | null> {
  const lock = await acquireDeliveryLock(deps, request.lockWaitMs)
  if (lock === null) return null
  const claimed: ClaimedAttempt[] = []
  const refused: Array<{ subject: HandOffSubject; reason: ClaimRefusal }> = []
  try {
    await recoverDeliveryJournal(deps)
    for (const subject of request.subjects) {
      const result = await claimOne(deps, request.lease, subject, request.earlierAnswerWriterGone?.(subject) ?? false)
      if ('reason' in result) {
        refused.push({ subject, reason: result.reason })
        deps.log?.info('delivery.claimed', { ...subjectFields(subject), claimed: false, reason: result.reason })
        continue
      }
      claimed.push(result.attempt)
      inFlight.add(result.attempt.attemptId)
      const entry: DeliveryJournalEntry = {
        attempt_id: result.attempt.attemptId,
        subject,
        stage: 'claimed',
        writer: deps.writer,
        claimed_at: deps.wall(),
      }
      updateDeliveryJournal(deps.sessionId, deps.env, (entries) => [...entries, entry])
      deps.log?.info('delivery.claimed', {
        ...subjectFields(subject),
        claimed: true,
        attempt_id: result.attempt.attemptId,
        generation: request.lease.generation,
      })
    }
  } catch (err) {
    // Journal I/O failed around a claim: give back what was claimed, unwritten.
    await settle(deps, claimed, 'released', lock)
    throw err
  }

  let began = false
  let finished = false
  const attemptIds = new Set(claimed.map((attempt) => attempt.attemptId))
  return {
    claimed,
    refused,
    begin: (commit) => {
      if (finished) return false
      if (began) return true
      const now = deps.monotonic()
      if (claimed.some((attempt) => now >= attempt.deadline - DELIVERY_WRITE_MARGIN_MS)) {
        deps.log?.info('delivery.handoff', { attempts: claimed.length, began: false, reason: 'claim-deadline' })
        return false
      }
      if (request.mayWrite !== undefined && !request.mayWrite()) return false
      if (commit !== undefined && !commit()) return false
      if (claimed.length > 0) setStage(deps, attemptIds, 'writing')
      began = true
      return true
    },
    finish: async (result) => {
      if (finished) return
      finished = true
      // A write that began and did not complete may have reached the harness.
      const stage: DeliveryJournalStage = !began ? 'released' : result === 'written' ? 'written' : 'failed'
      await settle(deps, claimed, stage, lock)
    },
  }
}

async function settle(
  deps: SequencerDeps,
  claimed: readonly ClaimedAttempt[],
  stage: DeliveryJournalStage,
  lock: { release(): void },
): Promise<void> {
  try {
    if (claimed.length > 0) setStage(deps, new Set(claimed.map((attempt) => attempt.attemptId)), stage)
  } finally {
    lock.release()
  }
  const outcome = recoveredOutcome(stage)
  for (const attempt of claimed) {
    let reported = false
    for (let round = 0; round < 3 && !reported; round += 1) {
      if (round > 0) await deps.sleep(1_000 * round)
      reported = await reportAttempt(deps, attempt.attemptId, outcome, 'writer')
    }
    // Unreported stays in the journal; this process or the next lock holder
    // reports it, and until then the service treats the outcome as pending.
    inFlight.delete(attempt.attemptId)
  }
}

function subjectFields(subject: HandOffSubject): Record<string, string> {
  return subject.type === 'answer'
    ? { subject: 'answer', request_id: subject.request_id }
    : { subject: 'session_message', message_id: subject.message_id }
}

function isJournalEntry(value: unknown): value is DeliveryJournalEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  const writer = entry['writer'] as Record<string, unknown> | undefined
  const subject = entry['subject'] as Record<string, unknown> | undefined
  return (
    typeof entry['attempt_id'] === 'string' &&
    typeof entry['stage'] === 'string' &&
    ['claimed', 'writing', 'written', 'failed', 'released'].includes(entry['stage']) &&
    typeof writer?.['pid'] === 'number' &&
    typeof writer['start'] === 'string' &&
    ((subject?.['type'] === 'answer' && typeof subject['request_id'] === 'string') ||
      (subject?.['type'] === 'session_message' && typeof subject['message_id'] === 'string'))
  )
}
