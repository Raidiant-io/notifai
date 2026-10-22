/**
 * The Claude Code picker hand-back.
 *
 * `notifai ask --wait` registers its question at once and, for a question
 * Claude Code's picker can ask, hands back the exact `AskUserQuestion` input
 * that asks it. The agent opens that picker unchanged. Its `PermissionRequest`
 * reads `metadata.source`, which names the registration, and binds the picker
 * to it there, so the device question keeps the agent's title, Body and
 * images, and a device answer returns as the picker's own result.
 *
 * Linking is exact or refused. A picker that names a registration and is the
 * same question links; one that names it and differs is refused. A picker that
 * names nothing links to a waiting hand-back it is exactly equal to, which
 * keeps older skills that drop `metadata` working, and any other picker is
 * refused while a hand-back waits, so the User is never asked a reworded copy
 * of a question they already have. A hand-back waits from `ask` until its
 * picker links, the turn ends or the User types.
 *
 * The input is the classic schema plain terminal `claude` always uses: its top
 * level is strict, so it carries `questions` and `metadata` and nothing else.
 */
import type { QuestionT } from '@raidiant/notifai-protocol'
import type { PickerQuestion } from './claude-question-bindings.js'
import type { NativeQuestionShown } from './codex-question-bindings.js'
import { hasSettledNativeAnswer } from './native-answer-operation.js'
import { captureCandidates } from './question-guard.js'
import type { PendingQuestion, SessionState } from './hook-types.js'

/** What the picker accepts: one to four questions, two to four options each. */
const PICKER_MAX_QUESTIONS = 4
const PICKER_MIN_OPTIONS = 2
const PICKER_MAX_OPTIONS = 4

/** Claude Code's own mark for the option it recommends; read back as the recommended choice. */
const RECOMMENDED_SUFFIX = ' (Recommended)'

/**
 * The longest header Claude Code 2.1.306 shows whole. A longer one it cuts
 * mid-word to 47 characters and "…", alone and as a tab, at every width.
 */
export const PICKER_HEADER_MAX = 48

/** `metadata.source` names the registration as `notifai:<question_id>`. */
const SOURCE_PREFIX = 'notifai:'

/**
 * How long a waiting hand-back keeps an early device answer for its picker
 * instead of waking the session: long enough for the agent to state its
 * commitments and open the picker, short enough that an agent which never
 * opens it is not kept from the answer.
 */
export const CLAUDE_HANDBACK_HOLD_MS = 60_000

export interface ClaudePickerInput {
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>
  metadata: { source: string }
}
/**
 * A picker header from a title. One that fits is the title itself; a longer
 * one is cut at a word boundary and ends with "...", because Claude Code shows
 * a header containing "…" in quotes. The device title stays whole.
 */
export function pickerHeader(title: string): string {
  const flat = title.replace(/\s+/gu, ' ').trim()
  if ([...flat].length <= PICKER_HEADER_MAX) return flat
  const room = [...flat].slice(0, PICKER_HEADER_MAX - 3).join('')
  const space = room.lastIndexOf(' ')
  return `${(space > 0 ? room.slice(0, space) : room).trimEnd()}...`
}

/** Each registered choice in the picker's order: the recommended one first, as Claude Code expects. */
function pickerChoices(question: QuestionT): NonNullable<QuestionT['choices']> {
  const choices = question.choices ?? []
  return [...choices.filter((choice) => choice.recommended === true), ...choices.filter((choice) => choice.recommended !== true)]
}

function pickerLabel(choice: NonNullable<QuestionT['choices']>[number]): string {
  return choice.recommended === true ? `${choice.label}${RECOMMENDED_SUFFIX}` : choice.label
}

/** The headers a registration's picker shows: its title for one question, each question's own title for several. */
function headersOf(pending: Pick<PendingQuestion, 'title' | 'headers' | 'questions'>): string[] | null {
  const count = pending.questions?.length ?? 0
  if (count === 1) return pending.title === undefined ? null : [pending.title]
  return pending.headers?.length === count ? pending.headers : null
}

