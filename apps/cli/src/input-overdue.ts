/**
 * Nothing holds a User's answer or Session Note silently. Every delivery path
 * keeps trying on its own terms; this is the one rule above them all. Input that
 * has waited too long is logged as a fault and the User is told once, in plain
 * words, what brings it in.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { CAPABILITIES_V1, validateDraft, type LifecycleT, type NotificationKind } from '@raidiant/notifai-protocol'
import { atomicWriteFileSync } from './atomic-file.js'
import type { ApiClient } from './client.js'
import { loadConfig, stateDir } from './config.js'
import { withFileLock } from './file-lock.js'
import { readSessionState, updateSessionState } from './hook-session-state.js'
import type { SessionState } from './hook-types.js'
import type { Logger } from './logging.js'
import { projectBinding, projectEnablementState } from './project-enablement.js'
import { buildDraft } from './send.js'
import { pendingInputCounts, recordInputWakeFailure } from './session-inputs.js'
import type { DeliveryLease } from './session-delivery.js'

/** The session looks free, so nothing it is doing explains the wait. */
export const INPUT_OVERDUE_MS = 5 * 60_000
/** The session is working: a long tool or model step can rightly keep input waiting this long. */
export const INPUT_OVERDUE_BUSY_MS = 30 * 60_000

export const INPUT_OVERDUE_TITLE = 'Not delivered yet'

export function inputOverdueSummary(pending: { answers: number; messages: number }): string {
  if (pending.answers > 0 && pending.messages > 0) return "Your answer and note haven't reached the agent yet. Type anything in its session to deliver them."
  if (pending.messages > 0) return `${pending.messages > 1 ? 'Your notes haven\'t' : 'Your note hasn\'t'} reached the agent yet. Type anything in its session to deliver ${pending.messages > 1 ? 'them' : 'it'}.`
  return `${pending.answers > 1 ? 'Your answers haven\'t' : 'Your answer hasn\'t'} reached the agent yet. Type anything in its session to deliver ${pending.answers > 1 ? 'them' : 'it'}.`
}

/** Longer than any watching loop's pause: nothing watched meanwhile, so the machine slept. */
const ASLEEP_GAP_MS = 60_000
const CHECK_RECORD_MS = 10_000

/**
 * Note when input started waiting, and when the session was last seen free to
 * take it, or clear the record once nothing waits. Time the machine slept does
 * not count: nothing could have delivered it, and the User should not be told on
 * waking about input the session is about to take.
 */
export function trackInputWaiting(sessionId: string, env: NodeJS.ProcessEnv, waiting: boolean, now: number, busy = false): SessionState['input_waiting'] {
  const current = readSessionState(sessionId, env).input_waiting
  if (!waiting && current === undefined) return current
  if (waiting && current !== undefined && (current.free_since === undefined) === busy &&
      now - (current.checked_at ?? current.since) < CHECK_RECORD_MS) return current
  let tracked: SessionState['input_waiting']
  updateSessionState(sessionId, env, (state) => {
    const existing = state.input_waiting
    if (!waiting) {
      tracked = undefined
      if (existing === undefined) return state
      const next = { ...state }
      delete next.input_waiting
      return next
    }
    if (existing === undefined) {
      tracked = { since: now, checked_at: now, ...(busy ? {} : { free_since: now }) }
      return { ...state, input_waiting: tracked }
    }
    const gap = now - (existing.checked_at ?? existing.since)
    const slept = gap >= ASLEEP_GAP_MS ? gap : 0
    const { free_since: wasFree, ...rest } = existing
    const freeSince = busy ? undefined : wasFree === undefined ? now : wasFree + slept
    tracked = { ...rest, since: existing.since + slept, checked_at: now, ...(freeSince === undefined ? {} : { free_since: freeSince }) }
    return { ...state, input_waiting: tracked }
  })
  return tracked
}

/**
 * Overdue once input has waited the working bound whatever the session did, or
 * the free bound while the session sat free to take it. A session that has just
 * come free is about to take it, so the time it spent working never counts
 * toward the shorter bound.
 */
