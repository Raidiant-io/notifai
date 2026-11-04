/**
 * Device answers to Codex question cards in an Orca chat, sent through Orca.
 *
 * Orca's chat shows a Codex turn's `request_user_input_async` cards as one
 * card and clears all of them on any delivered user message. Its own answer
 * form sends one message quoting each question: `> question\n\nanswer`
 * blocks joined by a blank line. Once every card question of a turn has an
 * answer from the User's device, Notifai sends that same message through
 * Orca's runtime (`agentSession.send`), exactly as the User answering Orca's
 * card would: mid-turn Orca steers it into the running turn, and after a
 * stop it starts a new turn, so it is also the wake. Until then, and wherever
 * this route is unavailable, answers take Notifai's ordinary route.
 *
 * The send is the answers' presentation, claimed and journaled like any
 * other, so an answer reaches the agent once: never also as hook context.
 * The prompt hook that sees the message adds only the acknowledgement
 * commands, and the message is never read back as a terminal answer.
 *
 * Only for a session Orca runs on this machine (`ORCA_STRUCTURED_SESSION=1`
 * with its `ORCA_AGENT_SESSION_ID`); never for a paired or remote host, and
 * never from WSL, whose Orca runs on Windows.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { acknowledgementContext } from './hook-acknowledgements.js'
import { CodexControlNotSent } from './codex-native-control.js'
import type { CodexQuestionRegistration } from './codex-question-bindings.js'
import { codexHost } from './codex-surface.js'
import type { ServiceIdentity } from './credentials.js'
import { pendingList, readSessionState, updateSessionState } from './hook-session-state.js'
import type { AnsweredPending, SessionState } from './hook-types.js'
import { orcaCapabilities, orcaOperationId, orcaPayloadFingerprint, orcaRuntime, type OrcaRuntime } from './orca-runtime.js'
import type { DeliveryLease } from './session-delivery.js'
import type { NativeInputAnswers } from './session-inputs.js'

/** What the route needs from Orca: structured sessions and a send that reports acceptance. */
export const ORCA_CHAT_CAPABILITIES = Object.freeze(['agent-session.structured.v1', 'agent-session.accepted-send.v1'])

const SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/u
const SENT_KEPT_MS = 24 * 60 * 60_000

/** Whether this process runs under WSL, where Orca's runtime is the Windows host's. */
function underWsl(platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') return false
  try { return /microsoft/iu.test(readFileSync('/proc/version', 'utf8')) } catch { return false }
}

/**
 * The Orca chat this hook's Codex runs in, from the environment Orca gives
 * it; null anywhere else. A session on a paired or remote Orca host
 * (`ORCA_ENVIRONMENT`, `ORCA_REMOTE_PAIRING`) is not reachable here.
 */
export function orcaChatSessionOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { session_id: string; user_data?: string } | null {
  if (codexHost(env) !== 'orca') return null
  const id = env['ORCA_AGENT_SESSION_ID']?.trim() ?? ''
  if (!SESSION_ID.test(id)) return null
  if ((env['ORCA_ENVIRONMENT']?.trim() ?? '') !== '' || (env['ORCA_REMOTE_PAIRING']?.trim() ?? '') !== '' || underWsl(platform)) return null
  const userData = env['ORCA_USER_DATA_PATH']?.trim()
  return { session_id: id, ...(userData === undefined || userData === '' ? {} : { user_data: userData }) }
}

/** Remember the Orca chat for the owner that runs in it; the hub sends from there. */
export function recordOrcaChatSession(sessionId: string, env: NodeJS.ProcessEnv, ownerKey: string): void {
  const chat = orcaChatSessionOf(env)
  if (chat === null) return
  const current = readSessionState(sessionId, env).orca_chat
  if (current?.key === ownerKey && current.session_id === chat.session_id && current.user_data === chat.user_data) return
  updateSessionState(sessionId, env, (state) => ({ ...state, orca_chat: { key: ownerKey, ...chat } }))
}

function cardRegistration(state: SessionState, ownerKey: string, questionId: string | undefined): CodexQuestionRegistration | undefined {
  return state.codex_question_bindings?.find((item) => item.question_id === questionId && item.owner_key === ownerKey &&
    item.card_call_id !== undefined && item.terminated !== true && item.dismissed !== true && item.terminal_answered !== true &&
    item.questions.length > 0 && item.questions.every((binding) => binding.verified === true && binding.native !== undefined &&
      binding.card !== undefined && binding.ambiguous !== true))
}

/** A whole device answer, ready to be presented as one reply. */
function wholeAnswer(answer: AnsweredPending, service: ServiceIdentity): boolean {
  return answer.delivery_claim === true && answer.replies.length === 1 && isDeepStrictEqual(answer.reply, answer.replies[0]) &&
    answer.pending.request_id !== undefined && isDeepStrictEqual(answer.pending.service_identity, service)
}

/**
 * The cards of the answer's turn, each with its device answer, in the order
 * they were opened; null while any card question of that turn still waits
 * for an answer (sending now would clear a card nobody answered).
 */
