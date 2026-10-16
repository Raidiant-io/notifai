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

/** Most Notification Requests one `companion/reads` call may name. */
export const COMPANION_READS_MAX_REQUESTS = 200

/**
 * `POST /api/v1/companion/reads` (user auth). Marks Notification Requests read
 * for the whole Account, so every Device Installation shows them read. Name
 * the requests, or pass `through` to mark everything accepted at or before
 * that instant (Mark All as Read). Marks are never cleared, so repeating or
 * reordering calls is safe.
 */
export type CompanionReadsRequest = { device_id: string } & (
  | { request_ids: string[]; through?: never }
  /** RFC 3339 instant; every retained request accepted at or before it becomes read. */
  | { through: string; request_ids?: never }
)

export interface CompanionReadsResponse {
  /** Requests that became read with this call; already-read ones are not counted. */
  marked: number
}

/** Read-only reconciliation for retained rows, independent of the history cursor.
 * `POST /api/v1/companion/read-state` (user auth), at most 200 request IDs.
 * Only visible, retained requests with a read mark are returned. No revisions
 * or read marks are created, and omitted IDs must not be marked unread.
 */
export interface CompanionReadStateRequest {
  device_id: string
  request_ids: string[]
}

export interface CompanionReadStateResponse {
  reads: { request_id: string; read_at: string }[]
}