export function inputOverdue(tracked: NonNullable<SessionState['input_waiting']>, busy: boolean, now: number): boolean {
  if (tracked.notified_at !== undefined) return false
  if (now - tracked.since >= INPUT_OVERDUE_BUSY_MS) return true
  if (busy || tracked.free_since === undefined) return false
  return now - Math.max(tracked.since, tracked.free_since) >= INPUT_OVERDUE_MS
}

export interface InputOverdueNotice {
  sessionId: string
  env: NodeJS.ProcessEnv
  cwd: string | null
  harness: string
  pending: { answers: number; messages: number }
  /** Why it is waiting, for the log. Never shown to the User. */
  reason: string
  now: number
  client: ApiClient | null
  logger: Logger
}

/**
 * Log the fault and tell the User. Marked told only once the service took the
 * notice, and a retry repeats its idempotency key, so a failed send tries again
 * at the next check and the User still hears once.
 */
export async function reportInputOverdue(notice: InputOverdueNotice): Promise<void> {
  const { sessionId, env, logger, now } = notice
  const tracked = readSessionState(sessionId, env).input_waiting
  if (tracked === undefined || tracked.notified_at !== undefined) return
  logger.error('delivery.overdue', { session: sessionId, reason: notice.reason, waited_ms: now - tracked.since,
    answers: notice.pending.answers, messages: notice.pending.messages })
  recordInputWakeFailure(sessionId, env, 'overdue', now, undefined, logger)
  const mark = (outcome: string, sent: SentNotice | null): void => {
    logger.info('delivery.overdue', { session: sessionId, stage: 'user-told', outcome })
    updateSessionState(sessionId, env, (state) => {
      const next = state.input_waiting === undefined ? { ...state } : { ...state, input_waiting: { ...state.input_waiting, notified_at: now } }
      // Input handed in while this was sending finds the record at the next check, which takes the notice down.
      if (sent !== null) {
        next.input_overdue_notice = { ...sent, told_at: now, cwd: notice.cwd, harness: notice.harness,
          answers: notice.pending.answers, messages: notice.pending.messages }
      }
      return next
    })
  }
  try {
    const collapseKey = `notifai-overdue-${randomBytes(8).toString('base64url')}`
    const outcome = await sendNotice(notice, { summary: inputOverdueSummary(notice.pending), idempotencyKey: `overdue-${tracked.since}-${sessionId}`, collapseKey })
    if (outcome.kind !== 'no-service') mark(outcome.kind, outcome.kind === 'sent' ? { request_id: outcome.requestId, collapse_key: collapseKey } : null)
  } catch (err) {
    logger.info('delivery.overdue', { session: sessionId, stage: 'notice-failed', message: err instanceof Error ? err.message : String(err) })
  }
}

type NoticeContext = Pick<InputOverdueNotice, 'sessionId' | 'env' | 'cwd' | 'harness' | 'client' | 'logger'>
type SentNotice = { request_id: string; collapse_key: string }
type NoticeOutcome = { kind: 'sent'; requestId: string } | { kind: 'no-service' | 'project-disabled' | 'not-built' }

async function sendNotice(notice: NoticeContext, options: { summary: string; idempotencyKey: string; collapseKey?: string;
  lifecycle?: LifecycleT; title?: string; kind?: NotificationKind }): Promise<NoticeOutcome> {
  const { summary, idempotencyKey, lifecycle } = options
  const collapseKey = options.collapseKey ?? `notifai-overdue-${randomBytes(8).toString('base64url')}`
  const { sessionId, env } = notice
  const cwd = notice.cwd ?? process.cwd()
  const config = loadConfig({ cwd, env, sessionId })
  const binding = projectBinding(cwd, env, config.project.value)
  // A retirement is not news: it only takes down what was already shown.
  if (lifecycle === undefined && binding !== null && projectEnablementState(binding) === 'disabled') return { kind: 'project-disabled' }
  if (notice.client === null) return { kind: 'no-service' }
  const build = buildDraft(config, { title: options.title ?? INPUT_OVERDUE_TITLE, summary, kind: options.kind ?? 'blocked', collapseKey,
    ...(lifecycle === undefined ? {} : { lifecycle }) }, { source: { session_id: sessionId, harness: notice.harness } })
  if (!build.ok) { notice.logger.error('delivery.overdue', { session: sessionId, stage: 'notice-not-built', message: build.error }); return { kind: 'not-built' } }
  const capabilities = CAPABILITIES_V1.describe(build.platform)
  if (capabilities === null || !validateDraft(build.draft, capabilities).ok) return { kind: 'not-built' }
  const receipt = await notice.client.submit({ idempotency_key: idempotencyKey.slice(0, 128), draft: build.draft }, 0)
  return { kind: 'sent', requestId: receipt.request_id }
}

