/** Accepted-answer delivery and required Agent Acknowledgement obligations. */
import { withFileLock } from './file-lock.js'
import { gate } from './hook-gates.js'
import {
  ACKNOWLEDGEMENT_SCOPE,
  acknowledgementCommand,
  acknowledgementDemand,
  quoted,
} from './injection-render.js'
import { retiringQuestion } from './hook-question-retirement.js'
import { isSamePending, pendingHasChoices, rememberQuestionState } from './hook-question-state.js'
import {
  pendingList,
  readSessionState,
  sessionStatePath,
  updateSessionState,
  writeSessionStateUnlocked,
} from './hook-session-state.js'
import { SESSION_MESSAGE_ID_PREFIX } from '@raidiant/notifai-protocol'
import type {
  AcceptedAnswerDelivery,
  AcknowledgementDue,
  AnsweredPending,
  HookContext,
  HookOutcome,
  MessageAcknowledgementDue,
  OwedAcknowledgement,
  RetiringQuestion,
  SessionState,
} from './hook-types.js'

export function owedAcknowledgementId(owed: OwedAcknowledgement): string {
  return 'message_id' in owed ? owed.message_id : owed.request_id
}

/** Every acknowledgement this session still owes, request debt first. */
export function owedAcknowledgements(state: SessionState): OwedAcknowledgement[] {
  return [...(state.acknowledgement_due ?? []), ...(state.message_acknowledgement_due ?? [])]
}

/**
 * Record the acknowledgement a Session Message is owed, before it is written:
 * an agent that acknowledges the moment it reads the message must find the
 * debt already there to clear.
 */
export function recordMessageAcknowledgementDue(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  due: MessageAcknowledgementDue,
): void {
  updateSessionState(sessionId, env, (current) => {
    const owed = current.message_acknowledgement_due ?? []
    if (owed.some((entry) => entry.message_id === due.message_id)) return current
    return { ...current, message_acknowledgement_due: [...owed, due] }
  })
}
/**
 * The answer as the agent should read it. For a question with choices the
 * latest reply IS the answer — an earlier conflicting one was corrected by
 * it. Free-text answers can arrive in parts, and every part reaches the
 * agent in the order it was written, so it can tell expansion from
 * correction itself.
 *
 * The continuation repeats only identity the agent actually registered and
 * the answer the server accepted. It never invents trust, urgency, permission,
 * or approval claims for the transport to assert.
 */
function answerContext(answered: AnsweredPending): string {
  const { pending, replies } = answered
  const latest = replies.at(-1)
  if (latest === undefined) return 'Notifai — no answer was recorded.'
  const answeredQuestionIds = [...new Set(latest.answers.map((answer) => answer.question_id))]
  const identity =
    answeredQuestionIds.length === 0
      ? ''
      : `question_id${answeredQuestionIds.length === 1 ? '' : 's'} ${answeredQuestionIds.join(', ')}, `
  const question = `question ${quoted(pending.question)}`
  if (replies.length === 1 || pendingHasChoices(pending)) {
    return `Notifai — ${identity}${question}; the user answered ${quoted(latest.text)}.`
  }
  const parts = replies.map((reply) => quoted(reply.text)).join(', then ')
  return (
    `Notifai — ${identity}${question}; the user answered in ${replies.length} parts, ` +
    `in the order written: ${parts}. Later parts extend or correct earlier ones.`
  )
}

function acknowledgementContext(answered: AnsweredPending[]): string {
  const due = answered.filter(
    (entry) => entry.pending.request_id !== undefined,
  )
  if (due.length === 0) {
    return ' Agent Acknowledgement is not required for the answered request(s).'
  }
  if (due.length === 1) {
    const entry = due[0]!
    const requestId = entry.pending.request_id!
    const textRequired = entry.agent_acknowledgement_text_required !== false
    return (
      ` Agent Acknowledgement is required for request ${requestId}. Immediately, before doing the resumed work or ending this turn, run ` +
      `\`${acknowledgementCommand(requestId, textRequired)}\`${acknowledgementDemand(textRequired)}.` +
      ACKNOWLEDGEMENT_SCOPE
    )
  }
  const anyTextRequired = due.some((entry) => entry.agent_acknowledgement_text_required !== false)
  const commands = due
    .map((entry) => {
      const requestId = entry.pending.request_id!
      return `- ${requestId}: \`${acknowledgementCommand(requestId, entry.agent_acknowledgement_text_required !== false)}\``
    })
    .join('\n')
  return (
    ` Agent Acknowledgement is required for ${due.length} requests. Immediately, before doing the resumed work or ending this turn, run every command below${acknowledgementDemand(anyTextRequired)}:\n` +
    commands +
    ACKNOWLEDGEMENT_SCOPE
  )
}

