import { Value } from '@sinclair/typebox/value'
import { rewriteMediaReferences } from './body-images.js'
import {
  NotificationDraft,
  type NotificationDraftT,
  ANDROID_SOUNDS,
  IOS_SOUNDS,
  DESKTOP_SOUNDS,
  INTERRUPTION_LEVELS,
  REPLY_MAX_LENGTH,
  COLLAPSE_KEY_MAX_BYTES,
  MEDIA_MAX_ITEMS,
  NOTIFICATION_IMAGE_MAX_BYTES,
  NOTIFICATION_CONTRACT_FINGERPRINT,
  SESSION_LABEL_MAX_LENGTH,
  type DesktopPlatform,
  type Platform,
} from './notification.js'
import { BODY_MAX_LENGTH, SUMMARY_MAX_LENGTH } from './content.js'
import {
  buildApnsEnvelope,
  CONTENT_TOKEN_LENGTH,
  RECEIPT_TOKEN_LENGTH,
  type ProjectIdentity,
} from './apns.js'
import { buildFcmDataEnvelope } from './fcm.js'

/**
 * Capability Catalog contract. Unsupported fields must produce
 * explicit capability results, never silent loss.
 */

export type FieldStatus = 'supported' | 'unsupported' | 'downgraded'

export interface CapabilityField {
  /** JSON-pointer-ish path inside the draft, e.g. "presentation.title". */
  path: string
  status: FieldStatus
  /** Present when unsupported/downgraded: why the target surface cannot honor it. */
  reason?: string
  constraints?: Record<string, unknown>
}

export interface CapabilityDocument {
  schema_version: number
  platform: Platform
  /** Opaque identity of the complete Notification Request schema this service accepts. */
  notification_contract_fingerprint: string
  /** Provider payload ceiling in bytes; null when no push provider carries the request. */
  payload_limit_bytes: number | null
  sounds: string[]
  interruption_levels: string[]
  fields: CapabilityField[]
}

export const IOS_CAPABILITIES_V1: CapabilityDocument = {
  schema_version: 1,
  platform: 'ios',
  notification_contract_fingerprint: NOTIFICATION_CONTRACT_FINGERPRINT,
  payload_limit_bytes: 4096,
  sounds: [...IOS_SOUNDS],
  interruption_levels: [...INTERRUPTION_LEVELS],
  fields: [
    { path: 'presentation.title', status: 'supported' },
    {
      path: 'presentation.summary',
      status: 'supported',
      constraints: {
        required: true,
        max_length: SUMMARY_MAX_LENGTH,
        format: 'plain_text',
        surfaces: ['banner', 'list', 'focused_fallback'],
      },
    },
    {
      path: 'presentation.body',
      status: 'supported',
      constraints: {
        required: false,
        max_length: BODY_MAX_LENGTH,
        format: 'markdown',
        surface: 'focused',
        remote_images: 'not fetched',
      },
    },
    {
      path: 'source',
      status: 'supported',
      reason: 'session_id is machine-only and never displayed; session_label is the human session name.',
    },
    {
      path: 'reply',
      status: 'supported',
      constraints: {
        max_length: REPLY_MAX_LENGTH,
        action: 'inline text',
        default_window_seconds: 86400,
      },
      reason:
        'Free-text reply is an inline action whose button and placeholder are fixed by the app. Closed-choice answers appear on the expanded notification; the banner never shows choice labels. Choice descriptions and the recommended marker show on the answer controls, never on notification action buttons.',
    },
    {
      path: 'presentation.media',
      status: 'supported',
      constraints: {
        max_items: MEDIA_MAX_ITEMS,
        max_bytes_per_item: NOTIFICATION_IMAGE_MAX_BYTES,
        media_types: ['jpeg', 'png', 'gif'],
        representative: 'first resolvable',
        banner_shows: 'one representative + count',
      },
      reason: 'The first resolvable image is attached to the banner; the full ordered collection remains available in the app.',
    },
    {
      path: 'platform.ios.sound',
      status: 'supported',
      constraints: { allowed: [...IOS_SOUNDS, null], custom: true },
      reason: 'Bundled semantic names, Account custom sound ids/names, or null (silent).',
    },
    { path: 'platform.ios.badge', status: 'supported' },
    { path: 'platform.ios.thread_id', status: 'supported' },
    {
      path: 'platform.ios.category',
      status: 'unsupported',
      reason: 'Caller-selected categories are unsupported; the companion registers fixed, app-owned reply categories.',
    },
    {
      path: 'platform.ios.interruption_level',
      status: 'supported',
      constraints: {
        allowed: [...INTERRUPTION_LEVELS],
        downgraded_values: ['time_sensitive'],
        default: 'active',
      },
      reason:
        'passive and active are supported; time_sensitive is accepted but Time Sensitive breakthrough is unavailable. critical is unsupported.',
    },
    { path: 'platform.ios.relevance_score', status: 'supported' },
    { path: 'platform.ios.target_content_id', status: 'supported' },
    {
      path: 'platform.ios.custom_data',
      status: 'supported',
      constraints: { max_keys: 16, max_value_length: 512, namespace: 'notifai' },
    },
    {
      path: 'icon',
      status: 'unsupported',
      reason: 'iOS has no arbitrary per-notification app-icon field.',
    },
    {
      path: 'sound_file',
      status: 'supported',
      reason: 'Account-owned custom sounds sync into Library/Sounds as notifai-<id>.wav.',
    },
    {
      path: 'localization',
      status: 'unsupported',
      reason: 'The V1 Companion App ships no localization catalogs, so loc-key fields cannot resolve.',
    },
  ],
}

