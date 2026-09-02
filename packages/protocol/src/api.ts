import { Type, type Static } from '@sinclair/typebox'
import {
  CUSTOM_SOUND_MAX_BYTES,
  KindSoundMap,
  NotificationDraft,
  NOTIFICATION_IMAGE_MAX_BYTES,
  NotificationMediaTypeSchema,
  PlatformSchema,
  REPLY_MAX_LENGTH,
  REPLY_MAX_QUESTIONS,
  NOTIFICATION_SOUND_MEDIA_TYPE,
  SOUND_NAME_MAX_LENGTH,
  SESSION_LABEL_MAX_LENGTH,
  type NotificationMediaType,
  type Platform,
} from './notification.js'
import type {
  CompanionReceiptState,
  DeliveryState,
  OverallState,
  EvidenceStage,
} from './status.js'
import {
  CapabilityAdvertisement,
  type AffectedOperation,
  type ClientCapability,
  type DeviceDerivedStatus,
  type MachineDerivedStatus,
  type SupportAssessment,
  type SupportState,
} from './compatibility.js'

/**
 * REST v1 wire contract shared by server, CLI, dashboard, and Companion App.
 *
 * This is the one declaration of the served wire. The private contracts
 * package re-exports it and adds only the shapes clients never exchange, so
 * a field documented here is a field the server accepts or returns.
 */

// ---------------------------------------------------------------------------
// Account preferences
// ---------------------------------------------------------------------------

/**
 * Default for accounts without a persisted preference. The server applies this
 * value when reading the setting; clients never infer a missing wire field.
 */
export const DEFAULT_AGENT_ACKNOWLEDGEMENT_TEXT_ENABLED = true

/**
 * The one account preference over Agent Acknowledgements, and it governs text
 * only. It applies when the submitting CLI advertised the acknowledgement job;
 * turning it off drops the agent's brief written reply, never the receipt itself.
 */
export const AccountPreferences = Type.Object(
  {
    agent_acknowledgement_text_enabled: Type.Boolean({
      default: DEFAULT_AGENT_ACKNOWLEDGEMENT_TEXT_ENABLED,
    }),
  },
  { additionalProperties: false },
)
export type AccountPreferencesT = Static<typeof AccountPreferences>
export type AccountPreferencesResponse = AccountPreferencesT

export const UpdateAccountPreferencesRequest = Type.Object(
  { agent_acknowledgement_text_enabled: Type.Boolean() },
  { additionalProperties: false },
)
export type UpdateAccountPreferencesRequestT = Static<typeof UpdateAccountPreferencesRequest>

export const AccountSoundDefaults = Type.Object(
  { sounds: KindSoundMap },
  { additionalProperties: false },
)
export type AccountSoundDefaultsT = Static<typeof AccountSoundDefaults>
export type AccountSoundDefaultsResponse = AccountSoundDefaultsT
export const UpdateAccountSoundDefaultsRequest = AccountSoundDefaults
export type UpdateAccountSoundDefaultsRequestT = AccountSoundDefaultsT

// ---------------------------------------------------------------------------
// Account access (the account shell is not product access)
// ---------------------------------------------------------------------------

/**
 * Stable access state returned to every authenticated client. `active` is
 * intentionally separate from the reason so later subscription and durable
 * payment-exemption decisions can extend the source without changing the
 * no-plan boundary or making Alpha look permanent.
 */
export const ACCESS_STATUSES = ['no_active_plan', 'active'] as const
export type AccountAccessStatus = (typeof ACCESS_STATUSES)[number]

/** Current Alpha source plus explicit slots for later paid V1 sources. */
export const ACCESS_REASONS = [
  'no_active_grant',
  'alpha_grant',
  'subscription',
  'payment_exemption',
] as const
export type AccountAccessReason = (typeof ACCESS_REASONS)[number]

