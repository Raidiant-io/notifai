import { Type, type Static } from '@sinclair/typebox'
import type { Platform } from './notification.js'

/**
 * Named jobs a client can perform. Per-client advertisement is routing authority.
 *
 * - `session_attendance` (CLI): runs a Session Attendant that holds an Agent
 *   Session's presence lease and hands Session Messages into it.
 * - `session_attendance_batch` (server only): one exchange may attend many
 *   Agent Sessions at once (`POST /api/v1/agent-sessions/attendance`). A CLI
 *   uses the batch only when the server lists it.
 * - `session_notes` / `answer_edits` (Companion App): writes Session Notes and
 *   Answer Edits and reads their state. An app advertises these only after
 *   `GET /api/v1/features` lists the matching Server Feature, because a server
 *   that predates them rejects an unknown advertised capability.
 * - `harness_answers` (CLI): records agent-reported harness submissions and
 *   scoped acknowledgements. Server support does not prove local native UI
 *   settlement or the provenance of a User interaction.
 * - `session_stopped_hold` (server only): attendance accepts `stopped` and a
 *   `continued` end, and a stopped Agent Session holds Session Notes and
 *   post-read Answer Edits until it is reopened. A CLI sends either only when
 *   the server lists it.
 * - `question_dismiss` (server only): the User can dismiss an open question
 *   from a Companion App. Listed as a Server Feature of the same name.
 * - `notification_content_batch` (server only): one exchange returns the
 *   content of many Notification Requests. Listed as a Server Feature of the
 *   same name.
 * - `session_confirmed_end` (server only): accepts `end_reason: 'closed'`
 *   only for positive close evidence. Unqualified legacy ends preserve inputs.
 * - `session_continued_successor` (server only): a `continued` end may name
 *   a successor the server has not seen yet, such as a fork that has not
 *   notified; the server creates it for this machine. Without it, a CLI names
 *   only a successor the server already knows.
 */
export const CLIENT_CAPABILITIES = [
  'answer',
  'agent_acknowledgement',
  'session_attendance',
  'session_attendance_batch',
  'session_notes',
  'machine_approval',
  'answer_edits',
  'harness_answers',
  'session_stopped_hold',
  'question_dismiss',
  'session_continued_successor',
  'session_confirmed_end',
  'notification_content_batch',
] as const
export type ClientCapability = (typeof CLIENT_CAPABILITIES)[number]

export const ClientCapabilitySchema = Type.Union(
  CLIENT_CAPABILITIES.map((capability) => Type.Literal(capability)),
)

/**
 * Capabilities shipped by this CLI release on authenticated machine traffic.
 * Every command advertises the same set, so a machine's recorded inventory does
 * not flip between an attendant exchange and an ordinary send.
 */
export const SHIPPED_CLI_CAPABILITIES = [
  'agent_acknowledgement',
  'session_attendance',
] as const satisfies readonly ClientCapability[]

/** Capabilities shipped by the current Companion App. */
export const SHIPPED_COMPANION_CAPABILITIES = ['answer'] as const satisfies readonly ClientCapability[]

export const CLI_VERSION_HEADER = 'x-notifai-cli-version'
export const CAPABILITIES_HEADER = 'x-notifai-capabilities'
/** The complete Notification Request contract this client will submit. */
export const NOTIFICATION_CONTRACT_HEADER = 'x-notifai-notification-contract'

export const SUPPORT_STATES = ['current', 'update_available', 'must_update'] as const
export type SupportState = (typeof SUPPORT_STATES)[number]

export const SUPPORT_REASONS = [
  'current',
  'newer_release',
  'sunset_scheduled',
  'minimum_not_met',
  'capability_unavailable',
] as const
export type SupportReason = (typeof SUPPORT_REASONS)[number]

/** Closed actions. A server never supplies the command or destination itself. */
export const RECOVERY_ACTIONS = ['update_cli', 'update_companion', 'wait_for_service'] as const
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number]

export const AFFECTED_OPERATIONS = [
  'send_notifications',
  'receive_notifications',
  'answer_questions',
  'agent_acknowledgements',
] as const
export type AffectedOperation = (typeof AFFECTED_OPERATIONS)[number]

/** Machine-readable support result. Human surfaces map this to the closed local copy. */
export const SupportAssessment = Type.Object({
  state: Type.Union(SUPPORT_STATES.map((value) => Type.Literal(value))),
  reason: Type.Union(SUPPORT_REASONS.map((value) => Type.Literal(value))),
  affected_operation: Type.Union([Type.Union(AFFECTED_OPERATIONS.map((value) => Type.Literal(value))), Type.Null()]),
  recovery_action: Type.Union([Type.Union(RECOVERY_ACTIONS.map((value) => Type.Literal(value))), Type.Null()]),
  current_version: Type.Union([Type.String(), Type.Null()]),
  current_build: Type.Union([Type.String(), Type.Null()]),
  recommended_version: Type.Union([Type.String(), Type.Null()]),
  recommended_build: Type.Union([Type.String(), Type.Null()]),
  minimum_version: Type.Union([Type.String(), Type.Null()]),
  minimum_build: Type.Union([Type.String(), Type.Null()]),
  deprecation: Type.Union([Type.String(), Type.Null()]),
  sunset: Type.Union([Type.String(), Type.Null()]),
})
export type SupportAssessment = Static<typeof SupportAssessment>

export interface PlatformSupportPolicyView {
  platform: Platform
  recommended_version: string | null
  recommended_build: string | null
  minimum_receive_build: string | null
  minimum_answer_build: string | null
  deprecation: string | null
  sunset: string | null
  replacement_available: boolean
  rollout_complete: boolean
}

export interface CompatibilityResponse {
  cli: SupportAssessment
  platforms: PlatformSupportPolicyView[]
  server_capabilities: ClientCapability[]
}

export const CapabilityAdvertisement = Type.Array(ClientCapabilitySchema, {
  maxItems: CLIENT_CAPABILITIES.length,
  uniqueItems: true,
})
export type CapabilityAdvertisementT = Static<typeof CapabilityAdvertisement>

export const DEVICE_DERIVED_STATUSES = [
  'must_update',
  'cannot_answer',
  'permission_setup',
  'working',
] as const
export type DeviceDerivedStatus = (typeof DEVICE_DERIVED_STATUSES)[number]

export type MachineDerivedStatus = 'must_update' | 'working'

export interface FeatureUnavailableDetails {
  affected_operation: AffectedOperation
  missing_capabilities: ClientCapability[]
  device_ids?: string[]
  device_names?: string[]
}
