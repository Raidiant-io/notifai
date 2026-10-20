/**
 * OpenCode's own question form, answerable from the User's devices.
 *
 * OpenCode's `question` tool shows a form and holds the agent's turn until the
 * User answers it or dismisses it. The generated plugin sees the form as a
 * `question.asked` event inside the OpenCode process and starts this command
 * for it. This command registers the form's own questions for the User's
 * devices and waits; it holds the Machine Credential, the plugin never does.
 *
 * Whichever answer arrives first settles the form:
 *
 * - A device answer is returned to the plugin, which checks that this exact
 *   request is still pending for this exact session and replies to it through
 *   OpenCode's in-process question API. The tool result then carries the
 *   answer back to the agent in the same turn.
 * - An answer or dismissal in OpenCode reaches the plugin as an event. The
 *   plugin passes it here: an answer is recorded as the native answer so the
 *   devices stop asking and show what was chosen; a dismissal withdraws the
 *   device question.
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
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { ListRepliesResponse, ReplyAnswerT, ReplyView } from '@raidiant/notifai-protocol'
import { pickerForm, type PickerForm, type PickerQuestion } from './claude-question-bindings.js'
import { ApiCallError, isRetryableReplyPollError, type ApiClient } from './client.js'
import { buildAskDraft } from './commands-ask.js'
import { log, makeClient, type CommandDeps } from './commands-core.js'
import { draftForServerCapabilities } from './commands-send.js'
import { acknowledgementCommand, resolveDraftInvocation } from './commands-send-support.js'
import { atomicWriteFileSync } from './atomic-file.js'
import { loadConfig, stateDir } from './config.js'
import { recordSessionNotified } from './hook-session-state.js'
import type { Logger } from './logging.js'
import { currentProcessIdentity, processIdentityLiveness, type ProcessIdentity } from './process-identity.js'
import { projectBinding, projectEnabled } from './project-enablement.js'

/** What OpenCode's devices-facing acknowledgement says for an answer given in OpenCode. */
export const OPENCODE_NATIVE_ACKNOWLEDGEMENT = 'Answered in OpenCode.'

/** How long the plugin has to send the form after starting this command. */
const ASK_FRAME_TIMEOUT_MS = 5_000

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
}

type AskFrame = {
  type: 'ask'
  session_id: string
  cwd: string
  request: OpencodeQuestionRequest
  /** OpenCode's own session title, when it has a real one. */
  session_label?: string
  session_label_pending?: boolean
}
type Inbound =
  | AskFrame
  | { type: 'applied' }
  | { type: 'stale' }
  | { type: 'native'; answers: string[][] }
  | { type: 'dismissed' }

export type OpencodeQuestionOutbound =
  | { type: 'terminal'; reason: string }
  | { type: 'registered'; request_id: string }
  | { type: 'answer'; request_id: string; answers: string[][]; acknowledgement: string }
  | { type: 'done'; outcome: string }

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** The request as OpenCode published it, or null when it is not one. */
export function opencodeQuestionRequest(value: unknown): OpencodeQuestionRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, sessionID, questions } = value as Record<string, unknown>
  if (!isString(id) || !/^que_[A-Za-z0-9_-]{1,128}$/.test(id) || !isString(sessionID) || sessionID === '' ||
      !Array.isArray(questions) || questions.length === 0) return null
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
  return { id, sessionID, questions: parsed }
}

