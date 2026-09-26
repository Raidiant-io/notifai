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
 * A claimed write is made in-process (the inbox-socket line) or by a harness
 * subprocess the writer starts in its own process group and waits for (a cold
 * resume). A subprocess write is journaled as such before it starts and its
 * group as soon as it exists: the Answer Edit release rule relies on "writer
 * gone" meaning nothing it started can still write, so a subprocess write
 * without a recorded group is never proven gone.
 *
 * Local only: PIDs and process start times never leave this machine.
 */
import type {
  ClaimDeliveryAttemptRequestT,
  DeliveryAttemptOutcome,
  DeliveryClaimRefusalReason,
} from '@raidiant/notifai-protocol'
import { DELIVERY_CLAIM_REFUSAL_REASONS } from '@raidiant/notifai-protocol'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

/** A write must be committed at least this long before its claim deadline. */
export const DELIVERY_WRITE_MARGIN_MS = 2_000

/** The first byte of a write must leave at least this long before the deadline. */
export const DELIVERY_WRITE_BOUNDARY_MS = 500

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
  /** The write is a harness subprocess the writer started; see `groups`. */
  subprocess?: true
  /** Process groups of that subprocess, recorded as soon as they exist. */
  groups?: number[]
  /**
   * A selected answer this machine wrote without a claim: no attempt exists
   * until it is recorded after the fact. Whoever holds the journal records it;
   * the write already happened, so the writer's liveness does not matter.
   */
  unclaimed?: true
  /** Why the service refused to record it; nothing more is owed. */
  refused?: string
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
  /** Test seam: whether any process of a recorded process group still runs. */
  groupAlive?: (pgid: number) => boolean
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
   * caller's own last fence, run after every check) refused. The deadline is
   * checked again after everything `begin` persisted. True with no claims
   * leaves the choice to write unclaimed with the caller. `subprocess` marks a
   * write made by a harness subprocess; record its group with `recordGroup`.
   */
  begin(commit?: () => boolean, options?: { subprocess?: boolean }): boolean
  /**
   * Checked at the write itself (a connected socket, before its first byte):
   * true while every claim still leaves `DELIVERY_WRITE_BOUNDARY_MS`.
   */
  writable(): boolean
  /** Milliseconds until the write boundary passes; Infinity without claims. */
  remainingMs(): number
  /** Journal the process group of a subprocess write the moment it exists. */
  recordGroup(pgid: number): void
  /**
   * Journal how the write ended, release the lock, then report every attempt.
   * `aborted`: the write began but was stopped before any byte left.
   */
  finish(result: 'written' | 'not-written' | 'failed' | 'aborted'): Promise<void>
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
    if (!reportable(entry, deps.writer, liveness)) continue
    if (entry.unclaimed === true) {
      if (await recordUnclaimed(deps, entry)) reported += 1
      continue
    }
    const own = sameProcess(entry.writer, deps.writer)
    const outcome = recoveredOutcome(entry.stage)
    if (await reportAttempt(deps, entry.attempt_id, outcome, own ? 'retry' : 'recovered')) reported += 1
  }
  const cutoff = deps.wall() - JOURNAL_KEEP_MS
  updateDeliveryJournal(deps.sessionId, deps.env, (entries) => {
    // Unsettled entries are never pruned; settled ones age out and are capped.
    const settled = entries.filter(
      (entry) => entry.reported !== undefined && (entry.reported_at ?? entry.claimed_at) >= cutoff,
    )
    const keep = new Set(settled.slice(-JOURNAL_CAP))
    return entries.filter((entry) => entry.reported === undefined || keep.has(entry))
  })
  return reported
}

/** Whether a recovery may report this entry now. */
function reportable(
  entry: DeliveryJournalEntry,
  self: ProcessIdentity,
  liveness: (identity: ProcessIdentity) => ProcessLiveness,
): boolean {
  if (entry.reported !== undefined || inFlight.has(entry.attempt_id)) return false
  if (entry.unclaimed === true) return true
  return sameProcess(entry.writer, self) || liveness(entry.writer) === 'gone'
}

/**
 * Journal selected answers just written without a claim, then record each
 * with the service. A failed record stays in the journal: the next hand-off in
 * this session, or the machine-wide sweep, records it later.
 */
export async function recordUnclaimedHandOffs(
  deps: SequencerDeps,
  requestIds: readonly string[],
): Promise<boolean> {
  if (requestIds.length === 0) return true
  const entries: DeliveryJournalEntry[] = requestIds.map((requestId) => ({
    attempt_id: `unclaimed:${requestId}`,
    subject: { type: 'answer', request_id: requestId },
    stage: 'written',
    writer: deps.writer,
    unclaimed: true,
    claimed_at: deps.wall(),
  }))
  updateDeliveryJournal(deps.sessionId, deps.env, (current) => [
    ...current.filter((entry) => !entries.some((added) => added.attempt_id === entry.attempt_id)),
    ...entries,
  ])
  let recorded = true
  for (const entry of entries) recorded = (await recordUnclaimed(deps, entry)) && recorded
  return recorded
}