/**
 * Every answer that has arrived, as one message. Several registered questions
 * may resolve in one hook pass; the agent reads them together, each answer
 * tied to the question that asked it, with a truthful note about anything
 * still waiting.
 */
export function answersContext(answered: AnsweredPending[], remaining: number): string {
  const tail =
    remaining > 0
      ? ` (${remaining} more registered question${remaining === 1 ? ' is' : 's are'} still waiting for an answer.)`
      : ''
  const guidance = acknowledgementContext(answered)
  if (answered.length === 1) {
    return answerContext(answered[0]!) + tail + guidance
  }
  const lines = answered.map(({ pending, replies }) => {
    const latest = replies.at(-1)!
    const answer =
      replies.length === 1 || pendingHasChoices(pending)
        ? quoted(latest.text)
        : `${replies.map((reply) => quoted(reply.text)).join(', then ')} (parts in the order written; later parts extend or correct earlier ones)`
    const ids = [...new Set(latest.answers.map((entry) => entry.question_id))]
    const identity = ids.length === 0 ? '' : `question_id${ids.length === 1 ? '' : 's'} ${ids.join(', ')}: `
    return `- ${identity}${quoted(pending.question)} → ${answer}`
  })
  return `Notifai — the user answered ${answered.length} questions:\n${lines.join('\n')}${tail}${guidance}`
}

export function stopAnswerOutput(context: string): string {
  return JSON.stringify({
    decision: 'block',
    reason: context,
  })
}

/**
 * Close, truthfully retire, and forget every answered pending question in one
 * state write, without dropping any other retirement debt or any question
 * still waiting. Stop answers also open one bounded continuation generation;
 * UserPromptSubmit answers ride the user's new turn.
 */
export function stageAcceptedAnswers(
  ctx: HookContext,
  sessionId: string,
  answered: AnsweredPending[],
  remaining: number,
): AcceptedAnswerDelivery {
  const accepted: AcceptedAnswerDelivery = {
    // This is the effective obligation, including responses whose server flag
    // predates mandatory acknowledgement. Persist it with the debt so absence
    // of debt cannot turn an unclassified recovery journal into delivery proof.
    answers: answered.map((answer) => ({
      ...answer,
      agent_acknowledgement_required: answer.pending.request_id !== undefined,
    })),
    remaining,
    recorded_at: ctx.now(),
  }
  updateSessionState(sessionId, ctx.env, (current) => {
    const pendingRemaining = pendingList(current).filter(
      (entry) => !answered.some(({ pending }) => isSamePending(entry, pending)),
    )
    const acknowledgementDue = [...(current.acknowledgement_due ?? [])]
    for (const answer of answered) {
      const requestId = answer.pending.request_id
      if (
        requestId !== undefined &&
        !acknowledgementDue.some((entry) => entry.request_id === requestId)
      ) {
        acknowledgementDue.push({
          request_id: requestId,
          recorded_at: accepted.recorded_at,
          text_required: answer.agent_acknowledgement_text_required !== false,
        })
      }
    }
    const next: SessionState = {
      ...current,
      accepted,
    }
    if (pendingRemaining.length > 0) next.pending = pendingRemaining
    else delete next.pending
    if (acknowledgementDue.length > 0) next.acknowledgement_due = acknowledgementDue
    else delete next.acknowledgement_due
    return answered.reduce(
      (remembered, answer) => rememberQuestionState(remembered, answer.pending, 'answered'),
      next,
    )
  })
  return accepted
}

/** Amend the live accepted record in place, without resurrecting a settled one. */
export function amendAcceptedAnswers(
  ctx: HookContext,
  sessionId: string,
  amend: (accepted: AcceptedAnswerDelivery) => AcceptedAnswerDelivery,
): void {
  updateSessionState(sessionId, ctx.env, (current) =>
    current.accepted === undefined ? current : { ...current, accepted: amend(current.accepted) },
  )
}

