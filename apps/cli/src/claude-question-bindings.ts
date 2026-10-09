/**
 * Local association of registered questions with a Claude Code question picker.
 *
 * Claude Code asks the User through its `AskUserQuestion` tool, which shows a
 * picker and holds the turn until it is answered. While the picker is on
 * screen Claude Code also runs `PermissionRequest` hooks for that tool call,
 * and takes whichever answers first. That is what lets one registered question
 * be answered from a device or from the terminal and settle in both places.
 *
 * A registration is kept beside the Codex ones, in the same list, so the
 * shared lifecycle (confirmed request, ordinary presentation, retirement,
 * native answer reports) treats both alike. Only reservation and matching
 * differ. A Codex card is found in a transcript, so it needs a marker in its
 * title. A Claude picker's hook receives the picker itself, so the picker is
 * identified by its content: the question text, option labels and selection
 * mode the agent already wrote for `notifai ask`. Nothing has to be copied.
 */
import { isDeepStrictEqual } from 'node:util'
import type { QuestionT } from '@raidiant/notifai-protocol'
import type { ServiceIdentity } from './credentials.js'
import {
  nativeQuestionTitle,
  type CodexQuestionRegistration,
  type NativeQuestionAdmission,
} from './codex-question-bindings.js'
import type { AnsweredPending, PendingQuestion, SessionState } from './hook-types.js'

export const CLAUDE_QUESTION_TOOL = 'AskUserQuestion'

/** Stands where a Codex registration names its turn; a picker has none. */
export const CLAUDE_PICKER_TURN = 'claude-code-picker'

/** What Claude Code's picker accepts: one to four questions, two to four options each. */
const PICKER_MAX_QUESTIONS = 4
const PICKER_MIN_OPTIONS = 2
const PICKER_MAX_OPTIONS = 4

export function isClaudeRegistration(registration: CodexQuestionRegistration): boolean {
  return registration.registration_turn_id === CLAUDE_PICKER_TURN
}

/** Whether every question can be shown by the picker exactly as registered. */
export function claudePickerShape(questions: readonly QuestionT[] | undefined): boolean {
  if (questions === undefined || questions.length < 1 || questions.length > PICKER_MAX_QUESTIONS) return false
  if (new Set(questions.map((question) => question.text)).size !== questions.length) return false
  return questions.every((question) => {
    const labels = question.choices?.map((choice) => choice.label) ?? []
    return labels.length >= PICKER_MIN_OPTIONS && labels.length <= PICKER_MAX_OPTIONS &&
      new Set(labels).size === labels.length
  })
}

/**
 * Called by registration while holding the session lock. Absent admission or
 * an unsupported shape leaves the ordinary registration untouched.
 */
export function reserveClaudeQuestion(
  state: SessionState,
  pending: PendingQuestion,
  admission: NativeQuestionAdmission | undefined,
): SessionState {
  if (admission === undefined || admission.turn_id !== CLAUDE_PICKER_TURN || state.harness !== 'claude-code' ||
      pending.question_id === undefined || pending.service_identity === undefined ||
      !isDeepStrictEqual(admission.service, pending.service_identity) || !claudePickerShape(pending.questions) ||
      state.codex_question_bindings?.some((item) => item.question_id === pending.question_id)) return state
  return {
    ...state,
    codex_question_bindings: [
      ...(state.codex_question_bindings ?? []),
      {
        question_id: pending.question_id,
        owner_key: admission.owner_key,
        registration_turn_id: CLAUDE_PICKER_TURN,
        transcript: { file: '', identity: CLAUDE_PICKER_TURN, registered_offset: 0 },
        service_identity: { ...pending.service_identity },
        questions: pending.questions!.map((question) => ({ question: structuredClone(question) })),
      },
    ],
  }
}

interface PickerQuestion {
  question: string
  options: string[]
  multiSelect: boolean
}

