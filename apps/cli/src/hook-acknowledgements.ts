/** Accepted-answer delivery and required Agent Acknowledgement obligations. */
import { withFileLock } from './file-lock.js'
import { gate } from './hook-gates.js'
import { retiringQuestion } from './hook-question-retirement.js'
import { isSamePending, pendingHasChoices, rememberQuestionState } from './hook-question-state.js'
import {
  pendingList,
  readSessionState,
  sessionStatePath,
  updateSessionState,
  writeSessionStateUnlocked,
} from './hook-session-state.js'
import type {
  AcceptedAnswerDelivery,
  AcknowledgementDue,
  AnsweredPending,
  HookContext,
  HookOutcome,
  RetiringQuestion,
  SessionState,
} from './hook-types.js'
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
  const question = `question ${JSON.stringify(pending.question)}`
  if (replies.length === 1 || pendingHasChoices(pending)) {
    return `Notifai — ${identity}${question}; the user answered ${JSON.stringify(latest.text)}.`
  }
  const parts = replies.map((reply) => JSON.stringify(reply.text)).join(', then ')
  return (
    `Notifai — ${identity}${question}; the user answered in ${replies.length} parts, ` +
    `in the order written: ${parts}. Later parts extend or correct earlier ones.`
  )
}

/**
 * Every answer that has arrived, as one message. Several registered questions
 * may resolve in one hook pass; the agent reads them together, each answer
 * tied to the question that asked it, with a truthful note about anything
 * still waiting.
 */
function acknowledgementCommand(requestId: string, textRequired = true): string {
  return textRequired
    ? `notifai acknowledge ${requestId} --text <text>`
    : `notifai acknowledge ${requestId}`
}

/**
 * The acknowledgement is owed either way; only its text is conditional. So the
 * instruction never says "you may skip this" — it says what to run.
 */
function acknowledgementDemand(textRequired: boolean): string {
  return textRequired
    ? ' with non-empty text saying what concrete work you will do because of the reply; a bare acknowledgement is insufficient'
    : ' exactly as shown; this account turned acknowledgement text off, so the receipt carries no words'
}

function acknowledgementContext(answered: AnsweredPending[]): string {
  const due = answered.filter(
    (entry) =>
      entry.agent_acknowledgement_required === true && entry.pending.request_id !== undefined,
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
      `\`${acknowledgementCommand(requestId, textRequired)}\`${acknowledgementDemand(textRequired)}.`
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
    commands
  )
}

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
        ? JSON.stringify(latest.text)
        : `${replies.map((reply) => JSON.stringify(reply.text)).join(', then ')} (parts in the order written; later parts extend or correct earlier ones)`
    const ids = [...new Set(latest.answers.map((entry) => entry.question_id))]
    const identity = ids.length === 0 ? '' : `question_id${ids.length === 1 ? '' : 's'} ${ids.join(', ')}: `
    return `- ${identity}${JSON.stringify(pending.question)} → ${answer}`
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
    answers: answered,
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
        answer.agent_acknowledgement_required === true &&
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
    writeSessionStateUnlocked(file, sessionId, {
      ...current,
      accepted: {
        ...current.accepted,
        delivered_at: ctx.now(),
        delivered_route: deliveredRoute,
      },
    })
  })
}

export function clearAcknowledgementObligation(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  requestId: string,
): boolean {
  let cleared = false
  updateSessionState(sessionId, env, (current) => {
    const due = current.acknowledgement_due ?? []
    const remaining = due.filter((entry) => entry.request_id !== requestId)
    cleared = remaining.length !== due.length
    if (!cleared) return current
    const next = { ...current }
    if (remaining.length > 0) next.acknowledgement_due = remaining
    else delete next.acknowledgement_due
    return next
  })
  return cleared
}

export function acknowledgementBlockContext(due: readonly AcknowledgementDue[]): string {
  const commands = due
    .map(
      (entry) =>
        `- ${entry.request_id}: \`${acknowledgementCommand(entry.request_id, entry.text_required !== false)}\``,
    )
    .join('\n')
  const anyTextRequired = due.some((entry) => entry.text_required !== false)
  return (
    `Notifai — required Agent Acknowledgement${due.length === 1 ? '' : 's'} still missing for request${due.length === 1 ? '' : 's'} ${due.map((entry) => entry.request_id).join(', ')}. ` +
    `Before doing more resumed work or ending this turn, run ${due.length === 1 ? 'this command' : 'every command'}${acknowledgementDemand(anyTextRequired)}:\n${commands}`
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
  due: readonly AcknowledgementDue[],
  notes: string[],
): HookOutcome | null {
  if (due.length === 0) return null
  const requestIds = due.map((entry) => entry.request_id)
  const blocks = (readSessionState(sessionId, ctx.env).acknowledgement_blocks ?? 0) + 1
  if (blocks > MAX_ACKNOWLEDGEMENT_BLOCKS) {
    // Drop the obligation with the reason recorded. The answer was already
    // delivered; what is lost is the agent's receipt for it, and the log is
    // where that loss stays visible.
    for (const requestId of requestIds) clearAcknowledgementObligation(sessionId, ctx.env, requestId)
    resetAcknowledgementBlocks(sessionId, ctx.env)
    gate(ctx, 'proceeding', 'acknowledgement-abandoned', {
      request_ids: requestIds,
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
  gate(ctx, 'held', 'acknowledgement-required', { request_ids: requestIds, blocks })
  return {
    stdout: stopAnswerOutput(acknowledgementBlockContext(due)),
    notes,
    log: { stage: 'acknowledgement-required', request_ids: requestIds },
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

export async function reconcileAcknowledgementObligations(
  ctx: HookContext,
  sessionId: string,
  due: readonly AcknowledgementDue[],
): Promise<AcknowledgementDue[]> {
  const unresolved: AcknowledgementDue[] = []
  for (const obligation of due) {
    try {
      const snapshot = await ctx.client.agentAcknowledgement(obligation.request_id, {
        waitSeconds: 0,
      })
      if (
        snapshot.agent_acknowledgement_required === false ||
        snapshot.agent_acknowledgement !== null
      ) {
        clearAcknowledgementObligation(sessionId, ctx.env, obligation.request_id)
      } else {
        unresolved.push(obligation)
      }
    } catch (err) {
      unresolved.push(obligation)
      ctx.log?.error('hook.gate', {
        verdict: 'held',
        reason: 'acknowledgement-required',
        stage: 'reconcile-failed',
        request_id: obligation.request_id,
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