export const INPUT_DELIVERED_SUMMARY = 'Your input reached the agent.'
export const INPUT_FOLLOWED_SUMMARY = 'Your input went on to where the conversation continues.'
export const INPUT_NOT_DELIVERED_TITLE = 'Not delivered'

/** What the User was told was waiting, said again once Notifai stops trying: it never arrived. */
export function inputNeverDeliveredSummary(pending: { answers?: number | undefined; messages?: number | undefined }): string {
  const answers = pending.answers ?? 0
  const messages = pending.messages ?? 0
  const what = answers > 0 && messages > 0 ? 'Your answer and note'
    : messages > 1 ? 'Your notes' : messages > 0 ? 'Your note'
      : answers > 1 ? 'Your answers' : answers > 0 ? 'Your answer' : 'Your input'
  return `${what} never reached the agent, so ${answers + messages > 1 || (answers > 0 && messages > 0) ? 'they were' : 'it was'} dropped.`
}

type NoticeRecord = NonNullable<SessionState['input_overdue_notice']>
/**
 * How a "not delivered yet" notice ends. `delivered` and `followed` take it
 * down: the input reached the agent, or went on with the conversation to its
 * continuation. `dropped` replaces it in place with one saying the input never
 * arrived, so the User is never left told to type in a session that is gone.
 */
export type InputNoticeEnd = 'delivered' | 'followed' | 'dropped'

/** One send per notice and ending, whoever sends it and however often it is retried. */
async function sendNoticeEnd(notice: NoticeContext, sent: NoticeRecord, end: InputNoticeEnd): Promise<NoticeOutcome> {
  if (end === 'dropped') {
    return sendNotice(notice, { summary: inputNeverDeliveredSummary(sent), idempotencyKey: `overdue-dropped-${sent.request_id}`,
      collapseKey: sent.collapse_key, title: INPUT_NOT_DELIVERED_TITLE, kind: 'failed' })
  }
  return sendNotice(notice, { summary: end === 'followed' ? INPUT_FOLLOWED_SUMMARY : INPUT_DELIVERED_SUMMARY,
    idempotencyKey: `overdue-${end === 'followed' ? 'followed' : 'retire'}-${sent.request_id}`, collapseKey: sent.collapse_key,
    lifecycle: { tier: 'done', retires_request_id: sent.request_id } })
}

/**
 * The input a notice said was stuck is no longer waiting: take the notice down
 * on every device, or, when Notifai dropped it, say so in its place. Sent once;
 * a failed send keeps the record and tries again at the next check.
 */
async function endInputOverdueNotice(notice: NoticeContext, sent: NoticeRecord, end: InputNoticeEnd): Promise<void> {
  const { sessionId, env, logger } = notice
  try {
    const outcome = await sendNoticeEnd(notice, sent, end)
    if (outcome.kind === 'no-service') return
    logger.info('delivery.overdue', { session: sessionId, stage: end === 'dropped' ? 'notice-dropped' : 'notice-retired', outcome: outcome.kind, request_id: sent.request_id })
    updateSessionState(sessionId, env, (state) => {
      if (state.input_overdue_notice?.request_id !== sent.request_id) return state
      const next = { ...state }
      delete next.input_overdue_notice
      return next
    })
  } catch (err) {
    logger.info('delivery.overdue', { session: sessionId, stage: 'retire-failed', message: err instanceof Error ? err.message : String(err) })
  }
}

