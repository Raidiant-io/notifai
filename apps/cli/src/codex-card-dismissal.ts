/**
 * A Codex card whose question the User dismissed on a device closes, saying so.
 *
 * The answer owner marks a dismissed question's registration `dismissed`
 * before retiring it (`markNativeQuestionsDismissed`). A card still on screen
 * for it would otherwise wait for an answer that never comes. The only way to
 * settle a visible card is its owning app-server: `turn/steer` into the
 * card's own turn with the reply envelope naming the card's exact question
 * items, the same route a device answer takes (`codex-answer-presentation.ts`).
 * It carries no answer, only the plain note that the User dismissed it, so the
 * agent carries on without one, as a Claude Code picker does.
 *
 * It happens only where that is safe, at a trusted tool callback of the
 * card's own turn, from the session's owner holding its lease:
 * - the card was accepted and bound to exact call ids in this turn;
 * - Notifai reaches the server that owns the thread (the shared Codex server,
 *   checked by `connectCodexAnswerControl`, never one it would load), and the
 *   turn is still in progress there.
 *
 * Elsewhere the card is left as it is: a card whose turn already ended, a
 * Codex app card (Notifai has no connection to the app's own server, so app
 * cards are never linked), and any card of a host without exact control.
 * Each card gets one attempt: it is marked settled before the write, so a
 * lost receipt never sends it twice.
 */
import { CLAUDE_PICKER_DISMISSED } from './claude-question-hooks.js'
import { connectCodexAnswerControl } from './codex-answer-control.js'
import { nativeQuestionTitle, type CodexQuestionRegistration } from './codex-question-bindings.js'
import { readSessionState, updateSessionState } from './hook-session-state.js'
import type { SessionState } from './hook-types.js'
import type { Logger } from './logging.js'

/** What the agent reads in place of an answer: the same words a Claude Code picker gives. */
export const CODEX_CARD_DISMISSED = CLAUDE_PICKER_DISMISSED
/** The card's answer field: it holds no answer. */
export const CODEX_CARD_DISMISSED_ANSWER = 'No answer: the user dismissed this question on their device.'

/** A dismissed card of this owner's current turn, bound to exact native items, not yet settled. */
export function dismissedCards(state: SessionState, ownerKey: string, turnId: string): CodexQuestionRegistration[] {
  return (state.codex_question_bindings ?? []).filter((registration) =>
    registration.dismissed === true && registration.terminated !== true && registration.ordinary_only !== true &&
    registration.owner_key === ownerKey && registration.registration_turn_id === turnId &&
    registration.card_call_id !== undefined && registration.card_allowed === true &&
    registration.questions.length > 0 &&
    registration.questions.every((binding) => binding.verified === true && binding.native !== undefined &&
      binding.native.call_id === registration.card_call_id && binding.ambiguous !== true))
}

/** The reply envelope that settles exactly these card items, with no answer in it. */
export function dismissalEnvelope(registration: CodexQuestionRegistration): string {
  return '<send_user_message_question_reply>\n' + JSON.stringify(registration.questions.map((binding) => ({
    questionItemId: JSON.stringify(['request_user_input_async', binding.native!.call_id, binding.native!.index]),
    question: nativeQuestionTitle(binding),
    answer: CODEX_CARD_DISMISSED_ANSWER,
    notifai: { origin: 'companion', question_id: registration.question_id, dismissed: true, instruction: CODEX_CARD_DISMISSED },
  }))) + '\n</send_user_message_question_reply>'
}

/** Close every dismissed card this turn still shows, where its owning server can. Returns how many were sent. */
export async function closeDismissedCodexCards(input: {
  sessionId: string; env: NodeJS.ProcessEnv; ownerKey: string; turnId: string; deadline: number
  mayWrite(): boolean; logger: Logger
  connect?: typeof connectCodexAnswerControl
}): Promise<number> {
  if (dismissedCards(readSessionState(input.sessionId, input.env), input.ownerKey, input.turnId).length === 0 || !input.mayWrite()) return 0
  const control = await (input.connect ?? connectCodexAnswerControl)(input.sessionId, input.turnId, input.env, input.deadline)
  if (control === null) {
    input.logger.info('hook.answer', { stage: 'card-dismissal-left', reason: 'no-owning-server', session: input.sessionId })
    return 0
  }
  let sent = 0
  try {
    for (;;) {
      if (!input.mayWrite() || !await control.currentTurn(input.turnId)) break
      // Claim one card under the state lock: settled before the write, so it is never sent twice.
      let claimed: CodexQuestionRegistration | null = null
      updateSessionState(input.sessionId, input.env, (state) => {
        const next = input.mayWrite() ? dismissedCards(state, input.ownerKey, input.turnId)[0] : undefined
        if (next === undefined) return state
        claimed = next
        return { ...state, codex_question_bindings: state.codex_question_bindings!.map((item) =>
          item.question_id === next.question_id ? { ...item, terminated: true as const } : item) }
      })
      if (claimed === null) break
      const card = claimed as CodexQuestionRegistration
      try {
        await control.steer(input.turnId, dismissalEnvelope(card))
        sent += 1
        input.logger.info('hook.answer', { stage: 'card-dismissal-sent', question_id: card.question_id, session: input.sessionId })
      } catch {
        input.logger.info('hook.answer', { stage: 'card-dismissal-unknown', question_id: card.question_id, session: input.sessionId })
      }
    }
  } finally {
    control.close()
  }
  return sent
}
