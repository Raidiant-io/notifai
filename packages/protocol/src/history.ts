import type { NotificationDraftT } from './notification.js'
import type { AgentAcknowledgementView, ReplyView } from './api.js'

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
  agent_acknowledgement_required: boolean
  latest_reply: (ReplyView & { client_reply_id: string }) | null
  agent_acknowledgement: AgentAcknowledgementView | null
}

export interface NotificationHistoryPage {
  entries: NotificationHistoryItem[]
  /** Opaque, Account-bound position; save only after every entry is durable. */
  next_cursor: string
  has_more: boolean
}
