/** A bounded reminder about registered work, never a detector for unasked questions. */
import { questionsAwaitingAnswer } from './native-answer-operation.js'
import { readSessionState, updateSessionState } from './hook-session-state.js'
import type { HookEnvelope, PendingQuestion, SessionState } from './hook-types.js'

export function pendingQuestionReminderContext(questions: PendingQuestion[], worker: boolean): string {
  const titles = questions.map(question => JSON.stringify((question.title ?? question.summary ?? question.question).slice(0, 160))).join(', ')
  return worker
    ? `Still waiting for the User's answer: ${titles}. Your assignment is not finished: tell your parent which answer it is waiting for and that the work it unblocks is not done yet. Do not ask again.`
    : `Still waiting for the User's answer: ${titles}. The work it unblocks is not finished. If you reported that work as done, correct it and name the answer you are waiting for, then end your turn. Do not ask again.`
}

/**
 * Once per registration and recipient, deliberately stronger than once per
 * native turn: inbox/queue reminders start new turns with stop_hook_active
 * false. Resetting at those prompts would make an endless reminder loop.
 * Claim immediately before writing, including a fresh closure/expiry check.
 */
export function pendingQuestionReminder(
  env: NodeJS.ProcessEnv,
  envelope: HookEnvelope,
  now: () => number,
): { context: string; claim: () => boolean } | null {
  const sessionId = envelope.session_id
  if (!sessionId || envelope.stop_hook_active === true || envelope.stopHookActive === true ||
      (envelope.loop_count ?? 0) > 0) return null
  const worker = envelope.agent_id !== undefined
  if (envelope.hook_event_name === 'SubagentStop' && !worker) return null
  const recipient = worker ? 'worker' : 'root'
  const eligible = (state: SessionState): PendingQuestion[] => {
    const accepted = new Set(state.accepted?.answers.map(answer => answer.pending.question_id))
    return questionsAwaitingAnswer(state).filter(question =>
      question.question_id !== undefined && !accepted.has(question.question_id) &&
      (question.reply_deadline_at === undefined || question.reply_deadline_at > now()) &&
      (!worker || question.asked_by?.agent_id === envelope.agent_id) &&
      !state.pending_question_reminders?.some(reminder => reminder.question_id === question.question_id && reminder[recipient] === true))
  }
  const questions = eligible(readSessionState(sessionId, env))
  if (questions.length === 0) return null
  const ids = new Set(questions.map(question => question.question_id))
  return {
    context: pendingQuestionReminderContext(questions, worker),
    claim: () => {
      let claimed = false
      updateSessionState(sessionId, env, state => {
        const live = eligible(state)
        if (!questions.every(question => live.some(entry => entry.question_id === question.question_id))) return state
        claimed = true
        const pendingIds = new Set(state.pending?.map(question => question.question_id))
        const reminders = new Map((state.pending_question_reminders ?? [])
          .filter(reminder => pendingIds.has(reminder.question_id))
          .map(reminder => [reminder.question_id, reminder]))
        for (const id of ids) {
          if (id !== undefined) reminders.set(id, { ...reminders.get(id), question_id: id, [recipient]: true })
        }
        return { ...state, pending_question_reminders: [...reminders.values()] }
      })
      return claimed
    },
  }
}