/** Notifai gave up on input the User was told is waiting (its window ended): the notice must say so. */
export function noticeInputDropped(state: SessionState, now: number): SessionState {
  const notice = state.input_overdue_notice
  return notice === undefined || notice.dropped_at !== undefined ? state : { ...state, input_overdue_notice: { ...notice, dropped_at: now } }
}

// -- Notices of ended sessions --------------------------------------------------
//
// An ended session's records go with it, and nothing watches it any more, so
// what its notice still owes the User is queued machine-wide, for whichever
// process next holds a client.

interface QueuedNoticeEnd {
  session_id: string
  end: InputNoticeEnd
  notice: NoticeRecord
  /** Where the session ran, for its config and Project, when the notice did not record it. */
  cwd: string | null
  harness: string
  queued_at: number
}

/** A notification lives a week at most; after that there is nothing left to correct. */
const NOTICE_END_TTL_MS = 7 * 24 * 60 * 60_000
const NOTICE_END_QUEUE_CAP = 50

function noticeEndQueuePath(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'input-notice-ends.json')
}

function readNoticeEndQueue(env: NodeJS.ProcessEnv): QueuedNoticeEnd[] {
  const file = noticeEndQueuePath(env)
  if (!existsSync(file)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((entry): entry is QueuedNoticeEnd =>
      typeof entry === 'object' && entry !== null && typeof (entry as QueuedNoticeEnd).notice?.request_id === 'string') : []
  } catch { return [] }
}

function updateNoticeEndQueue(env: NodeJS.ProcessEnv, update: (queue: QueuedNoticeEnd[]) => QueuedNoticeEnd[]): void {
  const file = noticeEndQueuePath(env)
  withFileLock(`${file}.lock`, () => { atomicWriteFileSync(file, `${JSON.stringify(update(readNoticeEndQueue(env)), null, 2)}\n`) })
}

/**
 * The session ends: queue what its notice owes, once per notice. Unless a
 * watched check saw the input gone (`cleared_at`), it goes with the session, so
 * the notice says it was dropped; a stopped session waits for its app, so
 * nothing it held was handed in. Input already handed in only has its notice
 * taken down. Returns the state without the notice. Call under the session's lock.
 */
export function queueInputNoticeAtEnd(env: NodeJS.ProcessEnv, sessionId: string, state: SessionState, now: number,
  fallback: { cwd: string | null; end?: InputNoticeEnd }): SessionState {
  const notice = state.input_overdue_notice
  if (notice === undefined) return state
  const end = fallback.end ?? (notice.cleared_at === undefined || notice.dropped_at !== undefined ? 'dropped' : 'delivered')
  updateNoticeEndQueue(env, (queue) => queue.some((entry) => entry.notice.request_id === notice.request_id) ? queue
    : [...queue, { session_id: sessionId, end, notice, cwd: notice.cwd ?? fallback.cwd, harness: notice.harness ?? state.harness ?? 'unknown', queued_at: now }]
      .slice(-NOTICE_END_QUEUE_CAP))
  const next = { ...state }
  delete next.input_overdue_notice
  return next
}

/** Send what ended sessions' notices owe. A failure stays queued for the next holder of a client. */
export async function drainInputNoticeEnds(ctx: { env: NodeJS.ProcessEnv; client: ApiClient | null; logger: Logger; now: number }): Promise<number> {
  const queue = readNoticeEndQueue(ctx.env)
  let sent = 0
  for (const entry of queue) {
    let done = ctx.now - entry.queued_at > NOTICE_END_TTL_MS
    if (!done) {
      try {
        const outcome = await sendNoticeEnd({ sessionId: entry.session_id, env: ctx.env, cwd: entry.cwd, harness: entry.harness, client: ctx.client, logger: ctx.logger },
          entry.notice, entry.end)
        if (outcome.kind === 'no-service') return sent
        ctx.logger.info('delivery.overdue', { session: entry.session_id, stage: entry.end === 'dropped' ? 'notice-dropped' : 'notice-retired',
          outcome: outcome.kind, request_id: entry.notice.request_id, session_ended: true })
        done = true
        sent += 1
      } catch (err) {
        ctx.logger.info('delivery.overdue', { session: entry.session_id, stage: 'retire-failed', message: err instanceof Error ? err.message : String(err) })
      }
    }
    if (done) updateNoticeEndQueue(ctx.env, (current) => current.filter((candidate) => candidate.notice.request_id !== entry.notice.request_id))
  }
  return sent
}

