import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { REPLY_MAX_QUESTIONS } from './notification.js'
import {
  PutAgentAcknowledgementRequest,
  ReplyAnswer,
  AgentAcknowledgementView,
  type PutAgentAcknowledgementResponse,
  ReplyAnswerView,
} from './api.js'

/**
 * Wire contract for Session Presence, Session Messages (Session Notes and
 * Answer Edits after the fenced answer), and the Delivery Attempts that hand
 * both answers and Session Messages into a running Agent Session.
 *
 * Everything here is additive: released CLIs and Companion Apps never call
 * these routes, and every existing response keeps its released shape.
 */

// ---------------------------------------------------------------------------
// Server Features (Companion App discovery before advertising)
// ---------------------------------------------------------------------------

/**
 * Server Features a Companion App must see before advertising the capability
 * of the same name at registration, or before offering the action a feature
 * names. Clients ignore names they do not know.
 *
 * - `setup_issues`: machine-reported setup snapshots and the Account setup-issue view.
 * - `session_stopped_hold`: a stopped Agent Session (presence `out_of_reach`
 *   with `accepts_messages: true`) accepts Session Notes and post-read Answer
 *   Edits and holds them until it is reopened.
 * - `question_dismiss`: an open question can be dismissed
 *   (`POST /api/v1/notifications/:request_id/dismiss`).
 * - `notification_content_batch`: the content of many requests in one
 *   exchange (`POST /api/v1/notifications/content`). Without it, a Companion
 *   App fetches each request's content on its own.
 */
export const SERVER_FEATURES = [
  'session_notes',
  'answer_edits',
  'machine_approval',
  'session_stopped_hold',
  'question_dismiss',
  'notification_content_batch',
  'read_sync',
  'setup_issues',
] as const
export type ServerFeature = (typeof SERVER_FEATURES)[number]

/** `GET /api/v1/features` (user auth). A 404 means a server with none of them. */
export const FeaturesResponse = Type.Object({
  /** Unknown names are retained for forward compatibility and ignored by older clients. */
  features: Type.Array(Type.String()),
})
export type FeaturesResponse = Static<typeof FeaturesResponse>

export function isFeaturesResponse(value: unknown): value is FeaturesResponse {
  return Value.Check(FeaturesResponse, value)
}

// ---------------------------------------------------------------------------
// Session Presence
// ---------------------------------------------------------------------------

/**
 * Mechanical evidence of whether an Agent Session's harness process is still
 * running. `unknown` means Notifai has no evidence either way and renders
 * exactly like a session without presence.
 */
export const SESSION_PRESENCE_STATES = ['running', 'out_of_reach', 'ended', 'unknown'] as const
export type SessionPresenceState = (typeof SESSION_PRESENCE_STATES)[number]

export const SESSION_ACTIVITIES = ['working', 'idle'] as const
export type SessionActivity = (typeof SESSION_ACTIVITIES)[number]

export const SessionActivitySchema = Type.Union(
  SESSION_ACTIVITIES.map((activity) => Type.Literal(activity)),
)

/** Effective presence, derived when read from the owner row and its lease. */
export const SessionPresenceView = Type.Union([
  Type.Object({
    state: Type.Literal('running'),
    activity: SessionActivitySchema,
    /** True when new Session Notes and post-delivery Answer Edits are accepted. */
    accepts_messages: Type.Boolean(),
    last_seen_at: Type.String(),
  }),
  Type.Object({
    /**
     * The lease lapsed without an end: the process may be alive but
     * unreachable. Also how a stopped Agent Session reads: its harness
     * stopped without the User closing it and may be reopened in place.
     */
    state: Type.Literal('out_of_reach'),
    last_seen_at: Type.String(),
    /**
     * Present and true only for a stopped Agent Session (server feature
     * `session_stopped_hold`): Session Notes and post-read Answer Edits are
     * accepted and held until it is reopened. Absent otherwise.
     */
    accepts_messages: Type.Optional(Type.Literal(true)),
  }),
  Type.Object({ state: Type.Literal('ended'), ended_at: Type.String() }),
  Type.Object({ state: Type.Literal('unknown') }),
])
export type SessionPresenceView = Static<typeof SessionPresenceView>

