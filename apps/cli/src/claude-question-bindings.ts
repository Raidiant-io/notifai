/**
 * A Claude Code question picker is the question.
 *
 * Claude Code asks the User through its `AskUserQuestion` tool, which shows a
 * picker and holds the turn until it is answered. While the picker is on
 * screen Claude Code runs `PermissionRequest` hooks for that tool call and
 * takes whichever answers first. Notifai's handler turns the picker it was
 * handed into a registered question for the User's devices and waits for the
 * device answer, so one picker can be answered from a device or from the
 * terminal and settle in both places.
 *
 * Nothing is matched by the agent. The device question is built from the
 * picker's own input, so the agent never copies text. A picker that is exactly
 * a question this session already has open links to it (the duplicate guard);
 * any other picker is its own question. Each binding keeps the picker's exact
 * question text and option labels, because the picker's answers are keyed by
 * them while the device may show a shortened form.
 *
 * Registrations live beside the Codex ones, in the same list, so the shared
 * lifecycle (confirmed request, ordinary presentation, retirement, native
 * answer reports) treats both alike.
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  CHOICE_DESCRIPTION_MAX_LENGTH,
  CHOICE_LABEL_MAX_LENGTH,
  QUESTION_TEXT_MAX_LENGTH,
  REPLY_MAX_CHOICES,
  REPLY_MAX_QUESTIONS,
  SUMMARY_MAX_LENGTH,
  type QuestionT,
  type ReplyAnswerT,
  type ReplyAnswerView,
} from '@raidiant/notifai-protocol'
import type { ServiceIdentity } from './credentials.js'
import type {
  CodexQuestionBinding,
  CodexQuestionRegistration,
  NativeQuestionAdmission,
  NativeQuestionShown,
} from './codex-question-bindings.js'
import type { AnsweredPending, PendingQuestion, SessionState } from './hook-types.js'
import { slugify } from './send.js'

export const CLAUDE_QUESTION_TOOL = 'AskUserQuestion'

/** Stands where a Codex registration names its turn; a picker has none. */
export const CLAUDE_PICKER_TURN = 'claude-code-picker'

/** What Claude Code's picker accepts: one to four questions, at least two options each. */
const PICKER_MAX_QUESTIONS = 4
const PICKER_MIN_OPTIONS = 2

export function isClaudeRegistration(registration: CodexQuestionRegistration): boolean {
  return registration.registration_turn_id === CLAUDE_PICKER_TURN
}

/** One picker question exactly as the hook received it. */
export interface PickerQuestion {
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
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
    const { question, header, options, multiSelect } = entry as {
      question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown
    }
    if (typeof question !== 'string' || !Array.isArray(options)) return null
    const shown: PickerQuestion['options'] = []
    for (const option of options) {
      if (typeof option !== 'object' || option === null) return null
      const { label, description } = option as { label?: unknown; description?: unknown }
      if (typeof label !== 'string') return null
      shown.push({ label, ...(typeof description === 'string' && description.trim() !== '' ? { description } : {}) })
    }
    questions.push({
      question,
      ...(typeof header === 'string' && header.trim() !== '' ? { header } : {}),
      options: shown,
      multiSelect: multiSelect === true,
    })
  }
  return questions
}

/**
 * The picker's identity within its own tool call: a digest of the questions it
 * shows, independent of key order. `PermissionRequest` and `PostToolUse` both
 * receive the same picker, so this ties one to the other without anything the
 * agent wrote having to match anything else.
 */