export interface AccountAccessResponse {
  status: AccountAccessStatus
  reason: AccountAccessReason
  /** Alpha grants are temporary; future sources may also carry an expiry. */
  expires_at: string | null
  /**
   * The account's sign-in email when the server knows it. Used at the
   * companion-device hop so install/sign-in copy can name the exact address
   * that must match — never guess, and omit only when the server has none.
   */
  email: string | null
  /**
   * Whether the server has opened public purchase. Decided by the server and
   * carried on the call every client already makes, because a client that
   * compiled its own copy of the instant keeps offering the wrong errand to
   * every install that has not been updated.
   */
  public_v1_cutover: boolean
}

// ---------------------------------------------------------------------------
// Machine pairing (Machine Access seam)
// ---------------------------------------------------------------------------

export const BeginPairingRequest = Type.Object(
  {
    machine_name: Type.String({ minLength: 1, maxLength: 128 }),
    /** SHA-256 hex of the locally generated 256-bit machine secret. */
    credential_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    /** SHA-256 hex of the one-time poll verifier; proves the poller began this pairing. */
    poll_verifier_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    /** SHA-256 hex of the one-time browser confirmation secret. */
    confirmation_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  },
  { additionalProperties: false },
)
export type BeginPairingRequestT = Static<typeof BeginPairingRequest>

export interface BeginPairingResponse {
  pairing_id: string
  /** Short human-checkable code shown in both CLI and approval page. */
  code: string
  approve_url: string
  expires_at: string
  poll_interval_seconds: number
}

export const PollPairingRequest = Type.Object(
  { poll_verifier: Type.String({ minLength: 32, maxLength: 128 }) },
  { additionalProperties: false },
)
export type PollPairingRequestT = Static<typeof PollPairingRequest>

/**
 * Proof carried by every authenticated dashboard pairing operation. The
 * short code is human-checkable; the high-entropy secret is transported only
 * in the approval URL fragment and is never sent by a browser GET.
 */
export const PAIRING_CODE_PATTERN_SOURCE =
  '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{3}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{3}$'
export const PAIRING_CONFIRMATION_SECRET_PATTERN_SOURCE = '^[A-Za-z0-9_-]{43}$'

export const PairingProofRequest = Type.Object(
  {
    code: Type.String({ pattern: PAIRING_CODE_PATTERN_SOURCE }),
    confirmation_secret: Type.String({ pattern: PAIRING_CONFIRMATION_SECRET_PATTERN_SOURCE }),
  },
  { additionalProperties: false },
)
export type PairingProofRequestT = Static<typeof PairingProofRequest>

export interface PollPairingResponse {
  /**
   * `no_active_plan` is set when the pairing initiator's poll verifier is
   * valid and the pending handshake has been marked by an authenticated
   * Request Alpha access errand that proved the approval link. Lookup alone
   * never sets this status. The CLI should stop polling and surface
   * `next_action` instead of waiting out the pairing TTL.
   */
  status: 'pending' | 'approved' | 'expired' | 'denied' | 'no_active_plan'
  machine_id?: string
  /** Present when status is `no_active_plan`; a concrete path to request access. */
  next_action?: string
}

// ---------------------------------------------------------------------------
// Alpha access request (the no-access errand)
// ---------------------------------------------------------------------------

export const ALPHA_ACCESS_DISTRIBUTION_LANES = [
  'iphone_testflight',
  'android_firebase',
] as const
export type AlphaAccessDistributionLane = (typeof ALPHA_ACCESS_DISTRIBUTION_LANES)[number]

/** Dashboard Account query key that may preselect one Distribution Lane. */
export const ALPHA_ACCESS_LANE_QUERY_PARAM = 'distribution_lane' as const

export const AlphaAccessDistributionLaneSchema = Type.Union([
  Type.Literal('iphone_testflight'),
  Type.Literal('android_firebase'),
])

/** Accept only the two active lanes; unknown or absent values preselect nothing. */
export function parseAlphaAccessLaneHint(
  value: string | null | undefined,
): AlphaAccessDistributionLane | null {
  if (value === 'iphone_testflight' || value === 'android_firebase') return value
  return null
}