// ---------------------------------------------------------------------------
// Session Attendance (CLI Session Attendant ↔ server)
// ---------------------------------------------------------------------------

/** Longest `wait_seconds` an attendance exchange may hold open. */
export const ATTENDANCE_MAX_WAIT_SECONDS = 25

/** Opaque, CLI-minted identity of one attendant incarnation. Never a PID. */
export const ATTENDANT_INCARNATION_PATTERN = '^inc_[A-Za-z0-9_-]{10,64}$'

const attendanceIdentity = {
  incarnation: Type.String({ pattern: ATTENDANT_INCARNATION_PATTERN }),
  /** The generation this incarnation holds; absent while acquiring. */
  generation: Type.Optional(Type.Integer({ minimum: 1 })),
} as const

/**
 * `POST /api/v1/agent-sessions/:session_id/attendance?wait_seconds=N`
 * (machine auth, CLI capability `session_attendance`).
 *
 * - `running` acquires or renews the lease and waits for Session Messages.
 * - `ended` with `end_reason: 'closed'` (server capability
 *   `session_confirmed_end`) records a positively confirmed close. Bare ends
 *   from older clients can describe crashes and are treated as stops by servers
 *   with this capability. On a confirmed end, open questions expire and an answer the agent never read is
 *   dropped (reported `not_delivered`, reason `session_ended`).
 *   With `end_reason: 'continued'` and `successor_session_id` (server feature
 *   `session_stopped_hold`) the session continues under that Agent Session
 *   instead: its open questions, held answers and pending Session Messages
 *   move there and nothing expires. The questions stay listed under the
 *   session that asked them. With `session_continued_successor` a successor
 *   the server has not seen yet is created, on the ending session's machine.
 * - `stopped` (holder only, server feature `session_stopped_hold`): the
 *   harness stopped without the User closing it and may be reopened in place.
 *   The lease stops; questions stay open for their own windows; Session Notes
 *   and post-read Answer Edits are accepted and held. The holder may repeat
 *   `stopped` to see held messages (never claimable while stopped) and may
 *   still send `ended`; a new incarnation acquires the session with `running`.
 * - `withdrawn` gives the lease up without an end (Project disabled, CLI
 *   contract changed); presence becomes `unknown`.
 *
 * Delivery outcomes never travel here; every writer reports on the Delivery
 * Attempt route so superseded incarnations and restarted journals share one path.
 */