/** Whether Claude Code's picker can ask these questions exactly. */
export function pickerCanAsk(questions: readonly QuestionT[]): boolean {
  return questions.length >= 1 && questions.length <= PICKER_MAX_QUESTIONS &&
    new Set(questions.map((question) => question.text)).size === questions.length &&
    questions.every((question) => {
      const count = question.choices?.length ?? 0
      return count >= PICKER_MIN_OPTIONS && count <= PICKER_MAX_OPTIONS
    })
}

/** The picker input that asks this registration, or null when the picker cannot ask it. */
export function handBackInput(pending: Pick<PendingQuestion, 'question_id' | 'title' | 'headers' | 'questions'>): ClaudePickerInput | null {
  const questions = pending.questions
  const headers = headersOf(pending)
  if (pending.question_id === undefined || questions === undefined || headers === null || !pickerCanAsk(questions)) return null
  return {
    questions: questions.map((question, index) => ({
      question: question.text,
      header: pickerHeader(headers[index]!),
      options: pickerChoices(question).map((choice) => ({ label: pickerLabel(choice), description: choice.description ?? '' })),
      multiSelect: question.multi === true,
    })),
    metadata: { source: `${SOURCE_PREFIX}${pending.question_id}` },
  }
}

/** The registration a picker's `metadata.source` names, if it names one. */
export function pickerSource(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const metadata = (toolInput as { metadata?: unknown }).metadata
  if (typeof metadata !== 'object' || metadata === null) return undefined
  const source = (metadata as { source?: unknown }).source
  return typeof source === 'string' && source.startsWith(SOURCE_PREFIX) && source.length > SOURCE_PREFIX.length
    ? source.slice(SOURCE_PREFIX.length)
    : undefined
}

/** A label without Claude Code's recommended mark, which is not part of a question's identity. */
function unmarked(label: string): string {
  return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label
}

/**
 * Whether the picker is the question the hand-back asks: the same questions in
 * order, each with the same text, the same option labels in the same order and
 * the same multi-select flag. Headers, descriptions and the recommended mark
 * are not part of it.
 */
export function sameAsHandBack(picker: readonly PickerQuestion[], input: ClaudePickerInput): boolean {
  return picker.length === input.questions.length && picker.every((question, index) => {
    const asked = input.questions[index]!
    return question.question === asked.question && question.multiSelect === asked.multiSelect &&
      question.options.length === asked.options.length &&
      question.options.every((option, position) => unmarked(option.label) === unmarked(asked.options[position]!.label))
  })
}

/** The picker's own text and labels for each registered question, which its answers are keyed by. */
export function handBackShown(picker: readonly PickerQuestion[], questions: readonly QuestionT[]): NativeQuestionShown[] {
  return questions.map((question, index) => {
    const shown = picker[index]!
    const labels: Record<string, string> = {}
    for (const [position, choice] of pickerChoices(question).entries()) labels[choice.id] = shown.options[position]!.label
    return { title: shown.question, labels }
  })
}

/** Record that `ask` handed back this question's picker in this turn. */
export function recordHandBack(state: SessionState, questionId: string, at: number): SessionState {
  return {
    ...state,
    claude_handbacks: [...(state.claude_handbacks ?? []).filter((entry) => entry.question_id !== questionId), { question_id: questionId, at }],
  }
}

/** The hand-back ends: its picker linked. */
export function withoutHandBack(state: SessionState, questionId: string): SessionState {
  if (state.claude_handbacks?.some((entry) => entry.question_id === questionId) !== true) return state
  const rest = state.claude_handbacks.filter((entry) => entry.question_id !== questionId)
  const next = { ...state }
  if (rest.length === 0) delete next.claude_handbacks
  else next.claude_handbacks = rest
  return next
}

/** Every hand-back ends: the turn ended or the User typed. */
export function withoutHandBacks(state: SessionState): SessionState {
  if (state.claude_handbacks === undefined) return state
  const next = { ...state }
  delete next.claude_handbacks
  return next
}

