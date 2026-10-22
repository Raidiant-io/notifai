/**
 * OpenCode's own question form, answerable from the User's devices.
 *
 * OpenCode's `question` tool shows a form and holds the agent's turn until the
 * User answers it or dismisses it. The generated plugin starts this command
 * for a root session's form before OpenCode opens it, with the tool input
 * (`form` frame), and this command decides first:
 *
 * - `accepted`: the form reaches the User's devices. It links to the question
 *   `notifai ask --wait` handed back for it, or to an equal one this session
 *   has open (the duplicate guard), or registers as a new question.
 * - `terminal`: the form stays in OpenCode only, and still works there (a
 *   disabled Project, questions off, a signed-out machine).
 * - `refused`: the plugin rejects the call before the form opens, with the
 *   message as the tool error, so the agent asks again the right way.
 *
 * An accepted form is then reported as opened (`opened` frame, OpenCode's
 * question request), and this command carries it: it holds the Machine
 * Credential, the plugin never does. Whichever answer arrives first settles
 * the form:
 *
 * - A device answer is returned to the plugin, which checks that this exact
 *   request is still pending for this exact session and replies to it through
 *   OpenCode's in-process question API. The tool result then carries the
 *   answer back to the agent in the same turn.
 * - An answer or dismissal in OpenCode reaches the plugin as an event. The
 *   plugin passes it here: an answer is recorded as the native answer so the
 *   devices stop asking and show what was chosen; a dismissal withdraws the
 *   device question.
 * - A question dismissed on a device, or one whose window ended, closes the
 *   form unanswered, and the plugin replaces the tool result with context
 *   that says only that it expired.
 *
 * An older plugin starts this command only once the form is open (`ask`
 * frame). Such a form can no longer be refused: it is carried or left in
 * OpenCode, as before.
 *
 * The plugin's pipe is the session's lifetime. When OpenCode exits, or the
 * plugin ends this command for a deleted session, the pipe closes and the
 * device question is withdrawn: a closed session's question never waits for
 * an answer nobody can receive, and nothing starts or resumes OpenCode. A
 * hang-up or termination signal (a closed terminal, Ctrl+C) means the same.
 * Each open form is also recorded under this command's own process identity;
 * if this command and OpenCode die together, the next form or turn end in any
 * OpenCode session withdraws the abandoned device question.
 *
 * Frames are one JSON object per line in each direction.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import {
  CAPABILITIES_V1,
  validateDraft,
  type ListRepliesResponse,
  type MediaItemT,
  type NotificationDraftT,
  type QuestionT,
  type ReplyAnswerT,
  type ReplyView,
} from '@raidiant/notifai-protocol'
import { pickerForm, type PickerForm, type PickerQuestion } from './claude-question-bindings.js'
import { CLAUDE_PICKER_DISMISSED } from './claude-question-hooks.js'
import { ApiCallError, isRetryableReplyPollError, type ApiClient } from './client.js'
import { log, makeClient, type CommandDeps } from './commands-core.js'
import { draftForServerCapabilities } from './commands-send.js'
import { acknowledgementCommand, resolveDraftInvocation, uploadImage } from './commands-send-support.js'
import { atomicWriteFileSync } from './atomic-file.js'
import { readLocalImage } from './local-input.js'
import { loadConfig, stateDir, type CliConfig } from './config.js'
import { QuestionRegistrationChanged, registerQuestion } from './hook-lifecycle.js'
import { dropPendingQuestion } from './hook-question-state.js'
import { pendingList, readSessionState, recordSessionNotified, updateSessionState } from './hook-session-state.js'
import type { OpencodeFormInput, PendingQuestion, QuestionTerminalState, SessionState } from './hook-types.js'
import type { Logger } from './logging.js'
import { currentProcessIdentity, processIdentityLiveness, type ProcessIdentity } from './process-identity.js'
import { projectBinding, projectDisabled } from './project-enablement.js'
import { sameQuestions } from './question-guard.js'
import { buildDraft, UNTITLED_FORM_TITLE, type DraftInvocation } from './send.js'

/** What OpenCode's devices-facing acknowledgement says for an answer given in OpenCode. */
export const OPENCODE_NATIVE_ACKNOWLEDGEMENT = 'Answered in OpenCode.'

/** The tool error for a form Notifai cannot carry, in a session where forms reach the devices. */
export const OPENCODE_FORM_UNCARRIABLE =
  'Notifai cannot carry this form to the User\'s devices. To wait for the answer, run `notifai ask --wait`; to keep working, ask in the conversation.'

/** How long the plugin has to send the form after starting this command. */
const ASK_FRAME_TIMEOUT_MS = 5_000

/** How long an accepted form may take to open before its registration is released. */
const OPEN_FRAME_TIMEOUT_MS = 15_000

/** The `source` a handed-back form carries: `notifai:<question_id>`. */
const SOURCE_PATTERN = /^notifai:(q_[A-Za-z0-9_-]{1,64})$/

/** One question as OpenCode's `question.asked` event carries it. */
export interface OpencodeQuestionInfo {
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiple?: boolean
  custom?: boolean
}

/** The pending question request, exactly as OpenCode published it. */
export interface OpencodeQuestionRequest {
  id: string
  sessionID: string
  questions: OpencodeQuestionInfo[]
  /** The tool call that opened it, when a model opened it. */
  tool?: { messageID: string; callID: string }
}

/** Notifai's own fields in a `question` tool input, which OpenCode never sees. */
export interface OpencodeFormExtras {
  title?: string
  body?: string
  images?: Array<{ path: string; alt?: string }>
  source?: string
}

type SessionLabel = {
  /** OpenCode's own session title, when it has a real one. */
  session_label?: string
  session_label_pending?: boolean
}
type AskFrame = { type: 'ask'; session_id: string; cwd: string; request: OpencodeQuestionRequest } & SessionLabel
type FormFrame = {
  type: 'form'
  session_id: string
  cwd: string
  call_id: string
  questions: unknown
  extras?: unknown
} & SessionLabel
type Inbound =
  | AskFrame
  | FormFrame
  | { type: 'opened'; request: unknown }
  | { type: 'applied' }
  | { type: 'stale' }
  | { type: 'native'; answers: string[][] }
  | { type: 'dismissed' }