const messageCursor = Type.String({ minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' })

/** Positive end evidence. Legacy unqualified ends may describe process failure. */
export const SESSION_END_REASONS = ['continued', 'closed'] as const
export type SessionEndReason = (typeof SESSION_END_REASONS)[number]

/**
 * `closed` requires positive close evidence and server feature
 * `session_confirmed_end`. `continued` requires a successor in this Account.
 */
const endedFields = {
  state: Type.Literal('ended'),
  end_reason: Type.Optional(Type.Union([Type.Literal('continued'), Type.Literal('closed')])),
  successor_session_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
} as const

export const AttendanceRequest = Type.Union([
  Type.Object(
    {
      ...attendanceIdentity,
      state: Type.Literal('running'),
      activity: SessionActivitySchema,
      accepts_messages: Type.Boolean(),
      /**
       * `message_cursor` from the previous exchange. The server holds the
       * exchange only while no Session Message newer than it exists; absent
       * means answer at once with every claimable message.
       */
      message_cursor: Type.Optional(messageCursor),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...attendanceIdentity, ...endedFields },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...attendanceIdentity, state: Type.Literal('withdrawn') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...attendanceIdentity,
      state: Type.Literal('stopped'),
      /** As for `running`: the exchange is held while no newer held message exists. */
      message_cursor: Type.Optional(messageCursor),
    },
    { additionalProperties: false },
  ),
])
export type AttendanceRequestT = Static<typeof AttendanceRequest>

/** A Session Message ready to be claimed and handed into the Agent Session. */
export type AttendanceMessage = {
  message_id: string
  created_at: string
  /** Account-preference snapshot taken when the message was accepted. */
  agent_acknowledgement_text_required: boolean
} & (
  | { kind: 'note'; body: string }
  | {
      kind: 'answer_edit'
      request_id: string
      /** The complete edited answer, one entry per answered question. */
      answers: ReplyAnswerView[]
      /** Human-readable rendering of the complete edited answer, assembled server-side. */
      text: string
    }
)

/**
 * Relative durations are measured from when the client sent the exchange, on
 * its own monotonic clock, so a wall-clock jump cannot extend them.
 */
export type AttendanceResponse =
  | {
      /** This incarnation holds the lease. */
      status: 'attending'
      generation: number
      lease_remaining_ms: number
      message_cursor: string
      /** Every Session Message for this Agent Session still waiting to be claimed. */
      messages: AttendanceMessage[]
    }
  | {
      /** Another incarnation holds a live lease; retry once it may have lapsed. */
      status: 'owned'
      retry_after_ms: number
    }
  | {
      /** The server holds no lease for this incarnation; stop attending. */
      status: 'withdrawn'
    }
  | {
      /**
       * Answer to `stopped`: this incarnation still holds the stopped session
       * (it may send `ended`). `messages` are held for the session and cannot
       * be claimed until it is reopened and attended `running`.
       */
      status: 'stopped'
      generation: number
      message_cursor: string
      messages: AttendanceMessage[]
    }

// ---------------------------------------------------------------------------
// Batched Session Attendance (one process attending many Agent Sessions)
// ---------------------------------------------------------------------------

/** Most Agent Sessions one batched exchange may carry. */
export const ATTENDANCE_BATCH_MAX_SESSIONS = 100

const batchSessionId = { session_id: Type.String({ minLength: 1, maxLength: 128 }) } as const

/**
 * `POST /api/v1/agent-sessions/attendance?wait_seconds=N` (machine auth, CLI
 * capability `session_attendance`; offered when the server lists
 * `session_attendance_batch`).
 *
 * Each entry is exactly one per-session exchange, applied in order and with
 * the same lease and generation rules. One cursor covers the whole batch: the
 * server holds the exchange only while every entry is attending or already
 * stopped, none was acquired or stopped by this exchange, and no such session
 * has a claimable or held Session Message newer than the cursor.
 */
export const AttendanceBatchEntry = Type.Union([
  Type.Object(
    {
      ...batchSessionId,
      ...attendanceIdentity,
      state: Type.Literal('running'),
      activity: SessionActivitySchema,
      accepts_messages: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...batchSessionId, ...attendanceIdentity, ...endedFields },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...batchSessionId, ...attendanceIdentity, state: Type.Literal('withdrawn') },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...batchSessionId, ...attendanceIdentity, state: Type.Literal('stopped') },
    { additionalProperties: false },
  ),
])
export type AttendanceBatchEntryT = Static<typeof AttendanceBatchEntry>