export const RequestAlphaAccessRequest = Type.Object(
  {
    distribution_lanes: Type.Array(AlphaAccessDistributionLaneSchema, {
      minItems: 1,
      maxItems: ALPHA_ACCESS_DISTRIBUTION_LANES.length,
      uniqueItems: true,
    }),
    pairing: Type.Optional(PairingProofRequest),
  },
  { additionalProperties: false },
)
export type RequestAlphaAccessRequestT = Static<typeof RequestAlphaAccessRequest>

export interface AlphaAccessRequestView {
  status: 'requested'
  distribution_lanes: AlphaAccessDistributionLane[]
  requested_at: string
  updated_at: string
}

export interface AlphaAccessRequestResponse {
  public_v1_cutover: boolean
  request: AlphaAccessRequestView | null
}

/**
 * `stopped` means the originating CLI was told this handshake could not
 * continue and exited without storing a credential. Approving afterwards would
 * mint an Approved Machine nobody holds, so the browser must neither offer it
 * nor claim the terminal will pick it up.
 */
export interface PairingDetailsResponse {
  pairing_id: string
  machine_name: string
  code: string
  status: 'pending' | 'approved' | 'expired' | 'denied' | 'stopped'
  expires_at: string
}

export interface MachineSummary {
  machine_id: string
  name: string
  status: 'active' | 'revoked'
  approved_at: string
  revoked_at: string | null
  last_seen_at: string | null
  cli_version: string | null
  capabilities: ClientCapability[]
  support: SupportAssessment
  support_state: SupportState
  derived_status: MachineDerivedStatus
  /** Null while this Approved Machine can send. Optional updates never appear here. */
  status_message: string | null
}

export interface ListMachinesResponse {
  machines: MachineSummary[]
}

// ---------------------------------------------------------------------------
// Device Registry (Companion App seam)
// ---------------------------------------------------------------------------

export const RegisterInstallationRequest = Type.Object(
  {
    /** Stable random identifier generated once per app installation. */
    installation_id: Type.String({ pattern: '^ins_[A-Za-z0-9_-]{10,64}$' }),
    platform: PlatformSchema,
    display_name: Type.String({ minLength: 1, maxLength: 128 }),
    /** Marketing version. Inventory only; capabilities remain routing authority. */
    app_version: Type.String({ minLength: 1, maxLength: 32 }),
    /** Platform build identifier. Inventory only; capabilities remain routing authority. */
    app_build: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    os_version: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    /** Named jobs this exact installation can perform. Absent means baseline receive only. */
    capabilities: Type.Optional(CapabilityAdvertisement),
  },
  { additionalProperties: false },
)
export type RegisterInstallationRequestT = Static<typeof RegisterInstallationRequest>

export interface RegisterInstallationResponse {
  device_id: string
  /** Omitted by servers released before compatibility inventory. */
  support?: SupportAssessment
}

export const ApnsRegistrationRequest = Type.Object(
  {
    provider: Type.Literal('apns'),
    environment: Type.Union([Type.Literal('development'), Type.Literal('production')]),
    /** Hex APNs device token as handed to the Companion App. */
    token: Type.String({ pattern: '^[a-f0-9]{32,512}$' }),
  },
  { additionalProperties: false },
)