/** Whether an early answer to this question is kept for its handed-back picker. */
export function handBackHolds(state: SessionState, questionId: string | undefined, now: number): boolean {
  return state.claude_handbacks?.some((entry) => entry.question_id === questionId && now - entry.at < CLAUDE_HANDBACK_HOLD_MS) === true
}

export type HandBackDecision =
  | { kind: 'link'; questionId: string; pending: PendingQuestion }
  | { kind: 'refuse'; reason: 'handback-mismatch' | 'handback-waiting' | 'already-delivered' | 'expired'; questionId: string; message: string }
  | { kind: 'none' }

export function handBackMismatch(questionId: string, input: ClaudePickerInput | null): string {
  return `This is not the question \`notifai ask\` handed back (\`${questionId}\`). ` +
    (input === null ? '' : `To ask that one, open exactly this input: ${JSON.stringify(input)}. `) +
    `For a different question, run \`notifai ask\` for it. If you no longer need \`${questionId}\`, run \`notifai close ${questionId}\`.`
}

export function handBackDelivered(questionId: string): string {
  return `\`${questionId}\` was already answered, and that answer was delivered to you. Do not ask it again.`
}

export function handBackExpired(questionId: string): string {
  return `\`${questionId}\` has expired without an answer: carry on without it, or ask in the conversation.`
}

/** Where a question this session asked ended up, once it can no longer capture a picker. */
function endedAs(state: SessionState, questionId: string): 'delivered' | 'expired' | undefined {
  if ([...(state.accepted?.answers ?? []), ...(state.delivered_answers ?? [])].some((answer) => answer.pending.question_id === questionId) ||
      hasSettledNativeAnswer(state, questionId)) return 'delivered'
  const history = state.question_history?.find((entry) => entry.question_id === questionId)
  const retiring = state.retiring?.find((entry) => entry.question_id === questionId)
  if (history?.state === 'answered' || retiring?.state === 'answered') return 'delivered'
  if (history !== undefined || retiring !== undefined ||
      state.codex_question_bindings?.some((registration) => registration.question_id === questionId)) return 'expired'
  return undefined
}

/**
 * What an opening picker does about the hand-backs of this session, before the
 * ordinary duplicate guard is consulted. Pure: the caller links under the
 * session lock and writes any refusal.
 */
export function decideHandBack(state: SessionState, toolInput: unknown, picker: readonly PickerQuestion[]): HandBackDecision {
  const live = captureCandidates(state)
  const named = pickerSource(toolInput)
  if (named !== undefined) {
    const pending = live.find((entry) => entry.question_id === named)
    if (pending !== undefined && !hasSettledNativeAnswer(state, named)) {
      const input = handBackInput(pending)
      return input !== null && sameAsHandBack(picker, input)
        ? { kind: 'link', questionId: named, pending }
        : { kind: 'refuse', reason: 'handback-mismatch', questionId: named, message: handBackMismatch(named, input) }
    }
    const ended = endedAs(state, named)
    if (ended === 'delivered') return { kind: 'refuse', reason: 'already-delivered', questionId: named, message: handBackDelivered(named) }
    if (ended === 'expired') return { kind: 'refuse', reason: 'expired', questionId: named, message: handBackExpired(named) }
    // A source this session never registered names nothing here.
  }
  const waiting = [...(state.claude_handbacks ?? [])].reverse().flatMap((entry) => {
    const pending = live.find((candidate) => candidate.question_id === entry.question_id)
    return pending === undefined || hasSettledNativeAnswer(state, entry.question_id) ? [] : [pending]
  })
  for (const pending of waiting) {
    const input = handBackInput(pending)
    if (input !== null && sameAsHandBack(picker, input)) return { kind: 'link', questionId: pending.question_id!, pending }
  }
  const latest = waiting[0]
  if (latest !== undefined) {
    return { kind: 'refuse', reason: 'handback-waiting', questionId: latest.question_id!, message: handBackMismatch(latest.question_id!, handBackInput(latest)) }
  }
  return { kind: 'none' }
}