/** The picker's questions as the hook received them, or null when the input is not one. */
export function pickerQuestions(toolInput: unknown): PickerQuestion[] | null {
  if (typeof toolInput !== 'object' || toolInput === null) return null
  const raw = (toolInput as { questions?: unknown }).questions
  if (!Array.isArray(raw) || raw.length === 0) return null
  const questions: PickerQuestion[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null
    const { question, options, multiSelect } = entry as { question?: unknown; options?: unknown; multiSelect?: unknown }
    if (typeof question !== 'string' || !Array.isArray(options)) return null
    const labels: string[] = []
    for (const option of options) {
      const label = typeof option === 'object' && option !== null ? (option as { label?: unknown }).label : undefined
      if (typeof label !== 'string') return null
      labels.push(label)
    }
    questions.push({ question, options: labels, multiSelect: multiSelect === true })
  }
  return questions
}

function sameLabels(shown: readonly string[], labels: readonly string[] | undefined): boolean {
  const registered = new Set(labels)
  return shown.length === registered.size && new Set(shown).size === shown.length && shown.every((label) => registered.has(label))
}

/** Whether the picker asks exactly this registration's questions: the same texts, labels and modes, in any order. */
function showsRegistration(picker: readonly PickerQuestion[], registration: CodexQuestionRegistration): boolean {
  return registration.questions.length === picker.length && registration.questions.every((binding) => {
    const shown = picker.filter((question) => question.question === nativeQuestionTitle(binding))
    return shown.length === 1 && sameLabels(shown[0]!.options, binding.question.choices?.map((choice) => choice.label)) &&
      shown[0]!.multiSelect === (binding.question.multi === true)
  })
}

function liveRegistrations(state: SessionState, ownerKey: string): CodexQuestionRegistration[] {
  return (state.codex_question_bindings ?? []).filter((registration) =>
    isClaudeRegistration(registration) && registration.owner_key === ownerKey && registration.terminated !== true)
}

/**
 * The one live registration of this session that the picker asks, exactly.
 * Similar wording never binds, a picker that mixes in another question is
 * left alone, and two live registrations with the same content bind neither.
 */
export function matchClaudePicker(
  state: SessionState,
  ownerKey: string,
  toolInput: unknown,
): CodexQuestionRegistration | null {
  const picker = pickerQuestions(toolInput)
  if (picker === null) return null
  const matches = liveRegistrations(state, ownerKey).filter((registration) => showsRegistration(picker, registration))
  return matches.length === 1 ? matches[0]! : null
}

/**
 * Why a picker was not linked to the live registrations it resembles by
 * sharing a question text. Null when it resembles none.
 */
export function claudePickerMiss(
  state: SessionState,
  ownerKey: string,
  toolInput: unknown,
): { question_ids: string[]; mismatch: 'duplicate-registration' | 'different-content' } | null {
  const picker = pickerQuestions(toolInput)
  if (picker === null) return null
  const live = liveRegistrations(state, ownerKey)
  const exact = live.filter((registration) => showsRegistration(picker, registration))
  if (exact.length === 1) return null
  if (exact.length > 1) return { question_ids: exact.map((registration) => registration.question_id), mismatch: 'duplicate-registration' }
  const near = live.filter((registration) => registration.questions.some((binding) =>
    picker.some((question) => question.question === nativeQuestionTitle(binding))))
  return near.length === 0 ? null : { question_ids: near.map((registration) => registration.question_id), mismatch: 'different-content' }
}

/** Record that Claude Code showed this registration's picker; a re-shown picker replaces the earlier one. */
export function observeClaudePicker(state: SessionState, questionId: string, toolUseId: string | undefined): SessionState {
  if (!state.codex_question_bindings?.some((item) => item.question_id === questionId && isClaudeRegistration(item))) return state
  return {
    ...state,
    codex_question_bindings: state.codex_question_bindings.map((registration) =>
      registration.question_id !== questionId || !isClaudeRegistration(registration)
        ? registration
        : {
            ...registration,
            questions: registration.questions.map((binding, index) => ({
              ...binding,
              native: { turn_id: CLAUDE_PICKER_TURN, call_id: toolUseId ?? 'picker', index },
              verified: true as const,
            })),
          }),
  }
}

