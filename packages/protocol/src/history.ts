import { Type, type Static } from '@sinclair/typebox'
import { LIFECYCLE_END_STATES } from './lifecycle.js'
import { NotificationDraftView } from './notification.js'
import { AgentAcknowledgementView, ReplyView } from './api.js'
import { AnswerVersionView } from './sessions.js'

const nullableString = Type.Union([Type.String(), Type.Null()])

export const QuestionRetirementView = Type.Object({
  /**
   * `answered`: the agent acknowledged an answer; `answered_elsewhere`: it was
   * answered where this Device Installation could not see it (another
   * device, or the agent's terminal); `expired`: nobody answered in time.
   */
  state: Type.Union(LIFECYCLE_END_STATES.map(value => Type.Literal(value))),
  /** The answering Device Installation's name, `terminal`, or null when nobody answered. */
  via: nullableString,
  /** The answer, when the service holds it. A terminal answer stays on the agent's machine. */
  answer: nullableString,
})
export type QuestionRetirementView = Static<typeof QuestionRetirementView>

/**
 * Current retained snapshot. Required row fields are decoded before advancing
 * a feed cursor, including retained draft, reply and answer content.
 */
export const NotificationHistoryItem = Type.Object({
  request_id: Type.String(),
  revision: Type.String(),
  accepted_at: Type.String(),
  native_expires_at: Type.String(),
  retained_until: Type.String(),
  /** False means update an existing local row only; never restore a missing row. */
  insertable: Type.Boolean(),
  has_body: Type.Boolean(),
  draft: NotificationDraftView,
  project_name: nullableString,
  delivery_id: nullableString,
  reply_expires_at: nullableString,
  retired_at: nullableString,
  /**
   * How the question stopped waiting on the User, once it was retired: where
   * it was answered and with what, as far as the service knows. Null while it
   * is live, for an answer given on this Device Installation, and for
   * requests that never asked anything.
   */
  retirement: Type.Union([QuestionRetirementView, Type.Null()]),
  /**
   * When the User dismissed this question from a Companion App (`question_dismiss`).
   * A dismissal closes the window and retires the question as `expired`, so
   * this is what tells a Dismissed question from one whose window ran out.
   * Null when it was not dismissed. Absent from servers that predate it:
   * read absent as unknown, not as "not dismissed".
   */
  dismissed_at: Type.Optional(nullableString),
  /**
   * When the User first read this request on any Companion App of the
   * Account. Account-wide and never cleared: a Companion App shows a request
   * read when this is set or when it read the request itself.
   */
  read_at: nullableString,
  agent_acknowledgement_required: Type.Boolean(),
  latest_reply: Type.Union([Type.Object({ ...ReplyView.properties, client_reply_id: Type.String() }), Type.Null()]),
  agent_acknowledgement: Type.Union([AgentAcknowledgementView, Type.Null()]),
  /**
   * Every answer the User gave this request, oldest first: replies, then
   * post-delivery Answer Edits. Present only for installations advertising
   * `answer_edits`; `latest_reply` and `agent_acknowledgement` keep their
   * released meaning either way.
   */
  answer_versions: Type.Optional(Type.Array(AnswerVersionView)),
})
export type NotificationHistoryItem = Static<typeof NotificationHistoryItem>


export interface NotificationHistoryPage {
  entries: NotificationHistoryItem[]
  /** Opaque, Account-bound position; save only after every entry is durable. */
  next_cursor: string
  has_more: boolean
}