export type OpencodeQuestionOutbound =
  | { type: 'accepted'; question_id: string }
  | { type: 'refused'; message: string }
  | { type: 'terminal'; reason: string }
  | { type: 'registered'; request_id: string }
  | { type: 'answer'; request_id: string; answers: string[][]; acknowledgement: string }
  | { type: 'expired'; context: string }
  | { type: 'done'; outcome: string }

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** A form's questions as OpenCode carries them, or null when they are not. */
function opencodeQuestions(questions: unknown): OpencodeQuestionInfo[] | null {
  if (!Array.isArray(questions) || questions.length === 0) return null
  const parsed: OpencodeQuestionInfo[] = []
  for (const entry of questions) {
    if (typeof entry !== 'object' || entry === null) return null
    const { question, header, options, multiple, custom } = entry as Record<string, unknown>
    if (!isString(question) || !Array.isArray(options)) return null
    const shown: OpencodeQuestionInfo['options'] = []
    for (const option of options) {
      if (typeof option !== 'object' || option === null) return null
      const { label, description } = option as Record<string, unknown>
      if (!isString(label)) return null
      shown.push({ label, ...(isString(description) && description.trim() !== '' ? { description } : {}) })
    }
    parsed.push({
      question,
      ...(isString(header) && header.trim() !== '' ? { header } : {}),
      options: shown,
      ...(multiple === true ? { multiple: true } : {}),
      ...(custom === false ? { custom: false } : {}),
    })
  }
  return parsed
}

/** The request as OpenCode published it, or null when it is not one. */
export function opencodeQuestionRequest(value: unknown): OpencodeQuestionRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, sessionID, questions, tool } = value as Record<string, unknown>
  if (!isString(id) || !/^que_[A-Za-z0-9_-]{1,128}$/.test(id) || !isString(sessionID) || sessionID === '') return null
  const parsed = opencodeQuestions(questions)
  if (parsed === null) return null
  const call = typeof tool === 'object' && tool !== null ? tool as Record<string, unknown> : null
  return {
    id, sessionID, questions: parsed,
    ...(call !== null && isString(call['messageID']) && isString(call['callID'])
      ? { tool: { messageID: call['messageID'], callID: call['callID'] } } : {}),
  }
}

/** Notifai's fields of a form, or an error naming the one that is malformed. */
export function opencodeFormExtras(value: unknown): OpencodeFormExtras | { error: string } {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object') return { error: 'the form\'s Notifai fields are malformed.' }
  const { title, body, images, source } = value as Record<string, unknown>
  const extras: OpencodeFormExtras = {}
  if (title !== undefined) {
    if (!isString(title)) return { error: '"title" must be text.' }
    if (title.trim() !== '') extras.title = title.trim()
  }
  if (body !== undefined) {
    if (!isString(body)) return { error: '"body" must be Markdown text.' }
    if (body.trim() !== '') extras.body = body
  }
  if (images !== undefined) {
    if (!Array.isArray(images)) return { error: '"images" must be a list of {"path", "alt"}.' }
    const list: NonNullable<OpencodeFormExtras['images']> = []
    for (const image of images) {
      const { path: file, alt } = typeof image === 'object' && image !== null ? image as Record<string, unknown> : {}
      if (!isString(file) || file.trim() === '' || (alt !== undefined && !isString(alt))) {
        return { error: '"images" must be a list of {"path", "alt"}.' }
      }
      list.push({ path: file, ...(isString(alt) && alt.trim() !== '' ? { alt: alt.trim() } : {}) })
    }
    if (list.length > 0) extras.images = list
  }
  if (source !== undefined) {
    if (!isString(source)) return { error: '"source" must be the value `notifai ask --wait` handed back.' }
    if (source !== '') extras.source = source
  }
  return extras
}

/** OpenCode's form is Claude Code's picker shape; the device form is built the same way. */
export function opencodePickerQuestions(request: Pick<OpencodeQuestionRequest, 'questions'>): PickerQuestion[] {
  return request.questions.map((entry) => ({
    question: entry.question,
    ...(entry.header === undefined ? {} : { header: entry.header }),
    options: entry.options,
    multiSelect: entry.multiple === true,
  }))
}

/**
 * The `question` input that asks exactly these registered questions, or null
 * when the form cannot ask them unchanged: a free-text question, too many
 * questions or choices, or wording the form would shorten. With one question
 * its header is the title; with several, each question's own title. A
 * recommended choice keeps OpenCode's convention: first, and marked
 * "(Recommended)".
 */
export function opencodeHandBackInput(
  questions: readonly QuestionT[],
  headers: { title?: string; headers?: string[] },
  questionId: string,
): OpencodeFormInput | null {
  if (questions.some((question) => question.choices === undefined ||
      question.choices.filter((choice) => choice.recommended === true).length > 1)) return null
  const input: OpencodeFormInput = {
    questions: questions.map((question, index) => ({
      question: question.text,
      header: (questions.length > 1 ? headers.headers?.[index] : undefined) ?? headers.title ?? `Question ${index + 1}`,
      options: question.choices!.map((choice) => ({
        label: choice.recommended === true ? `${choice.label} (Recommended)` : choice.label,
        description: choice.description ?? '',
      })),
      ...(question.multi === true ? { multiple: true } : {}),
    })),
    source: `notifai:${questionId}`,
  }
  const shape = pickerForm(opencodePickerQuestions(input))
  if ('error' in shape || !sameQuestions(shape.questions, questions)) return null
  return input
}

/** A registration's questions with each recommended choice first, as OpenCode shows it. */
export function recommendedFirst(questions: readonly QuestionT[]): QuestionT[] {
  return questions.map((question) => question.choices === undefined ? question : {
    ...question,
    choices: [
      ...question.choices.filter((choice) => choice.recommended === true),
      ...question.choices.filter((choice) => choice.recommended !== true),
    ],
  })
}