export const FcmRegistrationRequest = Type.Object(
  {
    provider: Type.Literal('fcm'),
    /** Opaque Firebase Installation ID supplied by the current Android registration path. */
    fid: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
)

/** Provider-specific registration shapes; FCM deliberately has no environment field. */
export const PutRegistrationRequest = Type.Union([
  ApnsRegistrationRequest,
  FcmRegistrationRequest,
])
export type PutRegistrationRequestT = Static<typeof PutRegistrationRequest>

export interface PutRegistrationResponse {
  registration_version: number
}

export const ReportHealthRequest = Type.Object(
  {
    permission_status: Type.Union([
      Type.Literal('authorized'),
      Type.Literal('provisional'),
      Type.Literal('denied'),
      Type.Literal('not_determined'),
    ]),
    alerts_enabled: Type.Boolean(),
  },
  { additionalProperties: false },
)
export type ReportHealthRequestT = Static<typeof ReportHealthRequest>

export interface RoutableDevice {
  device_id: string
  display_name: string
  platform: Platform
  permission_status: string
  registration_healthy: boolean
  app_version: string
  app_build: string | null
  os_version: string | null
  capabilities: ClientCapability[]
  support: SupportAssessment
  support_state: SupportState
  derived_status: DeviceDerivedStatus
  /** Exactly one dashboard status; null means working. */
  status_message: string | null
  last_seen_at: string | null
}

export interface ListDevicesResponse {
  devices: RoutableDevice[]
}

// ---------------------------------------------------------------------------
// Notification submission and evidence
// ---------------------------------------------------------------------------

/** Canonical URL-safe Notification Request identity accepted from a client. */
export const REQUEST_ID_PATTERN = '^req_[A-Za-z0-9_-]{22,24}$'

export const SubmitNotificationRequest = Type.Object(
  {
    /** Stable caller-generated identity for crash-safe submission replay. */
    request_id: Type.Optional(Type.String({ pattern: REQUEST_ID_PATTERN })),
    idempotency_key: Type.String({ minLength: 8, maxLength: 128 }),
    draft: NotificationDraft,
  },
  { additionalProperties: false },
)
export type SubmitNotificationRequestT = Static<typeof SubmitNotificationRequest>

export interface DeliveryOutcome {
  delivery_id: string
  device_id: string
  device_name: string
  state: DeliveryState
  attempts: number
  provider_status: number | null
  provider_reason: string | null
  provider_id: string | null
  updated_at: string
}

export interface SubmissionWarning {
  path: string
  message: string
  code?: 'capability_downgrade' | 'targets_omitted'
  affected_operation?: AffectedOperation
  device_ids?: string[]
  device_names?: string[]
  missing_capabilities?: ClientCapability[]
}

export interface SubmissionReceipt {
  request_id: string
  /** Committed reply deadline; null when this request did not ask for a reply. */
  reply_expires_at: string | null
  /**
   * Immutable snapshot: true only when the question's submitting CLI advertised
   * that it can perform Agent Acknowledgements.
   */
  agent_acknowledgement_required: boolean
  /**
   * Immutable account-preference snapshot taken when an acknowledgement
   * obligation is created: true when it must carry text. Otherwise false.
   */
  agent_acknowledgement_text_required: boolean
  /** True when idempotency returned a previously accepted request. */
  replayed: boolean
  overall: OverallState
  deliveries: DeliveryOutcome[]
  warnings: SubmissionWarning[]
}

export interface EvidenceEvent {
  stage: EvidenceStage
  source: string
  reason: string | null
  attempt: number | null
  occurred_at: string
}

/**
 * Derived from the first Companion Receipt event for one Delivery. Unknown
 * means only that no receipt has been observed; it is not a timeout or failure.
 */
export interface CompanionReceiptEvidence {
  state: CompanionReceiptState
  observed_at: string | null
  /** First companion_received minus first provider_accepted, when both exist. */
  latency_ms: number | null
}

export interface EvidenceSnapshot {
  request_id: string
  accepted_at: string
  overall: OverallState
  deliveries: (DeliveryOutcome & {
    companion_receipt: CompanionReceiptEvidence
    events: EvidenceEvent[]
  })[]
}

// ---------------------------------------------------------------------------
// Companion Receipt (best-effort diagnostic; not proof of display)
// ---------------------------------------------------------------------------

export const CompanionReceiptRequest = Type.Object(
  {
    delivery_id: Type.String({ pattern: '^del_[A-Za-z0-9_-]+$' }),
    /**
     * The delivery's own secret, taken from the push payload. Present, it is
     * the whole authorization and no Auth Session is needed — which is what
     * keeps Notification Service Extensions out of the keychain. Absent, the
     * request falls back to a bearer token, so companions installed before the
     * token existed keep reporting.
     */
    receipt_token: Type.Optional(Type.String({ minLength: 16, maxLength: 64 })),
  },
  { additionalProperties: false },
)
export type CompanionReceiptRequestT = Static<typeof CompanionReceiptRequest>

// ---------------------------------------------------------------------------
// Inline replies (opaque text carried from Companion App to agent)
// ---------------------------------------------------------------------------

/**
 * One question's answer inside a reply. Choice ids are validated against the
 * stored draft and rewritten to canonical labels server-side; `text` is the
 * typed answer, which is always possible even on a choice question (the
 * "Other" path) and may accompany selections on a multi-select question.
 * At least one of the two must be present — the server enforces what the
 * schema cannot say.
 */
export const ReplyAnswer = Type.Object(
  {
    question_id: Type.String({ minLength: 1, maxLength: 32 }),
    choice_ids: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { minItems: 1, maxItems: 6 }),
    ),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: REPLY_MAX_LENGTH })),
  },
  { additionalProperties: false },
)
export type ReplyAnswerT = Static<typeof ReplyAnswer>

