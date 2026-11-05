/**
 * Codex's pausing question (`request_user_input`) in an Orca chat, on the
 * User's devices too.
 *
 * Orca's chat shows each question of the request as its own item
 * (`agentSession.history` lists the pending ones in `actionablePromptIds`),
 * and Codex waits until every one is answered. Notifai's hooks never see the
 * request start (Codex runs no `PreToolUse` for it under Notifai's matcher),
 * so the hub reads Orca's history while an Orca chat turn runs and registers
 * one device question per request. A device answer goes back through Orca:
 *
 * - a picked choice answers its item with `agentSession.respondToQuestion`,
 *   exactly as picking it in Orca does; an item the User already answered in
 *   Orca keeps that answer (first reply wins);
 * - a typed answer is what typing in Orca's composer does while the question
 *   is open: a message of the User's own (`agentSession.send`), quoting the
 *   question it answers. As in Orca, it reaches the agent with the turn, once
 *   the pausing question itself is answered or the turn is stopped.
 *
 * The agent reads the answer once, as the tool's own result (or the
 * message); the acknowledgement command comes with the next hook that sees
 * it. An answer given in Orca closes the device question. Anything that keeps
 * this route from working leaves the question to Orca alone, and a device
 * question already created is withdrawn without a new alert.
 */
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { QUESTION_TEXT_MAX_LENGTH } from '@raidiant/notifai-protocol'
import { fit, fitChoiceLabels, withoutRecommendedSuffix } from './claude-question-bindings.js'
import { withdrawPickerQuestion } from './claude-question-hooks.js'
import { buildAskDraft, buildQuestions } from './commands-ask.js'
import type { CommandDeps } from './commands-core.js'
import { resolveDraftInvocation } from './commands-send-support.js'
import { CodexControlNotSent } from './codex-native-control.js'
import { loadConfig } from './config.js'
import type { ServiceIdentity } from './credentials.js'
import { acknowledgementContext } from './hook-acknowledgements.js'
import { registerQuestion } from './hook-lifecycle.js'
import { readSessionIncarnation, readSessionState, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import type { AnsweredPending, HookEnvelope, SessionState } from './hook-types.js'
import { orcaCapabilities, orcaOperationId, orcaPayloadFingerprint, orcaRuntime, type OrcaRuntime } from './orca-runtime.js'
import { projectBinding, projectDisabled } from './project-enablement.js'
import { spawnQuestionSettlement } from './question-settlement-process.js'
import type { DeliveryLease } from './session-delivery.js'
import type { NativeInputAnswers } from './session-inputs.js'

/** What Orca must offer: structured sessions, answers to its question items, and a send that reports acceptance. */
export const ORCA_BLOCKING_CAPABILITIES = Object.freeze(['agent-session.structured.v1', 'agent-session.question-answers.v1', 'agent-session.accepted-send.v1'])
/** A request whose items stay gone this long, with nothing from Notifai's hooks, ended without a device answer. */
export const ORCA_BLOCKING_GONE_MS = 15_000

export interface OrcaBlockingItem {
  item_id: string
  /** Codex's id of this question in the request. */
  codex_question_id: string
  /** The device question's own id in the Notifai question. */
  question_id: string
  /** The question as Orca and the agent show it. */
  title: string
  /** Device choice id → Orca option id. */
  options: Record<string, string>
}

export interface OrcaBlockingRegistration {
  question_id: string
  owner_key: string
  orca_session_id: string
  call_id: string
  service_identity: ServiceIdentity
  items: OrcaBlockingItem[]
  /** A device answer went back through Orca. */
  presented?: true
  /** Its acknowledgement command, for the first hook that sees the answer; `digest` names a typed message. */
  ack?: { context: string; digest?: string; shown?: true; typed_seen?: true }
  /** Settled another way (answered in Orca, or gone): nothing more is sent for it. */
  ended?: true
  missing_since?: number
}

interface OrcaPromptItem { itemId: string; revision: number; question: string; options: Array<{ id: string; label: string }> }
export interface OrcaBlockingRequest { callId: string; items: Array<OrcaPromptItem & { codexQuestionId: string }> }

const decode = (part: string): string | null => { try { return decodeURIComponent(part) } catch { return null } }

/** `orca:codex-prompt%3A<thread>%3A<call_id>%3A<question id>`, for this thread only; a digested id names nothing. */
export function parseOrcaPromptItemId(itemId: string, threadId: string): { callId: string; codexQuestionId: string } | null {
  const prefix = 'orca:codex-prompt%3A'
  if (!itemId.startsWith(prefix)) return null
  const parts = itemId.slice(prefix.length).split('%3A').map(decode)
  if (parts.length !== 3 || parts.some((part) => part === null || part === '') || parts[0] !== threadId) return null
  return { callId: parts[1]!, codexQuestionId: parts[2]! }
}

/** The pausing requests Orca's chat shows unanswered for this Codex thread, grouped by call. */
export function orcaBlockingRequests(page: Record<string, unknown>, threadId: string): OrcaBlockingRequest[] {
  const actionable = new Set(Array.isArray(page['actionablePromptIds']) ? (page['actionablePromptIds'] as unknown[]).filter((id): id is string => typeof id === 'string') : [])
  const requests = new Map<string, OrcaBlockingRequest>()
  for (const item of Array.isArray(page['items']) ? page['items'] as Array<{ itemId?: unknown; revision?: unknown; body?: Record<string, unknown> }> : []) {
    const body = item?.body
    if (typeof item?.itemId !== 'string' || !actionable.has(item.itemId) || body?.['kind'] !== 'question' ||
        (body['resolution'] as { state?: unknown } | undefined)?.state !== 'pending' || typeof item.revision !== 'number' ||
        typeof body['question'] !== 'string' || body['questions'] !== undefined || !Array.isArray(body['options'])) continue
    const parsed = parseOrcaPromptItemId(item.itemId, threadId)
    if (parsed === null) continue
    const options = (body['options'] as Array<{ id?: unknown; label?: unknown }>).flatMap((option) =>
      typeof option?.id === 'string' && typeof option.label === 'string' ? [{ id: option.id, label: option.label }] : [])
    const request = requests.get(parsed.callId) ?? { callId: parsed.callId, items: [] }
    request.items.push({ itemId: item.itemId, revision: item.revision, question: body['question'], options, codexQuestionId: parsed.codexQuestionId })
    requests.set(parsed.callId, request)
  }
  return [...requests.values()]
}

/** The request's own arguments, from the rollout: headers and option descriptions Orca does not show. */
export function readRequestArguments(transcriptPath: string | undefined, callId: string): Array<{ id: string; header?: string; question: string;
  options: Array<{ label: string; description?: string }> }> | null {
  if (transcriptPath === undefined) return null
  let fd: number | undefined
  try {
    fd = openSync(transcriptPath, 'r')
    const size = fstatSync(fd).size
    const at = Math.max(0, size - 512 * 1024)
    const bytes = Buffer.alloc(size - at)
    readSync(fd, bytes, 0, bytes.length, at)
    for (const line of bytes.toString('utf8').split('\n').reverse()) {
      if (!line.includes(callId) || !line.includes('request_user_input')) continue
      let record: { type?: unknown; payload?: { type?: unknown; name?: unknown; call_id?: unknown; arguments?: unknown } }
      try { record = JSON.parse(line) as typeof record } catch { continue }
      const payload = record.payload
      if (payload?.type !== 'function_call' || payload.name !== 'request_user_input' || payload.call_id !== callId || typeof payload.arguments !== 'string') continue
      const args = JSON.parse(payload.arguments) as { questions?: unknown }
      return Array.isArray(args.questions) ? args.questions.flatMap((entry: Record<string, unknown>) =>
        typeof entry?.['id'] === 'string' && typeof entry['question'] === 'string' && Array.isArray(entry['options']) ? [{
          id: entry['id'], question: entry['question'],
          ...(typeof entry['header'] === 'string' ? { header: entry['header'] } : {}),
          options: (entry['options'] as Array<Record<string, unknown>>).flatMap((option) => typeof option?.['label'] === 'string'
            ? [{ label: option['label'], ...(typeof option['description'] === 'string' ? { description: option['description'] } : {}) }] : []),
        }] : []) : null
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Register one device question for a pausing request, as the card hook does
 * for a card: same Project, routing and sign-in rules, the Agent Session's
 * name as title. Null when it is not carried (stays Orca's alone).
 */
export function registerOrcaBlockingQuestion(deps: CommandDeps, input: {
  sessionId: string; env: NodeJS.ProcessEnv; cwd: string; ownerKey: string; orcaSessionId: string
  transcriptPath?: string; request: OrcaBlockingRequest; now: number
}): string | null {
  const { sessionId, env, cwd, request } = input
  const config = loadConfig({ cwd, env, sessionId })
  if (projectDisabled(projectBinding(cwd, env, config.project.value)) || !config.ask_notifications.value) return null
  const credential = deps.store.load()
  if (credential === null) return null
  const service = { machine_id: credential.machineId, base_url: credential.baseUrl }
  if (request.items.length === 0 || request.items.length > 3 || request.items.some((item) => item.options.length < 2 || item.options.length > 6)) return null
  const args = readRequestArguments(input.transcriptPath, request.callId)
  const questions = request.items.map((item) => {
    const spec = args?.find((entry) => entry.id === item.codexQuestionId)
    const labels = item.options.map((option) => withoutRecommendedSuffix(option.label) ?? option.label)
    const recommended = item.options.filter((option) => withoutRecommendedSuffix(option.label) !== null)
    const fitted = fitChoiceLabels(labels)
    return {
      text: fit(item.question, QUESTION_TEXT_MAX_LENGTH),
      ...(spec?.header !== undefined && request.items.length > 1 ? { title: spec.header } : {}),
      choices: fitted.map((label, position) => {
        const description = spec?.options.find((option) => option.label === item.options[position]!.label)?.description
        return { label, ...(description === undefined || description.trim() === '' ? {} : { description }),
          ...(recommended.length === 1 && recommended[0] === item.options[position] ? { recommended: true } : {}) }
      }),
    }
  })
  const form = buildQuestions({ form: JSON.stringify({ summary: questions[0]!.text, questions }) }, undefined, { selfOpened: true })
  if (!form.ok) return null
  const source = resolveDraftInvocation({ ...deps, cwd, env }, {}, { harness: 'codex', label: 'Codex', sessionId })
  if (!source.ok) return null
  const draft = buildAskDraft(config, form, {}, source.invocation, [], undefined, env)
  if (!draft.ok) return null
  const { question_id: questionId } = registerQuestion(sessionId, env, {
    question: form.questions[0]!.text, title: draft.draft.presentation.title, summary: draft.draft.presentation.summary,
    questions: form.questions, service_identity: service,
    ...(draft.draft.presentation.body === undefined ? {} : { body: draft.draft.presentation.body }),
    ...(draft.draft.project === undefined ? {} : { project: draft.draft.project }),
    ...(draft.draft.source === undefined ? {} : { source: draft.draft.source }),
  }, input.now, undefined, { owner_key: input.ownerKey, machineStillMatches: () => {
    const current = deps.store.load()
    return current?.machineId === service.machine_id && current.baseUrl === service.base_url
  } })
  const registration: OrcaBlockingRegistration = {
    question_id: questionId, owner_key: input.ownerKey, orca_session_id: input.orcaSessionId, call_id: request.callId,
    service_identity: service,
    items: request.items.map((item, index) => ({
      item_id: item.itemId, codex_question_id: item.codexQuestionId, question_id: form.questions[index]!.id, title: item.question,
      options: Object.fromEntries((form.questions[index]!.choices ?? []).map((choice, position) => [choice.id, item.options[position]!.id])),
    })),
  }
  updateSessionState(sessionId, env, (state) => state.orca_blocking?.some((entry) => entry.call_id === request.callId) ? state
    : { ...state, orca_blocking: [...(state.orca_blocking ?? []), registration] })
  try {
    ;(deps.spawnQuestionSettlement ?? spawnQuestionSettlement)({ envelope: { session_id: sessionId, cwd }, harness: 'codex', purpose: 'submission' })
  } catch { /* The next hook or attendant pass submits it. */ }
  return questionId
}

function openRegistration(state: SessionState, ownerKey: string, questionId: string | undefined): OrcaBlockingRegistration | undefined {
  return state.orca_blocking?.find((entry) => entry.question_id === questionId && entry.owner_key === ownerKey &&
    entry.presented !== true && entry.ended !== true)
}

/** Whether the User answered on a device and that answer can go back through Orca now. */
export function orcaBlockingAnswerWaits(state: SessionState, ownerKey: string, service: ServiceIdentity): boolean {
  return (state.waiting_answers ?? []).some((answer) => answer.delivery_claim === true &&
    isDeepStrictEqual(answer.pending.service_identity, service) && openRegistration(state, ownerKey, answer.pending.question_id) !== undefined)
}

interface Plan { picks: Array<{ item: OrcaBlockingItem; option: string }>; typed: Array<{ item: OrcaBlockingItem; text: string }> }

/** A device answer as Orca takes it: a picked choice per item, typed text as the User's message. */
export function orcaBlockingPlan(registration: OrcaBlockingRegistration, answer: AnsweredPending): Plan | null {
  const plan: Plan = { picks: [], typed: [] }
  for (const part of answer.reply.answers) {
    const item = registration.items.find((entry) => entry.question_id === part.question_id)
    if (item === undefined) return null
    const typed = part.text?.trim() ?? ''
    if (part.choice_ids.length === 1 && typed === '') {
      const option = item.options[part.choice_ids[0]!]
      if (option === undefined) return null
      plan.picks.push({ item, option })
    } else if (part.choice_ids.length === 0 && typed !== '') plan.typed.push({ item, text: typed })
    else return null
  }
  return plan.picks.length + plan.typed.length === 0 ? null : plan
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const promptDigest = (text: string): string => sha256(text.replace(/\r\n?/gu, '\n').trimEnd())

async function historyPage(runtime: OrcaRuntime, sessionId: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const reply = await runtime.call('agentSession.history', { sessionId, direction: 'tail', limit: 100 }, timeoutMs)
  const page = reply.ok ? (reply.result as { page?: Record<string, unknown> } | null)?.page : undefined
  return page !== undefined && page !== null && typeof page['fence'] === 'number' ? page : null
}

const refusal = (result: unknown): string | null => {
  const value = result as { ok?: unknown; refusal?: { code?: unknown } } | null
  return value?.ok === false ? (typeof value.refusal?.code === 'string' ? value.refusal.code : 'refused') : null
}

export function orcaBlockingPresentation(input: {
  sessionId: string; env: NodeJS.ProcessEnv; lease: DeliveryLease; ownerKey: string
  service: ServiceIdentity; serviceCurrent(): boolean; wall(): number; remainingMs?: () => number
  runtime?: OrcaRuntime | null
}): NativeInputAnswers {
  const budget = (ms: number): number => Math.max(1, Math.min(ms, input.remainingMs?.() ?? ms))
  const registration = (answer: AnsweredPending, state: SessionState) => state.orca_chat?.key === input.ownerKey
    ? openRegistration(state, input.ownerKey, answer.pending.question_id) : undefined
  const ready = (answer: AnsweredPending, state: SessionState) => answer.delivery_claim === true && answer.replies.length === 1 &&
    isDeepStrictEqual(answer.pending.service_identity, input.service) && registration(answer, state) !== undefined
  return {
    eligible: ready,
    group: (answer, state) => ready(answer, state) ? [answer] : null,
    prepare: async () => null,
    prepareGroup: async (selected, state) => {
      const answer = selected[0]
      const entry = answer === undefined || selected.length !== 1 ? undefined : registration(answer, state)
      const chat = state.orca_chat
      const plan = entry === undefined ? null : orcaBlockingPlan(entry, answer!)
      if (entry === undefined || plan === null || chat === undefined || chat.session_id !== entry.orca_session_id) return null
      const runtime = input.runtime !== undefined ? input.runtime
        : orcaRuntime({ ...input.env, ...(chat.user_data === undefined ? {} : { ORCA_USER_DATA_PATH: chat.user_data }) })
      if (runtime === null) return null
      const capabilities = await orcaCapabilities(runtime, budget(2_000))
      if (capabilities === null || !ORCA_BLOCKING_CAPABILITIES.every((capability) => capabilities.has(capability))) return null
      const typedText = plan.typed.map(({ item, text }) => `> ${item.title.replace(/[\r\n]+/gu, ' ')}\n\n${text}`).join('\n\n')
      const context = 'Notifai — the User answered this question on their device' +
        (plan.picks.length > 0 ? '; their choice is in the tool result' : '') +
        (plan.typed.length > 0 ? `; what they typed arrives as their message` : '') + ', and it is final.' + acknowledgementContext([answer!])
      const validate = (latest: SessionState) => ({ state: latest, valid: registration(answer!, latest) !== undefined &&
        isDeepStrictEqual(orcaBlockingPlan(registration(answer!, latest)!, answer!), plan) })
      return {
        presentation: {
          kind: 'orca-blocking-answer', request_id: answer!.pending.request_id!, question_id: entry.question_id,
          replies: [{ reply_id: answer!.reply.reply_id, seq: answer!.reply.seq }],
          owner_key: input.ownerKey, incarnation: input.lease.incarnation, generation: input.lease.generation,
          service_identity: input.service, orca_session_id: entry.orca_session_id, call_id: entry.call_id,
        },
        validate,
        write: async (mayWrite) => {
          if (!input.serviceCurrent()) throw new CodexControlNotSent('The Approved Machine changed before the Orca answer was sent')
          let page = await historyPage(runtime, entry.orca_session_id, budget(3_000))
          if (page === null) throw new CodexControlNotSent('Orca history is not readable')
          const live = (itemId: string) => (page!['items'] as Array<{ itemId?: unknown; revision?: unknown; body?: { resolution?: { state?: unknown } } }> | undefined)
            ?.find((item) => item?.itemId === itemId)
          // Every item of the answer must still be this chat's, or nothing is sent.
          if (![...plan.picks, ...plan.typed].every(({ item }) => live(item.item_id) !== undefined)) throw new CodexControlNotSent('The Orca chat does not show this question')
          let valid = false
          updateSessionState(input.sessionId, input.env, (latest) => {
            valid = validate(latest).valid && mayWrite()
            return !valid ? latest : { ...latest, orca_blocking: (latest.orca_blocking ?? []).map((item) => item.call_id === entry.call_id
              ? { ...item, presented: true as const, ack: { context, ...(typedText === '' ? {} : { digest: promptDigest(typedText) }) } } : item) }
          })
          if (!valid) throw new CodexControlNotSent('Answer authority changed before the Orca answer')
          let answered = 0
          let unsettled = false
          for (const { item, option } of plan.picks) {
            for (let attempt = 0; attempt < 2; attempt += 1) {
              const current = live(item.item_id) as { revision?: number; body?: { resolution?: { state?: unknown } } } | undefined
              if (current?.body?.resolution?.state !== 'pending' || typeof current.revision !== 'number') break
              const fields = { itemId: item.item_id, expectedRevision: current.revision, answers: [{ questionId: 'q1', optionIds: [option] }] }
              const reply = await runtime.call('agentSession.respondToQuestion', { envelope: { sessionId: entry.orca_session_id,
                clientOperationId: orcaOperationId(input.wall()), expectedRuntimeFence: page['fence'],
                payloadFingerprint: orcaPayloadFingerprint('agentSession.respondTo:question', entry.orca_session_id, fields) }, ...fields }, budget(3_000))
              const refused = reply.ok ? refusal(reply.result) : reply.code
              if (refused === null) { answered += 1; break }
              // Answered in Orca first: that answer stands.
              if (refused === 'agent_session_already_resolved') break
              if (refused === 'agent_session_item_revision_stale' && attempt === 0) {
                page = await historyPage(runtime, entry.orca_session_id, budget(2_000)) ?? page
                continue
              }
              if (!reply.ok && ['timeout', 'connection_closed'].includes(reply.code)) unsettled = true
              break
            }
          }
          let sent = false
          if (typedText !== '') {
            const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: typedText }] }
            const reply = await runtime.call('agentSession.send', { envelope: { sessionId: entry.orca_session_id,
              clientOperationId: orcaOperationId(input.wall()), expectedRuntimeFence: page['fence'],
              payloadFingerprint: orcaPayloadFingerprint('agentSession.send', entry.orca_session_id, { body }) }, body }, budget(4_000))
            sent = reply.ok && refusal(reply.result) === null
            if (!reply.ok && ['timeout', 'connection_closed'].includes(reply.code)) unsettled = true
          }
          if (answered > 0 || sent) return
          if (unsettled) throw new Error('The Orca answer may have been taken; it is not sent again')
          // Nothing of it reached Orca: the ordinary route keeps the answer.
          updateSessionState(input.sessionId, input.env, (latest) => ({ ...latest, orca_blocking: (latest.orca_blocking ?? []).map((item) => {
            if (item.call_id !== entry.call_id) return item
            const next = { ...item }
            delete next.presented
            delete next.ack
            return next
          }) }))
          throw new CodexControlNotSent('Orca took none of the answer')
        },
        close: () => undefined,
      }
    },
  }
}

/** The live root hook of this session's owner, as every Codex input observer requires. */
function hookOwnerKey(deps: CommandDeps, envelope: HookEnvelope): string | null {
  const sessionId = envelope.session_id
  if (sessionId === undefined || envelope.agent_id !== undefined || envelope.agent_type !== undefined) return null
  const owner = readSessionIncarnation(sessionId, deps.env)
  return owner?.harness_process?.pid === Number(deps.env['NOTIFAI_HOOK_SOURCE_PID']) && !sessionHasEnded(sessionId, deps.env) ? owner.key : null
}

/**
 * `PostToolUse` of a pausing question: the agent just read its answers.
 * After a device answer it gets that answer's acknowledgement, once. With no
 * device answer the User answered in Orca, and the device question closes.
 * `carried` says the question was on the devices, so no "not carried" notice applies.
 */
export function orcaBlockingPostToolUse(deps: CommandDeps, envelope: HookEnvelope): { carried: boolean; context: string | null } {
  if (envelope.tool_name !== 'request_user_input' || typeof envelope.tool_use_id !== 'string') return { carried: false, context: null }
  const owner = hookOwnerKey(deps, envelope)
  if (owner === null) return { carried: false, context: null }
  const sessionId = envelope.session_id!
  const entry = readSessionState(sessionId, deps.env).orca_blocking?.find((item) => item.call_id === envelope.tool_use_id && item.owner_key === owner)
  if (entry === undefined) return { carried: false, context: null }
  if (entry.presented === true) return { carried: true, context: takeAck(sessionId, deps.env, (item) => item.call_id === entry.call_id) }
  if (entry.ended !== true) {
    endRegistration(sessionId, deps.env, entry.call_id)
    if (withdrawPickerQuestion(sessionId, deps.env, entry.question_id, 'answered_elsewhere') === 'retiring') {
      try { (deps.spawnQuestionSettlement ?? spawnQuestionSettlement)({ envelope: { session_id: sessionId, cwd: envelope.cwd ?? deps.cwd }, harness: 'codex', purpose: 'submission' }) }
      catch { /* The next settlement pass retires it. */ }
    }
  }
  return { carried: true, context: null }
}

/**
 * A typed device answer reached Codex as the User's message (Codex runs
 * `UserPromptSubmit` for it once the pausing question is answered, right
 * after its `PostToolUse`): its acknowledgement, unless that hook showed it.
 * `typed` says the prompt is that message, which is no answer to anything else.
 */
export function takeOrcaBlockingTypedAck(sessionId: string, env: NodeJS.ProcessEnv, prompt: unknown): { typed: boolean; context: string | null } {
  if (typeof prompt !== 'string') return { typed: false, context: null }
  const digest = promptDigest(prompt)
  const which = (item: OrcaBlockingRegistration) => item.ack?.digest === digest && item.ack.typed_seen !== true
  if (!readSessionState(sessionId, env).orca_blocking?.some(which)) return { typed: false, context: null }
  let context: string | null = null
  let typed = false
  updateSessionState(sessionId, env, (state) => ({ ...state, orca_blocking: (state.orca_blocking ?? []).map((item) => {
    if (typed || !which(item)) return item
    typed = true
    if (item.ack!.shown !== true) context = item.ack!.context
    return { ...item, ack: { ...item.ack!, shown: true as const, typed_seen: true as const } }
  }) }))
  return { typed, context }
}

function takeAck(sessionId: string, env: NodeJS.ProcessEnv, which: (item: OrcaBlockingRegistration) => boolean): string | null {
  if (!readSessionState(sessionId, env).orca_blocking?.some((item) => which(item) && item.ack !== undefined && item.ack.shown !== true)) return null
  let context: string | null = null
  updateSessionState(sessionId, env, (state) => ({ ...state, orca_blocking: (state.orca_blocking ?? []).map((item) => {
    if (context !== null || !which(item) || item.ack === undefined || item.ack.shown === true) return item
    context = item.ack.context
    return { ...item, ack: { ...item.ack, shown: true as const } }
  }) }))
  return context
}

function endRegistration(sessionId: string, env: NodeJS.ProcessEnv, callId: string): void {
  updateSessionState(sessionId, env, (state) => ({ ...state, orca_blocking: (state.orca_blocking ?? []).map((item) =>
    item.call_id === callId ? { ...item, ended: true as const } : item) }))
}

/**
 * One look at Orca's chat for this session: register the pausing requests
 * not yet on the devices, and withdraw, without a new alert, a device
 * question whose request left Orca unanswered (the turn was stopped, or
 * Orca dropped it) and that no hook settled within `ORCA_BLOCKING_GONE_MS`.
 */
export async function reconcileOrcaBlocking(deps: CommandDeps, input: {
  sessionId: string; env: NodeJS.ProcessEnv; cwd: string; ownerKey: string; transcriptPath?: string
  runtime?: OrcaRuntime | null; now: number; skip: Set<string>
}): Promise<{ registered: string[]; withdrawn: string[] }> {
  const result = { registered: [] as string[], withdrawn: [] as string[] }
  const state = readSessionState(input.sessionId, input.env)
  const chat = state.orca_chat
  if (chat?.key !== input.ownerKey) return result
  const runtime = input.runtime !== undefined ? input.runtime
    : orcaRuntime({ ...input.env, ...(chat.user_data === undefined ? {} : { ORCA_USER_DATA_PATH: chat.user_data }) })
  if (runtime === null) return result
  const capabilities = await orcaCapabilities(runtime, 2_000)
  if (capabilities === null || !ORCA_BLOCKING_CAPABILITIES.every((capability) => capabilities.has(capability))) return result
  const page = await historyPage(runtime, chat.session_id, 3_000)
  if (page === null) return result
  const requests = orcaBlockingRequests(page, input.sessionId)
  const known = new Set((state.orca_blocking ?? []).map((entry) => entry.call_id))
  for (const request of requests) {
    if (known.has(request.callId) || input.skip.has(request.callId)) continue
    let id: string | null = null
    try {
      id = registerOrcaBlockingQuestion(deps, { sessionId: input.sessionId, env: input.env, cwd: input.cwd, ownerKey: input.ownerKey,
        orcaSessionId: chat.session_id, ...(input.transcriptPath === undefined ? {} : { transcriptPath: input.transcriptPath }), request, now: input.now })
    } catch {
      // The Agent Session changed under it: this request stays Orca's alone.
    }
    if (id === null) input.skip.add(request.callId)
    else result.registered.push(id)
  }
  const pendingIds = new Set(requests.flatMap((request) => request.items.map((item) => item.itemId)))
  for (const entry of readSessionState(input.sessionId, input.env).orca_blocking ?? []) {
    if (entry.owner_key !== input.ownerKey || entry.ended === true || entry.presented === true) continue
    const showing = entry.items.some((item) => pendingIds.has(item.item_id))
    if (showing) {
      if (entry.missing_since !== undefined) updateSessionState(input.sessionId, input.env, (latest) => ({ ...latest,
        orca_blocking: (latest.orca_blocking ?? []).map((item) => {
          if (item.call_id !== entry.call_id) return item
          const next = { ...item }
          delete next.missing_since
          return next
        }) }))
      continue
    }
    if (entry.missing_since === undefined) {
      updateSessionState(input.sessionId, input.env, (latest) => ({ ...latest, orca_blocking: (latest.orca_blocking ?? []).map((item) =>
        item.call_id === entry.call_id ? { ...item, missing_since: input.now } : item) }))
      continue
    }
    if (input.now - entry.missing_since < ORCA_BLOCKING_GONE_MS) continue
    endRegistration(input.sessionId, input.env, entry.call_id)
    // An answer already given on a device keeps its own route; anything else is withdrawn quietly.
    if (withdrawPickerQuestion(input.sessionId, input.env, entry.question_id, 'expired') === 'retiring') {
      try { (deps.spawnQuestionSettlement ?? spawnQuestionSettlement)({ envelope: { session_id: input.sessionId, cwd: input.cwd }, harness: 'codex', purpose: 'submission' }) }
      catch { /* The next settlement pass retires it. */ }
      result.withdrawn.push(entry.question_id)
    }
  }
  return result
}