export function pickerDigest(toolInput: unknown): string | null {
  const picker = pickerQuestions(toolInput)
  if (picker === null) return null
  const canonical = picker.map((question) => [question.question, question.multiSelect, question.options.map((option) => option.label)])
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

export interface PickerForm {
  questions: QuestionT[]
  /** The picker's non-empty headers joined, when it has any: the title unless the picker carries a heading. */
  title?: string
  summary: string
  body?: string
  shown: NativeQuestionShown[]
}

/**
 * The heading a picker shows above its questions, in a host that enables the
 * extended schema (`title`, "Optional single-line heading shown above the
 * questions"). Plain terminal `claude` never carries one.
 */
export function pickerHeading(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const heading = (toolInput as { title?: unknown }).title
  return typeof heading === 'string' && heading.trim() !== '' ? oneLine(heading) : undefined
}

function chars(text: string): number {
  return [...text].length
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Text that fits the device. A picker question often opens with context and
 * ends with the question itself, so the closing sentences are kept; the whole
 * text goes into the body.
 */
function fit(text: string, max: number): string {
  const flat = oneLine(text)
  if (chars(flat) <= max) return flat
  const sentences = flat.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/gu) ?? []
  let tail = ''
  for (let index = sentences.length - 1; index >= 0; index--) {
    const next = oneLine(`${sentences[index]!} ${tail}`)
    if (chars(`… ${next}`) > max) break
    tail = next
  }
  if (tail !== '') return `… ${tail}`
  return `${[...flat].slice(0, max - 1).join('').trimEnd()}…`
}

/**
 * An option description that fits a device choice. A long one keeps its
 * opening sentence when that fits, otherwise its words up to the limit; the
 * whole description goes into the body.
 */
function fitDescription(text: string): string {
  const flat = oneLine(text)
  if (chars(flat) <= CHOICE_DESCRIPTION_MAX_LENGTH) return flat
  const first = /^.+?[.!?](?=\s|$)/u.exec(flat)?.[0]
  if (first !== undefined && chars(first) <= CHOICE_DESCRIPTION_MAX_LENGTH) return first
  const cut = [...flat].slice(0, CHOICE_DESCRIPTION_MAX_LENGTH - 1).join('')
  const space = cut.lastIndexOf(' ')
  return `${(space > CHOICE_DESCRIPTION_MAX_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** A picker label carrying Claude Code's recommended suffix, without it. */
function withoutRecommendedSuffix(label: string): string | null {
  const match = /^(.*\S)\s*\(recommended\)\s*$/iu.exec(label)
  return match === null ? null : match[1]!
}

function uniqueId(base: string, fallback: string, used: Set<string>): string {
  let id = base === '' || !/^[a-z0-9]/u.test(base) ? fallback : base
  if (used.has(id)) id = `${id.slice(0, 28)}-${used.size + 1}`
  used.add(id)
  return id
}

/**
 * The device question this picker asks. Each option's description rides on
 * its choice, and the one option labelled "(Recommended)" becomes the
 * recommended choice. Long question text, labels and descriptions are
 * shortened to fit, and only then does the picker's full wording go into the
 * body. The Summary is the first question; the headers, when the picker has
 * any, become its title, so the question is never copied into the title. An
 * error names why the picker cannot be a device question at all; it then
 * stays in the terminal.
 */
export function pickerForm(picker: readonly PickerQuestion[]): PickerForm | { error: string } {
  if (picker.length < 1 || picker.length > Math.min(PICKER_MAX_QUESTIONS, REPLY_MAX_QUESTIONS)) {
    return { error: 'unsupported-question-count' }
  }
  if (new Set(picker.map((question) => question.question)).size !== picker.length) return { error: 'duplicate-question' }
  const questionIds = new Set<string>()
  const questions: QuestionT[] = []
  const shown: NativeQuestionShown[] = []
  let detailed = false
  for (const [index, entry] of picker.entries()) {
    const text = fit(entry.question, QUESTION_TEXT_MAX_LENGTH)
    if (text === '') return { error: 'empty-question' }
    if (text !== entry.question.trim()) detailed = true
    const labels = entry.options.map((option) => option.label)
    if (labels.length < PICKER_MIN_OPTIONS || labels.length > REPLY_MAX_CHOICES) return { error: 'unsupported-option-count' }
    if (new Set(labels).size !== labels.length) return { error: 'duplicate-option' }
    const choiceIds = new Set<string>()
    const choices: NonNullable<QuestionT['choices']> = []
    const byId: Record<string, string> = {}
    const recommended = entry.options.filter((option) => withoutRecommendedSuffix(option.label) !== null)
    for (const [position, option] of entry.options.entries()) {
      // One recommendation is a recommendation; several are just wording.
      const plain = recommended.length === 1 && recommended[0] === option
        ? withoutRecommendedSuffix(option.label)!
        : option.label
      const label = fit(plain, CHOICE_LABEL_MAX_LENGTH)
      if (label === '') return { error: 'empty-option' }
      if (label !== plain) detailed = true
      const description = option.description === undefined ? undefined : fitDescription(option.description)
      if (description !== undefined && description !== oneLine(option.description!)) detailed = true
      const id = uniqueId(slugify(plain), `option-${position + 1}`, choiceIds)
      choices.push({
        id,
        label,
        ...(description === undefined || description === '' ? {} : { description }),
        ...(plain !== option.label ? { recommended: true as const } : {}),
      })
      byId[id] = option.label
    }
    if (new Set(choices.map((choice) => choice.label)).size !== choices.length) return { error: 'duplicate-option' }
    questions.push({
      id: uniqueId(slugify(text), `q${index + 1}`, questionIds),
      text,
      choices,
      ...(entry.multiSelect ? { multi: true } : {}),
    })
    shown.push({ title: entry.question, labels: byId })
  }
  const headers = picker.flatMap((question) => question.header === undefined || oneLine(question.header) === '' ? [] : [oneLine(question.header)])
  const title = headers.length === 0 ? {} : { title: headers.join(' · ') }
  const summary = fit(questions[0]!.text, SUMMARY_MAX_LENGTH)
  if (!detailed) return { questions, ...title, summary, shown }
  const body = picker.map((entry) => [
    `**${oneLine(entry.question)}**`,
    '',
    ...entry.options.map((option) => option.description === undefined
      ? `- ${oneLine(option.label)}`
      : `- **${oneLine(option.label)}**: ${oneLine(option.description)}`),
  ].join('\n')).join('\n\n')
  return { questions, ...title, summary, body, shown }
}

/**
 * Called by registration while holding the session lock: bind the device
 * question to the picker that asked it. The binding is verified by
 * construction; there is nothing to observe later. A picker linked to a
 * question registered earlier (by `ask`, or by a picker that is gone) gets
 * its binding here too, with the request the submission already confirmed, so
 * the device answer can return through this picker.
 */
export function reserveClaudeQuestion(
  state: SessionState,
  pending: PendingQuestion,
  admission: NativeQuestionAdmission | undefined,
): SessionState {
  const picker = admission?.picker
  if (admission === undefined || picker === undefined || admission.turn_id !== CLAUDE_PICKER_TURN ||
      state.harness !== 'claude-code' || pending.question_id === undefined || pending.service_identity === undefined ||
      !isDeepStrictEqual(admission.service, pending.service_identity) || pending.questions === undefined ||
      pending.questions.length !== picker.length ||
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
        ...(pending.request_id === undefined ? {} : { confirmed_request_id: pending.request_id }),
        questions: pending.questions.map((question, index) => ({
          question: structuredClone(question),
          picker: structuredClone(picker[index]!),
          native: { turn_id: CLAUDE_PICKER_TURN, call_id: 'picker', index },
          verified: true as const,
        })),
      },
    ],
  }
}

/** The picker question text a binding answers to. */
export function pickerTitle(binding: CodexQuestionBinding): string {
  return binding.picker?.title ?? binding.question.text
}

function pickerLabel(binding: CodexQuestionBinding, choiceId: string): string | undefined {
  return binding.picker?.labels[choiceId] ?? binding.question.choices?.find((choice) => choice.id === choiceId)?.label
}

/** Joins the answers one question received in several replies, in the order written. */
const LATER_PART = '; then '

/**
 * One question's answer in one reply as the picker's own value: the chosen
 * picker labels, then any typed text. Null when the reply did not answer it.
 */
function pickerValue(binding: CodexQuestionBinding, part: ReplyAnswerView | undefined): { value: string; typed: boolean } | null {
  if (part === undefined) return null
  const labels = [...new Set(part.choice_ids ?? [])].flatMap((id) => {
    const label = pickerLabel(binding, id)
    return label === undefined ? [] : [label]
  })
  const typed = part.text?.trim() ?? ''
  const value = [...labels, ...(typed === '' ? [] : [typed])].join(', ')
  return value === '' ? null : { value, typed: typed !== '' }
}

/**
 * The device answer as this registration's picker result: each answered
 * question's exact picker text mapped to its picker labels or typed text.
 * Every reply the device sent counts, in the order written. A question no
 * reply answered is left out, as Claude Code leaves out a question the User
 * skips in the picker. When a question was answered more than once, a later
 * choice corrects an earlier one, as it does on every other route, and
 * answers with typed text are all kept in order, so the agent can tell an
 * addition from a correction.
 *
 * Null only when this is not the picker's own answer to give: unclaimed,
 * another Machine's, another question's, or one already presented another
 * way. That answer goes the ordinary route.
 */
export function claudePickerAnswers(
  registration: CodexQuestionRegistration,
  answer: AnsweredPending,
  service: ServiceIdentity,
): Record<string, string> | null {
  if (answer.delivery_claim !== true ||
      !isDeepStrictEqual(answer.pending.service_identity, service) || !isClaudeRegistration(registration) ||
      registration.ordinary_only === true || registration.terminated === true ||
      registration.question_id !== answer.pending.question_id ||
      registration.confirmed_request_id === undefined || registration.confirmed_request_id !== answer.pending.request_id ||
      !isDeepStrictEqual(registration.service_identity, service) ||
      !isDeepStrictEqual(registration.questions.map((item) => item.question), answer.pending.questions)) return null
  const replies = [...(answer.replies.length > 0 ? answer.replies : [answer.reply])].sort((a, b) => a.seq - b.seq)
  const answers: Record<string, string> = {}
  for (const binding of registration.questions) {
    if (binding.verified !== true || binding.ambiguous === true) return null
    const values: Array<{ value: string; typed: boolean }> = []
    for (const reply of replies) {
      const given = pickerValue(binding, reply.answers.findLast((part) => part.question_id === binding.question.id))
      if (given !== null && given.value !== values.at(-1)?.value) values.push(given)
    }
    if (values.length === 0) continue
    answers[pickerTitle(binding)] = values.some((entry) => entry.typed)
      ? values.map((entry) => entry.value).join(LATER_PART)
      : values.at(-1)!.value
  }
  return Object.keys(answers).length === 0 ? null : answers
}

/** The picker's questions an answer left out, by their exact picker text. */
export function claudePickerUnanswered(registration: CodexQuestionRegistration, answers: Record<string, string>): string[] {
  return registration.questions.map(pickerTitle).filter((title) => !Object.hasOwn(answers, title))
}

/**
 * The terminal's own picker answers as registered question and choice ids, for
 * the native answer report. A value that is not one of the picker's labels is
 * typed text. Null when the response does not answer every question of the
 * picker.
 */
export function claudeTerminalAnswers(
  registration: CodexQuestionRegistration,
  toolResponse: unknown,
): ReplyAnswerT[] | null {
  const raw = typeof toolResponse === 'object' && toolResponse !== null
    ? (toolResponse as { answers?: unknown }).answers
    : undefined
  if (typeof raw !== 'object' || raw === null) return null
  const given = raw as Record<string, unknown>
  const answers: ReplyAnswerT[] = []
  for (const binding of registration.questions) {
    const value = given[pickerTitle(binding)]
    if (typeof value !== 'string' || value.trim() === '') return null
    const choices = (binding.question.choices ?? []).map((choice) => ({ id: choice.id, label: pickerLabel(binding, choice.id)! }))
    const exact = choices.find((choice) => choice.label === value)
    if (exact !== undefined) {
      answers.push({ question_id: binding.question.id, choice_ids: [exact.id] })
      continue
    }
    if (binding.question.multi === true) {
      const parts = value.split(', ').map((part) => part.trim()).filter((part) => part !== '')
      const picked = parts.map((part) => choices.find((choice) => choice.label === part))
      if (parts.length > 0 && picked.every((choice) => choice !== undefined)) {
        answers.push({ question_id: binding.question.id, choice_ids: [...new Set(picked.map((choice) => choice!.id))] })
        continue
      }
    }
    answers.push({ question_id: binding.question.id, text: value.trim() })
  }
  return answers
}