/**
 * The desktop Companion App presents requests in its own Edge over its own
 * connection to the service, so no provider envelope limits the request and
 * the Edge, not the operating system, owns every presentation choice but sound.
 */
const MACOS_IPHONE_ONLY_FIELDS = [
  'badge',
  'thread_id',
  'category',
  'interruption_level',
  'relevance_score',
  'target_content_id',
  'custom_data',
] as const

function desktopCapabilities(platform: DesktopPlatform): CapabilityDocument {
  return {
    schema_version: 1,
    platform,
    notification_contract_fingerprint: NOTIFICATION_CONTRACT_FINGERPRINT,
    payload_limit_bytes: null,
    sounds: [...DESKTOP_SOUNDS],
    interruption_levels: [],
    fields: [
      { path: 'presentation.title', status: 'supported' },
      {
        path: 'presentation.summary',
        status: 'supported',
        constraints: {
          required: true,
          max_length: SUMMARY_MAX_LENGTH,
          format: 'plain_text',
          surfaces: ['island', 'list', 'focused_fallback'],
        },
      },
      {
        path: 'presentation.body',
        status: 'supported',
        constraints: {
          required: false,
          max_length: BODY_MAX_LENGTH,
          format: 'markdown',
          surface: 'focused',
          remote_images: 'not fetched',
        },
      },
      {
        path: 'source',
        status: 'supported',
        reason: 'session_id is machine-only and never displayed; session_label is the human session name.',
      },
      {
        path: 'reply',
        status: 'supported',
        constraints: {
          max_length: REPLY_MAX_LENGTH,
          free_text: 'in the Edge',
          closed_and_multi_question: 'in the Edge',
          default_window_seconds: 86400,
        },
      },
      {
        path: 'presentation.media',
        status: 'supported',
        constraints: {
          max_items: MEDIA_MAX_ITEMS,
          max_bytes_per_item: NOTIFICATION_IMAGE_MAX_BYTES,
          media_types: ['jpeg', 'png', 'gif'],
          representative: 'first resolvable',
        },
      },
      {
        path: `platform.${platform}.sound`,
        status: 'supported',
        constraints: { allowed: [...DESKTOP_SOUNDS, null], custom: true },
        reason: 'Bundled semantic names, Account custom sound ids/names, or null (silent).',
      },
      ...(platform === 'macos'
        ? MACOS_IPHONE_ONLY_FIELDS.map((field) => ({
            path: `platform.macos.${field}`,
            status: 'unsupported' as const,
            reason: 'An iPhone option; the Edge ignores it on the desktop.',
          }))
        : []),
      {
        path: 'icon',
        status: 'unsupported',
        reason: 'The Edge shows the Project avatar, never a per-notification icon.',
      },
      {
        path: 'localization',
        status: 'unsupported',
        reason: 'The desktop Companion App ships no caller-addressable localization catalogs.',
      },
    ],
  }
}

