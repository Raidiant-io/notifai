/**
 * Local rules for a conversation the service holds as stopped, and for one
 * that continues as another Agent Session.
 *
 * A service that offers `session_stopped_hold` drops an answer the agent never
 * read when its question's own window ends while the session is stopped, and
 * shows it as not delivered. It does not refuse a later claim, so the answer
 * held here must go at the same moment: a conversation that comes back after
 * that must never be handed an answer the User was told did not arrive.
 *
 * A continued end moves the session's open questions, held answers and pending
 * notes to its successor at the service; the local records that let a session
 * collect and hand in those answers move with them.
 */
import { readSessionState, updateSessionState } from './hook-session-state.js'
import type { AnsweredPending, SessionState } from './hook-types.js'
import { readDeliveryJournal } from './session-delivery.js'

const requestOf = (answer: AnsweredPending): string | undefined => answer.pending.request_id ?? answer.pending.submission?.request_id

/**
 * Drop every held answer whose question's window ended by `now` and that was
 * never written into the conversation. Returns the request ids dropped.
 */
export function dropExpiredHeldAnswers(sessionId: string, env: NodeJS.ProcessEnv, now: number): string[] {
  const expired = (answer: AnsweredPending): boolean =>
    answer.pending.reply_deadline_at !== undefined && answer.pending.reply_deadline_at <= now
  const before = readSessionState(sessionId, env)
  const unread = [...(before.waiting_answers ?? []), ...(unreadAccepted(before)?.answers ?? [])]
  if (!unread.some(expired)) return []
  // Written (or being written) into the conversation: it may have been read.
  const written = new Set(readDeliveryJournal(sessionId, env)
    .filter((entry) => entry.subject.type === 'answer' && ['writing', 'written', 'failed'].includes(entry.stage))
    .map((entry) => entry.subject.type === 'answer' ? entry.subject.request_id : ''))
  const dropped = new Set<string>()
  updateSessionState(sessionId, env, (state) => {
    const drop = (answer: AnsweredPending): boolean => {
      const requestId = requestOf(answer)
      if (requestId === undefined || !expired(answer) || written.has(requestId)) return false
      dropped.add(requestId)
      return true
    }
    const waiting = (state.waiting_answers ?? []).filter((answer) => !drop(answer))
    const accepted = unreadAccepted(state)
    const acceptedLeft = accepted?.answers.filter((answer) => !drop(answer))
    if (dropped.size === 0) return state
    const next: SessionState = { ...state }
    if (waiting.length > 0) next.waiting_answers = waiting
    else delete next.waiting_answers
    if (accepted !== undefined) {
      if (acceptedLeft!.length > 0) next.accepted = { ...accepted, answers: acceptedLeft! }
      else delete next.accepted
    }
    // The agent never read these, so it owes no acknowledgement for them.
    const due = (state.acknowledgement_due ?? []).filter((entry) => !dropped.has(entry.request_id))
    if (due.length > 0) next.acknowledgement_due = due
    else delete next.acknowledgement_due
    return next
  })
  return [...dropped]
}

/** The answer journal while nothing of it was handed in yet. */
function unreadAccepted(state: SessionState): SessionState['accepted'] {
  const accepted = state.accepted
  return accepted !== undefined && accepted.delivered_at === undefined && accepted.delivery_committed_at === undefined ? accepted : undefined
}

/** What one session's records held for the conversation, moved to its successor. */
export interface MovedQuestions {
  questions: string[]
  answers: string[]
}

/**
 * Move the questions this session asked that the service knows, the answers
 * held for it and the acknowledgements its agent owes, to `successorId`, the
 * Agent Session the conversation continues as. Questions not yet submitted
 * stay, and end with this session.
 */
export function moveQuestionsToSuccessor(sessionId: string, successorId: string, env: NodeJS.ProcessEnv): MovedQuestions {
  const moved: MovedQuestions = { questions: [], answers: [] }
  updateSessionState(sessionId, env, (state) => {
    const live = (state.pending ?? []).filter((entry) => entry.request_id !== undefined)
    const accepted = unreadAccepted(state)
    const answers = [...(state.waiting_answers ?? [])]
    for (const answer of accepted?.answers ?? []) {
      if (!answers.some((entry) => requestOf(entry) === requestOf(answer))) answers.push(answer)
    }
    const delivered = state.delivered_answers ?? []
    const due = state.acknowledgement_due ?? []
    const messagesDue = state.message_acknowledgement_due ?? []
    if (live.length + answers.length + delivered.length + due.length + messagesDue.length === 0) return state
    updateSessionState(successorId, env, (target) => {
      const known = (list: readonly AnsweredPending[], answer: AnsweredPending): boolean =>
        list.some((entry) => requestOf(entry) === requestOf(answer))
      const next: SessionState = { ...target }
      const pending = [...(target.pending ?? [])]
      for (const entry of live) if (!pending.some((existing) => existing.request_id === entry.request_id)) pending.push(entry)
      if (pending.length > 0) next.pending = pending
      const waiting = [...(target.waiting_answers ?? [])]
      for (const answer of answers) if (!known(waiting, answer)) waiting.push(answer)
      if (waiting.length > 0) next.waiting_answers = waiting
      const handed = [...(target.delivered_answers ?? [])]
      for (const answer of delivered) if (!known(handed, answer)) handed.push(answer)
      if (handed.length > 0) next.delivered_answers = handed
      const owed = [...(target.acknowledgement_due ?? [])]
      for (const entry of due) if (!owed.some((existing) => existing.request_id === entry.request_id)) owed.push(entry)
      if (owed.length > 0) next.acknowledgement_due = owed
      const messagesOwed = [...(target.message_acknowledgement_due ?? [])]
      for (const entry of messagesDue) if (!messagesOwed.some((existing) => existing.message_id === entry.message_id)) messagesOwed.push(entry)
      if (messagesOwed.length > 0) next.message_acknowledgement_due = messagesOwed
      return next
    })
    moved.questions = live.map((entry) => entry.request_id!)
    moved.answers = answers.flatMap((answer) => requestOf(answer) ?? [])
    const next: SessionState = { ...state, pending: (state.pending ?? []).filter((entry) => entry.request_id === undefined) }
    if (next.pending!.length === 0) delete next.pending
    for (const field of ['waiting_answers', 'delivered_answers', 'acknowledgement_due', 'message_acknowledgement_due', 'acknowledgement_blocks'] as const) {
      delete next[field]
    }
    if (accepted !== undefined) delete next.accepted
    return next
  })
  return moved
}