/**
 * A device reply as OpenCode's answers: per question, in order, the chosen
 * option labels exactly as OpenCode showed them, then any typed text. Null
 * when the reply does not answer every question of the form.
 */
export function opencodeDeviceAnswers(form: PickerForm, reply: ReplyView): string[][] | null {
  const answers: string[][] = []
  for (const [index, question] of form.questions.entries()) {
    const part = reply.answers.find((entry) => entry.question_id === question.id)
    if (part === undefined) return null
    const labels: string[] = []
    for (const id of part.choice_ids) {
      const label = form.shown[index]?.labels[id]
      if (label === undefined) return null
      labels.push(label)
    }
    const typed = part.text?.trim()
    if (typed) labels.push(typed)
    if (labels.length === 0) return null
    answers.push(labels)
  }
  return answers
}

/**
 * An answer given in OpenCode as the service's answer report: a value that is
 * one of the form's own labels is that choice, anything else is typed text.
 * Null when it does not answer every question.
 */
export function opencodeNativeAnswers(form: PickerForm, answers: unknown): ReplyAnswerT[] | null {
  if (!Array.isArray(answers) || answers.length !== form.questions.length) return null
  const reported: ReplyAnswerT[] = []
  for (const [index, question] of form.questions.entries()) {
    const given = answers[index]
    if (!Array.isArray(given) || !given.every(isString)) return null
    const values = given.map((value) => value.trim()).filter((value) => value !== '')
    if (values.length === 0) return null
    const labels = Object.entries(form.shown[index]!.labels)
    const choiceIds: string[] = []
    const typed: string[] = []
    for (const value of values) {
      const match = labels.find(([, label]) => label === value)
      if (match === undefined) typed.push(value)
      else if (!choiceIds.includes(match[0])) choiceIds.push(match[0])
    }
    if (question.multi !== true && choiceIds.length > 1) {
      reported.push({ question_id: question.id, text: values.join(', ') })
      continue
    }
    reported.push({
      question_id: question.id,
      ...(choiceIds.length === 0 ? {} : { choice_ids: choiceIds }),
      ...(typed.length === 0 ? {} : { text: typed.join(', ') }),
    })
  }
  return reported
}

/**
 * The form as answers travel: the registration's question and choice ids,
 * with the labels this form shows. A linked form asks the registration's
 * questions in the same order, so its labels line up by position.
 */
function answerForm(registered: readonly QuestionT[], shape: PickerForm): PickerForm {
  return {
    ...shape,
    questions: [...registered],
    shown: registered.map((question, index) => {
      const shownQuestion = shape.questions[index]!
      const labels: Record<string, string> = {}
      for (const [position, choice] of (question.choices ?? []).entries()) {
        const label = shape.shown[index]!.labels[shownQuestion.choices![position]!.id]
        if (label !== undefined) labels[choice.id] = label
      }
      return { title: shape.shown[index]!.title, labels }
    }),
  }
}

/** One stable identity per question, so a restarted command never asks twice. */
function stableKey(prefix: string, sessionId: string, key: string): string {
  return `${prefix}-${createHash('sha256').update(`${sessionId}\0${key}`).digest('base64url').slice(0, 40)}`
}

/** Line-framed pipe to the plugin. Malformed or oversized lines are ignored. */
class PluginPipe {
  private lines: readline.Interface
  private waiters: Array<(frame: Inbound | null) => void> = []
  private queued: Inbound[] = []
  closed = false

  constructor(input: Readable, private output: Writable) {
    // OpenCode gone mid-write (EPIPE) is the session closing, never a crash
    // that would skip withdrawing the device question.
    input.on('error', () => this.end())
    output.on('error', () => this.end())
    this.lines = readline.createInterface({ input, crlfDelay: Infinity })
    this.lines.on('line', (line) => this.receive(line))
    this.lines.on('close', () => {
      this.closed = true
      for (const waiter of this.waiters.splice(0)) waiter(null)
    })
  }

  private receive(line: string): void {
    if (line.length > 1024 * 1024) return
    let frame: unknown
    try { frame = JSON.parse(line) } catch { return }
    if (typeof frame !== 'object' || frame === null || !isString((frame as { type?: unknown }).type)) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(frame as Inbound)
    else this.queued.push(frame as Inbound)
  }

  /** The next frame, or null once the plugin's side is closed. */
  next(timeoutMs?: number): Promise<Inbound | null | 'timeout'> {
    const queued = this.queued.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const waiter = (frame: Inbound | null): void => {
        if (timer !== undefined) clearTimeout(timer)
        resolve(frame)
      }
      this.waiters.push(waiter)
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter)
          resolve('timeout')
        }, timeoutMs)
      }
    })
  }

  send(frame: OpencodeQuestionOutbound): void {
    if (this.output.destroyed || this.output.writableEnded) return
    try {
      this.output.write(`${JSON.stringify(frame)}\n`)
    } catch {
      // The plugin is gone; the closed input ends this command.
    }
  }

  /** A signal ended the session: behave exactly as if the pipe had closed. */
  end(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter(null)
    this.lines.close()
  }

  close(): void {
    this.lines.close()
  }
}

type OpenForm = { request_id: string; session_id: string; base_url: string; machine_id: string; owner: ProcessIdentity }

function formsDir(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'opencode-questions')
}

