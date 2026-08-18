import { Type, type Static } from '@sinclair/typebox'
import type { Platform } from './notification.js'

/** Named jobs a client can perform. Per-client advertisement is routing authority. */
export const CLIENT_CAPABILITIES = ['answer', 'agent_acknowledgement'] as const
export type ClientCapability = (typeof CLIENT_CAPABILITIES)[number]

export const ClientCapabilitySchema = Type.Union(
  CLIENT_CAPABILITIES.map((capability) => Type.Literal(capability)),
)

/** Capabilities shipped by this CLI release on authenticated machine traffic. */
export const SHIPPED_CLI_CAPABILITIES = ['agent_acknowledgement'] as const satisfies readonly ClientCapability[]

/** Capabilities shipped by the current Companion App. */
export const SHIPPED_COMPANION_CAPABILITIES = ['answer'] as const satisfies readonly ClientCapability[]

export const CLI_VERSION_HEADER = 'x-notifai-cli-version'
export const CAPABILITIES_HEADER = 'x-notifai-capabilities'

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
export interface SupportAssessment {
  state: SupportState
  reason: SupportReason
  affected_operation: AffectedOperation | null
  recovery_action: RecoveryAction | null
  current_version: string | null
  current_build: string | null
  recommended_version: string | null
  recommended_build: string | null
  minimum_version: string | null
  minimum_build: string | null
  deprecation: string | null
  sunset: string | null
}

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