/**
 * Finish a route write that linearized before SessionEnd.
 *
 * Ordinary state writers stop at the ended marker. This one narrow completion
 * is allowed through because the journal's own `delivery_committed_at` proves
 * the irreversible write won the ordering first; without the matching finish,
 * a later SessionStart would replay a write that already reached the harness.
 */
export function finishCommittedDelivery(
  ctx: HookContext,
  sessionId: string,
  accepted: AcceptedAnswerDelivery,
  deliveredRoute: string,
): void {
  const file = sessionStatePath(sessionId, ctx.env)
  withFileLock(`${file}.lock`, () => {
    const current = readSessionState(sessionId, ctx.env)
    if (
      current.accepted?.recorded_at !== accepted.recorded_at ||
      current.accepted.delivery_committed_at === undefined
    ) {
      return
    }
    let next: SessionState = {
      ...current,
      accepted: {
        ...current.accepted,
        delivered_at: ctx.now(),
        delivered_route: deliveredRoute,
      },
    }
    if (deliveredRoute === 'session-queue') next = archiveQueuedAnswers(next, current.accepted)
    writeSessionStateUnlocked(file, sessionId, next)
  })
}

/** Move a proven queue write out of the delivery slot without forgetting its answer. */
function archiveQueuedAnswers(current: SessionState, accepted: AcceptedAnswerDelivery): SessionState {
  current = classifyAcceptedAcknowledgements({ ...current, accepted })
  accepted = current.accepted!
  const delivered = [...(current.delivered_answers ?? [])]
  const retiring = [...(current.retiring ?? [])]
  const due = [...(current.acknowledgement_due ?? [])]
  for (const answer of accepted.answers) {
    const requestId = answer.pending.request_id
    if (due.some((entry) => entry.request_id === requestId)) {
      const classified = { ...answer, agent_acknowledgement_required: true }
      const index = delivered.findIndex((entry) => isSamePending(entry.pending, answer.pending))
      if (index < 0) delivered.push(classified)
      else delivered[index] = classified
    }
    const retirement = retiringQuestion(answer.pending, 'answered')
    if (retirement !== null && !retiring.some((entry) => entry.request_id === retirement.request_id)) {
      retiring.push(retirement)
    }
  }
  const next: SessionState = {
    ...current,
    retiring,
    continuation: {
      answered_at: accepted.recorded_at,
      count: (current.continuation?.count ?? 0) + 1,
    },
  }
  delete next.accepted
  if (delivered.length > 0) next.delivered_answers = delivered
  else delete next.delivered_answers
  if (due.length > 0) next.acknowledgement_due = due
  return next
}

/** An unclassified request cannot use missing local debt as acknowledgement proof. */
function classifyAcceptedAcknowledgements(current: SessionState): SessionState {
  if (current.accepted === undefined) return current
  const accepted = current.accepted
  const due = [...(current.acknowledgement_due ?? [])]
  const answers = accepted.answers.map((answer) => {
    const requestId = answer.pending.request_id
    if (answer.agent_acknowledgement_required === true || requestId === undefined) return answer
    if (!due.some((entry) => entry.request_id === requestId)) {
      due.push({ request_id: requestId, recorded_at: accepted.recorded_at,
        text_required: answer.agent_acknowledgement_text_required !== false })
    }
    return { ...answer, agent_acknowledgement_required: true }
  })
  return { ...current, accepted: { ...accepted, answers },
    ...(due.length === 0 ? {} : { acknowledgement_due: due }) }
}

export function classifyJournaledAcknowledgements(sessionId: string, env: NodeJS.ProcessEnv): AcceptedAnswerDelivery | undefined {
  return updateSessionState(sessionId, env, classifyAcceptedAcknowledgements).accepted
}

/** Resume a queue write recorded by an earlier process without replaying it. */
export function recoverQueuedAnswers(sessionId: string, env: NodeJS.ProcessEnv): void {
  updateSessionState(sessionId, env, (current) =>
    current.accepted?.delivered_route === 'session-queue' && current.accepted.delivered_at !== undefined
      ? archiveQueuedAnswers(current, current.accepted)
      : current,
  )
}

