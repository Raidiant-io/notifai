/**
 * The duplicate guard: one Agent Session registers one asked question once,
 * whichever route asked it first.
 *
 * `notifai ask`, a Claude Code picker and a Codex card all register through
 * `registerQuestion`, under the session lock. Before a new question is stored,
 * the guard looks for an equal one this session still has open, or answered
 * with the answer not yet handed to the agent. An equal question links to that
 * registration instead of asking the User twice. A question that is closed,
 * dismissed, or whose answer the agent already received never captures a new
 * one: asking the same thing again later is a new question.
 *
 * Equal means exact: the same number of questions, in order, each with an
 * equal text, equal choice labels in the same order, and the same multi-select
 * flag. Title, Summary, Body, images, descriptions and the recommended mark
 * are not part of it. Nothing is normalised or guessed.
 */
import { isDeepStrictEqual } from 'node:util'
import type { QuestionT } from '@raidiant/notifai-protocol'
import type { ServiceIdentity } from './credentials.js'
import { pendingList } from './hook-session-state.js'
import type { PendingQuestion, SessionState } from './hook-types.js'

function sameQuestion(a: QuestionT, b: QuestionT): boolean {
  if (a.text !== b.text || (a.multi === true) !== (b.multi === true)) return false
  if (a.choices === undefined || b.choices === undefined) return a.choices === undefined && b.choices === undefined
  return a.choices.length === b.choices.length &&
    a.choices.every((choice, index) => choice.label === b.choices![index]!.label)
}

/** Whether two question sets are the same question, by the guard's exact rule. */
export function sameQuestions(a: readonly QuestionT[] | undefined, b: readonly QuestionT[] | undefined): boolean {
  if (a === undefined || b === undefined || a.length !== b.length) return false
  return a.every((question, index) => sameQuestion(question, b[index]!))
}

/**
 * The questions of this session that can still capture an equal new one: open
 * (registered, submitted or not), or answered with the answer still waiting to
 * be handed to the agent. Dismissed and terminated registrations are ended,
 * and a delivered answer was consumed, so neither is a candidate.
 */
export function captureCandidates(state: SessionState): PendingQuestion[] {
  const ended = new Set((state.codex_question_bindings ?? [])
    .filter((registration) => registration.dismissed === true || registration.terminated === true)
    .map((registration) => registration.question_id))
  const accepted = state.accepted
  const unread = accepted !== undefined && accepted.delivered_at === undefined && accepted.delivery_committed_at === undefined
    ? accepted.answers.map((answer) => answer.pending)
    : []
  return [...pendingList(state), ...(state.waiting_answers ?? []).map((answer) => answer.pending), ...unread]
    .filter((pending) => pending.question_id !== undefined && !ended.has(pending.question_id))
}

/** The registered question that is this question, if this session still has one open. */
export function findOpenEqualQuestion(state: SessionState, questions: readonly QuestionT[] | undefined): PendingQuestion | undefined {
  if (questions === undefined) return undefined
  return captureCandidates(state).find((pending) => sameQuestions(pending.questions, questions))
}

/**
 * Catch the immediate ask-then-form mistake without guessing whether two texts
 * mean the same thing. Claude Code has no stable turn id: use a 60-second
 * window, ending sooner at a new User prompt. Even a long unanswered question
 * cannot bar a later form indefinitely. Only explicit `ask` registrations
 * qualify; native forms remain free to ask several independent questions.
 */
export function recentAskQuestion(state: SessionState, service: ServiceIdentity, now: number): PendingQuestion | undefined {
  return captureCandidates(state).filter(pending => pending.registered_via_ask === true &&
    pending.asked_by === undefined && pending.asked_at !== undefined &&
    now >= pending.asked_at && now - pending.asked_at < 60_000 &&
    (state.last_prompt_at ?? 0) <= pending.asked_at && isDeepStrictEqual(pending.service_identity, service))
    .sort((a, b) => b.asked_at! - a.asked_at!)[0]
}

export function recentAskRefusal(pending: PendingQuestion): string {
  return `Question ${pending.question_id} (${JSON.stringify(pending.title ?? pending.summary)}) is already registered for the User's devices. ` +
    'Wait for its answer; do not open another form for it. For a separate question, run `notifai ask`.'
}