export const SubmitReplyRequest = Type.Object(
  {
    delivery_id: Type.String({ pattern: '^del_[A-Za-z0-9_-]+$' }),
    /** Device-generated id; makes outbox retries idempotent. */
    client_reply_id: Type.String({ minLength: 8, maxLength: 64 }),
    /**
     * The answers, one per question answered, in question order. The server
     * resolves each against the stored draft, so a stored reply cannot
     * disagree with what was actually asked.
     */
    answers: Type.Array(ReplyAnswer, { minItems: 1, maxItems: REPLY_MAX_QUESTIONS }),
    /**
     * Which surface the user actually answered from. Native iOS actions,
     * Android RemoteInput, and each Companion App's in-app composer converge
     * here. They looked identical once stored, so a regression
     * in one of them was indistinguishable from a regression in another
     * without device logs.
     *
     * Optional and open: a device that does not send it is not wrong, and an
     * unknown value is recorded rather than rejected, because rejecting a
     * reply over a diagnostic field would lose the answer.
     */
    source: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  },
  { additionalProperties: false },
)
export type SubmitReplyRequestT = Static<typeof SubmitReplyRequest>

/** The reply surfaces the companions know how to name. */
export const REPLY_SOURCES = [
  /** iOS custom UNTextInputNotificationAction, reached by long-press. */
  'action',
  /** iOS system message-style field, delivered as an INSendMessageIntent. */
  'intent',
  /** The notification content extension's answer buttons. */
  'choice',
  /** Android's native RemoteInput free-text action. */
  'remote_input',
  /** The Companion App's own detail-view composer or picker. */
  'app',
] as const

/** One question's answer as stored: canonical ids and labels, server-checked. */
export interface ReplyAnswerView {
  question_id: string
  /** Chosen choice ids, in choice order; empty for a purely typed answer. */
  choice_ids: string[]
  /** The typed answer, when the user wrote one (the "Other" path). */
  text: string | null
}

export interface ReplyView {
  reply_id: string
  /** Monotonic cursor within the Notification Request. */
  seq: number
  delivery_id: string
  device_id: string
  device_name: string
  /** Human-readable rendering of the whole reply, assembled server-side. */
  text: string
  /** The checkable answers, one per question answered. */
  answers: ReplyAnswerView[]
  /** Which surface it was answered from, when the device said. */
  source: string | null
  created_at: string
}

export interface AgentAcknowledgementView {
  /**
   * The agent's brief written reply, or empty when the account turned
   * acknowledgement text off. Empty text is still a recorded acknowledgement:
   * it says an agent read the answer.
   */
  text: string
  created_at: string
}