export const MACOS_CAPABILITIES_V1 = desktopCapabilities('macos')
export const WINDOWS_CAPABILITIES_V1 = desktopCapabilities('windows')
export const LINUX_CAPABILITIES_V1 = desktopCapabilities('linux')

/**
 * The first Android versionCode whose notification shows a button per choice.
 * Every build distributed before it (up to 65) opens choice questions in the app.
 */
export const ANDROID_CHOICE_BUTTONS_MIN_APP_BUILD = 66
/** Android shows at most three notification actions. */
export const ANDROID_CHOICE_BUTTONS_MAX_CHOICES = 3

/** Android 6+ with Google Play services, using an application-owned FCM data envelope. */
export const ANDROID_CAPABILITIES_V1: CapabilityDocument = {
  schema_version: 1,
  platform: 'android',
  notification_contract_fingerprint: NOTIFICATION_CONTRACT_FINGERPRINT,
  payload_limit_bytes: 4096,
  sounds: [...ANDROID_SOUNDS],
  interruption_levels: [],
  fields: [
    { path: 'presentation.title', status: 'supported' },
    {
      path: 'presentation.summary',
      status: 'supported',
      constraints: {
        required: true,
        max_length: SUMMARY_MAX_LENGTH,
        format: 'plain_text',
        surfaces: ['banner', 'list', 'focused_fallback'],
      },
    },
    {
      path: 'presentation.body',
      status: 'supported',
      constraints: {
        required: false,
        max_length: BODY_MAX_LENGTH,
        format: 'markdown',
        surface: 'focused',
        remote_images: 'not fetched',
      },
    },
    {
      path: 'source',
      status: 'supported',
      reason: 'session_id is machine-only and never displayed; session_label is the human session name.',
    },
    {
      path: 'reply',
      status: 'supported',
      constraints: {
        free_text: 'native RemoteInput on API 24+; in-app composer on API 23',
        choice_buttons: {
          min_app_build: ANDROID_CHOICE_BUTTONS_MIN_APP_BUILD,
          questions: 1,
          multi_select: false,
          max_choices: ANDROID_CHOICE_BUTTONS_MAX_CHOICES,
          earlier_builds: 'in app',
        },
        closed_and_multi_question: 'in app',
        max_length: REPLY_MAX_LENGTH,
      },
      reason:
        `From app build ${ANDROID_CHOICE_BUTTONS_MIN_APP_BUILD}, one question with one answer and up to ${ANDROID_CHOICE_BUTTONS_MAX_CHOICES} choices shows a notification button per choice; with fewer than ${ANDROID_CHOICE_BUTTONS_MAX_CHOICES} choices an Other… button takes typed words. Earlier builds, multi-select questions, more choices or several questions open the exact question in the app. Choice descriptions and the recommended marker show in the app, never on notification buttons. Free text is always possible in the app.`,
    },
    {
      path: 'presentation.media',
      status: 'downgraded',
      constraints: {
        max_items: MEDIA_MAX_ITEMS,
        max_bytes_per_item: NOTIFICATION_IMAGE_MAX_BYTES,
        media_types: ['jpeg', 'png', 'gif'],
        initial_banner: 'summary',
        representative: 'may update later',
        full_collection: 'in app',
      },
      reason:
        'Android posts the text notification first; a representative image may update it later and the full ordered collection remains in the app.',
    },
    {
      path: 'platform.android.sound',
      status: 'supported',
      constraints: {
        allowed: [...ANDROID_SOUNDS, null],
        custom: true,
        delivery: 'product-owned channels subject to User settings',
      },
      reason: 'Bundled semantic names, Account custom sound ids/names, or null for the quiet channel.',
    },
    {
      path: 'platform.android.thread_id',
      status: 'downgraded',
      reason:
        'Android maps thread_id to a notification group, but final grouping and presentation vary by OS version and device manufacturer.',
    },
    {
      path: 'platform.android.custom_data',
      status: 'supported',
      constraints: { max_keys: 16, max_value_length: 512, namespace: 'notifai' },
    },
    {
      path: 'platform.android.badge',
      status: 'unsupported',
      reason: 'Portable launcher badge counts are unsupported in the first Android Companion App.',
    },
    {
      path: 'platform.android.category',
      status: 'unsupported',
      reason: 'Caller-selected raw notification channels and categories are unsupported.',
    },
    {
      path: 'platform.android.interruption_level',
      status: 'unsupported',
      reason:
        'Caller-selected interruption levels are unsupported; kind, product-owned channels, and User channel settings own attention.',
    },
    {
      path: 'platform.android.relevance_score',
      status: 'unsupported',
      reason: 'Apple relevance scores have no Android contract.',
    },
    {
      path: 'platform.android.target_content_id',
      status: 'unsupported',
      reason: 'Apple target-content identifiers have no Android contract.',
    },
    {
      path: 'icon',
      status: 'unsupported',
      reason: 'The Android Companion App owns one fixed monochrome small icon.',
    },
    {
      path: 'sound_file',
      status: 'supported',
      reason:
        'Account-owned custom sounds ingest through MediaStore; channels are notifai.<kind>.<soundRef>.v1.',
    },
    {
      path: 'localization',
      status: 'unsupported',
      reason: 'The first Android Companion App ships no caller-addressable localization catalogs.',
    },
  ],
}

