import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
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
  type QuestionT,
} from './notification.js'
import type {
  CompanionReceiptState,
  DeliveryState,
  OverallState,
  EvidenceStage,
} from './status.js'
import type { AnswerVersionView, SessionPresenceView } from './sessions.js'
import {
  CapabilityAdvertisement,
  type AffectedOperation,
  type ClientCapability,
  ClientCapabilitySchema,
  DEVICE_DERIVED_STATUSES,
  MachineDerivedStatusSchema,
  SupportAssessment,
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
 * Send Delay choices in seconds: the Companion-side hold between pressing send
 * and an in-app answer, Answer Edit, or Session Note leaving the device. Zero is
 * "Off". Native notification actions always send immediately.
 */
export const SEND_DELAY_SECONDS_OPTIONS = [0, 3, 5, 10] as const
export type SendDelaySeconds = (typeof SEND_DELAY_SECONDS_OPTIONS)[number]
export const DEFAULT_SEND_DELAY_SECONDS: SendDelaySeconds = 5

export const SendDelaySecondsSchema = Type.Union(
  SEND_DELAY_SECONDS_OPTIONS.map((seconds) => Type.Literal(seconds)),
)

/**
 * `agent_acknowledgement_text_enabled` is the one account preference over
 * Agent Acknowledgements, and it governs text only. It applies when the
 * submitting CLI advertised the acknowledgement job; turning it off drops the
 * agent's brief written reply, never the receipt itself.
 *
 * `send_delay_seconds` is the Account's Send Delay. Servers that predate it
 * omit the field, which a Companion App reads as "not offered" rather than
 * inferring a value.
 */
export const AccountPreferences = Type.Object(
  {
    agent_acknowledgement_text_enabled: Type.Boolean({
      default: DEFAULT_AGENT_ACKNOWLEDGEMENT_TEXT_ENABLED,
    }),
    send_delay_seconds: Type.Optional(SendDelaySecondsSchema),
  },
  { additionalProperties: false },
)
export type AccountPreferencesT = Static<typeof AccountPreferences>
/** Successful responses retain additive facts; update requests remain closed. */
export const AccountPreferencesResponse = Type.Object(AccountPreferences.properties)
export type AccountPreferencesResponse = Static<typeof AccountPreferencesResponse>

export function isAccountPreferencesResponse(value: unknown): value is AccountPreferencesResponse {
  return Value.Check(AccountPreferencesResponse, value)
}

/** A partial update: each present field is written; at least one must be present. */
export const UpdateAccountPreferencesRequest = Type.Object(
  {
    agent_acknowledgement_text_enabled: Type.Optional(Type.Boolean()),
    send_delay_seconds: Type.Optional(SendDelaySecondsSchema),
  },
  { additionalProperties: false, minProperties: 1 },
)
export type UpdateAccountPreferencesRequestT = Static<typeof UpdateAccountPreferencesRequest>

export const AccountSoundDefaults = Type.Object(
  { sounds: KindSoundMap },
  { additionalProperties: false },
)
export type AccountSoundDefaultsT = Static<typeof AccountSoundDefaults>
/** Responses preserve additive fields; update requests keep their closed shape. */
export const AccountSoundDefaultsResponse = Type.Object({ sounds: Type.Object(KindSoundMap.properties) })
export type AccountSoundDefaultsResponse = Static<typeof AccountSoundDefaultsResponse>

export function isAccountSoundDefaultsResponse(value: unknown): value is AccountSoundDefaultsResponse {
  return Value.Check(AccountSoundDefaultsResponse, value)
}
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

/** Open response schema: newer servers may add fields without breaking clients. */
export const AccountAccessResponse = Type.Object({
  status: Type.Union(ACCESS_STATUSES.map(value => Type.Literal(value))),
  reason: Type.Union(ACCESS_REASONS.map(value => Type.Literal(value))),
  /** Alpha grants are temporary; future sources may also carry an expiry. */
  expires_at: Type.Union([Type.String(), Type.Null()]),
  /**
   * The account's sign-in email when the server knows it. Used at the
   * companion-device hop so install/sign-in copy can name the exact address
   * that must match — never guess, and omit only when the server has none.
   */
  email: Type.Union([Type.String(), Type.Null()]),
  /**
   * Whether the server has opened public purchase. Decided by the server and
   * carried on the call every client already makes, because a client that
   * compiled its own copy of the instant keeps offering the wrong errand to
   * every install that has not been updated.
   */
  public_v1_cutover: Type.Boolean(),
})
export type AccountAccessResponse = Static<typeof AccountAccessResponse>
export function isAccountAccessResponse(value: unknown): value is AccountAccessResponse {
  return Value.Check(AccountAccessResponse, value)
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
    /**
     * How long this client keeps the handshake to collect an approval. The
     * service grants up to its own maximum and reports the result as
     * `expires_at`. Omitted, the approval lasts ten minutes: clients that
     * predate this field stop waiting then and discard the handshake, so a
     * later approval would create an Approved Machine nobody holds. No upper
     * bound here, so a later client asking for more is clamped, not refused.
     */
    lifetime_seconds: Type.Optional(Type.Integer({ minimum: 60 })),
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
 * Keeps a waiting approval open: `POST /api/v1/pairings/:id/extend`. Only the
 * initiator can extend, proved by the same poll verifier it polls with. The
 * code and the approval link stay the same, so an open approval page and a QR
 * on screen keep working. Allowed while the approval is still waiting (also
 * just after it lapsed) and for up to two hours after it began; the service
 * answers `pairing_not_pending` once it was approved, denied or stopped, and
 * `pairing_too_old` after that. Omitted, `lifetime_seconds` asks for the
 * longest lifetime the service grants.
 */
export const ExtendPairingRequest = Type.Object(
  {
    poll_verifier: Type.String({ minLength: 32, maxLength: 128 }),
    lifetime_seconds: Type.Optional(Type.Integer({ minimum: 60 })),
  },
  { additionalProperties: false },
)
export type ExtendPairingRequestT = Static<typeof ExtendPairingRequest>

/** The extended approval, in the same shape `POST /api/v1/pairings` returns. */
export type ExtendPairingResponse = BeginPairingResponse

/** The initiator explicitly selects Account-email targeting; response is non-enumerating. */
export const PairingNotificationRequest = Type.Object(
  {
    poll_verifier: Type.String({ minLength: 32, maxLength: 128 }),
    email: Type.String({ format: 'email', maxLength: 254 }),
  },
  { additionalProperties: false },
)
export type PairingNotificationRequestT = Static<typeof PairingNotificationRequest>

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

/** Open resource responses retain facts added by newer services. */
export const MachineSummary = Type.Object({
  machine_id: Type.String(),
  name: Type.String(),
  status: Type.Union([Type.Literal('active'), Type.Literal('revoked')]),
  approved_at: Type.String(),
  revoked_at: Type.Union([Type.String(), Type.Null()]),
  last_seen_at: Type.Union([Type.String(), Type.Null()]),
  cli_version: Type.Union([Type.String(), Type.Null()]),
  capabilities: Type.Array(ClientCapabilitySchema),
  support: SupportAssessment,
  support_state: SupportAssessment.properties.state,
  derived_status: MachineDerivedStatusSchema,
  /** Null while this Approved Machine can send. Optional updates never appear here. */
  status_message: Type.Union([Type.String(), Type.Null()]),
})
export type MachineSummary = Static<typeof MachineSummary>

export const ListMachinesResponse = Type.Object({ machines: Type.Array(MachineSummary) })
export type ListMachinesResponse = Static<typeof ListMachinesResponse>

export function isListMachinesResponse(value: unknown): value is ListMachinesResponse {
  return Value.Check(ListMachinesResponse, value)
}

/** Removing a Device Installation or revoking an Approved Machine completed. */
export const ResourceMutationResponse = Type.Object({ ok: Type.Literal(true) })
export type ResourceMutationResponse = Static<typeof ResourceMutationResponse>

export function isResourceMutationResponse(value: unknown): value is ResourceMutationResponse {
  return Value.Check(ResourceMutationResponse, value)
}

// ---------------------------------------------------------------------------
// Device Registry (Companion App seam)
// ---------------------------------------------------------------------------

export const RegisterInstallationRequest = Type.Object(
  {
    /** Stable random identifier generated once per app installation. */
    installation_id: Type.String({ pattern: '^ins_[A-Za-z0-9_-]{10,64}$' }),
    /** Account-local continuity across sign-out; never an authorization token. */
    recovery_installation_id: Type.Optional(Type.String({ pattern: '^rec_[A-Za-z0-9_-]{10,64}$' })),
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

// Identifiers are opaque; only an empty/whitespace-only identity is unusable.
const ResponseIdentity = Type.String({ pattern: '\\S' })

export const RegisterInstallationResponse = Type.Object({
  device_id: ResponseIdentity,
  recovery_installation_id: ResponseIdentity,
  /** Omitted by servers released before compatibility inventory. */
  support: Type.Optional(SupportAssessment),
})
export type RegisterInstallationResponse = Static<typeof RegisterInstallationResponse>

export function isRegisterInstallationResponse(value: unknown): value is RegisterInstallationResponse {
  return Value.Check(RegisterInstallationResponse, value)
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

/**
 * A desktop Companion App receives over its own changes feed, so it registers
 * no token: the service routes to it while that feed is being read.
 */
export const StreamRegistrationRequest = Type.Object(
  { provider: Type.Literal('stream') },
  { additionalProperties: false },
)

/** Provider-specific registration shapes; only APNs carries an environment. */
export const PutRegistrationRequest = Type.Union([
  ApnsRegistrationRequest,
  FcmRegistrationRequest,
  StreamRegistrationRequest,
])
export type PutRegistrationRequestT = Static<typeof PutRegistrationRequest>

export const PutRegistrationResponse = Type.Object({ registration_version: Type.Number() })
export type PutRegistrationResponse = Static<typeof PutRegistrationResponse>

export function isPutRegistrationResponse(value: unknown): value is PutRegistrationResponse {
  return Value.Check(PutRegistrationResponse, value)
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

export const RoutableDevice = Type.Object({
  device_id: Type.String(),
  display_name: Type.String(),
  platform: PlatformSchema,
  permission_status: Type.String(),
  registration_healthy: Type.Boolean(),
  app_version: Type.String(),
  app_build: Type.Union([Type.String(), Type.Null()]),
  os_version: Type.Union([Type.String(), Type.Null()]),
  capabilities: Type.Array(ClientCapabilitySchema),
  support: SupportAssessment,
  support_state: SupportAssessment.properties.state,
  derived_status: Type.Union(DEVICE_DERIVED_STATUSES.map((status) => Type.Literal(status))),
  /** Exactly one dashboard status; null means working. */
  status_message: Type.Union([Type.String(), Type.Null()]),
  last_seen_at: Type.Union([Type.String(), Type.Null()]),
})
export type RoutableDevice = Static<typeof RoutableDevice>

export const ListDevicesResponse = Type.Object({ devices: Type.Array(RoutableDevice) })
export type ListDevicesResponse = Static<typeof ListDevicesResponse>

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

/** An Approved Machine reports a native answer its agent has already read. */
export const RecordHarnessAnswerRequest = Type.Object({
  session_id: Type.String({ minLength: 1, maxLength: 256 }),
  /** Persist before sending; retries keep the same key and normalized answers. */
  submission_id: Type.String({ minLength: 8, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }),
  answers: Type.Array(ReplyAnswer, { minItems: 1, maxItems: REPLY_MAX_QUESTIONS }),
}, { additionalProperties: false })
export type RecordHarnessAnswerRequestT = Static<typeof RecordHarnessAnswerRequest>

export function isRecordHarnessAnswerRequest(value: unknown): value is RecordHarnessAnswerRequestT {
  return Value.Check(RecordHarnessAnswerRequest, value)
}

export interface RecordHarnessAnswerResponse {
  status: 'recorded' | 'replayed'
  reply_seq: number
  answer_version: AnswerVersionView
  /** Independent accepted submissions; the agent must reconcile contradictions. */
  other_submissions: AnswerVersionView[]
  /** All questions have a reported native answer; partial reports never imply this. */
  complete: boolean
}

export const SubmitReplyRequest = Type.Object(
  {
    delivery_id: Type.Optional(Type.String({ pattern: '^del_[A-Za-z0-9_-]+$' })),
    /** Recovery replies name a Request and the current Device Installation. */
    request_id: Type.Optional(Type.String({ pattern: '^req_[A-Za-z0-9_-]+$' })),
    device_id: Type.Optional(Type.String({ pattern: '^dev_[A-Za-z0-9_-]+$' })),
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
  {
    additionalProperties: false,
    oneOf: [
      { required: ['delivery_id'], not: { anyOf: [{ required: ['request_id'] }, { required: ['device_id'] }] } },
      { required: ['request_id', 'device_id'], not: { required: ['delivery_id'] } },
    ],
  },
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
export const ReplyAnswerView = Type.Object({
  question_id: Type.String(),
  /** Choice ids in choice order; empty for a purely typed answer. */
  choice_ids: Type.Array(Type.String()),
  /** Typed answer on the Other path, when supplied. */
  text: Type.Union([Type.String(), Type.Null()]),
})
export type ReplyAnswerView = Static<typeof ReplyAnswerView>

/** Retained output accepts additive fields and opaque identities. */
export const ReplyView = Type.Object({
  reply_id: Type.String(),
  /** Monotonic cursor within the Notification Request. */
  seq: Type.Number(),
  /** Null after recovery or removal of the installation. */
  delivery_id: Type.Union([Type.String(), Type.Null()]),
  device_id: Type.Union([Type.String(), Type.Null()]),
  device_name: Type.String(),
  text: Type.String(),
  answers: Type.Array(ReplyAnswerView),
  /** Open surface name, when the device supplied one. */
  source: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
})
export type ReplyView = Static<typeof ReplyView>

/** Confirmed companion reply submission; retries return the retained reply. */
export const SubmitReplyResponse = Type.Object({
  outcome: Type.Union([Type.Literal('recorded'), Type.Literal('replayed')]),
  reply: ReplyView,
})
export type SubmitReplyResponse = Static<typeof SubmitReplyResponse>

export function isSubmitReplyResponse(value: unknown): value is SubmitReplyResponse {
  return Value.Check(SubmitReplyResponse, value)
}

/** Empty text still records that the agent read the answer. */
export const AgentAcknowledgementView = Type.Object({
  text: Type.String(),
  created_at: Type.String(),
})
export type AgentAcknowledgementView = Static<typeof AgentAcknowledgementView>

/**
 * Optional body of `POST /api/v1/notifications/:request_id/replies/close`.
 * A capable CLI names why it closes: `deliver` when it collected the answers
 * and will hand them to the agent, `retire` when the question is being retired
 * without delivery. The first recorded disposition wins; a later close never
 * changes it. A close without a body (released CLIs) records none, so answers
 * collected that way cannot be edited after the window closes.
 */
export const CLOSE_DISPOSITIONS = ['deliver', 'retire'] as const
export type CloseDisposition = (typeof CLOSE_DISPOSITIONS)[number]

export const CloseRepliesRequest = Type.Object(
  {
    disposition: Type.Union(CLOSE_DISPOSITIONS.map((value) => Type.Literal(value))),
  },
  { additionalProperties: false },
)
export type CloseRepliesRequestT = Static<typeof CloseRepliesRequest>

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

/**
 * Close response when the close carried a disposition. A close without a body
 * receives exactly `ListRepliesResponse`.
 */
export interface CloseRepliesResponse extends ListRepliesResponse {
  /** The stored disposition, which may be an earlier close's rather than this one's. */
  close_disposition: CloseDisposition | null
  /**
   * The reply selected for delivery to the agent by a `deliver` close: the
   * fenced answer a capable writer claims and hands off. Null when the stored
   * disposition is `retire`, or when the window closed with no reply.
   */
  delivered_reply_seq: number | null
}

/**
 * `POST /api/v1/notifications/:request_id/dismiss` (user auth, server feature
 * `question_dismiss`; no body). Dismisses an open question: its reply window
 * closes now, every device retires it silently as expired, and the agent sees
 * an ordinary window expiry. Idempotent. An answered question, or one whose
 * window already closed, is left exactly as it was: an answer recorded first
 * always wins over a dismissal.
 */
export interface DismissQuestionResponse {
  request_id: string
  /** When the question was dismissed, by this call or an earlier one; null when nothing changed. */
  dismissed_at: string | null
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
    /** Both fields are required together when acknowledging a reported native answer. */
    reply_seq: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    session_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
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

/** Shared grant for uploading media bytes, including sounds and Project avatars. */
export const CreateMediaUploadResponse = Type.Object({
  media_id: ResponseIdentity,
  upload_url: Type.String({ pattern: '^[hH][tT][tT][pP][sS]?://' }),
  /** Headers the client must send unchanged with the PUT upload. */
  upload_headers: Type.Record(Type.String(), Type.String()),
  expires_at: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$' }),
})
export type CreateMediaUploadResponse = Static<typeof CreateMediaUploadResponse>
export const BeginSoundUploadResponse = CreateMediaUploadResponse
export type BeginSoundUploadResponse = CreateMediaUploadResponse

export function isCreateMediaUploadResponse(value: unknown): value is CreateMediaUploadResponse {
  if (!Value.Check(CreateMediaUploadResponse, value)) return false
  try {
    // Permit local HTTP and arbitrary signed hosts, but require a usable URL and headers.
    new Request(value.upload_url, { method: 'PUT', headers: value.upload_headers })
    return Number.isFinite(Date.parse(value.expires_at))
  } catch {
    return false
  }
}

export const SoundView = Type.Object({
  sound_id: Type.String(),
  name: Type.String(),
  duration_ms: Type.Number(),
  content_hash: Type.String(),
  url: Type.String(),
})
export type SoundView = Static<typeof SoundView>

export const ListSoundsResponse = Type.Object({ sounds: Type.Array(SoundView) })
export type ListSoundsResponse = Static<typeof ListSoundsResponse>

export function isSoundView(value: unknown): value is SoundView {
  return Value.Check(SoundView, value)
}

export function isListSoundsResponse(value: unknown): value is ListSoundsResponse {
  return Value.Check(ListSoundsResponse, value)
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
  /** Purpose-written plain text used when the request has no Markdown Body. */
  summary: string
  /** Standalone focused content, always interpreted as Markdown when present. */
  body: string | null
  media: NotificationContentMediaItem[]
  /**
   * The reply questions exactly as accepted, choice descriptions included,
   * or empty for a request that asks nothing. A push leaves the descriptions
   * out when they do not fit; this is where a Companion App gets them.
   */
  questions: QuestionT[]
}

/** Most requests one content batch may name; a Companion App splits a longer list. */
export const NOTIFICATION_CONTENT_BATCH_MAX = 50

/**
 * `POST /api/v1/notifications/content` (user auth; Server Feature
 * `notification_content_batch`): the content of every named request in one
 * exchange, so a screen or refresh costs one request rather than one per row.
 */
export const NotificationContentBatchRequest = Type.Object(
  {
    request_ids: Type.Array(Type.String({ pattern: REQUEST_ID_PATTERN }), {
      minItems: 1,
      maxItems: NOTIFICATION_CONTENT_BATCH_MAX,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
)
export type NotificationContentBatchRequestT = Static<typeof NotificationContentBatchRequest>

export interface NotificationContentBatchResponse {
  /** Content of each named request this Account still holds, in request order. */
  contents: NotificationContentResponse[]
  /**
   * Named requests with no content to return: unknown, another Account's, or
   * deleted by retention. One case, exactly like the single-request 404.
   */
  missing: string[]
}

/**
 * `POST /api/v1/delivery-content` (no Auth Session): the content of the one
 * request a Delivery carried, authorized by the Delivery's `content_token`
 * from the push. This is how a Notification Service Extension, which holds no
 * session, fetches a Body that did not fit in the push and every image
 * preview at arrival. The response is a {@link NotificationContentResponse}.
 */
export const DeliveryContentRequest = Type.Object(
  {
    delivery_id: Type.String({ pattern: '^del_[A-Za-z0-9_-]+$' }),
    content_token: Type.String({ minLength: 16, maxLength: 64 }),
  },
  { additionalProperties: false },
)
export type DeliveryContentRequestT = Static<typeof DeliveryContentRequest>

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

export const ProjectView = Type.Object({
  project_id: Type.String(),
  identifier: Type.String(),
  display_name: Type.Union([Type.String(), Type.Null()]),
  image_media_id: Type.Union([Type.String(), Type.Null()]),
  /** Stable cache identity. Signed URLs are transport capabilities, never cache identity. */
  avatar_revision: Type.String(),
  /** Public generated avatar URL, or a short-lived signed URL for custom media. */
  image_url: Type.Union([Type.String(), Type.Null()]),
  last_seen_at: Type.String(),
})
export type ProjectView = Static<typeof ProjectView>

export const ListProjectsResponse = Type.Object({ projects: Type.Array(ProjectView) })
export type ListProjectsResponse = Static<typeof ListProjectsResponse>

export function isProjectView(value: unknown): value is ProjectView {
  return Value.Check(ProjectView, value)
}

export function isListProjectsResponse(value: unknown): value is ListProjectsResponse {
  return Value.Check(ListProjectsResponse, value)
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
  /** Informational CLI-detected harness; omitted by older services or when unknown. */
  harness?: string
  session_id: string
  label: string
  renamed_by: 'user' | 'agent'
  updated_at: string
}

export interface ListAgentSessionsResponse {
  /**
   * `presence` is additive: servers that predate Session Presence omit it,
   * which a Companion App renders exactly like `unknown`.
   */
  agent_sessions: (AgentSessionView & { presence?: SessionPresenceView })[]
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