export function orcaCardGroup(state: SessionState, ownerKey: string, service: ServiceIdentity, answer: AnsweredPending):
  Array<{ registration: CodexQuestionRegistration; answer: AnsweredPending }> | null {
  const first = cardRegistration(state, ownerKey, answer.pending.question_id)
  if (first === undefined) return null
  const waiting = state.waiting_answers ?? []
  const pending = new Set(pendingList(state).map((question) => question.question_id))
  const group: Array<{ registration: CodexQuestionRegistration; answer: AnsweredPending }> = []
  for (const registration of state.codex_question_bindings ?? []) {
    if (registration.registration_turn_id !== first.registration_turn_id ||
        cardRegistration(state, ownerKey, registration.question_id) !== registration) continue
    const answers = waiting.filter((entry) => entry.pending.question_id === registration.question_id)
    // Already handed in, or answered in Orca: nothing of it waits.
    if (answers.length === 0 && !pending.has(registration.question_id)) continue
    if (answers.length !== 1 || !wholeAnswer(answers[0]!, service)) return null
    group.push({ registration, answer: answers[0]! })
  }
  return group.length === 0 ? null : group
}

/** Orca's own answer message for these cards: one `> question` block per answered question. */
export function orcaAnswerText(group: Array<{ registration: CodexQuestionRegistration; answer: AnsweredPending }>): string {
  const blocks: string[] = []
  for (const { registration, answer } of group) {
    for (const binding of registration.questions) {
      const part = answer.reply.answers.find((entry) => entry.question_id === binding.question.id)
      if (part === undefined) continue
      const labels = part.choice_ids.map((id) => binding.card!.labels[id] ?? binding.question.choices?.find((choice) => choice.id === id)?.label ?? '')
        .filter((label) => label !== '')
      const typed = part.text?.trim() ?? ''
      const text = [...labels, ...(typed === '' ? [] : [typed])].join(', ')
      if (text !== '') blocks.push(`> ${binding.card!.title.replace(/[\r\n]+/gu, ' ')}\n\n${text}`)
    }
  }
  return blocks.join('\n\n').trimEnd()
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
/** The prompt Codex hands its hook for a sent message, compared by content. */
const promptDigest = (text: string): string => sha256(text.replace(/\r\n?/gu, '\n').trimEnd())

interface ToolCall { kind?: unknown; type?: unknown; name?: unknown; callId?: unknown }

/**
 * A card in the Orca session's recent history, by its Codex call id: a
 * `tool-call` item, or a `tool-call` block of an assistant message (how
 * Orca 1.4.248 records Codex's cards).
 */
function historyShowsCards(page: { items?: unknown }, callIds: readonly string[]): boolean {
  const seen = new Set<string>()
  const note = (call: ToolCall | undefined) => {
    if ((call?.kind === 'tool-call' || call?.type === 'tool-call') && call.name === 'request_user_input_async' &&
        typeof call.callId === 'string') seen.add(call.callId)
  }
  for (const item of Array.isArray(page.items) ? page.items as Array<{ body?: ToolCall & { blocks?: unknown } }> : []) {
    note(item?.body)
    if (Array.isArray(item?.body?.blocks)) for (const block of item.body.blocks as ToolCall[]) note(block)
  }
  return callIds.every((id) => seen.has(id))
}

async function history(runtime: OrcaRuntime, sessionId: string): Promise<{ fence: number; page: Record<string, unknown> } | null> {
  const reply = await runtime.call('agentSession.history', { sessionId, direction: 'tail', limit: 100 })
  const page = reply.ok ? ((reply.result as { page?: unknown } | null)?.page as Record<string, unknown> | undefined) : undefined
  return page !== undefined && page !== null && typeof page['fence'] === 'number' ? { fence: page['fence'], page } : null
}

/** Whether Orca recorded the submission with this operation id; null when it cannot be read. */
async function submitted(runtime: OrcaRuntime, sessionId: string, operationId: string): Promise<boolean | null> {
  const read = await history(runtime, sessionId)
  if (read === null || !Array.isArray(read.page['submissions'])) return null
  return (read.page['submissions'] as Array<{ clientMessageId?: unknown }>).some((entry) => entry?.clientMessageId === operationId)
}

export function orcaChatPresentation(input: {
  sessionId: string; env: NodeJS.ProcessEnv; lease: DeliveryLease; ownerKey: string
  service: ServiceIdentity; serviceCurrent(): boolean; wall(): number
  runtime?: OrcaRuntime | null
}): NativeInputAnswers {
  const chat = (state: SessionState) => state.orca_chat?.key === input.ownerKey ? state.orca_chat : undefined
  const group = (answer: AnsweredPending, state: SessionState) =>
    chat(state) === undefined ? null : orcaCardGroup(state, input.ownerKey, input.service, answer)
  return {
    eligible: (answer, state) => group(answer, state) !== null,
    group: (answer, state) => group(answer, state)?.map((entry) => entry.answer) ?? null,
    prepare: async () => null,
    prepareGroup: async (selected, state) => {
      const session = chat(state)
      const members = selected.length === 0 ? null : group(selected[0]!, state)
      if (session === undefined || members === null || members.length !== selected.length ||
          !members.every((member) => selected.some((entry) => isDeepStrictEqual(entry, member.answer)))) return null
      const text = orcaAnswerText(members)
      if (text === '') return null
      const runtime = input.runtime !== undefined ? input.runtime
        : orcaRuntime({ ...input.env, ...(session.user_data === undefined ? {} : { ORCA_USER_DATA_PATH: session.user_data }) })
      if (runtime === null) return null
      const capabilities = await orcaCapabilities(runtime)
      if (capabilities === null || !ORCA_CHAT_CAPABILITIES.every((capability) => capabilities.has(capability))) return null
      const operationId = orcaOperationId(input.wall())
      const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
      const validate = (latest: SessionState) => {
        const now = group(selected[0]!, latest)
        return { state: latest, valid: now !== null && isDeepStrictEqual(now.map((entry) => entry.answer), members.map((entry) => entry.answer)) }
      }
      const context = 'Notifai — this message is the User\'s answer from their device to your question card' +
        `${members.length === 1 ? '' : 's'}, sent for them through Orca; it is final.` +
        acknowledgementContext(members.map((entry) => entry.answer))
      const sent = { digest: promptDigest(text), operation_id: operationId, context, at: input.wall() }
      const forget = () => updateSessionState(input.sessionId, input.env, (latest) => ({ ...latest,
        orca_chat_sent: (latest.orca_chat_sent ?? []).filter((entry) => entry.operation_id !== operationId) }))
      return {
        presentation: {
          kind: 'orca-chat-answers',
          answers: members.map(({ answer }) => ({ request_id: answer.pending.request_id!, question_id: answer.pending.question_id!,
            replies: answer.replies.map((reply) => ({ reply_id: reply.reply_id, seq: reply.seq })) })),
          owner_key: input.ownerKey, incarnation: input.lease.incarnation, generation: input.lease.generation,
          service_identity: input.service, orca_session_id: session.session_id, client_operation_id: operationId,
          text_sha256: sha256(text),
        },
        validate,
        write: async (mayWrite) => {
          if (!input.serviceCurrent()) throw new CodexControlNotSent('The Approved Machine changed before the Orca answer was sent')
          // Read the fence and confirm the cards are this chat's, just before the send.
          const read = await history(runtime, session.session_id)
          if (read === null || !historyShowsCards(read.page, members.map((entry) => entry.registration.card_call_id!))) {
            throw new CodexControlNotSent('The Orca chat does not show these cards')
          }
          let valid = false
          // Recorded before the send: the prompt hook may run before Orca replies.
          updateSessionState(input.sessionId, input.env, (latest) => {
            valid = validate(latest).valid && mayWrite()
            return !valid ? latest : { ...latest, orca_chat_sent: [...(latest.orca_chat_sent ?? [])
              .filter((entry) => input.wall() - entry.at < SENT_KEPT_MS), sent] }
          })
          if (!valid) throw new CodexControlNotSent('Answer authority changed before the Orca send')
          const reply = await runtime.call('agentSession.send', {
            envelope: { sessionId: session.session_id, clientOperationId: operationId, expectedRuntimeFence: read.fence,
              payloadFingerprint: orcaPayloadFingerprint('agentSession.send', session.session_id, { body }) },
            body,
          }, 8_000)
          const accepted = reply.ok && (reply.result as { ok?: unknown } | null)?.ok !== false
          if (accepted) return
          // A refusal sent nothing. A lost reply is settled by Orca's own record of the operation.
          const known = reply.ok || !['timeout', 'connection_closed'].includes(reply.code) ? false
            : await submitted(runtime, session.session_id, operationId)
          if (known === true) return
          if (known === false) { forget(); throw new CodexControlNotSent('Orca did not accept the answer message') }
          throw new Error('The Orca answer message may have been sent; it is not sent again')
        },
        close: () => undefined,
      }
    },
  }
}

/**
 * The prompt hook of a message this route sent: the agent already reads the
 * answers in it, so it gets only their acknowledgement, once. Null for any
 * other prompt. A match also means the message is not a terminal answer.
 */
export function takeOrcaChatSentContext(sessionId: string, env: NodeJS.ProcessEnv, prompt: unknown): string | null {
  if (typeof prompt !== 'string') return null
  const digest = promptDigest(prompt)
  if (!readSessionState(sessionId, env).orca_chat_sent?.some((entry) => entry.digest === digest && entry.shown !== true)) return null
  let context: string | null = null
  updateSessionState(sessionId, env, (state) => ({ ...state, orca_chat_sent: (state.orca_chat_sent ?? []).map((entry) => {
    if (context !== null || entry.digest !== digest || entry.shown === true) return entry
    context = entry.context
    return { ...entry, shown: true as const }
  }) }))
  return context
}

/** Whether a prompt is a message this route sent (shown or not): never read as a terminal answer. */
export function isOrcaChatSentPrompt(sessionId: string, env: NodeJS.ProcessEnv, prompt: unknown): boolean {
  return typeof prompt === 'string' && readSessionState(sessionId, env).orca_chat_sent?.some((entry) => entry.digest === promptDigest(prompt)) === true
}
