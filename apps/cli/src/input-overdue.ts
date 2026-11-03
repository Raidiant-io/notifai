/**
 * Nothing holds a User's answer or Session Note silently. Every delivery path
 * keeps trying on its own terms; this is the one rule above them all. Input that
 * has waited too long is logged as a fault and the User is told once, in plain
 * words, what brings it in.
 */
import { randomBytes } from 'node:crypto'
import { CAPABILITIES_V1, validateDraft, type LifecycleT } from '@raidiant/notifai-protocol'
import type { ApiClient } from './client.js'
import { loadConfig } from './config.js'
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
      if (sent !== null) next.input_overdue_notice = { ...sent, told_at: now }
      return next
    })
  }
  try {
    const collapseKey = `notifai-overdue-${randomBytes(8).toString('base64url')}`
    const outcome = await sendNotice(notice, inputOverdueSummary(notice.pending), `overdue-${tracked.since}-${sessionId}`, collapseKey)
    if (outcome.kind !== 'no-service') mark(outcome.kind, outcome.kind === 'sent' ? { request_id: outcome.requestId, collapse_key: collapseKey } : null)
  } catch (err) {
    logger.info('delivery.overdue', { session: sessionId, stage: 'notice-failed', message: err instanceof Error ? err.message : String(err) })
  }
}

type NoticeContext = Pick<InputOverdueNotice, 'sessionId' | 'env' | 'cwd' | 'harness' | 'client' | 'logger'>
type SentNotice = { request_id: string; collapse_key: string }
type NoticeOutcome = { kind: 'sent'; requestId: string } | { kind: 'no-service' | 'project-disabled' | 'not-built' }

async function sendNotice(notice: NoticeContext, summary: string, idempotencyKey: string,
  collapseKey = `notifai-overdue-${randomBytes(8).toString('base64url')}`, lifecycle?: LifecycleT): Promise<NoticeOutcome> {
  const { sessionId, env } = notice
  const cwd = notice.cwd ?? process.cwd()
  const config = loadConfig({ cwd, env, sessionId })
  const binding = projectBinding(cwd, env, config.project.value)
  // A retirement is not news: it only takes down what was already shown.
  if (lifecycle === undefined && binding !== null && projectEnablementState(binding) === 'disabled') return { kind: 'project-disabled' }
  if (notice.client === null) return { kind: 'no-service' }
  const build = buildDraft(config, { title: INPUT_OVERDUE_TITLE, summary, kind: 'blocked', collapseKey,
    ...(lifecycle === undefined ? {} : { lifecycle }) }, { source: { session_id: sessionId, harness: notice.harness } })
  if (!build.ok) { notice.logger.error('delivery.overdue', { session: sessionId, stage: 'notice-not-built', message: build.error }); return { kind: 'not-built' } }
  const capabilities = CAPABILITIES_V1.describe(build.platform)
  if (capabilities === null || !validateDraft(build.draft, capabilities).ok) return { kind: 'not-built' }
  const receipt = await notice.client.submit({ idempotency_key: idempotencyKey.slice(0, 128), draft: build.draft }, 0)
  return { kind: 'sent', requestId: receipt.request_id }
}

export const INPUT_DELIVERED_SUMMARY = 'Your input reached the agent.'

/**
 * The input a notice said was stuck is no longer waiting: take the notice down
 * on every device, so the User is not left reading a stale status. Silent, and
 * sent once; a failed send keeps the record and tries again at the next check.
 */
async function retireInputOverdueNotice(notice: NoticeContext, sent: NonNullable<SessionState['input_overdue_notice']>): Promise<void> {
  const { sessionId, env, logger } = notice
  try {
    const outcome = await sendNotice(notice, INPUT_DELIVERED_SUMMARY, `overdue-retire-${sent.request_id}`, sent.collapse_key,
      { tier: 'done', retires_request_id: sent.request_id })
    if (outcome.kind === 'no-service') return
    logger.info('delivery.overdue', { session: sessionId, stage: 'notice-retired', outcome: outcome.kind, request_id: sent.request_id })
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

export const INPUT_DROPPED_SUMMARY = "Your answer couldn't reach the agent, so it was dropped. Tell the agent in its session."

/** A route gave up on an answer it could never hand over. The User must not think it arrived. */
export async function reportInputDropped(notice: NoticeContext & { requestIds: readonly string[] }): Promise<void> {
  notice.logger.error('delivery.overdue', { session: notice.sessionId, stage: 'dropped', request_ids: [...notice.requestIds] })
  try {
    await sendNotice(notice, INPUT_DROPPED_SUMMARY, `dropped-${notice.requestIds.join('-')}`)
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
    void retireInputOverdueNotice(input, state.input_overdue_notice).finally(() => { reporting.delete(sessionId) })
    return
  }
  if (tracked === undefined || input.boundary === true || !inputOverdue(tracked, input.busy, now)) return
  reporting.add(sessionId)
  void reportInputOverdue({ ...input, pending, reason: input.reason() }).finally(() => { reporting.delete(sessionId) })
}