/**
 * Catalog lookup for validation/help metadata. Version and build are explicit so
 * two binaries on one marketing line may diverge; advertised capabilities, not
 * this document, remain routing authority.
 */
export interface CapabilityRegistry {
  describe(platform: Platform, appVersion?: string, appBuild?: string): CapabilityDocument | null
}

export function createCapabilityRegistry(
  documents: readonly CapabilityDocument[],
): CapabilityRegistry {
  const byPlatform = new Map(documents.map((document) => [document.platform, document]))
  return {
    describe(platform) {
      return byPlatform.get(platform) ?? null
    },
  }
}

/** V1 publishes the client-visible contract for every current Companion surface. */
export const CAPABILITY_DOCUMENTS_V1 = [
  IOS_CAPABILITIES_V1,
  ANDROID_CAPABILITIES_V1,
  MACOS_CAPABILITIES_V1,
  WINDOWS_CAPABILITIES_V1,
  LINUX_CAPABILITIES_V1,
] as const
export const CAPABILITIES_V1 = createCapabilityRegistry(CAPABILITY_DOCUMENTS_V1)

export interface ValidationIssue {
  code: 'invalid_request' | 'unsupported_field' | 'payload_too_large'
  path: string
  message: string
}

export interface CapabilityWarning {
  path: string
  message: string
}

export interface ValidationReport {
  ok: boolean
  errors: ValidationIssue[]
  warnings: CapabilityWarning[]
}

function isCapabilityDocumentList(
  value: CapabilityDocument | readonly CapabilityDocument[],
): value is readonly CapabilityDocument[] {
  return Array.isArray(value)
}

/**
 * Validate a draft against the schema and one or more capability documents. Shared by the
 * CLI (offline pre-flight with the bundled document) and the control plane
 * (authoritative check at submission).
 */