async function recordUnclaimed(deps: SequencerDeps, entry: DeliveryJournalEntry): Promise<boolean> {
  if (entry.subject.type !== 'answer') return false
  const requestId = entry.subject.request_id
  let settled: Partial<DeliveryJournalEntry>
  try {
    const recorded = await deps.client.claimDeliveryAttempt(deps.sessionId, {
      subject: { type: 'answer', request_id: requestId },
      already_handed_off: true,
    })
    settled = { reported: 'handed_off' }
    deps.log?.info('delivery.handoff', {
      subject: 'answer',
      request_id: requestId,
      attempt_id: recorded.attempt_id,
      outcome: 'handed_off',
      source: 'after-the-fact',
      reported: true,
    })
  } catch (err) {
    const refusal =
      err instanceof ApiCallError && err.status === 409 && err.code === 'claim_refused'
        ? refusalReason(err.details)
        : err instanceof ApiCallError && err.status === 404
          ? 'not_found'
          : null
    deps.log?.error('delivery.handoff', {
      subject: 'answer',
      request_id: requestId,
      outcome: 'handed_off',
      source: 'after-the-fact',
      reported: false,
      ...(refusal === null ? {} : { refused: refusal }),
      message: err instanceof Error ? err.message : String(err),
    })
    // A transport failure, or another attempt still pending, stays owed: that
    // attempt may yet report `released`, and then this write must be recorded.
    // Every other refusal is final (another attempt settled the answer, this
    // machine does not own the lease, or the answer was never selected).
    if (refusal === null || refusal === 'attempt_pending') return false
    settled = { reported: 'released', refused: refusal }
  }
  const at = deps.wall()
  updateDeliveryJournal(deps.sessionId, deps.env, (entries) =>
    entries.map((candidate) =>
      candidate.attempt_id === entry.attempt_id ? { ...candidate, ...settled, reported_at: at } : candidate,
    ),
  )
  return settled.reported === 'handed_off'
}

/** At most this often per machine, and at most this many journals per sweep. */
export const JOURNAL_SWEEP_INTERVAL_MS = 10 * 60_000
export const JOURNAL_SWEEP_MAX_JOURNALS = 20
/** Journals read per sweep while looking for those that owe something. */
export const JOURNAL_SWEEP_MAX_SCANNED = 500

/**
 * Report, from any hook that already holds a client, the attempts that dead
 * writers left in any session's journal on this machine. A session that never
 * runs again has no next hand-off to recover its journal, and until someone
 * reports, the service keeps those attempts pending (holding their Answer
 * Edits, or a claimed Session Message until its abandonment sweep).
 *
 * Bounded: rate-limited by a stamp file, a fixed number of journals read and
 * recovered per sweep. Only journals that owe something reportable now are
 * recovered, oldest first, so none can be starved. Gone writers' attempts and
 * unrecorded unclaimed hand-offs are reported; a live writer reports its own.
 */
export async function sweepDeliveryJournals(input: {
  env: NodeJS.ProcessEnv
  client: ApiClient
  writer: ProcessIdentity
  now: number
  log?: Logger
  liveness?: (identity: ProcessIdentity) => ProcessLiveness
  force?: boolean
}): Promise<number> {
  const directory = path.join(stateDir(input.env), 'sessions')
  const stamp = path.join(stateDir(input.env), 'last-delivery-sweep')
  if (input.force !== true) {
    try {
      if (existsSync(stamp) && input.now - statSync(stamp).mtimeMs < JOURNAL_SWEEP_INTERVAL_MS) return 0
    } catch {
      return 0
    }
  }
  if (!existsSync(directory)) return 0
  mkdirSync(path.dirname(stamp), { recursive: true })
  let cursor = ''
  try {
    cursor = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : ''
  } catch {
    cursor = ''
  }
  writeFileSync(stamp, cursor, { mode: 0o600 })
  // Read journals round-robin from where the last sweep stopped, so every
  // journal is eventually looked at however many settled ones accumulate, and
  // recover only those that owe something reportable now: settled journals and
  // newer debt can never starve an older one out.
  const liveness = input.liveness ?? ((identity: ProcessIdentity) => processIdentityLiveness(identity))
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.deliveries'))
    .sort()
  const start = Math.max(0, names.findIndex((name) => name > cursor))
  const rotated = [...names.slice(start), ...names.slice(0, start)]
  const candidates = rotated.slice(0, JOURNAL_SWEEP_MAX_SCANNED).map((name) => ({ file: path.join(directory, name), name }))
  const owing: string[] = []
  let scanned = 0
  for (const { file } of candidates) {
    if (owing.length >= JOURNAL_SWEEP_MAX_JOURNALS) break
    scanned += 1
    let sessionId: unknown
    try {
      sessionId = (JSON.parse(readFileSync(file, 'utf8')) as { session_id?: unknown }).session_id
    } catch {
      continue
    }
    if (typeof sessionId !== 'string' || deliveryJournalPath(sessionId, input.env) !== file) continue
    if (readDeliveryJournal(sessionId, input.env).some((entry) => reportable(entry, input.writer, liveness))) {
      owing.push(sessionId)
    }
  }
  const last = candidates[scanned - 1]?.name
  if (last !== undefined) writeFileSync(stamp, last, { mode: 0o600 })
  let reported = 0
  for (const sessionId of owing) {
    reported += await recoverDeliveryJournal({
      sessionId,
      env: input.env,
      client: input.client,
      monotonic: () => performance.now(),
      wall: () => input.now,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      writer: input.writer,
      ...(input.log === undefined ? {} : { log: input.log }),
      ...(input.liveness === undefined ? {} : { liveness: input.liveness }),
    })
  }
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
  groupAlive: (pgid: number) => boolean = processGroupAlive,
): boolean {
  const entry = readDeliveryJournal(sessionId, env)
    .filter((candidate) => candidate.subject.type === 'answer' && candidate.subject.request_id === requestId)
    .at(-1)
  if (entry === undefined || inFlight.has(entry.attempt_id) || liveness(entry.writer) !== 'gone') return false
  if (entry.subprocess !== true) return true
  // A subprocess write is gone only when its whole recorded group is.
  return (entry.groups?.length ?? 0) > 0 && entry.groups!.every((pgid) => !groupAlive(pgid))
}

