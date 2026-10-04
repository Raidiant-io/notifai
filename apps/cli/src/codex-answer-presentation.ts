/** Present one claimed app submission through its exact accepted native form. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ServiceIdentity } from './credentials.js'
import type { AnsweredPending, SessionState } from './hook-types.js'
import { acknowledgementContext } from './hook-acknowledgements.js'
import { TRANSPORT_LIMIT } from './injection-render.js'
import { nativeQuestionTitle, observeCodexQuestions, type CodexQuestionRegistration } from './codex-question-bindings.js'
import { readNativeQuestionSnapshot } from './codex-native-turn.js'
import { readSessionIncarnation, updateSessionState } from './hook-session-state.js'
import { connectCodexAnswerControl } from './codex-answer-control.js'
import { CodexControlNotSent } from './codex-native-control.js'
import type { DeliveryLease } from './session-delivery.js'
import type { NativeInputAnswers } from './session-inputs.js'

/** Multipart, malformed and unsupported answers keep the ordinary input path. */
function boundAnswer(answer: AnsweredPending, state: SessionState, ownerKey: string, service: ServiceIdentity): CodexQuestionRegistration | null {
  if (answer.delivery_claim !== true || answer.replies.length !== 1 ||
      !isDeepStrictEqual(answer.reply, answer.replies[0]) || !isDeepStrictEqual(answer.pending.service_identity, service)) return null
  const registration = state.codex_question_bindings?.find(item => item.question_id === answer.pending.question_id)
  if (registration === undefined || registration.owner_key !== ownerKey || registration.ordinary_only === true ||
      registration.terminated === true || registration.confirmed_request_id !== answer.pending.request_id ||
      !isDeepStrictEqual(registration.service_identity, service) ||
      !isDeepStrictEqual(registration.questions.map(item => item.question), answer.pending.questions)) return null
  const parts = answer.reply.answers
  if (parts.length === 0 || new Set(parts.map(part => part.question_id)).size !== parts.length) return null
  for (const part of parts) {
    const binding = registration.questions.find(item => item.question.id === part.question_id)
    if (binding?.verified !== true || binding.native === undefined || binding.ambiguous === true ||
        binding.question.multi === true || part.choice_ids.length > 1 ||
        part.choice_ids.some(id => !binding.question.choices?.some(choice => choice.id === id)) ||
        (part.choice_ids.length === 0 && !part.text?.trim())) return null
  }
  return registration
}

export function codexAnswerPresentation(input: {
  sessionId: string; env: NodeJS.ProcessEnv; lease: DeliveryLease; ownerKey: string
  turnId: string; transcriptPath: string | undefined; service: ServiceIdentity
  deadline: number; mayWrite(): boolean
  /** Credential stores may invoke the OS: call only outside state locks. */
  serviceCurrent(): boolean
  connect?: typeof connectCodexAnswerControl
}): NativeInputAnswers {
  const eligible = (answer: AnsweredPending, state: SessionState) => boundAnswer(answer, state, input.ownerKey, input.service)
  const refresh = (state: SessionState) => {
    const snapshot = readNativeQuestionSnapshot(input.transcriptPath, input.sessionId, input.env)
    return { state: observeCodexQuestions(state, input.ownerKey, snapshot),
      current: snapshot?.latest.id === input.turnId && !snapshot.latest.ended }
  }
  const owned = () => input.mayWrite() && readSessionIncarnation(input.sessionId, input.env)?.key === input.ownerKey
  return {
    eligible: (answer, state) => eligible(answer, state) !== null,
    prepare: async (answer, _state, deadline) => {
      let registration: CodexQuestionRegistration | null = null
      updateSessionState(input.sessionId, input.env, state => {
        const observed = refresh(state)
        if (owned() && observed.current) registration = eligible(answer, observed.state)
        return observed.state
      })
      if (registration === null) return null
      // Freeze the binding independently of later state changes and retries.
      const binding = structuredClone(registration) as CodexQuestionRegistration
      const control = await (input.connect ?? connectCodexAnswerControl)(input.sessionId, input.turnId, input.env,
        Math.min(input.deadline, deadline))
      if (control === null) return null
      try {
        if (!owned() || !await control.currentTurn(input.turnId)) { control.close(); return null }
        const reply = answer.reply
        const text = '<send_user_message_question_reply>\n' + JSON.stringify(reply.answers.map(part => {
          const question = binding.questions.find(item => item.question.id === part.question_id)!
          const selected = part.choice_ids.map(id => question.question.choices!.find(choice => choice.id === id)!.label)
          return { questionItemId: JSON.stringify(['request_user_input_async', question.native!.call_id, question.native!.index]),
            question: nativeQuestionTitle(question), answer: [...selected, ...(part.text == null ? [] : [part.text])].join('\n'),
            notifai: { origin: 'companion', request_id: answer.pending.request_id, question_id: part.question_id,
              reply_id: reply.reply_id, reply_seq: reply.seq,
              instruction: 'This is the existing Notifai app submission, not a new native submission. Do not report it as a native answer.' +
                acknowledgementContext([answer]) + TRANSPORT_LIMIT } }
        })) + '\n</send_user_message_question_reply>'
        const validate = (state: SessionState) => {
          const observed = refresh(state)
          return { state: observed.state, valid: owned() && observed.current &&
            isDeepStrictEqual(eligible(answer, observed.state), binding) }
        }
        return {
          presentation: { kind: 'codex-answer', request_id: answer.pending.request_id!, question_id: binding.question_id,
            replies: [{ reply_id: reply.reply_id, seq: reply.seq }],
            questions: reply.answers.map(part => ({ question_id: part.question_id,
              ...binding.questions.find(item => item.question.id === part.question_id)!.native! })),
            owner_key: input.ownerKey, ...input.lease, service_identity: input.service,
            namespace: control.namespace, thread_id: control.threadId, expected_turn_id: input.turnId,
            envelope_sha256: createHash('sha256').update(text).digest('hex') },
          validate,
          write: async (mayWrite) => {
            if (!input.serviceCurrent()) throw new CodexControlNotSent('Native answer Machine changed before send')
            let valid = false
            updateSessionState(input.sessionId, input.env, state => {
              const checked = validate(state)
              valid = checked.valid
              return checked.state
            })
            if (!valid || !owned() || !mayWrite()) throw new CodexControlNotSent('Native answer authority changed before send')
            await control.steer(input.turnId, text)
          },
          close: () => control.close(),
        }
      } catch { control.close(); return null }
    },
  }
}
