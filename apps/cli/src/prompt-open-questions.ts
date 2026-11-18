/**
 * Questions still open on the User's devices, listed beside a new prompt the
 * User typed in Claude Code.
 *
 * A plain `notifai ask` keeps working: the conversation shows the question as
 * text, and the User may answer it there. Nothing mechanical links that prose
 * answer to the device question, and guessing it from the prompt's words would
 * close the wrong question whenever two are open or the prompt is about
 * something else. So the prompt carries each open question's exact id, text and
 * close command, and the agent, which read both, retires exactly the ones the
 * message answered. The others stay open: their answers still come back.
 *
 * This is recovery, not answer recording: `notifai close` retires the device
 * question; it records no answer.
 */

import type { QuestionT } from '@raidiant/notifai-protocol'
import type { PendingQuestion, SessionState } from './hook-types.js'
import { questionsAwaitingAnswer } from './native-answer-operation.js'

/** More than this many are summarised, not listed, so a prompt never carries a long backlog. */
const LISTED_AT_MOST = 5

/** A question's own words, shortened only for a very long one. */
const TEXT_AT_MOST = 200

/** The open questions this prompt might answer: registered, not already answered or being handed in. */
export function promptOpenQuestions(state: SessionState): PendingQuestion[] {
  const answered = new Set([
    ...(state.accepted?.answers ?? []).map((answer) => answer.pending.question_id),
    ...(state.delivered_answers ?? []).map((answer) => answer.pending.question_id),
    ...(state.waiting_answers ?? []).map((answer) => answer.pending.question_id),
  ])
  return questionsAwaitingAnswer(state)
    .filter((entry) => entry.question_id !== undefined && !answered.has(entry.question_id))
}

function shortened(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= TEXT_AT_MOST ? flat : `${flat.slice(0, TEXT_AT_MOST - 1)}…`
}

function line(text: string, choices: QuestionT['choices']): string {
  return `${JSON.stringify(shortened(text))}${choices === undefined ? '' : ` (${choices.map((choice) => choice.label).join(' / ')})`}`
}

function describe(entry: PendingQuestion): string {
  const questions = entry.questions ?? []
  const asker = entry.asked_by === undefined ? '' : ', asked by a subagent'
  const close = `Close: \`notifai close ${entry.question_id}\``
  if (questions.length <= 1) return `- ${entry.question_id}${asker}: ${line(questions[0]?.text ?? entry.question, questions[0]?.choices)}. ${close}`
  return [
    `- ${entry.question_id}${asker}, one form of ${questions.length} questions that closes as a whole. ${close}`,
    ...questions.map((question) => `  - ${line(question.text, question.choices)}`),
  ].join('\n')
}

/** The context for one genuine User prompt, or null when nothing is open. */
export function promptOpenQuestionsContext(state: SessionState): string | null {
  const open = promptOpenQuestions(state)
  if (open.length === 0) return null
  const listed = open.slice(0, LISTED_AT_MOST)
  const rest = open.length - listed.length
  return [
    `Notifai: ${open.length === 1 ? 'this question is' : 'these questions are'} still open on the User's devices:`,
    ...listed.map(describe),
    ...(rest > 0 ? [`- ${rest} more: \`notifai replies --pending --json\` lists them.`] : []),
    'If the User\'s message answers one of them, or makes it unnecessary, run that question\'s close command before the work it unblocks, then act on the answer as given. ' +
      'Close a form only when the message settles every question in it. Close nothing else: every other question stays open, and its answer still comes back here.',
  ].join('\n')
}
