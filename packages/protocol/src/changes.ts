import type { NotificationHistoryItem } from './history.js'
import type { SessionMessageView, SessionPresenceView } from './sessions.js'

/** Longest `wait_seconds` a companion changes-feed call may hold open. */
export const COMPANION_CHANGES_MAX_WAIT_SECONDS = 25

export interface SessionPresenceEntry {
  session_id: string
  presence: SessionPresenceView
}

/**
 * `GET /api/v1/companion/changes?device_id=&cursor=&wait_seconds=` (user
 * auth). The desktop Companion App's one connection to the service: it holds
 * open until something changed after `cursor`, then returns every change in
 * order. Reading it keeps the installation routable for new Deliveries.
 */
export interface CompanionChangesPage {
  /** Notification Requests whose state advanced after `cursor`, oldest first. */
  notifications: NotificationHistoryItem[]
  /** Session Messages whose state advanced after `cursor`, oldest first. */
  session_messages: SessionMessageView[]
  /** Every Agent Session with recorded presence, when any of it changed after `cursor`; otherwise null. */
  presence: SessionPresenceEntry[] | null
  /** Opaque, Account-bound position; save only after every change is durable. */
  next_cursor: string
  /** More changes are ready now: call again at once. */
  has_more: boolean
}
