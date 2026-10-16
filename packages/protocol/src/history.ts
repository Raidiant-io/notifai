import type { LifecycleEndState } from './lifecycle.js'
import type { NotificationDraftT } from './notification.js'
import type { AgentAcknowledgementView, ReplyView } from './api.js'
import type { AnswerVersionView } from './sessions.js'

/** A current retained Request snapshot; fetching it never posts a native alert. */
export interface NotificationHistoryItem {
  request_id: string
  revision: string
  accepted_at: string
  native_expires_at: string
  retained_until: string
  /** False means update an existing local row only; never restore a missing row. */
  insertable: boolean
  has_body: boolean
  draft: NotificationDraftT
  project_name: string | null
  delivery_id: string | null
  reply_expires_at: string | null
  retired_at: string | null
  /**
   * How the question stopped waiting on the User, once it was retired: where
   * it was answered and with what, as far as the service knows. Null while it
   * is live, for an answer given on this Device Installation, and for
   * requests that never asked anything.
   */
  retirement: QuestionRetirementView | null
  /**
   * When the User first read this request on any Companion App of the
   * Account. Account-wide and never cleared: a Companion App shows a request
   * read when this is set or when it read the request itself.
   */
  read_at: string | null
  agent_acknowledgement_required: boolean
  latest_reply: (ReplyView & { client_reply_id: string }) | null
  agent_acknowledgement: AgentAcknowledgementView | null
  /**
   * Every answer the User gave this request, oldest first: replies, then
   * post-delivery Answer Edits. Present only for installations advertising
   * `answer_edits`; `latest_reply` and `agent_acknowledgement` keep their
   * released meaning either way.
   */
  answer_versions?: AnswerVersionView[]
}

export interface QuestionRetirementView {
  /**
   * `answered`: the agent acknowledged an answer; `answered_elsewhere`: it was
   * answered where this Device Installation could not see it (another
   * device, or the agent's terminal); `expired`: nobody answered in time.
   */
  state: LifecycleEndState
  /** The answering Device Installation's name, `terminal`, or null when nobody answered. */
  via: string | null
  /** The answer, when the service holds it. A terminal answer stays on the agent's machine. */
  answer: string | null
}

export interface NotificationHistoryPage {
  entries: NotificationHistoryItem[]
  /** Opaque, Account-bound position; save only after every entry is durable. */
  next_cursor: string
  has_more: boolean
}
