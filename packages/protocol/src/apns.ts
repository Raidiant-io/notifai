import { bannerExcerpt } from './content.js'
import {
  DEFAULT_NOTIFICATION_KIND,
  effectiveKind,
  REPLY_CATEGORY_ID,
  REPLY_CHOICE_CATEGORY_ID,
  type NotificationDraftT,
  type Platform,
} from './notification.js'

export interface ApnsEnvelope {
  payload: Record<string, unknown>
  /** APNs priority derived from the selected platform interruption level. */
  priority: 10 | 5
  /** Background is the silent state sync of a `done` lifecycle draft. */
  pushType: 'alert' | 'background'
}

/** Dispatch-time Project identity resolved by the service. */
export interface ProjectIdentity {
  /** User-facing sender name; companions fall back to the identifier. */
  name?: string | null
  /** Generated public or custom signed avatar URL the extension can fetch. */
  imageUrl?: string | null
}

/** What a companion needs to name this Delivery back to the service. */
export interface EnvelopeIds {
  requestId: string
  deliveryId: string
  receiptToken?: string | null
}

/** Service-owned metadata for the original reply-enabled Notification Request. */
export interface ReplyMetadata {
  /** Immutable account-preference snapshot taken at request acceptance. */
  agentAcknowledgementRequired: boolean
}

/** Metadata for a silent sync emitted after an Agent Acknowledgement exists. */
export interface AgentAcknowledgementSync {
  /** Creation time of the persisted acknowledgement; its text never enters APNs. */
  createdAt: Date
}

/** Service-derived context carried by a done-tier retirement. */
export interface RetirementAnswerContext {
  answeredVia: string
  answer?: string
}

/** Encoded width of the per-Delivery receipt token. */
export const RECEIPT_TOKEN_LENGTH = 22

/** Pure APNs payload assembly shared by rendering and client-side size estimation. */
export function buildApnsEnvelope(
  draft: NotificationDraftT,
  ids: EnvelopeIds,
  mediaUrl: string | null,
  platform: Platform = 'ios',
  projectIdentity: ProjectIdentity | null = null,
  /** Service-owned close time of this request's reply window. */
  replyExpiresAt: Date | null = null,
  retirementAnswerContext: RetirementAnswerContext | null = null,
  replyMetadata: ReplyMetadata | null = null,
  agentAcknowledgementSync: AgentAcknowledgementSync | null = null,
): ApnsEnvelope {
  const options = draft.platform?.[platform]
  if (draft.lifecycle?.tier === 'done') {
    return {
      payload: {
        aps: { 'content-available': 1, 'mutable-content': 1 },
        notifai: notifaiKey(
          draft,
          ids,
          mediaUrl,
          projectIdentity,
          replyExpiresAt,
          options,
          retirementAnswerContext,
          replyMetadata,
          agentAcknowledgementSync,
        ),
      },
      priority: 5,
      pushType: 'background',
    }
  }

  const aps: Record<string, unknown> = {
    alert: {
      title: draft.presentation.title,
      ...(draft.presentation.subtitle !== undefined ? { subtitle: draft.presentation.subtitle } : {}),
      body: bannerExcerpt(draft.presentation.body),
    },
  }
  if (options?.sound !== null) {
    const sound = options?.sound ?? 'default'
    aps['sound'] = sound === 'default' ? 'default' : `${sound}.caf`
  }
  if (options?.badge !== undefined && options.badge !== null) aps['badge'] = options.badge
  if (options?.thread_id !== undefined && options.thread_id !== null) aps['thread-id'] = options.thread_id
  aps['interruption-level'] = options?.interruption_level ?? 'active'
  if (options?.relevance_score !== undefined && options.relevance_score !== null) {
    aps['relevance-score'] = options.relevance_score
  }
  if (options?.target_content_id !== undefined && options.target_content_id !== null) {
    aps['target-content-id'] = options.target_content_id
  }
  if (draft.reply !== undefined) {
    const [first] = draft.reply.questions
    const usesCard = draft.reply.questions.length > 1 || first?.choices !== undefined
    aps['category'] = usesCard ? REPLY_CHOICE_CATEGORY_ID : REPLY_CATEGORY_ID
  }
  // Every alert reaches the Notification Service Extension so closed-app
  // history capture does not depend on the presence of media or Project identity.
  aps['mutable-content'] = 1

  return {
    payload: {
      aps,
      notifai: notifaiKey(
        draft,
        ids,
        mediaUrl,
        projectIdentity,
        replyExpiresAt,
        options,
        retirementAnswerContext,
        replyMetadata,
        agentAcknowledgementSync,
      ),
    },
    priority: options?.interruption_level === 'passive' ? 5 : 10,
    pushType: 'alert',
  }
}

/** The custom `notifai` payload key shared by alert and silent state syncs. */
function notifaiKey(
  draft: NotificationDraftT,
  ids: EnvelopeIds,
  mediaUrl: string | null,
  projectIdentity: ProjectIdentity | null,
  replyExpiresAt: Date | null,
  options?: NonNullable<NotificationDraftT['platform']>[Platform],
  retirementAnswerContext?: RetirementAnswerContext | null,
  replyMetadata?: ReplyMetadata | null,
  agentAcknowledgementSync?: AgentAcknowledgementSync | null,
): Record<string, unknown> {
  const kind = effectiveKind(draft)
  const excerpt = bannerExcerpt(draft.presentation.body)
  return {
    request_id: ids.requestId,
    delivery_id: ids.deliveryId,
    ...(ids.receiptToken != null ? { receipt_token: ids.receiptToken } : {}),
    ...(draft.event !== undefined ? { event: draft.event } : {}),
    ...(kind !== DEFAULT_NOTIFICATION_KIND ? { kind } : {}),
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
    ...(draft.delivery.collapse_key !== null ? { collapse_key: draft.delivery.collapse_key } : {}),
    ...(draft.project !== undefined ? { project: draft.project } : {}),
    ...(draft.source?.session_id !== undefined ? { session_id: draft.source.session_id } : {}),
    ...(draft.source?.session_label !== undefined ? { session_label: draft.source.session_label } : {}),
    ...(draft.source?.harness !== undefined ? { harness: draft.source.harness } : {}),
    ...(draft.source?.branch !== undefined ? { branch: draft.source.branch } : {}),
    ...(draft.source?.worktree !== undefined ? { worktree: draft.source.worktree } : {}),
    ...(projectIdentity?.name != null ? { project_name: projectIdentity.name } : {}),
    ...(projectIdentity?.imageUrl != null ? { project_image_url: projectIdentity.imageUrl } : {}),
    ...(options?.custom_data !== undefined ? { data: options.custom_data } : {}),
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
}