/**
 * The app answer this registration's picker can carry, as the picker's own
 * answers: each question's marked title mapped to its chosen labels, or to the
 * typed text. Null keeps the ordinary path: a partial answer, a multipart
 * reply, another Machine's question, or anything already presented.
 */
export function claudePickerAnswers(
  registration: CodexQuestionRegistration,
  answer: AnsweredPending,
  service: ServiceIdentity,
): Record<string, string> | null {
  if (answer.delivery_claim !== true || answer.replies.length !== 1 || !isDeepStrictEqual(answer.reply, answer.replies[0]) ||
      !isDeepStrictEqual(answer.pending.service_identity, service) || !isClaudeRegistration(registration) ||
      registration.ordinary_only === true || registration.terminated === true ||
      registration.question_id !== answer.pending.question_id ||
      registration.confirmed_request_id === undefined || registration.confirmed_request_id !== answer.pending.request_id ||
      !isDeepStrictEqual(registration.service_identity, service) ||
      !isDeepStrictEqual(registration.questions.map((item) => item.question), answer.pending.questions)) return null
  const parts = answer.reply.answers
  if (parts.length !== registration.questions.length ||
      new Set(parts.map((part) => part.question_id)).size !== parts.length) return null
  const answers: Record<string, string> = {}
  for (const binding of registration.questions) {
    const part = parts.find((entry) => entry.question_id === binding.question.id)
    if (part === undefined || binding.verified !== true || binding.ambiguous === true) return null
    const choices = part.choice_ids ?? []
    if (new Set(choices).size !== choices.length || (binding.question.multi !== true && choices.length > 1)) return null
    const labels: string[] = []
    for (const id of choices) {
      const choice = binding.question.choices?.find((entry) => entry.id === id)
      if (choice === undefined) return null
      labels.push(choice.label)
    }
    const typed = part.text?.trim()
    const value = [...labels, ...(typed ? [typed] : [])].join(', ')
    if (value === '') return null
    answers[nativeQuestionTitle(binding)] = value
  }
  return answers
}

/**
 * The terminal's own picker answers as registered question and choice ids, for
 * the native answer report. A label that is not a registered choice is typed
 * text. Null when the response does not answer every question of the picker.
 */
export function claudeTerminalAnswers(
  registration: CodexQuestionRegistration,
  toolResponse: unknown,
): Array<{ question_id: string; choice_ids?: string[]; text?: string }> | null {
  const raw = typeof toolResponse === 'object' && toolResponse !== null
    ? (toolResponse as { answers?: unknown }).answers
    : undefined
  if (typeof raw !== 'object' || raw === null) return null
  const given = raw as Record<string, unknown>
  const answers: Array<{ question_id: string; choice_ids?: string[]; text?: string }> = []
  for (const binding of registration.questions) {
    const value = given[nativeQuestionTitle(binding)]
    if (typeof value !== 'string' || value.trim() === '') return null
    const choices = binding.question.choices ?? []
    const exact = choices.find((choice) => choice.label === value)
    if (exact !== undefined) {
      answers.push({ question_id: binding.question.id, choice_ids: [exact.id] })
      continue
    }
    const parts = value.split(',').map((part) => part.trim()).filter((part) => part !== '')
    const picked = parts.map((part) => choices.find((choice) => choice.label === part))
    if (binding.question.multi === true && parts.length > 0 && picked.every((choice) => choice !== undefined)) {
      answers.push({ question_id: binding.question.id, choice_ids: picked.map((choice) => choice!.id) })
      continue
    }
    answers.push({ question_id: binding.question.id, text: value })
  }
  return answers
}