/** Signal 0 to a process group: ESRCH means no process of it remains. */
export function processGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return true
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * The answers of this batch whose earlier hand-off already began a write: a
 * restart must never write them again, since the harness has no dedup key.
 */
export function answersAlreadyWritten(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  requestIds: readonly string[],
): Array<{ requestId: string; stage: DeliveryJournalStage }> {
  const wanted = new Set(requestIds)
  const found = new Map<string, DeliveryJournalStage>()
  for (const entry of readDeliveryJournal(sessionId, env)) {
    if (entry.subject.type !== 'answer' || !wanted.has(entry.subject.request_id)) continue
    if (entry.stage === 'writing' || entry.stage === 'failed' || entry.stage === 'written') {
      found.set(entry.subject.request_id, entry.stage)
    }
  }
  return [...found].map(([requestId, stage]) => ({ requestId, stage }))
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
  const earliest = Math.min(...claimed.map((attempt) => attempt.deadline))
  const committable = (): boolean => deps.monotonic() < earliest - DELIVERY_WRITE_MARGIN_MS
  return {
    claimed,
    refused,
    begin: (commit, options = {}) => {
      if (finished) return false
      if (began) return true
      if (!committable()) {
        deps.log?.info('delivery.handoff', { attempts: claimed.length, began: false, reason: 'claim-deadline' })
        return false
      }
      if (request.mayWrite !== undefined && !request.mayWrite()) return false
      // The lease check can block; the caller's fence must not run late.
      if (!committable()) {
        deps.log?.info('delivery.handoff', { attempts: claimed.length, began: false, reason: 'claim-deadline' })
        return false
      }
      if (commit !== undefined && !commit()) return false
      if (claimed.length > 0) {
        updateDeliveryJournal(deps.sessionId, deps.env, (entries) =>
          entries.map((entry) =>
            attemptIds.has(entry.attempt_id)
              ? { ...entry, stage: 'writing' as const, ...(options.subprocess === true ? { subprocess: true as const } : {}) }
              : entry,
          ),
        )
        // Everything above may have blocked: the deadline holds after it too.
        if (!committable()) {
          updateDeliveryJournal(deps.sessionId, deps.env, (entries) =>
            entries.map((entry) => {
              if (!attemptIds.has(entry.attempt_id)) return entry
              const reverted: DeliveryJournalEntry = { ...entry, stage: 'claimed' }
              delete reverted.subprocess
              return reverted
            }),
          )
          deps.log?.info('delivery.handoff', { attempts: claimed.length, began: false, reason: 'claim-deadline' })
          return false
        }
      }
      began = true
      return true
    },
    writable: () => claimed.length === 0 || deps.monotonic() < earliest - DELIVERY_WRITE_BOUNDARY_MS,
    remainingMs: () =>
      claimed.length === 0 ? Number.POSITIVE_INFINITY : Math.max(0, earliest - DELIVERY_WRITE_BOUNDARY_MS - deps.monotonic()),
    recordGroup: (pgid) => {
      if (claimed.length === 0) return
      updateDeliveryJournal(deps.sessionId, deps.env, (entries) =>
        entries.map((entry) =>
          attemptIds.has(entry.attempt_id) ? { ...entry, groups: [...new Set([...(entry.groups ?? []), pgid])] } : entry,
        ),
      )
    },
    finish: async (result) => {
      if (finished) return
      finished = true
      // A write that began and did not complete may have reached the harness,
      // unless it was stopped before its first byte left.
      const stage: DeliveryJournalStage =
        !began || result === 'aborted' ? 'released' : result === 'written' ? 'written' : 'failed'
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