export function validateDraft(
  draft: unknown,
  capabilities: CapabilityDocument | readonly CapabilityDocument[] = IOS_CAPABILITIES_V1,
  options: PayloadEstimateOptions = {},
): ValidationReport {
  const errors: ValidationIssue[] = []
  const warnings: CapabilityWarning[] = []

  if (!Value.Check(NotificationDraft, draft)) {
    for (const err of [...Value.Errors(NotificationDraft, draft)].slice(0, 20)) {
      errors.push({
        code: 'invalid_request',
        path: err.path.replaceAll('/', '.').replace(/^\./, ''),
        message: err.message,
      })
    }
    return { ok: false, errors, warnings }
  }

  const documents: readonly CapabilityDocument[] = isCapabilityDocumentList(capabilities)
    ? capabilities
    : [capabilities]
  const typed = draft as NotificationDraftT

  const collapseKey = typed.delivery.collapse_key
  if (
    collapseKey !== null &&
    new TextEncoder().encode(collapseKey).length > COLLAPSE_KEY_MAX_BYTES
  ) {
    errors.push({
      code: 'invalid_request',
      path: 'delivery.collapse_key',
      message: `Collapse keys must be at most ${COLLAPSE_KEY_MAX_BYTES} UTF-8 bytes.`,
    })
  }

  // Identity rules the schema cannot express. A duplicate id would make an
  // answer ambiguous to the agent; a `multi` flag on a free-text question
  // claims a selection surface that does not exist. Either would reach the
  // device as a question whose answer cannot be trusted or given.
  if (typed.reply !== undefined) {
    const questionIds = new Set<string>()
    for (const [index, question] of typed.reply.questions.entries()) {
      const path = `reply.questions.${index}`
      if (questionIds.has(question.id)) {
        errors.push({
          code: 'invalid_request',
          path,
          message: `Duplicate question id '${question.id}' — ids identify the answer to the agent and must be unique.`,
        })
      }
      questionIds.add(question.id)
      if (question.multi === true && question.choices === undefined) {
        errors.push({
          code: 'invalid_request',
          path: `${path}.multi`,
          message: 'multi is only meaningful on a question with choices.',
        })
      }
      if (question.choices !== undefined) {
        const seen = new Set<string>()
        for (const choice of question.choices) {
          if (seen.has(choice.id)) {
            errors.push({
              code: 'invalid_request',
              path: `${path}.choices`,
              message: `Duplicate choice id '${choice.id}' — ids identify the answer to the agent and must be unique.`,
            })
            break
          }
          seen.add(choice.id)
        }
        // A recommendation singles one answer out; two would be no
        // recommendation at all.
        if (question.choices.filter((choice) => choice.recommended === true).length > 1) {
          errors.push({
            code: 'invalid_request',
            path: `${path}.choices`,
            message: 'Recommend at most one choice per question.',
          })
        }
      }
    }
  }

  // Declaring a question without opening a reply window would render an
  // answering affordance on the device that nothing can satisfy — the user
  // taps, and the answer has nowhere to go. Asking is a thing you do, not a
  // label you apply.
  if (typed.kind === 'question' && typed.reply === undefined) {
    errors.push({
      code: 'invalid_request',
      path: 'kind',
      message:
        "kind: 'question' needs a reply block — a question the user cannot answer is not one. Use `notifai ask`, or send with a reply request.",
    })
  }

  if (typed.source?.session_label !== undefined && typed.source.session_id === undefined) {
    errors.push({
      code: 'invalid_request',
      path: 'source.session_label',
      message: 'An Agent Session label needs an opaque Agent Session id behind it; omit both when identity is unknown.',
    })
  }
  if (
    typed.source?.session_label_source !== undefined &&
    typed.source.session_label === undefined
  ) {
    errors.push({
      code: 'invalid_request',
      path: 'source.session_label_source',
      message: 'Agent Session label provenance is valid only when a label is present.',
    })
  }
  if (
    typed.source?.session_label_previous_source !== undefined &&
    typed.source.session_label_source !== 'semantic'
  ) {
    errors.push({
      code: 'invalid_request',
      path: 'source.session_label_previous_source',
      message: 'A prior fallback may accompany only the semantic label that replaced it.',
    })
  }

  if (typed.presentation.body !== undefined) {
    const body = rewriteMediaReferences(
      typed.presentation.body,
      typed.presentation.media?.map((item) => item.media_id) ?? [],
      { allowPositions: false },
    )
    if (!body.ok) {
      errors.push({ code: 'invalid_request', path: 'presentation.body', message: body.error })
    }
  }

  // How something ended is detail inside `done`; on any other tier it would
  // claim an ending the notification has not had.
  if (typed.lifecycle !== undefined && typed.lifecycle.tier !== 'done') {
    if (typed.lifecycle.state !== undefined) {
      errors.push({
        code: 'invalid_request',
        path: 'lifecycle.state',
        message: "A lifecycle end state is only meaningful with tier: 'done'.",
      })
    }
    if (typed.lifecycle.retires_request_id !== undefined) {
      errors.push({
        code: 'invalid_request',
        path: 'lifecycle.retires_request_id',
        message: "Retiring another request is only meaningful with tier: 'done'.",
      })
    }
  }

  for (const document of documents) {
    if (document.platform === 'ios') {
      const options = typed.platform?.ios
      if (options?.category !== undefined && options.category !== null) {
        errors.push({
          code: 'unsupported_field',
          path: 'platform.ios.category',
          message: findReason(document, 'platform.ios.category'),
        })
      }
    }

    if (document.platform === 'android' && typed.reply !== undefined) {
      const [first] = typed.reply.questions
      const choices = first?.choices
      if (typed.reply.questions.length > 1 || (choices !== undefined && (first?.multi === true || choices.length > ANDROID_CHOICE_BUTTONS_MAX_CHOICES))) {
        warnings.push({
          path: 'reply',
          message:
            `Android presents multi-select, multi-question and more-than-${ANDROID_CHOICE_BUTTONS_MAX_CHOICES}-choice replies in the Companion App rather than as notification buttons.`,
        })
      } else if (choices !== undefined) {
        warnings.push({
          path: 'reply',
          message:
            `Android app builds before ${ANDROID_CHOICE_BUTTONS_MIN_APP_BUILD} present closed-choice replies in the Companion App; later builds show a notification button per choice.`,
        })
      }
    }

    for (const field of document.fields) {
      const value = draftValueAtPath(typed, field.path)
      const downgradedValues = field.constraints?.downgraded_values
      const isDowngradedValue =
        Array.isArray(downgradedValues) && downgradedValues.includes(value)
      if (
        value !== undefined &&
        value !== null &&
        (field.status === 'downgraded' || isDowngradedValue)
      ) {
        warnings.push({
          path: field.path,
          message:
            field.reason ??
            `The field ${field.path} is delivered with reduced behavior on ${document.platform}.`,
        })
      }
    }

    if (document.payload_limit_bytes === null) continue
    const estimated = estimatePayloadBytes(typed, document.platform, options)
    if (estimated > document.payload_limit_bytes) {
      const provider = document.platform === 'android' ? 'FCM' : 'APNs'
      errors.push({
        code: 'payload_too_large',
        path: documents.length === 1 ? 'presentation' : `platform.${document.platform}`,
        message:
          documents.length === 1
            ? `Estimated ${provider} payload is ${estimated} bytes; the limit is ${document.payload_limit_bytes}.`
            : `Estimated ${document.platform} ${provider} payload is ${estimated} bytes; the limit is ${document.payload_limit_bytes}.`,
      })
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

function findReason(capabilities: CapabilityDocument, path: string): string {
  const field = capabilities.fields.find((f) => f.path === path)
  return field?.reason ?? `The field ${path} is not supported on ${capabilities.platform}.`
}

function draftValueAtPath(draft: NotificationDraftT, path: string): unknown {
  let value: unknown = draft
  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null || !(segment in value)) return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

function estimatePayloadBytes(
  draft: NotificationDraftT,
  platform: Platform,
  options: PayloadEstimateOptions,
): number {
  return platform === 'android'
    ? estimateFcmPayloadBytes(draft, options)
    : estimateApnsPayloadBytes(draft, options)
}

/** What a push size estimate assumes about the Project's name and avatar. */
export interface PayloadEstimateOptions {
  /**
   * The Project identity the service will put in the push. Omitted: the
   * longest identity the service allows (a 128-character name, a 500-character
   * signed avatar URL and a 128-character revision), so a draft that fits
   * fits any Project. `null`: none, as for a draft without a Project.
   */
  projectIdentity?: ProjectIdentity | null
}

const ESTIMATED_ENVELOPE_IDS = {
  requestId: 'req_00000000000000000000000000',
  deliveryId: 'del_00000000000000000000000000',
  // Fixed width by construction (a truncated HMAC), so a placeholder reserves
  // exactly the room the real token will take.
  receiptToken: '0'.repeat(RECEIPT_TOKEN_LENGTH),
  // Emitted only when the request has a Body or media; same fixed width.
  contentToken: '0'.repeat(CONTENT_TOKEN_LENGTH),
  // ISO-8601 instants are fixed width, so any date reserves the real send time.
  createdAt: new Date(0),
} as const
const ESTIMATED_MEDIA_URL = 'https://x.invalid/'.padEnd(500, 'a')
/**
 * Longest signed URL the service puts in a push for a custom Project avatar
 * or a media preview. The service sizes a custom avatar with this bound; a
 * generated avatar URL is short and exact.
 */
export const SIGNED_PUSH_URL_MAX_LENGTH = 500
const ESTIMATED_PROJECT_IDENTITY = {
  name: 'n'.padEnd(128, 'n'),
  imageUrl: 'https://x.invalid/'.padEnd(SIGNED_PUSH_URL_MAX_LENGTH, 'a'),
  avatarRevision: 'a'.repeat(128),
} as const

function estimatedIdentity(
  draft: NotificationDraftT,
  options: PayloadEstimateOptions,
): ProjectIdentity | null {
  if (draft.project === undefined) return null
  return options.projectIdentity === undefined ? ESTIMATED_PROJECT_IDENTITY : options.projectIdentity
}

/**
 * Conservative byte accounting for the exact APNs envelope. A fixed-length
 * signed media URL keeps pre-flight validation safe before a real URL exists.
 */
export function estimateApnsPayloadBytes(
  draft: NotificationDraftT,
  options: PayloadEstimateOptions = {},
): number {
  return utf8Length(JSON.stringify(estimatedApnsPayload(draft, options)))
}

function estimatedApnsPayload(
  draft: NotificationDraftT,
  options: PayloadEstimateOptions,
): Record<string, unknown> {
  const envelope = buildApnsEnvelope(
    draft,
    ESTIMATED_ENVELOPE_IDS,
    draft.presentation.media !== undefined ? ESTIMATED_MEDIA_URL : null,
    // A project resolves to a sender name and avatar URL at dispatch; the
    // caller passes the identity it knows, or the worst case is reserved.
    estimatedIdentity(draft, options),
    // ISO-8601 instants are fixed width, so any date reserves the real room.
    draft.reply !== undefined ? new Date(0) : null,
    // Retirement answer context is server-derived and absent from authored drafts.
    null,
    // Reply-enabled requests always carry the immutable server snapshot. Boolean
    // true is the longer JSON representation and therefore the safe estimate.
    draft.reply !== undefined ? { agentAcknowledgementRequired: true } : null,
    // Done-tier syncs may announce acknowledgement availability. The timestamp
    // is fixed width and text is deliberately absent from push envelopes.
    draft.lifecycle?.tier === 'done' ? { createdAt: new Date(0), replyId: 'rpl_00000000000000000000000000' } : null,
  )
  return envelope.payload
}

/** Conservative byte accounting for the exact FCM data map rendered for Android. */
export function estimateFcmPayloadBytes(
  draft: NotificationDraftT,
  options: PayloadEstimateOptions = {},
): number {
  return utf8Length(JSON.stringify(estimatedFcmData(draft, options)))
}

function estimatedFcmData(
  draft: NotificationDraftT,
  options: PayloadEstimateOptions,
  soundHash: string | null = null,
): { notifai: string } {
  const envelope = buildFcmDataEnvelope(
    draft,
    ESTIMATED_ENVELOPE_IDS,
    draft.presentation.media !== undefined ? ESTIMATED_MEDIA_URL : null,
    estimatedIdentity(draft, options),
    draft.reply !== undefined ? new Date(0) : null,
    null,
    draft.reply !== undefined ? { agentAcknowledgementRequired: true } : null,
    draft.lifecycle?.tier === 'done' ? { createdAt: new Date(0), replyId: 'rpl_00000000000000000000000000' } : null,
    soundHash,
  )
  return envelope.data
}

/** Device Installation ids are `dev_` and 16 random bytes in base64url. */
const ESTIMATED_DEVICE_ID = `dev_${'A'.repeat(22)}`
/** Custom sound ids are `snd_` and 16 random bytes in base64url. */
const ESTIMATED_CUSTOM_SOUND = `snd_${'A'.repeat(22)}`
/** A custom sound's content hash: SHA-256 in hex. */
const ESTIMATED_SOUND_HASH = '0'.repeat(64)

/**
 * The size of the push the service sends for this draft, as far as anyone can
 * know before it is sent: the draft with the given Project identity, plus
 * what the service adds after accepting it, each at its longest. That is the
 * device's `device_id`, a custom sound in place of any shipped one (Android
 * also carries its `sound_hash`), an iPhone interruption level from Project
 * settings, and the Agent Session's current label of up to
 * {@link SESSION_LABEL_MAX_LENGTH} characters. The service refuses a draft
 * this puts over the platform's limit, and the CLI checks the same rule
 * before registering a question.
 */
export function estimateDeliveredPayloadBytes(
  draft: NotificationDraftT,
  platform: 'ios' | 'android',
  options: PayloadEstimateOptions = {},
): number {
  const dispatched = withLongestDispatchChanges(draft, platform)
  if (platform === 'android') {
    const data = estimatedFcmData(dispatched, options, ESTIMATED_SOUND_HASH)
    const notifai = { ...(JSON.parse(data.notifai) as Record<string, unknown>), device_id: ESTIMATED_DEVICE_ID }
    return utf8Length(JSON.stringify({ ...data, notifai: JSON.stringify(notifai) }))
  }
  const payload = estimatedApnsPayload(dispatched, options)
  const notifai = payload['notifai'] as Record<string, unknown>
  return utf8Length(JSON.stringify({ ...payload, notifai: { ...notifai, device_id: ESTIMATED_DEVICE_ID } }))
}

/**
 * Bytes a Project identity adds to this draft's push on one platform: what
 * the service reports as `project_identity_push_bytes`. Identity fields are
 * separate keys, so a client can add the reported bytes to an estimate made
 * with `projectIdentity: null`.
 */
export function projectIdentityPushBytes(
  draft: NotificationDraftT,
  platform: 'ios' | 'android',
  projectIdentity: ProjectIdentity | null,
): number {
  if (draft.project === undefined || projectIdentity === null) return 0
  return (
    estimateDeliveredPayloadBytes(draft, platform, { projectIdentity }) -
    estimateDeliveredPayloadBytes(draft, platform, { projectIdentity: null })
  )
}

function withLongestDispatchChanges(
  draft: NotificationDraftT,
  platform: 'ios' | 'android',
): NotificationDraftT {
  const options = draft.platform?.[platform]
  // Silence stays silent; any other sound may resolve to a custom one.
  const sound = options?.sound === null ? null : ESTIMATED_CUSTOM_SOUND
  const platformOptions = platform === 'ios'
    ? {
        ...draft.platform?.ios,
        sound,
        interruption_level: draft.platform?.ios?.interruption_level ?? 'time-sensitive',
      }
    : { ...draft.platform?.android, sound }
  const source = draft.source
  const label = source?.session_label ?? ''
  const longestLabel = 'x'.repeat(SESSION_LABEL_MAX_LENGTH)
  return {
    ...draft,
    platform: { ...draft.platform, [platform]: platformOptions },
    ...(source?.session_id !== undefined
      ? {
          source: {
            ...source,
            // Compared as Android carries it: JSON inside JSON.
            session_label: escapedLength(label) > escapedLength(longestLabel) ? label : longestLabel,
          },
        }
      : {}),
  }
}

function escapedLength(value: string): number {
  return utf8Length(JSON.stringify(JSON.stringify(value)))
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}