function formFile(env: NodeJS.ProcessEnv, requestId: string): string {
  return path.join(formsDir(env), `${requestId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
}

function recordOpenForm(env: NodeJS.ProcessEnv, form: OpenForm): void {
  atomicWriteFileSync(formFile(env, form.request_id), `${JSON.stringify(form)}\n`, { mode: 0o600 })
}

function dropOpenForm(env: NodeJS.ProcessEnv, requestId: string): void {
  rmSync(formFile(env, requestId), { force: true })
}

/**
 * Withdraw the device questions of forms whose command died without settling
 * them, which only happens when it was killed together with OpenCode. Their
 * sessions are gone, so an answer could reach nobody.
 */
export async function sweepAbandonedOpencodeForms(
  deps: Pick<CommandDeps, 'env' | 'store' | 'clientFactory' | 'logger'>,
  options: { timeoutMs?: number; limit?: number; liveness?: (identity: ProcessIdentity) => string } = {},
): Promise<number> {
  let names: string[]
  try { names = readdirSync(formsDir(deps.env)).filter((name) => name.endsWith('.json')) } catch { return 0 }
  const liveness = options.liveness ?? ((identity: ProcessIdentity) => processIdentityLiveness(identity))
  const credential = deps.store.load()
  let withdrawn = 0
  for (const name of names) {
    if (withdrawn >= (options.limit ?? Number.POSITIVE_INFINITY)) break
    const file = path.join(formsDir(deps.env), name)
    let form: OpenForm
    try { form = JSON.parse(readFileSync(file, 'utf8')) as OpenForm } catch { rmSync(file, { force: true }); continue }
    if (!isString(form?.request_id) || typeof form.owner?.pid !== 'number' || !isString(form.owner.start)) {
      rmSync(file, { force: true })
      continue
    }
    if (liveness(form.owner) !== 'gone') continue
    if (credential === null || credential.baseUrl !== form.base_url || credential.machineId !== form.machine_id) {
      // Another Machine Credential cannot withdraw it; its reply window ends it.
      rmSync(file, { force: true })
      continue
    }
    try {
      const client = makeClient(deps as CommandDeps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`,
        options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs })
      await client.closeReplies(form.request_id, 'retire')
      rmSync(file, { force: true })
      withdrawn += 1
      log(deps as CommandDeps).info('hook.gate', { hook: 'opencode-question', reason: 'abandoned-form-withdrawn',
        request_id: form.request_id, session: form.session_id })
    } catch (err) {
      log(deps as CommandDeps).info('hook.gate', { hook: 'opencode-question', reason: 'abandoned-form-retry-later',
        request_id: form.request_id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return withdrawn
}

/** The refusal for a form that is not the question `notifai ask --wait` handed back. */
function notTheHandBack(questionId: string, input: OpencodeFormInput): string {
  return `This is not the question \`notifai ask --wait\` handed back (\`${questionId}\`). ` +
    `To ask that one, open exactly this input: ${JSON.stringify(input)}. ` +
    'For a different question, run `notifai ask --wait` for it. ' +
    `If you no longer need \`${questionId}\`, run \`notifai close ${questionId}\`.`
}

function alreadyAnswered(questionId: string): string {
  return `\`${questionId}\` was already answered, and that answer was delivered to you. Do not ask it again.`
}

function expiredUnanswered(questionId: string): string {
  return `\`${questionId}\` has expired without an answer: carry on without it, or ask in the conversation.`
}

function invalidForm(detail: string): string {
  return `Notifai cannot carry this form to the User's devices: ${detail} Fix that and open the form again, or ask in the conversation.`
}

/** The form this command was started for, from whichever plugin started it. */
interface FormContext {
  sessionId: string
  cwd: string
  questions: OpencodeQuestionInfo[]
  extras: OpencodeFormExtras
  /** Notifai's fields were malformed; the form is refused once it would reach the devices. */
  extrasError?: string
  label: SessionLabel
  callId?: string
  /** Already open: an older plugin started this command for it. It can no longer be refused. */
  opened?: OpencodeQuestionRequest
}

/** A form carried to the devices: the registration it claimed, and what submits it. */
interface Carriage {
  config: CliConfig
  client: ApiClient
  service: { base_url: string; machine_id: string }
  sessionId: string
  /** The form as OpenCode shows it. */
  shape: PickerForm
  entry: PendingQuestion & { question_id: string }
  /** This command registered it, so a form that never opens drops it. */
  created: boolean
  owner: ProcessIdentity | null
  /** Checked local images of a self-opened form, uploaded once it is open. */
  images: Array<{ path: string; alt?: string }>
}

type Admission =
  | { kind: 'terminal'; reason: string; detail?: Record<string, unknown> }
  | { kind: 'refused'; reason: string; message: string; stage?: string; detail?: Record<string, unknown> }
  | { kind: 'carry'; carriage: Carriage }

const ownerIsLive = (owner: ProcessIdentity | undefined, self: ProcessIdentity | null): boolean =>
  owner !== undefined && !(self !== null && owner.pid === self.pid && owner.start === self.start) &&
  processIdentityLiveness(owner) !== 'gone'

/**
 * The hand-backs still waiting for their form: registered since the latest
 * User prompt and not yet carried by a form. A User prompt or Stop ends the
 * wait; Stop also retires them.
 */
function waitingHandBacks(state: SessionState, self: ProcessIdentity | null): Array<PendingQuestion & { question_id: string }> {
  const since = state.last_prompt_at ?? 0
  return pendingList(state).filter((entry): entry is PendingQuestion & { question_id: string } =>
    entry.question_id !== undefined && entry.opencode_hand_back !== undefined &&
    (entry.asked_at ?? 0) >= since && !ownerIsLive(entry.opencode_form_owner, self))
}

/** Claim an existing registration for this form, unless another live form carries it. */
function claimRegistration(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  questionId: string,
  owner: ProcessIdentity | null,
): (PendingQuestion & { question_id: string }) | 'gone' | 'owned' {
  let result: (PendingQuestion & { question_id: string }) | 'gone' | 'owned' = 'gone'
  updateSessionState(sessionId, env, (state) => {
    const list = pendingList(state)
    const index = list.findIndex((entry) => entry.question_id === questionId)
    if (index < 0) return state
    if (ownerIsLive(list[index]!.opencode_form_owner, owner)) {
      result = 'owned'
      return state
    }
    const claimed = { ...list[index]!, question_id: questionId, ...(owner === null ? {} : { opencode_form_owner: owner }) }
    result = claimed
    const next = [...list]
    next[index] = claimed
    return { ...state, pending: next }
  })
  return result
}

/** Let a hand-back wait for its form again, or drop what a form that never opened registered. */
function releaseRegistration(carriage: Carriage, env: NodeJS.ProcessEnv, state: QuestionTerminalState = 'withdrawn'): void {
  if (carriage.created) {
    dropPendingQuestion(carriage.sessionId, env, carriage.entry, state)
    return
  }
  updateSessionState(carriage.sessionId, env, (current) => {
    const list = pendingList(current)
    const index = list.findIndex((entry) => entry.question_id === carriage.entry.question_id)
    if (index < 0 || list[index]!.opencode_form_owner === undefined) return current
    const rest = { ...list[index]! }
    delete rest.opencode_form_owner
    const next = [...list]
    next[index] = rest
    return { ...current, pending: next }
  })
}

/**
 * A local image a form names, checked before the form opens: a form's paths
 * are model-written, so it is read under the same local file policy as
 * `--image` (`local-input.ts`), and a file that is not the image its name
 * says never leaves the machine.
 */
export function checkFormImage(cwd: string, file: string): { path: string } | { error: string } {
  if (/^[a-z][a-z0-9+.-]*:/i.test(file)) return { error: `image "${file}" must be a local file path.` }
  const read = readLocalImage(cwd, file, 'image')
  return read.ok ? { path: read.path } : { error: read.error }
}

/** The draft a carried form submits, validated against the device contract. */
function formDraft(
  config: CliConfig,
  entry: PendingQuestion & { question_id: string },
  media: MediaItemT[],
  invocation: DraftInvocation,
  replyWindowSeconds?: number,
): { ok: true; draft: NotificationDraftT } | { ok: false; error: string } {
  const result = buildDraft(config, {
    title: entry.title ?? invocation.source?.session_label ?? UNTITLED_FORM_TITLE,
    summary: entry.summary,
    ...(entry.body === undefined ? {} : { body: entry.body }),
    ...(entry.project === undefined ? {} : { project: entry.project }),
    ...(media.length === 0 ? {} : { media }),
    reply: true,
    ...(replyWindowSeconds === undefined ? {} : { replyWindow: replyWindowSeconds }),
    questions: entry.questions ?? [],
  }, invocation)
  if (!result.ok) return result
  const capabilities = CAPABILITIES_V1.describe(result.platform)
  if (capabilities === null) return { ok: false, error: 'No iOS capability contract is available.' }
  const validation = validateDraft(result.draft, capabilities)
  if (!validation.ok) return { ok: false, error: validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join('\n') }
  return { ok: true, draft: result.draft }
}

/**
 * Decide what this form is: carried to the devices (linked or registered),
 * left in OpenCode, or refused before it opens. Every case that leaves the
 * form in OpenCode keeps it working there.
 */
function admitForm(deps: CommandDeps, form: FormContext): Admission {
  const { sessionId, cwd } = form
  let config: CliConfig
  try {
    config = loadConfig({ cwd, env: deps.env, sessionId })
  } catch {
    return { kind: 'terminal', reason: 'config-invalid' }
  }
  // Nothing reaches the devices from a Project the User disabled.
  if (projectDisabled(projectBinding(cwd, deps.env, config.project.value))) return { kind: 'terminal', reason: 'project-disabled' }
  if (!config.ask_notifications.value) return { kind: 'terminal', reason: 'question-notifications-off' }
  const credential = deps.store.load()
  if (credential === null) return { kind: 'terminal', reason: 'not-signed-in' }
  if (form.extrasError !== undefined) return { kind: 'refused', reason: 'invalid-fields', message: invalidForm(form.extrasError) }
  const shape = pickerForm(opencodePickerQuestions(form))
  const owner = currentProcessIdentity()
  const state = readSessionState(sessionId, deps.env)
  const service = { base_url: credential.baseUrl, machine_id: credential.machineId }
  const client = makeClient(deps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`)
  const carry = (entry: PendingQuestion & { question_id: string }, created: boolean, images: Carriage['images'] = []): Admission =>
    'error' in shape ? { kind: 'terminal', reason: 'unsupported-form' }
      : { kind: 'carry', carriage: { config, client, service, sessionId, shape, entry, created, owner, images } }
  const link = (questionId: string): Admission => {
    const claimed = claimRegistration(sessionId, deps.env, questionId, owner)
    if (claimed === 'gone') return { kind: 'terminal', reason: 'question-closed' }
    if (claimed === 'owned') return { kind: 'terminal', reason: 'question-on-another-form' }
    return carry(claimed, false)
  }
  const sameAsShape = (entry: PendingQuestion) => !('error' in shape) && sameQuestions(entry.questions, shape.questions)

  // The question `notifai ask --wait` handed back, named by its source.
  const named = form.extras.source === undefined ? undefined : SOURCE_PATTERN.exec(form.extras.source)?.[1]
  if (named !== undefined) {
    const pending = pendingList(state).find((entry) => entry.question_id === named)
    if (pending?.opencode_hand_back !== undefined) {
      if (sameAsShape(pending)) return link(named)
      return { kind: 'refused', reason: 'not-the-hand-back', message: notTheHandBack(named, pending.opencode_hand_back),
        detail: { question_id: named } }
    }
    const ended = (state.question_history ?? []).find((entry) => entry.question_id === named)
    if (pending === undefined && ended !== undefined) {
      return ended.state === 'answered'
        ? { kind: 'refused', reason: 'already-answered', message: alreadyAnswered(named), detail: { question_id: named } }
        : { kind: 'refused', reason: 'expired', message: expiredUnanswered(named), detail: { question_id: named } }
    }
  }
  const waiting = waitingHandBacks(state, owner)
  const match = waiting.find(sameAsShape)
  if (match !== undefined) return link(match.question_id)
  if (waiting.length > 0) {
    const latest = waiting[waiting.length - 1]!
    return { kind: 'refused', reason: 'not-the-hand-back', message: notTheHandBack(latest.question_id, latest.opencode_hand_back!),
      detail: { question_id: latest.question_id } }
  }
  if ('error' in shape) {
    return { kind: 'refused', reason: 'unlinkable', stage: 'form-refused-unlinkable', message: OPENCODE_FORM_UNCARRIABLE,
      detail: { shape: shape.error } }
  }

  // A form the agent opened itself: titled by its own title, else its headers,
  // else the Agent Session name; its Body and images are checked before it opens.
  const images: Carriage['images'] = []
  for (const image of form.extras.images ?? []) {
    const checked = checkFormImage(cwd, image.path)
    if ('error' in checked) return { kind: 'refused', reason: 'invalid-image', message: invalidForm(checked.error) }
    images.push({ path: checked.path, ...(image.alt === undefined ? {} : { alt: image.alt }) })
  }
  const silent = { ...deps, cwd, io: { ...deps.io, err: () => undefined } }
  const source = resolveDraftInvocation(silent, {}, {
    harness: 'opencode', label: 'OpenCode', sessionId,
    ...(isString(form.label.session_label) && form.label.session_label.trim() !== '' ? { sessionLabel: form.label.session_label } : {}),
    ...(form.label.session_label_pending === true ? { sessionLabelPending: true } : {}),
  })
  if (!source.ok) return { kind: 'terminal', reason: 'source-invalid' }
  const body = [form.extras.body, shape.body].filter((part): part is string => part !== undefined).join('\n\n')
  const title = form.extras.title ?? shape.title
  const entry: PendingQuestion & { question_id: string } = {
    question_id: `q_${randomBytes(12).toString('base64url')}`,
    question: shape.questions[0]!.text,
    ...(title === undefined ? {} : { title }),
    summary: shape.summary,
    service_identity: service,
    questions: shape.questions,
    ...(body === '' ? {} : { body }),
    ...(source.invocation.source === undefined ? {} : { source: source.invocation.source }),
    ...(owner === null ? {} : { opencode_form_owner: owner }),
  }
  const placeholders = images.map((image, index) => ({ media_id: `med_pending_${index + 1}`, ...(image.alt === undefined ? {} : { alt: image.alt }) }))
  const preflight = formDraft(config, entry, placeholders, source.invocation)
  if (!preflight.ok) {
    return form.opened === undefined && (form.extras.body !== undefined || form.extras.title !== undefined || images.length > 0)
      ? { kind: 'refused', reason: 'invalid-draft', message: invalidForm(preflight.error.split('\n')[0]!) }
      : { kind: 'terminal', reason: 'invalid-draft', detail: { error: preflight.error } }
  }
  const frozen = { ...entry, title: preflight.draft.presentation.title,
    ...(preflight.draft.project === undefined ? {} : { project: preflight.draft.project }) }
  let registered
  try {
    registered = registerQuestion(sessionId, deps.env, frozen, (deps.now ?? Date.now)(), undefined, {
      machineStillMatches: () => {
        const current = deps.store.load()
        return current !== null && current.machineId === service.machine_id && current.baseUrl === service.base_url
      },
    })
  } catch (err) {
    return { kind: 'terminal', reason: err instanceof QuestionRegistrationChanged ? 'session-changed' : 'registration-failed',
      detail: { error: err instanceof Error ? err.message : String(err) } }
  }
  // The duplicate guard found this question already open in this session.
  if (!registered.registered) return link(registered.question_id)
  return carry(frozen, true, images)
}

async function settlesWithin(frame: Promise<unknown>, ms: number, deps: Pick<CommandDeps, 'sleep'>): Promise<boolean> {
  if (ms <= 0) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  const elapsed = deps.sleep?.(ms) ?? new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })
  try {
    return await Promise.race([frame.then(() => true), elapsed.then(() => false)])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type Submitted = Carriage & { requestId: string; form: PickerForm }

/** Upload a self-opened form's images, then submit the registration for the User's devices. */
async function submitForm(
  deps: CommandDeps,
  carriage: Carriage,
  logger: Logger,
): Promise<Submitted | { reason: string; detail?: Record<string, unknown> }> {
  const media: MediaItemT[] = [...(carriage.entry.media ?? [])]
  for (const image of carriage.images) {
    const uploaded = await uploadImage({ ...deps, io: { ...deps.io, err: () => undefined } }, carriage.client, image.path)
    if (!uploaded.ok) return { reason: 'media-upload-failed', ...(uploaded.error === null ? {} : { detail: { error: uploaded.error } }) }
    media.push({ media_id: uploaded.mediaId, ...(image.alt === undefined ? {} : { alt: image.alt }) })
  }
  const draft = formDraft(carriage.config, carriage.entry, media,
    carriage.entry.source === undefined ? {} : { source: carriage.entry.source })
  if (!draft.ok) return { reason: 'invalid-draft', detail: { error: draft.error } }
  try {
    const capabilities = await carriage.client.capabilities()
    const receipt = await carriage.client.submit({
      idempotency_key: stableKey('opencode-question', carriage.sessionId, carriage.entry.question_id),
      draft: draftForServerCapabilities(draft.draft, capabilities),
    }, 0)
    recordSessionNotified(carriage.sessionId, deps.env, (deps.now ?? Date.now)())
    logger.info('ask.registered', {
      ok: true, origin: 'opencode-question', session: carriage.sessionId, question_id: carriage.entry.question_id,
      request_id: receipt.request_id, questions: carriage.shape.questions.length, overall: receipt.overall,
      linked: !carriage.created, ...(carriage.entry.opencode_hand_back === undefined ? {} : { hand_back: true }),
    })
    return { ...carriage, requestId: receipt.request_id, form: answerForm(carriage.entry.questions ?? [], carriage.shape) }
  } catch (err) {
    return { reason: 'submission-failed', detail: {
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof ApiCallError ? { status: err.status, code: err.code } : {}),
    } }
  }
}

async function closeQuietly(registration: Submitted, logger: Logger): Promise<void> {
  try {
    await registration.client.closeReplies(registration.requestId, 'retire')
  } catch (err) {
    logger.info('hook.gate', { hook: 'opencode-question', reason: 'retire-failed', request_id: registration.requestId,
      error: err instanceof Error ? err.message : String(err) })
  }
}

/** Record an answer given in OpenCode, so the devices show it and stop asking. */
async function reportNativeAnswer(registration: Submitted, answers: unknown, logger: Logger): Promise<string> {
  const reported = opencodeNativeAnswers(registration.form, answers)
  if (reported === null) {
    await closeQuietly(registration, logger)
    return 'native-answer-unreadable'
  }
  try {
    const report = await registration.client.recordHarnessAnswer(registration.requestId, {
      session_id: registration.sessionId,
      submission_id: stableKey('ocn', registration.sessionId, registration.requestId),
      answers: reported,
    })
    await registration.client.putAgentAcknowledgement(registration.requestId, {
      session_id: registration.sessionId, reply_seq: report.reply_seq, text: OPENCODE_NATIVE_ACKNOWLEDGEMENT,
    })
    // The form is settled and nothing in OpenCode waits for a later answer:
    // close the window so a device cannot answer into a void.
    await closeQuietly(registration, logger)
    return 'native-answer-recorded'
  } catch (err) {
    logger.info('hook.gate', { hook: 'opencode-question', reason: 'native-report-failed', request_id: registration.requestId,
      error: err instanceof Error ? err.message : String(err) })
    await closeQuietly(registration, logger)
    return 'native-answer-withdrawn'
  }
}

type PollResult =
  | { kind: 'answered'; response: ListRepliesResponse }
  | { kind: 'expired' }

/**
 * Long-poll the reply window until an answer arrives or the window ends,
 * whether by time or because a device dismissed the question.
 * `stopped` is checked between polls; a frame from the plugin wins at once.
 */
async function pollForAnswer(
  registration: Submitted,
  stopped: () => boolean,
  deps: Pick<CommandDeps, 'now' | 'sleep'>,
): Promise<PollResult | null> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let failures = 0
  let expiresAt: number | null = null
  while (!stopped()) {
    if (expiresAt !== null && now() >= expiresAt) return { kind: 'expired' }
    try {
      const response = await registration.client.replies(registration.requestId, { waitSeconds: 25, afterSeq: 0 })
      failures = 0
      if (response.reply_expires_at !== null) expiresAt = Date.parse(response.reply_expires_at)
      if (response.replies.length > 0) return { kind: 'answered', response }
    } catch (err) {
      if (!isRetryableReplyPollError(err)) throw err
      failures += 1
      await sleep(Math.min(250 * 2 ** (failures - 1), 5_000))
    }
  }
  return null
}

/** `notifai hook opencode-question`: one OpenCode question form, one plugin pipe. */
export async function opencodeQuestionCommand(
  deps: CommandDeps,
  input: Readable,
  output: Writable,
  signals: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGINT'],
): Promise<number> {
  const pipe = new PluginPipe(input, output)
  const onSignal = (): void => pipe.end()
  for (const signal of signals) process.on(signal, onSignal)
  try {
    return await runForm(deps, pipe)
  } finally {
    for (const signal of signals) process.off(signal, onSignal)
  }
}

function sessionLabel(frame: SessionLabel): SessionLabel {
  return {
    ...(isString(frame.session_label) && frame.session_label.length <= 512 ? { session_label: frame.session_label } : {}),
    ...(frame.session_label_pending === true ? { session_label_pending: true } : {}),
  }
}

/** The form from the first frame, or an error frame's reason. */
function formContext(first: Inbound | null | 'timeout'): FormContext | { error: string } {
  if (first === null || first === 'timeout') return { error: 'invalid-form' }
  if (first.type === 'ask') {
    const request = opencodeQuestionRequest(first.request)
    if (request === null || first.session_id !== request.sessionID || !isString(first.cwd) ||
        !path.isAbsolute(first.cwd) || !existsSync(first.cwd)) return { error: 'invalid-form' }
    return { sessionId: request.sessionID, cwd: first.cwd, questions: request.questions, extras: {}, label: sessionLabel(first),
      ...(request.tool === undefined ? {} : { callId: request.tool.callID }), opened: request }
  }
  if (first.type !== 'form') return { error: 'invalid-form' }
  const questions = opencodeQuestions(first.questions)
  if (questions === null || !isString(first.session_id) || first.session_id === '' || !isString(first.call_id) ||
      !isString(first.cwd) || !path.isAbsolute(first.cwd) || !existsSync(first.cwd)) return { error: 'invalid-form' }
  const extras = opencodeFormExtras(first.extras)
  return {
    sessionId: first.session_id, cwd: first.cwd, questions, label: sessionLabel(first), callId: first.call_id,
    ...('error' in extras ? { extras: {}, extrasError: extras.error } : { extras }),
  }
}

/** The `opened` frame for this exact form, or null when it never opened. */
async function awaitOpened(pipe: PluginPipe, form: FormContext): Promise<OpencodeQuestionRequest | null> {
  const frame = await pipe.next(OPEN_FRAME_TIMEOUT_MS)
  if (frame === null || frame === 'timeout' || frame.type !== 'opened') return null
  const request = opencodeQuestionRequest(frame.request)
  if (request === null || request.sessionID !== form.sessionId || request.tool?.callID !== form.callId) return null
  const opened = pickerForm(opencodePickerQuestions(request))
  const checked = pickerForm(opencodePickerQuestions(form))
  if ('error' in opened || 'error' in checked || !sameQuestions(opened.questions, checked.questions)) return null
  return request
}

async function runForm(deps: CommandDeps, pipe: PluginPipe): Promise<number> {
  const logger = log(deps)
  const form = formContext(await pipe.next(ASK_FRAME_TIMEOUT_MS))
  if ('error' in form) {
    pipe.send({ type: 'terminal', reason: form.error })
    pipe.close()
    return 0
  }
  logger.bind({ cmd: 'hook opencode-question', session: form.sessionId })
  let admission = admitForm(deps, form)
  // A form already open can only be carried or left in OpenCode.
  if (admission.kind === 'refused' && form.opened !== undefined) {
    admission = { kind: 'terminal', reason: admission.reason === 'unlinkable' ? 'unsupported-form' : admission.reason,
      ...(admission.detail === undefined ? {} : { detail: admission.detail }) }
  }
  if (admission.kind === 'refused') {
    logger.info('hook.gate', { hook: 'opencode-question', reason: admission.reason, ...admission.detail,
      stage: admission.stage ?? 'form-refused' })
    pipe.send({ type: 'refused', message: admission.message })
    pipe.close()
    return 0
  }
  if (admission.kind === 'terminal') {
    logger.info('hook.gate', { hook: 'opencode-question', reason: admission.reason, ...admission.detail, stage: 'form-terminal-only' })
    pipe.send({ type: 'terminal', reason: admission.reason })
    pipe.close()
    return 0
  }
  const carriage = admission.carriage
  if (form.opened === undefined) {
    pipe.send({ type: 'accepted', question_id: carriage.entry.question_id })
    if (await awaitOpened(pipe, form) === null) {
      releaseRegistration(carriage, deps.env)
      logger.info('hook.end', { hook: 'opencode-question', outcome: 'form-not-opened', question_id: carriage.entry.question_id })
      pipe.send({ type: 'done', outcome: 'form-not-opened' })
      pipe.close()
      return 0
    }
  }
  await sweepAbandonedOpencodeForms(deps)
  let settled: Inbound | null | undefined
  const frame = pipe.next().then((value) => {
    const inbound = value === 'timeout' ? null : value
    settled = inbound
    return inbound
  })
  // The terminal-first delay runs from registration: a hand-back registered
  // a while ago has already served part of it.
  const now = (deps.now ?? Date.now)()
  const dueAt = Math.min(carriage.entry.asked_at ?? now, now) + carriage.config.ask_grace_seconds.value * 1000
  if (await settlesWithin(frame, dueAt - now, deps)) {
    releaseRegistration(carriage, deps.env, settled?.type === 'native' ? 'answered' : 'withdrawn')
    logger.info('hook.gate', { hook: 'opencode-question', reason: 'settled-in-opencode', stage: 'form-terminal-only' })
    pipe.send({ type: 'terminal', reason: 'settled-in-opencode' })
    pipe.close()
    return 0
  }
  const submitted = await submitForm(deps, carriage, logger)
  if ('reason' in submitted) {
    releaseRegistration(carriage, deps.env)
    logger.info('hook.gate', { hook: 'opencode-question', reason: submitted.reason, ...submitted.detail, stage: 'form-terminal-only' })
    pipe.send({ type: 'terminal', reason: submitted.reason })
    pipe.close()
    return 0
  }
  const registration = submitted
  if (registration.owner !== null) {
    recordOpenForm(deps.env, { request_id: registration.requestId, session_id: registration.sessionId, ...registration.service,
      owner: registration.owner })
  }
  pipe.send({ type: 'registered', request_id: registration.requestId })

  let outcome = 'withdrawn'
  let terminal: QuestionTerminalState = 'retired'
  try {
    for (;;) {
      const raced = await Promise.race([
        frame.then((value) => ({ source: 'plugin' as const, value })),
        pollForAnswer(registration, () => settled !== undefined, deps)
          .then((value) => ({ source: 'service' as const, value })),
      ])
      if (raced.source === 'plugin' || settled !== undefined) {
        const value = settled ?? null
        if (value?.type === 'native') outcome = await reportNativeAnswer(registration, value.answers, logger)
        else {
          // Dismissed in OpenCode, the session deleted, or OpenCode gone.
          await closeQuietly(registration, logger)
          outcome = value?.type === 'dismissed' ? 'dismissed' : 'session-closed'
        }
        break
      }
      const result = raced.value
      if (result === null) continue
      if (result.kind === 'expired') {
        // Dismissed on a device, or its window ended: the form closes
        // unanswered, and the agent reads only that the question expired.
        await closeQuietly(registration, logger)
        pipe.send({ type: 'expired', context: CLAUDE_PICKER_DISMISSED })
        const verdict = await frame
        if (verdict?.type === 'native') outcome = await reportNativeAnswer(registration, verdict.answers, logger)
        else outcome = verdict?.type === 'applied' ? 'expired' : verdict?.type === 'stale' ? 'form-already-settled' : 'session-closed'
        break
      }
      // Close under the reply fence before handing an answer over, so a
      // correction racing the close is the answer that reaches the agent.
      const closed = await registration.client.closeReplies(registration.requestId, 'deliver')
      const reply = closed.replies.find((item) => item.seq === closed.delivered_reply_seq) ??
        closed.replies[closed.replies.length - 1]
      const answers = reply === undefined ? null : opencodeDeviceAnswers(registration.form, reply)
      if (answers === null) {
        outcome = 'answer-not-presentable'
        break
      }
      const acknowledgement = acknowledgementCommand(registration.requestId, closed.agent_acknowledgement_text_required,
        closed.agent_acknowledgement, true)
      pipe.send({
        type: 'answer', request_id: registration.requestId, answers,
        acknowledgement: acknowledgement === null ? '' : acknowledgement,
      })
      const verdict = await frame
      if (verdict?.type === 'applied') outcome = 'device-answer-delivered'
      else if (verdict?.type === 'native') outcome = await reportNativeAnswer(registration, verdict.answers, logger)
      else outcome = verdict?.type === 'stale' ? 'form-already-settled' : 'session-closed'
      break
    }
  } catch (err) {
    outcome = 'failed'
    logger.error('hook.end', { hook: 'opencode-question', outcome: 'failed', request_id: registration.requestId,
      error: err instanceof Error ? err.message : String(err) })
    await closeQuietly(registration, logger)
  }
  if (outcome === 'device-answer-delivered' || outcome === 'native-answer-recorded') terminal = 'answered'
  dropPendingQuestion(registration.sessionId, deps.env, registration.entry, terminal)
  dropOpenForm(deps.env, registration.requestId)
  logger.info('hook.end', { hook: 'opencode-question', outcome, request_id: registration.requestId,
    question_id: registration.entry.question_id })
  pipe.send({ type: 'done', outcome })
  pipe.close()
  return 0
}