/** Forget one owed acknowledgement, dispatched by identifier: `sm_…` or a request id. */
export function clearAcknowledgementObligation(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  id: string,
): boolean {
  if (id.startsWith(SESSION_MESSAGE_ID_PREFIX)) return clearMessageAcknowledgement(sessionId, env, id)
  const requestId = id
  let cleared = false
  updateSessionState(sessionId, env, (current) => {
    const due = current.acknowledgement_due ?? []
    const remaining = due.filter((entry) => entry.request_id !== requestId)
    const delivered = (current.delivered_answers ?? []).filter((entry) => entry.pending.request_id !== requestId)
    cleared = remaining.length !== due.length || delivered.length !== (current.delivered_answers?.length ?? 0)
    if (!cleared) return current
    const next = { ...current }
    if (remaining.length > 0) next.acknowledgement_due = remaining
    else delete next.acknowledgement_due
    if (delivered.length > 0) next.delivered_answers = delivered
    else delete next.delivered_answers
    return next
  })
  return cleared
}

function clearMessageAcknowledgement(sessionId: string, env: NodeJS.ProcessEnv, messageId: string): boolean {
  let cleared = false
  updateSessionState(sessionId, env, (current) => {
    const due = current.message_acknowledgement_due ?? []
    const remaining = due.filter((entry) => entry.message_id !== messageId)
    cleared = remaining.length !== due.length
    if (!cleared) return current
    const next = { ...current }
    if (remaining.length > 0) next.message_acknowledgement_due = remaining
    else delete next.message_acknowledgement_due
    return next
  })
  return cleared
}

export function acknowledgementBlockContext(due: readonly OwedAcknowledgement[]): string {
  const anyTextRequired = due.some((entry) => entry.text_required !== false)
  const commands = due
    .map((entry) => {
      const id = owedAcknowledgementId(entry)
      return `- ${id}: \`${acknowledgementCommand(id, entry.text_required !== false)}\``
    })
    .join('\n')
  const requests = due.filter((entry): entry is AcknowledgementDue => !('message_id' in entry))
  const messages = due.filter((entry): entry is MessageAcknowledgementDue => 'message_id' in entry)
  const subjects = [
    ...(requests.length === 0
      ? []
      : [`request${requests.length === 1 ? '' : 's'} ${requests.map((entry) => entry.request_id).join(', ')}`]),
    ...(messages.length === 0
      ? []
      : [`message${messages.length === 1 ? '' : 's'} ${messages.map((entry) => entry.message_id).join(', ')}`]),
  ].join(' and ')
  const cause = requests.length === 0 ? 'message' : 'reply'
  return (
    `Notifai — required Agent Acknowledgement${due.length === 1 ? '' : 's'} still missing for ${subjects}. ` +
    `Before doing more resumed work or ending this turn, run ${due.length === 1 ? 'this command' : 'every command'}${acknowledgementDemand(anyTextRequired, cause)}:\n${commands}` +
    ACKNOWLEDGEMENT_SCOPE
  )
}

/**
 * How many turns in a row a session may be held waiting for an acknowledgement.
 *
 * The gate is the one place hooks deliberately break the fail-open rule, and it
 * had no bound at all: an agent that could not or would not acknowledge — or a
 * server that stayed unreachable, since an error here counts as unresolved —
 * held every turn of that session for ever. Blocking a user's agent
 * indefinitely does not get them an acknowledgement; it costs them the agent as
 * well as the acknowledgement.
 */
const MAX_ACKNOWLEDGEMENT_BLOCKS = 3

/**
 * Hold the turn for an outstanding acknowledgement, or give up and let it
 * through once holding has stopped being worth its cost.
 *
 * Returns the outcome that blocks the turn, or `null` to carry on.
 */