export interface ListRepliesResponse {
  request_id: string
  /** Null when the Notification Request did not request replies. */
  reply_expires_at: string | null
  /** True for every request that asked for a reply. */
  agent_acknowledgement_required: boolean
  /**
   * Immutable account-preference snapshot recorded at request acceptance: true
   * when the acknowledgement must carry text.
   */
  agent_acknowledgement_text_required: boolean
  /** The one recorded Agent Acknowledgement, or null while none is available. */
  agent_acknowledgement: AgentAcknowledgementView | null
  replies: ReplyView[]
}

/** Agent-authored follow-up text is kept intentionally smaller than a user reply. */
export const AGENT_ACKNOWLEDGEMENT_MAX_LENGTH = 200

/**
 * The service trims `text` before validation and persistence. When present it
 * must be non-empty after trimming and no longer than
 * AGENT_ACKNOWLEDGEMENT_MAX_LENGTH. Omitting it records the acknowledgement
 * without text, which the service accepts only where the account turned
 * acknowledgement text off.
 */
export const PutAgentAcknowledgementRequest = Type.Object(
  {
    text: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
        pattern: '.*\\S.*',
      }),
    ),
  },
  { additionalProperties: false },
)
export type PutAgentAcknowledgementRequestT = Static<typeof PutAgentAcknowledgementRequest>

export interface PutAgentAcknowledgementResponse {
  status: 'recorded' | 'replayed'
  agent_acknowledgement: AgentAcknowledgementView
}

export interface GetAgentAcknowledgementResponse {
  request_id: string
  /** True for every request that asked for a reply. */
  agent_acknowledgement_required: boolean
  /** True when the acknowledgement must carry text. */
  agent_acknowledgement_text_required: boolean
  agent_acknowledgement: AgentAcknowledgementView | null
}

// ---------------------------------------------------------------------------
// Media intake
// ---------------------------------------------------------------------------

export const CreateMediaUploadRequest = Type.Object(
  {
    media_type: NotificationMediaTypeSchema,
    size_bytes: Type.Integer({ minimum: 1, maximum: NOTIFICATION_IMAGE_MAX_BYTES }),
    sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  },
  { additionalProperties: false },
)
export type CreateMediaUploadRequestT = Static<typeof CreateMediaUploadRequest>

export const BeginSoundUploadRequest = Type.Object(
  {
    media_type: Type.Literal(NOTIFICATION_SOUND_MEDIA_TYPE),
    size_bytes: Type.Integer({ minimum: 1, maximum: CUSTOM_SOUND_MAX_BYTES }),
    sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  },
  { additionalProperties: false },
)
export type BeginSoundUploadRequestT = Static<typeof BeginSoundUploadRequest>

export const CommitSoundRequest = Type.Object(
  {
    media_id: Type.String({ pattern: '^med_[A-Za-z0-9_-]+$' }),
    name: Type.String({ minLength: 1, maxLength: SOUND_NAME_MAX_LENGTH }),
  },
  { additionalProperties: false },
)
export type CommitSoundRequestT = Static<typeof CommitSoundRequest>

export const RenameSoundRequest = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: SOUND_NAME_MAX_LENGTH }),
  },
  { additionalProperties: false },
)
export type RenameSoundRequestT = Static<typeof RenameSoundRequest>

export interface BeginSoundUploadResponse {
  media_id: string
  upload_url: string
  upload_headers: Record<string, string>
  expires_at: string
}

export interface SoundView {
  sound_id: string
  name: string
  duration_ms: number
  content_hash: string
  url: string
}

export interface ListSoundsResponse {
  sounds: SoundView[]
}

export interface CreateMediaUploadResponse {
  media_id: string
  upload_url: string
  /** Headers the client must send with the PUT upload. */
  upload_headers: Record<string, string>
  expires_at: string
}

export interface FinalizeMediaUploadResponse {
  media_id: string
  /** Storage-provider-observed bytes used for quota accounting. */
  size_bytes: number
  status: 'ready'
}

// ---------------------------------------------------------------------------
// Canonical notification content (fetched by Companion Apps on open)
// ---------------------------------------------------------------------------