/** OpenCode's form is Claude Code's picker shape; the device form is built the same way. */
export function opencodePickerQuestions(request: OpencodeQuestionRequest): PickerQuestion[] {
  return request.questions.map((entry) => ({
    question: entry.question,
    ...(entry.header === undefined ? {} : { header: entry.header }),
    options: entry.options,
    multiSelect: entry.multiple === true,
  }))
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

/** One stable identity per OpenCode request, so a restarted command never asks twice. */
function stableKey(prefix: string, sessionId: string, requestId: string): string {
  return `${prefix}-${createHash('sha256').update(`${sessionId}\0${requestId}`).digest('base64url').slice(0, 40)}`
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
  next(timeoutMs?: number): Promise<Inbound | null> {
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
          resolve(null)
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

type Registration = {
  client: ApiClient
  requestId: string
  form: PickerForm
  sessionId: string
  service: { base_url: string; machine_id: string }
}

type Prepared = Registration | { reason: string; detail?: Record<string, unknown> }

/**
 * Register the form's questions for the User's devices. Every refusal leaves
 * the form to OpenCode alone, which always works.
 */
async function registerForm(deps: CommandDeps, ask: AskFrame, logger: Logger): Promise<Prepared> {
  const { session_id: sessionId, cwd, request } = ask
  let config
  try {
    config = loadConfig({ cwd, env: deps.env, sessionId })
  } catch {
    return { reason: 'config-invalid' }
  }
  // Project Enablement is the User's opt-in: forms elsewhere stay in OpenCode.
  if (!projectEnabled(projectBinding(cwd, deps.env, config.project.value))) return { reason: 'project-not-enabled' }
  if (!config.ask_notifications.value) return { reason: 'question-routing-off' }
  const form = pickerForm(opencodePickerQuestions(request))
  if ('error' in form) return { reason: 'unsupported-form', detail: { shape: form.error } }
  const credential = deps.store.load()
  if (credential === null) return { reason: 'not-signed-in' }
  const client = makeClient(deps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`)
  // Hook stderr reaches nobody; a fallback-label heads-up has no reader here.
  const silent = { ...deps, cwd, io: { ...deps.io, err: () => undefined } }
  const source = resolveDraftInvocation(silent, {}, {
    harness: 'opencode', label: 'OpenCode', sessionId,
    ...(isString(ask.session_label) && ask.session_label.trim() !== '' ? { sessionLabel: ask.session_label } : {}),
    ...(ask.session_label_pending === true ? { sessionLabelPending: true } : {}),
  })
  if (!source.ok) return { reason: 'source-invalid' }
  const draft = buildAskDraft(config, form, {}, source.invocation, [])
  if (!draft.ok) return { reason: 'invalid-draft', detail: { error: draft.error } }
  try {
    const capabilities = await client.capabilities()
    const receipt = await client.submit({
      idempotency_key: stableKey('opencode-question', sessionId, request.id),
      draft: draftForServerCapabilities(draft.draft, capabilities),
    }, 0)
    recordSessionNotified(sessionId, deps.env, (deps.now ?? Date.now)())
    logger.info('ask.registered', {
      ok: true, origin: 'opencode-question', session: sessionId, request_id: receipt.request_id,
      questions: form.questions.length, overall: receipt.overall,
    })
    return { client, requestId: receipt.request_id, form, sessionId,
      service: { base_url: credential.baseUrl, machine_id: credential.machineId } }
  } catch (err) {
    return { reason: 'submission-failed', detail: {
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof ApiCallError ? { status: err.status, code: err.code } : {}),
    } }
  }
}

async function closeQuietly(registration: Registration, logger: Logger): Promise<void> {
  try {
    await registration.client.closeReplies(registration.requestId, 'retire')
  } catch (err) {
    logger.info('hook.gate', { hook: 'opencode-question', reason: 'retire-failed', request_id: registration.requestId,
      error: err instanceof Error ? err.message : String(err) })
  }
}

/** Record an answer given in OpenCode, so the devices show it and stop asking. */
async function reportNativeAnswer(registration: Registration, answers: unknown, logger: Logger): Promise<string> {
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
 * Long-poll the reply window until an answer arrives or the window ends.
 * `stopped` is checked between polls; a frame from the plugin wins at once.
 */
async function pollForAnswer(
  registration: Registration,
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

async function runForm(deps: CommandDeps, pipe: PluginPipe): Promise<number> {
  const logger = log(deps)
  const first = await pipe.next(ASK_FRAME_TIMEOUT_MS)
  const request = first?.type === 'ask' ? opencodeQuestionRequest(first.request) : null
  if (first?.type !== 'ask' || request === null || first.session_id !== request.sessionID ||
      !isString(first.cwd) || !path.isAbsolute(first.cwd) || !existsSync(first.cwd)) {
    pipe.send({ type: 'terminal', reason: 'invalid-form' })
    pipe.close()
    return 0
  }
  const ask: AskFrame = {
    type: 'ask', session_id: first.session_id, cwd: first.cwd, request,
    ...(isString(first.session_label) && first.session_label.length <= 512 ? { session_label: first.session_label } : {}),
    ...(first.session_label_pending === true ? { session_label_pending: true } : {}),
  }
  logger.bind({ cmd: 'hook opencode-question', session: ask.session_id })
  await sweepAbandonedOpencodeForms(deps)
  const prepared = await registerForm(deps, ask, logger)
  if ('reason' in prepared) {
    logger.info('hook.gate', { hook: 'opencode-question', reason: prepared.reason, ...prepared.detail, stage: 'form-terminal-only' })
    pipe.send({ type: 'terminal', reason: prepared.reason })
    pipe.close()
    return 0
  }
  const registration = prepared
  const owner = currentProcessIdentity()
  if (owner !== null) {
    recordOpenForm(deps.env, { request_id: registration.requestId, session_id: registration.sessionId, ...registration.service, owner })
  }
  pipe.send({ type: 'registered', request_id: registration.requestId })

  let outcome = 'withdrawn'
  let settled: Inbound | null | undefined
  const frame = pipe.next().then((value) => { settled = value; return value })
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
        await closeQuietly(registration, logger)
        outcome = 'expired'
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
  dropOpenForm(deps.env, registration.requestId)
  logger.info('hook.end', { hook: 'opencode-question', outcome, request_id: registration.requestId })
  pipe.send({ type: 'done', outcome })
  pipe.close()
  return 0
}