export function holdForAcknowledgement(
  ctx: HookContext,
  sessionId: string,
  due: readonly OwedAcknowledgement[],
  notes: string[],
): HookOutcome | null {
  if (due.length === 0) return null
  const ids = subjectIds(due)
  const blocks = (readSessionState(sessionId, ctx.env).acknowledgement_blocks ?? 0) + 1
  if (blocks > MAX_ACKNOWLEDGEMENT_BLOCKS) {
    // Drop the obligation with the reason recorded. The answer was already
    // delivered; what is lost is the agent's receipt for it, and the log is
    // where that loss stays visible.
    for (const owed of due) clearAcknowledgementObligation(sessionId, ctx.env, owedAcknowledgementId(owed))
    resetAcknowledgementBlocks(sessionId, ctx.env)
    gate(ctx, 'proceeding', 'acknowledgement-abandoned', {
      ...ids,
      blocks: blocks - 1,
      limit: MAX_ACKNOWLEDGEMENT_BLOCKS,
    })
    notes.push(
      `no acknowledgement after ${MAX_ACKNOWLEDGEMENT_BLOCKS} turns; continuing without one rather than holding this session for ever`,
    )
    return null
  }
  updateSessionState(sessionId, ctx.env, (current) => ({
    ...current,
    acknowledgement_blocks: blocks,
  }))
  gate(ctx, 'held', 'acknowledgement-required', { ...ids, blocks })
  return {
    stdout: stopAnswerOutput(acknowledgementBlockContext(due)),
    notes,
    log: { stage: 'acknowledgement-required', ...ids },
  }
}

/** Log fields naming owed acknowledgements; `request_ids` keeps its released meaning. */
function subjectIds(due: readonly OwedAcknowledgement[]): Record<string, string[]> {
  const requestIds = due.flatMap((entry) => ('message_id' in entry ? [] : [entry.request_id]))
  const messageIds = due.flatMap((entry) => ('message_id' in entry ? [entry.message_id] : []))
  return {
    ...(requestIds.length === 0 && messageIds.length > 0 ? {} : { request_ids: requestIds }),
    ...(messageIds.length === 0 ? {} : { message_ids: messageIds }),
  }
}

/** A turn that was not held resets the streak; only consecutive holds count. */
export function resetAcknowledgementBlocks(sessionId: string, env: NodeJS.ProcessEnv): void {
  updateSessionState(sessionId, env, (current) => {
    if (current.acknowledgement_blocks === undefined) return current
    const next = { ...current }
    delete next.acknowledgement_blocks
    return next
  })
}

/**
 * Ask the service which owed acknowledgements now exist and forget those.
 * Returns what is still owed; a failed check counts as still owed.
 */
export async function reconcileAcknowledgementObligations<T extends OwedAcknowledgement>(
  ctx: HookContext,
  sessionId: string,
  due: readonly T[],
): Promise<T[]> {
  const unresolved: T[] = []
  for (const obligation of due) {
    const id = owedAcknowledgementId(obligation)
    try {
      const acknowledgement =
        'message_id' in obligation
          ? (await ctx.client.sessionMessageAcknowledgement(obligation.message_id)).agent_acknowledgement
          : (await ctx.client.agentAcknowledgement(obligation.request_id, { waitSeconds: 0 }))
              .agent_acknowledgement
      if (acknowledgement !== null) {
        clearAcknowledgementObligation(sessionId, ctx.env, id)
      } else {
        unresolved.push(obligation)
      }
    } catch (err) {
      unresolved.push(obligation)
      ctx.log?.error('hook.gate', {
        verdict: 'held',
        reason: 'acknowledgement-required',
        stage: 'reconcile-failed',
        ...('message_id' in obligation ? { message_id: id } : { request_id: id }),
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return unresolved
}

/**
 * Retire the answered questions and close the journal.
 *
 * Called once an answer's delivery is acknowledged — by the route's own write,
 * or by the successor Stop of a blocking continuation. The continuation counter
 * grows with each settled generation, so the cap that bounds chained
 * answer-to-question loops is a real count rather than a constant 1.
 */
export function settleAcceptedAnswers(
  ctx: HookContext,
  sessionId: string,
  accepted: AcceptedAnswerDelivery,
  cwd?: string,
): void {
  const retirements = accepted.answers
    .map(({ pending }) => retiringQuestion(pending, 'answered', cwd))
    .filter((entry): entry is RetiringQuestion => entry !== null)
  updateSessionState(sessionId, ctx.env, (current) => {
    const retiring = [...(current.retiring ?? [])]
    for (const retirement of retirements) {
      const existing = retiring.findIndex((entry) => entry.request_id === retirement.request_id)
      if (existing < 0) retiring.push(retirement)
      else retiring[existing] = retirement
    }
    const next: SessionState = { ...current, retiring }
    delete next.accepted
    next.continuation = {
      answered_at: accepted.recorded_at,
      count: (current.continuation?.count ?? 0) + 1,
    }
    return next
  })
}
