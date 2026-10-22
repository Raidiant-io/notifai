/** Exact card hand-backs and their bounded acceptance window. */
import { isDeepStrictEqual } from 'node:util'
import type { QuestionT } from '@raidiant/notifai-protocol'
import type { CodexQuestionRegistration, NativeQuestionShown } from './codex-question-bindings.js'
import type { HookEnvelope, SessionState } from './hook-types.js'
import { readSessionIncarnation, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import { currentCodexTurn } from './session-attendant-state.js'

export const CARD_ACCEPTANCE_MS = 30_000

export function cardShown(questions: QuestionT[]): NativeQuestionShown[] {
  return questions.map(question => ({ title: question.text, labels: Object.fromEntries(
    [...(question.choices ?? [])].sort((a, b) => Number(b.recommended === true) - Number(a.recommended === true))
      .map(choice => [choice.id, choice.label])) }))
}

export function cardHandbackInput(registration: CodexQuestionRegistration) {
  return { questions: registration.questions.map(binding => ({ title: binding.card!.title,
    ...(binding.question.choices === undefined ? {} : { options: Object.values(binding.card!.labels) }) })) }
}

/** An expired hold never hides an answer, even if no further hook runs. */
export function codexCardAnswerHeld(state: SessionState, questionId: string | undefined, now = Date.now()): boolean {
  return questionId !== undefined && state.codex_question_bindings?.some(item => item.question_id === questionId &&
    item.ordinary_only !== true && item.terminated !== true && (item.card_accept_until ?? 0) > now) === true
}

function ordinary(item: CodexQuestionRegistration): CodexQuestionRegistration {
  const next = { ...item, ordinary_only: true as const }
  delete next.card_accept_until
  delete next.card_allowed
  return next
}

/** Release before a boundary can drain input; a foreign denial may have no post hook. */
export function releaseCodexCardHandbacks(sessionId: string, env: NodeJS.ProcessEnv, envelope: HookEnvelope,
  event: string, now = Date.now()): void {
  const owner = readSessionIncarnation(sessionId, env)
  if (owner?.harness_process?.pid !== Number(env['NOTIFAI_HOOK_SOURCE_PID']) || sessionHasEnded(sessionId, env)) return
  let response = envelope.tool_response
  if (typeof response === 'string') { try { response = JSON.parse(response) as unknown } catch { response = null } }
  const accepts = envelope.tool_name === 'request_user_input_async' &&
    (response as { accepted?: unknown } | null)?.accepted === true
  updateSessionState(sessionId, env, state => state.codex_question_bindings === undefined ? state : ({ ...state, codex_question_bindings: state.codex_question_bindings.map(item => {
    if (item.owner_key !== owner.key || item.card_handback !== true || item.ordinary_only === true ||
        item.questions.some(binding => binding.verified)) return item
    const expired = item.card_accept_until !== undefined && item.card_accept_until <= now
    const ended = event === 'user-prompt-submit' || (['stop', 'interrupt'].includes(event) &&
      (envelope.turn_id === undefined || envelope.turn_id === item.registration_turn_id))
    const rejected = event === 'post-tool-use' && item.card_accept_until !== undefined &&
      !(accepts && item.card_call_id === envelope.tool_use_id && item.registration_turn_id === envelope.turn_id)
    return expired || ended || rejected ? ordinary(item) : item
  }) }))
}

/** Decide and bind under the same lock that publishes an ordinary answer. */
export function matchCodexCardHandback(sessionId: string, env: NodeJS.ProcessEnv, envelope: HookEnvelope,
  ownerKey: string, service: { machine_id: string; base_url: string }, accepted: boolean, now = Date.now()):
  { registration: CodexQuestionRegistration; reason?: 'mismatch' | 'answered' | 'delivered' | 'expired' | 'released' } | null {
  let result: ReturnType<typeof matchCodexCardHandback> = null
  updateSessionState(sessionId, env, state => {
    if (readSessionIncarnation(sessionId, env)?.key !== ownerKey || sessionHasEnded(sessionId, env) ||
        currentCodexTurn(sessionId, env, ownerKey) !== envelope.turn_id) return state
    const candidates = (state.codex_question_bindings ?? []).filter(item => item.card_handback === true &&
      item.owner_key === ownerKey && item.registration_turn_id === envelope.turn_id && isDeepStrictEqual(item.service_identity, service))
    const exact = candidates.find(item => isDeepStrictEqual(cardHandbackInput(item), envelope.tool_input))
    const item = exact ?? candidates.find(item => item.ordinary_only !== true && item.card_call_id === undefined)
    if (item === undefined) return state
    const answered = [...(state.waiting_answers ?? []), ...(state.accepted?.answers ?? [])]
      .some(answer => answer.pending.question_id === item.question_id)
    const pending = state.pending?.some(question => question.question_id === item.question_id)
    let reason: NonNullable<ReturnType<typeof matchCodexCardHandback>>['reason']
    if (item.terminal_answered) reason = 'delivered'
    else if (item.dismissed || item.terminated) reason = 'expired'
    else if (!pending && !answered) reason = 'delivered'
    else if (item.ordinary_only || (item.card_accept_until !== undefined && item.card_accept_until <= now)) reason = answered ? 'answered' : 'released'
    else if (!exact) reason = 'mismatch'
    else if (!accepted && answered) reason = 'answered'
    else if (accepted && (item.card_call_id !== envelope.tool_use_id || item.card_accept_until === undefined)) {
      // A repeated accepted callback is harmless; an unallowed call cannot adopt the question.
      if (item.card_call_id === envelope.tool_use_id && item.questions.every(binding => binding.verified)) {
        result = { registration: item }
      }
      return state
    }
    const next = reason !== undefined ? ordinary(item) : { ...item, card_call_id: envelope.tool_use_id!, card_allowed: true as const,
      ...(accepted ? {} : { card_accept_until: item.card_accept_until ?? now + CARD_ACCEPTANCE_MS }),
      questions: item.questions.map((binding, index) => accepted ? { ...binding, verified: true as const,
        native: { turn_id: envelope.turn_id!, call_id: envelope.tool_use_id!, index } } : binding) }
    if (accepted) delete next.card_accept_until
    result = { registration: next, ...(reason === undefined ? {} : { reason }) }
    return { ...state, codex_question_bindings: state.codex_question_bindings!.map(entry => entry === item ? next : entry) }
  })
  return result
}
