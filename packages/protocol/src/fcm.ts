import { bannerExcerpt } from './content.js'
import { effectiveKind, type NotificationDraftT } from './notification.js'
import type {
  AgentAcknowledgementSync,
  EnvelopeIds,
  ProjectIdentity,
  ReplyMetadata,
  RetirementAnswerContext,
} from './apns.js'

/** Application-owned Android envelope version inside FCM data.notifai. */
export const ANDROID_ENVELOPE_SCHEMA_VERSION = 1

export interface FcmDataEnvelope {
  /** FCM data values are strings; the application envelope is serialized exactly once. */
  data: { notifai: string }
  /** Visible Notification Requests are high priority; silent state sync is normal priority. */
  priority: 'HIGH' | 'NORMAL'
}

/**
 * Pure client-visible FCM data assembly shared by Android payload estimation and
 * the provider renderer. Provider authentication, project ids, and message
 * resource names remain outside this observable envelope.
 */
export function buildFcmDataEnvelope(
  draft: NotificationDraftT,
  ids: EnvelopeIds,
  mediaUrl: string | null,
  projectIdentity: ProjectIdentity | null = null,
  /** Service-owned close time of this request's reply window. */
  replyExpiresAt: Date | null = null,
  retirementAnswerContext: RetirementAnswerContext | null = null,
  replyMetadata: ReplyMetadata | null = null,
  agentAcknowledgementSync: AgentAcknowledgementSync | null = null,
): FcmDataEnvelope {
  const options = draft.platform?.android
  const kind = effectiveKind(draft)
  const excerpt = bannerExcerpt(draft.presentation.body)
  const envelope = {
    schema_version: ANDROID_ENVELOPE_SCHEMA_VERSION,
    request_id: ids.requestId,
    delivery_id: ids.deliveryId,
    ...(ids.receiptToken != null ? { receipt_token: ids.receiptToken } : {}),
    title: draft.presentation.title,
    banner_excerpt: excerpt,
    ...(draft.presentation.subtitle !== undefined
      ? { subtitle: draft.presentation.subtitle }
      : {}),
    // Android always receives the effective value because it selects the
    // product-owned channel even when the author omitted the default kind.
    kind,
    ...(draft.lifecycle !== undefined ? { lifecycle: draft.lifecycle } : {}),
    ...(draft.lifecycle?.tier === 'done' && draft.lifecycle.retires_request_id !== undefined
      ? { retires_request_id: draft.lifecycle.retires_request_id }
      : {}),
    ...(draft.lifecycle?.tier === 'done' && retirementAnswerContext != null
      ? {
          answered_via: retirementAnswerContext.answeredVia,
          ...(retirementAnswerContext.answer !== undefined
            ? { answer: retirementAnswerContext.answer }
            : {}),
        }
      : {}),
    ...(draft.delivery.collapse_key !== null
      ? { collapse_key: draft.delivery.collapse_key }
      : {}),
    ...(draft.project !== undefined ? { project: draft.project } : {}),
    ...(draft.source?.session_id !== undefined
      ? { session_id: draft.source.session_id }
      : {}),
    ...(draft.source?.session_label !== undefined
      ? { session_label: draft.source.session_label }
      : {}),
    ...(draft.source?.harness !== undefined ? { harness: draft.source.harness } : {}),
    ...(draft.source?.branch !== undefined ? { branch: draft.source.branch } : {}),
    ...(draft.source?.worktree !== undefined ? { worktree: draft.source.worktree } : {}),
    ...(projectIdentity?.name != null ? { project_name: projectIdentity.name } : {}),
    ...(projectIdentity?.imageUrl != null
      ? { project_image_url: projectIdentity.imageUrl }
      : {}),
    ...(options?.sound !== undefined ? { sound: options.sound } : {}),
    ...(options?.thread_id !== undefined && options.thread_id !== null
      ? { thread_id: options.thread_id }
      : {}),
    ...(options?.custom_data !== undefined ? { custom_data: options.custom_data } : {}),
    ...(mediaUrl !== null ? { media_url: mediaUrl } : {}),
    ...(draft.presentation.media !== undefined
      ? { media_count: draft.presentation.media.length }
      : {}),
    ...(excerpt !== draft.presentation.body ? { has_full_body: true } : {}),
    ...(draft.reply !== undefined && replyExpiresAt !== null
      ? { reply_expires_at: replyExpiresAt.toISOString() }
      : {}),
    ...(draft.reply !== undefined && replyMetadata != null
      ? { agent_acknowledgement_required: replyMetadata.agentAcknowledgementRequired }
      : {}),
    ...(draft.lifecycle?.tier === 'done' && agentAcknowledgementSync != null
      ? {
          agent_acknowledgement_available: true,
          agent_acknowledgement_created_at: agentAcknowledgementSync.createdAt.toISOString(),
        }
      : {}),
    ...(draft.reply !== undefined ? { questions: draft.reply.questions } : {}),
  }

  return {
    data: { notifai: JSON.stringify(envelope) },
    priority: draft.lifecycle?.tier === 'done' ? 'NORMAL' : 'HIGH',
  }
}