export const AttendanceBatchRequest = Type.Object(
  {
    /** The previous batch's cursor; absent means answer at once with every claimable message. */
    message_cursor: Type.Optional(
      Type.String({ minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' }),
    ),
    sessions: Type.Array(AttendanceBatchEntry, { minItems: 1, maxItems: ATTENDANCE_BATCH_MAX_SESSIONS }),
  },
  { additionalProperties: false },
)
export type AttendanceBatchRequestT = Static<typeof AttendanceBatchRequest>

/**
 * One entry's outcome, in request order. `unknown_session` replaces the
 * per-session 404; `unknown_successor` refuses a `continued` end whose
 * successor is not another Agent Session of this Account or has already
 * ended, changing nothing. With `session_continued_successor` an unseen
 * successor is created instead, and one that another machine owns or attends
 * is refused. The per-session route answers it with a 404 whose
 * `details.reason` is `unknown_successor`.
 */
export type AttendanceBatchResult = { session_id: string } & (
  | AttendanceResponse
  | { status: 'unknown_session' }
  | { status: 'unknown_successor' }
)

export interface AttendanceBatchResponse {
  /** The Account position the final snapshot observed; send it with the next batch. */
  message_cursor: string
  sessions: AttendanceBatchResult[]
}

// ---------------------------------------------------------------------------
// Delivery Attempts (one claim protocol for every harness hand-off)
// ---------------------------------------------------------------------------

export const SESSION_MESSAGE_ID_PREFIX = 'sm_'
export const SESSION_MESSAGE_ID_PATTERN = '^sm_[A-Za-z0-9_-]+$'
export const DELIVERY_ATTEMPT_ID_PATTERN = '^att_[A-Za-z0-9_-]+$'

const AttemptSubject = Type.Union([
  Type.Object(
    {
      type: Type.Literal('session_message'),
      message_id: Type.String({ pattern: SESSION_MESSAGE_ID_PATTERN }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('answer'),
      request_id: Type.String({ pattern: '^req_[A-Za-z0-9_-]+$' }),
    },
    { additionalProperties: false },
  ),
])

/**
 * `POST /api/v1/agent-sessions/:session_id/delivery-attempts` (machine auth).
 *
 * Claims one hand-off: a Session Message, or a Notification Request's fenced
 * answer (the reply its `deliver` close selected). The claim is bound to the
 * generation the claimant holds; claims from a fenced generation are refused.
 *
 * The second form records, after the fact, that this machine already wrote a
 * selected answer into the session without holding a claim (the lease moved or
 * a claim was refused, and an answer is never withheld). It is stored as an
 * attempt whose outcome is `handed_off`, so the answer's Answer Edits follow
 * it in order. It is refused with `attempt_pending` while another attempt for
 * that answer has no outcome yet (temporary), and with `not_claimable` once one
 * reported anything but `released` (final).
 */
export const ClaimDeliveryAttemptRequest = Type.Union([
  Type.Object(
    {
      incarnation: Type.String({ pattern: ATTENDANT_INCARNATION_PATTERN }),
      generation: Type.Integer({ minimum: 1 }),
      subject: AttemptSubject,
      /**
       * Answer Edits only, when the fenced answer's attempt is `unconfirmed`:
       * this machine proved that attempt's writer and its whole process group
       * are gone, so it can never write again. Deadline expiry alone is not proof.
       */
      earlier_answer_writer_gone: Type.Optional(Type.Literal(true)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      subject: Type.Object(
        {
          type: Type.Literal('answer'),
          request_id: Type.String({ pattern: '^req_[A-Za-z0-9_-]+$' }),
        },
        { additionalProperties: false },
      ),
      already_handed_off: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
])
export type ClaimDeliveryAttemptRequestT = Static<typeof ClaimDeliveryAttemptRequest>

export interface ClaimDeliveryAttemptResponse {
  attempt_id: string
  /**
   * The claimant must not begin a harness write after this long, measured on
   * its own monotonic clock from when it sent the claim. Zero for an attempt
   * recorded after the fact.
   */
  claim_remaining_ms: number
  /** `handed_off` for an attempt recorded after the fact; absent for a claim. */
  outcome?: 'handed_off'
}

/** `details.reason` of a 409 `claim_refused`. */
export const DELIVERY_CLAIM_REFUSAL_REASONS = [
  /** A newer generation owns the Agent Session. */
  'generation_fenced',
  /** The subject is claimed, settled, or no longer deliverable. */
  'not_claimable',
  /** An Answer Edit waits for the fenced answer's attempt to report an outcome. */
  'awaiting_earlier_answer',
  /** An earlier Session Message must be claimed first; retry after refreshing the pending batch. */
  'awaiting_earlier_message',
  /**
   * An after-the-fact record waits: another attempt for that answer has no
   * outcome yet. Record again once it reports; a `released` report frees it.
   * Every other refusal of an after-the-fact record is final.
   */
  'attempt_pending',
] as const
export type DeliveryClaimRefusalReason = (typeof DELIVERY_CLAIM_REFUSAL_REASONS)[number]

/**
 * - `handed_off`: the harness write completed.
 * - `unconfirmed`: a write may have happened but completion is unknown (crash
 *   between write and journal mark). Never retried automatically.
 * - `released`: the claimant made no harness write and never will (its claim
 *   deadline passed first); the subject becomes claimable again.
 */
export const DELIVERY_ATTEMPT_OUTCOMES = ['handed_off', 'unconfirmed', 'released'] as const
export type DeliveryAttemptOutcome = (typeof DELIVERY_ATTEMPT_OUTCOMES)[number]

/**
 * `POST /api/v1/delivery-attempts/:attempt_id/report` (machine auth, the
 * attempt's machine). Accepted from a superseded incarnation too: attempts
 * outlive ownership.
 */
export const ReportDeliveryAttemptRequest = Type.Object(
  {
    outcome: Type.Union(DELIVERY_ATTEMPT_OUTCOMES.map((outcome) => Type.Literal(outcome))),
  },
  { additionalProperties: false },
)
export type ReportDeliveryAttemptRequestT = Static<typeof ReportDeliveryAttemptRequest>

export interface ReportDeliveryAttemptResponse {
  attempt_id: string
  /** The stored outcome; a replay or a report after fencing returns what was kept. */
  outcome: DeliveryAttemptOutcome
  replayed: boolean
}

// ---------------------------------------------------------------------------
// Session Messages (Session Notes and post-delivery Answer Edits)
// ---------------------------------------------------------------------------

export const SESSION_MESSAGE_KINDS = ['note', 'answer_edit'] as const
export type SessionMessageKind = (typeof SESSION_MESSAGE_KINDS)[number]

/**
 * `accepted → claimed → handed_off → acknowledged`, with terminal
 * `not_delivered` (never claimed) and `unconfirmed` (claimed, hand-off never
 * reported). An Agent Acknowledgement dominates any non-negative state and
 * never regresses.
 */
export const SESSION_MESSAGE_STATES = [
  'accepted',
  'claimed',
  'handed_off',
  'acknowledged',
  'not_delivered',
  'unconfirmed',
] as const
export type SessionMessageState = (typeof SESSION_MESSAGE_STATES)[number]

/**
 * Why a message was never claimed, or why a reply Answer Version was never
 * delivered. Clients render unknown reasons generically.
 */
export const SESSION_MESSAGE_NOT_DELIVERED_REASONS = [
  /**
   * The Agent Session ended first. On a reply Answer Version: the agent never
   * read the answer before its session closed, so it was dropped.
   */
  'session_ended',
  /** The Agent Session stayed out of reach past the delivery limit. */
  'out_of_reach',
  /** The fenced answer's hand-off is unconfirmed on a writer that may still write. */
  'earlier_answer_unconfirmed',
] as const
export type SessionMessageNotDeliveredReason =
  (typeof SESSION_MESSAGE_NOT_DELIVERED_REASONS)[number]

export const SESSION_NOTE_MAX_LENGTH = 4000

/**
 * `POST /api/v1/agent-sessions/:session_id/notes` (user auth, companion
 * capability `session_notes`). Accepted only while the Agent Session is
 * `running` with `accepts_messages`, or stopped (presence `out_of_reach` with
 * `accepts_messages`, held for 24 hours until it is reopened); otherwise 409
 * `session_not_accepting_messages` and the app keeps the draft.
 */
export const CreateSessionNoteRequest = Type.Object(
  {
    /** Allocated when the Send Delay countdown starts; makes retries idempotent. */
    client_message_id: Type.String({ minLength: 8, maxLength: 64 }),
    device_id: Type.String({ pattern: '^dev_[A-Za-z0-9_-]+$' }),
    body: Type.String({ minLength: 1, maxLength: SESSION_NOTE_MAX_LENGTH, pattern: '\\S' }),
  },
  { additionalProperties: false },
)
export type CreateSessionNoteRequestT = Static<typeof CreateSessionNoteRequest>

const sessionMessageFields = {
  message_id: Type.String(),
  session_id: Type.String(),
  client_message_id: Type.String(),
  /** The installation that sent it; null once that installation was removed. */
  device_id: Type.Union([Type.String(), Type.Null()]),
  state: Type.Union(SESSION_MESSAGE_STATES.map(value => Type.Literal(value))),
  // Unknown reasons have always been rendered generically by clients.
  not_delivered_reason: Type.Union([Type.String(), Type.Null()]),
  agent_acknowledgement_text_required: Type.Boolean(),
  agent_acknowledgement: Type.Union([AgentAcknowledgementView, Type.Null()]),
  created_at: Type.String(),
  handed_off_at: Type.Union([Type.String(), Type.Null()]),
  /** Opaque change position; equal revisions mean an unchanged message. */
  revision: Type.String(),
}
export const SessionMessageView = Type.Union([
  Type.Object({ ...sessionMessageFields, kind: Type.Literal('note'), body: Type.String(), request_id: Type.Null() }),
  Type.Object({ ...sessionMessageFields, kind: Type.Literal('answer_edit'), request_id: Type.String(),
    answers: Type.Array(ReplyAnswerView), text: Type.String() }),
])
export type SessionMessageView = Static<typeof SessionMessageView>

export const CreateSessionNoteResponse = Type.Object({
  /** True when `client_message_id` returned a previously accepted note. */
  replayed: Type.Boolean(),
  message: SessionMessageView,
})
export type CreateSessionNoteResponse = Static<typeof CreateSessionNoteResponse>

export function isCreateSessionNoteResponse(value: unknown): value is CreateSessionNoteResponse {
  return Value.Check(CreateSessionNoteResponse, value)
}

/**
 * `GET /api/v1/session-messages?cursor=&limit=` (user auth). Pulled after a
 * `sync=session_messages` push and on foreground; pages cover every Session
 * Message whose revision advanced after `cursor`.
 */
export interface SessionMessagesPage {
  entries: SessionMessageView[]
  /** Opaque, Account-bound position; save only after every entry is durable. */
  next_cursor: string
  has_more: boolean
}

// ---------------------------------------------------------------------------
// Session Message Agent Acknowledgements
// ---------------------------------------------------------------------------

/**
 * `PUT /api/v1/session-messages/:message_id/agent-acknowledgement` (machine
 * auth). Accepted from the machine of any recorded attempt or the current
 * lease owner of the same Agent Session. Same body and bounds as a Notification
 * Request acknowledgement.
 */
export const PutSessionMessageAcknowledgementRequest = PutAgentAcknowledgementRequest
export type PutSessionMessageAcknowledgementRequestT = Static<
  typeof PutSessionMessageAcknowledgementRequest
>
export type PutSessionMessageAcknowledgementResponse = PutAgentAcknowledgementResponse

/** `GET /api/v1/session-messages/:message_id/agent-acknowledgement` (machine auth). */
export interface GetSessionMessageAcknowledgementResponse {
  message_id: string
  agent_acknowledgement_text_required: boolean
  agent_acknowledgement: AgentAcknowledgementView | null
}

// ---------------------------------------------------------------------------
// Answer Edits and Answer Versions
// ---------------------------------------------------------------------------

/**
 * `POST /api/v1/notifications/:request_id/answer-edits` (user auth, companion
 * capability `answer_edits`). `answers` holds only the edited questions; the
 * server merges them into the latest complete answer.
 *
 * While the reply window is open the edit is an ordinary correction reply
 * (latest wins). After a `deliver` close it becomes an `answer_edit` Session
 * Message and needs a `running` session with `accepts_messages`, or a stopped
 * one (held like a Session Note). Otherwise 409
 * `answer_not_editable`; a stale `base_version` is 409 `answer_changed`.
 */
export const CreateAnswerEditRequest = Type.Object(
  {
    /** Allocated when the Send Delay countdown starts; idempotent across both outcomes. */
    client_edit_id: Type.String({ minLength: 8, maxLength: 64 }),
    device_id: Type.String({ pattern: '^dev_[A-Za-z0-9_-]+$' }),
    /** `version_id` of the latest Answer Version the edit was composed against. */
    base_version: Type.String({ minLength: 1, maxLength: 64 }),
    answers: Type.Array(ReplyAnswer, { minItems: 1, maxItems: REPLY_MAX_QUESTIONS }),
  },
  { additionalProperties: false },
)
export type CreateAnswerEditRequestT = Static<typeof CreateAnswerEditRequest>

/**
 * Status of one Answer Version. Replies are `superseded` by a later reply,
 * `current` while they are the latest undelivered answer, or `delivered` when
 * a `deliver` close fenced them. A reply is `not_delivered` (reason
 * `session_ended`) when its Agent Session ended before the agent read it: the
 * answer was dropped and is never delivered later. Post-delivery edits carry
 * their Session Message state.
 */
export type AnswerVersionStatus = AnswerVersionView['status']

/** Retained answer output; unknown delivery reasons render generically. */
export const AnswerVersionView = Type.Object({
  origin: Type.Union([Type.Literal('companion'), Type.Literal('harness')]),
  /** An agent report does not attest which native control was used. */
  provenance: Type.Union([Type.Literal('agent-reported'), Type.Null()]),
  /** The exact version corrected, or null for an independent answer. */
  base_version: Type.Union([Type.String(), Type.Null()]),
  /** Reply id or post-delivery edit message id; base_version names it. */
  version_id: Type.String(),
  source: Type.Union([Type.Literal('reply'), Type.Literal('edit')]),
  status: Type.Union(['superseded', 'current', 'delivered', 'presented', ...SESSION_MESSAGE_STATES].map(value => Type.Literal(value))),
  not_delivered_reason: Type.Union([Type.String(), Type.Null()]),
  /**
   * On a User's reply: true once the agent's computer has it, either fenced
   * by a `deliver` close or returned by a close with no disposition that
   * ended the window. Says Delivered on the reply label only; whether the
   * answer can still be edited follows `status`. Absent from older services
   * and on agent-reported answers.
   */
  agent_received: Type.Optional(Type.Boolean()),
  /** Complete answer at this version, not just the edited questions. */
  answers: Type.Array(ReplyAnswerView),
  text: Type.String(),
  device_id: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  /** This version's acknowledgement; never borrowed from another edit. */
  agent_acknowledgement: Type.Union([AgentAcknowledgementView, Type.Null()]),
})
export type AnswerVersionView = Static<typeof AnswerVersionView>

export const CreateAnswerEditResponse = Type.Object({
  /** True when `client_edit_id` returned a previously accepted edit. */
  replayed: Type.Boolean(),
  answer_version: AnswerVersionView,
})
export type CreateAnswerEditResponse = Static<typeof CreateAnswerEditResponse>

export function isCreateAnswerEditResponse(value: unknown): value is CreateAnswerEditResponse {
  return Value.Check(CreateAnswerEditResponse, value)
}