export const INPUT_DROPPED_SUMMARY = "Your answer couldn't reach the agent, so it was dropped. Tell the agent in its session."

/** A route gave up on an answer it could never hand over. The User must not think it arrived. */
export async function reportInputDropped(notice: NoticeContext & { requestIds: readonly string[] }): Promise<void> {
  notice.logger.error('delivery.overdue', { session: notice.sessionId, stage: 'dropped', request_ids: [...notice.requestIds] })
  try {
    await sendNotice(notice, { summary: INPUT_DROPPED_SUMMARY, idempotencyKey: `dropped-${notice.requestIds.join('-')}` })
  } catch (err) {
    notice.logger.info('delivery.overdue', { session: notice.sessionId, stage: 'notice-failed', message: err instanceof Error ? err.message : String(err) })
  }
}

const reporting = new Set<string>()

/**
 * One check, from whatever loop watches a session. `serviceMessages` counts notes
 * the service still offers this session because no writer could take them yet,
 * and `heldAnswers` adds answers a route is keeping for its own next chance
 * instead of the shared input queue. `excludeAnswers` is for answers something
 * else is returning itself, a picker's own result. `boundary` marks a check made
 * at a hook boundary (a prompt, a turn's end), which is when waiting input is
 * handed in: it tracks the wait but tells the User nothing, and the next check
 * finds whether the input really stayed behind.
 */
export function checkInputOverdue(input: Omit<InputOverdueNotice, 'pending' | 'reason'> & {
  lease: DeliveryLease | null; busy: boolean; reason: () => string
  serviceMessages?: number; heldAnswers?: boolean; excludeAnswers?: boolean; boundary?: boolean
}): void {
  const { sessionId, env, now } = input
  const local = pendingInputCounts(sessionId, env, input.lease)
  const state = readSessionState(sessionId, env)
  const held = input.heldAnswers === true && state.accepted !== undefined && state.accepted.delivered_at === undefined ? state.accepted.answers.length : 0
  const pending = {
    answers: input.excludeAnswers === true ? 0 : Math.max(local.answers, held),
    messages: Math.max(local.messages, input.serviceMessages ?? 0),
  }
  const waiting = pending.answers + pending.messages > 0
  const tracked = trackInputWaiting(sessionId, env, waiting, now, input.busy)
  if (reporting.has(sessionId)) return
  if (!waiting && state.input_overdue_notice !== undefined) {
    reporting.add(sessionId)
    const sent = state.input_overdue_notice
    // Seen gone while the session was watched: should it end before the notice comes down, it still only comes down.
    if (sent.cleared_at === undefined) {
      updateSessionState(sessionId, env, (current) => current.input_overdue_notice?.request_id !== sent.request_id ||
        current.input_overdue_notice.cleared_at !== undefined ? current : { ...current, input_overdue_notice: { ...current.input_overdue_notice, cleared_at: now } })
    }
    void endInputOverdueNotice(input, sent, sent.dropped_at === undefined ? 'delivered' : 'dropped').finally(() => { reporting.delete(sessionId) })
    return
  }
  if (tracked === undefined || input.boundary === true || !inputOverdue(tracked, input.busy, now)) return
  reporting.add(sessionId)
  void reportInputOverdue({ ...input, pending, reason: input.reason() }).finally(() => { reporting.delete(sessionId) })
}