export interface NotificationContentMediaItem {
  media_id: string
  /** Zero-based collection position; presentation.media order is semantic. */
  position: number
  media_type: NotificationMediaType
  alt: string | null
  /** Fresh one-hour signed URL of the original, or null when this item is unavailable. */
  url: string | null
  /**
   * Fresh one-hour signed URL of the server-generated WebP preview variant
   * (longest side 1024px), or null when the asset has no preview.
   */
  preview_url: string | null
  /** Oriented pixel width of the original, or null when never decoded. */
  width: number | null
  /** Oriented pixel height of the original, or null when never decoded. */
  height: number | null
}

export interface NotificationContentResponse {
  request_id: string
  /** The one full author-facing body, always interpreted as Markdown. */
  body: string
  media: NotificationContentMediaItem[]
}

// ---------------------------------------------------------------------------
// Projects (lazy identity; user-facing customization surface)
// ---------------------------------------------------------------------------

export const UpdateProjectRequest = Type.Object(
  {
    display_name: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
)
export type UpdateProjectRequestT = Static<typeof UpdateProjectRequest>

export interface ProjectView {
  project_id: string
  identifier: string
  display_name: string | null
  image_media_id: string | null
  /** Stable cache identity. Signed URLs are transport capabilities, never cache identity. */
  avatar_revision: string
  /** Public generated avatar URL, or a short-lived signed URL for custom media. */
  image_url: string | null
  last_seen_at: string
}

export interface ListProjectsResponse {
  projects: ProjectView[]
}

// ---------------------------------------------------------------------------
// Agent Sessions (Account-authoritative current labels)
// ---------------------------------------------------------------------------

export const PutAgentSessionLabelRequest = Type.Object(
  {
    session_id: Type.String({ minLength: 1, maxLength: 128 }),
    label: Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH }),
  },
  { additionalProperties: false },
)
export type PutAgentSessionLabelRequestT = Static<typeof PutAgentSessionLabelRequest>

export interface AgentSessionView {
  session_id: string
  label: string
  renamed_by: 'user' | 'agent'
  updated_at: string
}

export interface ListAgentSessionsResponse {
  agent_sessions: AgentSessionView[]
}

// ---------------------------------------------------------------------------
// Feedback intake (paired machine → developers)
// ---------------------------------------------------------------------------

const feedbackLogFields = {
  encoding: Type.Literal('gzip+base64'),
  uncompressed_bytes: Type.Integer({ minimum: 0 }),
  compressed_bytes: Type.Integer({ minimum: 1 }),
  record_count: Type.Integer({ minimum: 0 }),
  truncated: Type.Boolean(),
  since: Type.String({ minLength: 20, maxLength: 40 }),
  until: Type.String({ minLength: 20, maxLength: 40 }),
  schema_version: Type.Integer({ minimum: 1 }),
} as const

/** Content-free metadata for an optional compressed log slice. */
export const FeedbackLogMeta = Type.Object(feedbackLogFields, { additionalProperties: false })
export type FeedbackLogMetaT = Static<typeof FeedbackLogMeta>

export const FeedbackLogAttachment = Type.Object(
  {
    ...feedbackLogFields,
    bytes: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)
export type FeedbackLogAttachmentT = Static<typeof FeedbackLogAttachment>

export const FeedbackClient = Type.Object(
  {
    cli_version: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    cli_channel: Type.Union([
      Type.Literal('dev'),
      Type.Literal('prerelease'),
      Type.Literal('stable'),
    ]),
    os: Type.String({ minLength: 1, maxLength: 128 }),
    node: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
)
export type FeedbackClientT = Static<typeof FeedbackClient>

export const SubmitFeedbackRequest = Type.Object(
  {
    message: Type.String({ minLength: 1, maxLength: 4000 }),
    include_logs: Type.Boolean(),
    log: Type.Optional(FeedbackLogAttachment),
    client: FeedbackClient,
  },
  { additionalProperties: false },
)
export type SubmitFeedbackRequestT = Static<typeof SubmitFeedbackRequest>

export interface SubmitFeedbackResponse {
  report_id: string
}
