import { Type, type Static } from '@sinclair/typebox'
import { BODY_MAX_LENGTH } from './content.js'
import { LIFECYCLE_END_STATES, LIFECYCLE_TIERS } from './lifecycle.js'

/**
 * The common Notification Request envelope, schema_version 1.
 *
 * The public contract never exposes raw provider submission JSON. Provider-owned
 * routing keys, authorization, expiry syntax, and request identifiers remain
 * renderer/implementation concerns and are deliberately absent here.
 */

export const NOTIFICATION_SCHEMA_VERSION = 1

/** Cross-provider collapse identifiers are limited by encoded size, not JavaScript characters. */
export const COLLAPSE_KEY_MAX_BYTES = 64

/** Fixed identifiers registered by the iOS Companion App for inline replies. */
export const REPLY_CATEGORY_ID = 'notifai.reply'
/**
 * Question sets carry their own category so the expanded notification is the
 * answering surface: the content extension renders choices and the secondary
 * typed-answer path.
 */
export const REPLY_CHOICE_CATEGORY_ID = 'notifai.reply.choice'
/**
 * Collapsed-banner copy for closed-choice iPhone notifications. iOS never
 * renders category actions until press-and-hold; this is the discoverability
 * hint. It must never include choice labels or extra request content.
 */
export const CLOSED_CHOICE_BANNER_AFFORDANCE = 'Press and hold to answer'
export const REPLY_ACTION_ID = 'notifai.reply.text'
export const REPLY_MAX_LENGTH = 4000
/** Companion image-attachment ceiling, shared by intake and capabilities. */
export const NOTIFICATION_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const NOTIFICATION_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif'] as const
export type NotificationMediaType = (typeof NOTIFICATION_MEDIA_TYPES)[number]
export const NotificationMediaTypeSchema = Type.Union(
  NOTIFICATION_MEDIA_TYPES.map((mediaType) => Type.Literal(mediaType)),
)

/** Device platforms known to the public contract. Delivery support is registry-owned. */
export const PLATFORMS = ['ios', 'macos', 'android'] as const
export type Platform = (typeof PLATFORMS)[number]
export const PlatformSchema = Type.Union(PLATFORMS.map((platform) => Type.Literal(platform)))

/** Apple platforms that share the APNs envelope contract. */
export const APPLE_PLATFORMS = ['ios', 'macos'] as const
export type ApplePlatform = (typeof APPLE_PLATFORMS)[number]

/** Push providers known to the public contract. Platform routing chooses the adapter. */
export const PROVIDERS = ['apns', 'fcm'] as const
export type Provider = (typeof PROVIDERS)[number]
export const ProviderSchema = Type.Union(PROVIDERS.map((provider) => Type.Literal(provider)))

export const MediaItem = Type.Object(
  {
    media_id: Type.String({ pattern: '^med_[A-Za-z0-9_-]+$' }),
    /** Accessibility and fallback text; also the inline-render fallback. */
    alt: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
)

export const MEDIA_MAX_ITEMS = 8

export const Presentation = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 512 }),
    subtitle: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    /** The one canonical body. Always interpreted as Markdown. */
    body: Type.String({ minLength: 1, maxLength: BODY_MAX_LENGTH }),
    /** Ordered image attachments. Order is meaning: first is representative. */
    media: Type.Optional(Type.Array(MediaItem, { minItems: 1, maxItems: MEDIA_MAX_ITEMS })),
  },
  { additionalProperties: false },
)

export const SESSION_LABEL_MAX_LENGTH = 64

export const SourceContext = Type.Object(
  {
    /** Opaque Agent Session identity. Never rendered in User-facing text. */
    session_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    /** The only Agent Session string a User-facing surface may display. */
    session_label: Type.Optional(
      Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH }),
    ),
    /** Open harness slug, set only when authoritatively known. */
    harness: Type.Optional(
      Type.String({ minLength: 1, maxLength: 32, pattern: '^[a-z][a-z0-9-]*$' }),
    ),
    /** Git branch name; omitted on detached HEAD and outside Git. */
    branch: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    /** Privacy-safe linked-worktree basename, never a filesystem path. */
    worktree: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
)

export const TargetSelector = Type.Union([
  Type.Object({ mode: Type.Literal('all') }, { additionalProperties: false }),
  Type.Object(
    {
      mode: Type.Literal('selected'),
      device_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 64 }),
    },
    { additionalProperties: false },
  ),
])

export const DeliveryPolicy = Type.Object(
  {
    /** 24h default; 0 requests one immediate attempt with no retries. */
    ttl_seconds: Type.Integer({ minimum: 0, maximum: 7 * 24 * 3600, default: 86400 }),
    /** No collapse by default; opting in requests replacement semantics. */
    collapse_key: Type.Union(
      [Type.String({ minLength: 1, maxLength: COLLAPSE_KEY_MAX_BYTES }), Type.Null()],
      { default: null },
    ),
  },
  { additionalProperties: false },
)

/**
 * One answer in a closed question. The id is the agent-facing token — stable,
 * machine-checkable, and never shown to the user; the label is the human text
 * rendered on the button.
 */
export const ReplyChoice = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 32, pattern: '^[a-z0-9][a-z0-9_-]*$' }),
    label: Type.String({ minLength: 1, maxLength: 40 }),
  },
  { additionalProperties: false },
)
export type ReplyChoiceT = Static<typeof ReplyChoice>

/** Upper bound on choices in one question. */
export const REPLY_MAX_CHOICES = 6

/** A reply window cannot outlive retained Notification Request content. */
export const REPLY_MAX_WINDOW_SECONDS = 72 * 3600

/** Upper bound on questions in one notification. */
export const REPLY_MAX_QUESTIONS = 10

/**
 * One question must be readable in full on the surface that offers the answers,
 * which is a notification the user reads at a glance. This bound sits under the
 * banner excerpt so a question always fits the surface it arrives on; longer
 * context follows it in the canonical Markdown body.
 */
export const QUESTION_TEXT_MAX_LENGTH = 240

/**
 * One question in a reply request. With `choices` it is a closed question
 * answered by id; without, a free-text question. A typed answer remains possible
 * either way, so an agent must be prepared to receive text where it offered a
 * token.
 */
export const Question = Type.Object(
  {
    /** Agent-facing token naming this question inside the set. */
    id: Type.String({ minLength: 1, maxLength: 32, pattern: '^[a-z0-9][a-z0-9_-]*$' }),
    text: Type.String({ minLength: 1, maxLength: QUESTION_TEXT_MAX_LENGTH }),
    choices: Type.Optional(
      Type.Array(ReplyChoice, { minItems: 2, maxItems: REPLY_MAX_CHOICES }),
    ),
    /** The user may select several choices. Only meaningful with `choices`. */
    multi: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)
export type QuestionT = Static<typeof Question>

/** Opt-in reply channel. Presence enables the reply action. */
export const ReplyRequest = Type.Object(
  {
    /** How long the server accepts a reply for this Notification Request. */
    expires_in_seconds: Type.Integer({
      minimum: 60,
      maximum: REPLY_MAX_WINDOW_SECONDS,
      default: 86400,
    }),
    /** What is being asked, in order. */
    questions: Type.Array(Question, { minItems: 1, maxItems: REPLY_MAX_QUESTIONS }),
  },
  { additionalProperties: false },
)

/** Product-owned semantic sound names shared by current Companion Apps. */
export const SEMANTIC_SOUNDS = ['default', 'done', 'attention', 'alert'] as const
/** Semantic sound names shipped by the iOS Companion App. */
export const IOS_SOUNDS = SEMANTIC_SOUNDS
/** Semantic sound names shipped by the macOS Companion App. */
export const MACOS_SOUNDS = SEMANTIC_SOUNDS
/** Semantic sound names shipped by the Android Companion App. */
export const ANDROID_SOUNDS = SEMANTIC_SOUNDS
/** A semantic sound name a Companion App can play. */
export type IosSound = (typeof IOS_SOUNDS)[number]
export type MacosSound = (typeof MACOS_SOUNDS)[number]
export type AndroidSound = (typeof ANDROID_SOUNDS)[number]
/** CLI spelling adds `none` for the contract's explicit silent (`null`) value. */
export const CLI_SOUNDS = [...SEMANTIC_SOUNDS, 'none'] as const

export const INTERRUPTION_LEVELS = ['passive', 'active', 'time_sensitive'] as const

export const IosOptions = Type.Object(
  {
    /** A bundled semantic sound name, or null (silent). */
    sound: Type.Optional(Type.Union([...IOS_SOUNDS.map((sound) => Type.Literal(sound)), Type.Null()])),
    badge: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    thread_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
    /** Caller-selected categories are unsupported; companions own their fixed reply categories. */
    category: Type.Optional(Type.Null()),
    interruption_level: Type.Optional(
      Type.Union(INTERRUPTION_LEVELS.map((level) => Type.Literal(level))),
    ),
    relevance_score: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()])),
    target_content_id: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    ),
    /** Namespaced, size-bounded custom data delivered under the `notifai` key. */
    custom_data: Type.Optional(
      Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }), Type.String({ maxLength: 512 }), {
        maxProperties: 16,
      }),
    ),
  },
  { additionalProperties: false },
)

/** macOS UserNotifications options carried in the shared APNs alert envelope. */
export const MacosOptions = Type.Object(
  {
    sound: Type.Optional(Type.Union([...MACOS_SOUNDS.map((sound) => Type.Literal(sound)), Type.Null()])),
    badge: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    thread_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
    /** Caller-selected categories are unsupported; companions own their fixed reply categories. */
    category: Type.Optional(Type.Null()),
    interruption_level: Type.Optional(
      Type.Union(INTERRUPTION_LEVELS.map((level) => Type.Literal(level))),
    ),
    relevance_score: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()])),
    target_content_id: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    ),
    /** Namespaced custom data delivered under the `notifai` key. */
    custom_data: Type.Optional(
      Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }), Type.String({ maxLength: 512 }), {
        maxProperties: 16,
      }),
    ),
  },
  { additionalProperties: false },
)

/** Android options the first native Companion App actually honors. */
export const AndroidOptions = Type.Object(
  {
    /** A product-owned semantic channel sound, or null for the quiet channel. */
    sound: Type.Optional(
      Type.Union([...ANDROID_SOUNDS.map((sound) => Type.Literal(sound)), Type.Null()]),
    ),
    /** Explicit notification group key; final grouping remains Android/OEM-owned. */
    thread_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
    /** Namespaced, size-bounded custom data inside the application-owned FCM envelope. */
    custom_data: Type.Optional(
      Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }), Type.String({ maxLength: 512 }), {
        maxProperties: 16,
      }),
    ),
  },
  { additionalProperties: false },
)

/** Sender-chosen Project identifier slug. */
export const PROJECT_IDENTIFIER_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$'

/** Sender-declared position on the lifecycle axis. */
export const Lifecycle = Type.Object(
  {
    tier: Type.Union(LIFECYCLE_TIERS.map((tier) => Type.Literal(tier))),
    state: Type.Optional(Type.Union(LIFECYCLE_END_STATES.map((state) => Type.Literal(state)))),
    /** The request id of the question this `done` draft retires. */
    retires_request_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
)
export type LifecycleT = Static<typeof Lifecycle>

/**
 * What kind of thing this notification is. Kept closed so Companion Apps can
 * treat each value semantically rather than printing a sender-invented word.
 */
export const NOTIFICATION_KINDS = [
  /** Ordinary news. The default, and the honest answer most of the time. */
  'update',
  /** Asks the user something. Implied by a `reply` block. */
  'question',
  /** A body of work finished successfully. */
  'done',
  /** Work reached a terminal unsuccessful outcome. */
  'failed',
  /** Work cannot proceed, and no User reply would resume it. */
  'blocked',
] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

/** Absent means `update`: a send that says nothing about itself is news. */
export const DEFAULT_NOTIFICATION_KIND: NotificationKind = 'update'

/** A reply block is a question by construction, whatever kind was supplied. */
export function effectiveKind(draft: NotificationDraftT): NotificationKind {
  if (draft.reply !== undefined) return 'question'
  return draft.kind ?? DEFAULT_NOTIFICATION_KIND
}

/**
 * The sound each kind arrives with when nobody chose one.
 *
 * Kind states what happened; this table turns that truth into the attention it
 * deserves, so an honest sender gets the right sound without reasoning about
 * audio. A caller's explicit sound and the user's saved preference both outrank
 * it — this is the floor, not a ceiling.
 *
 * It also closes the abuse this vocabulary used to invite: when kind drove
 * nothing, an agent could keep a failure quiet by calling it `done`. Now that
 * kind carries attention, the only rule an agent needs is to declare the kind
 * that is true.
 */
export const DEFAULT_SOUND_BY_KIND: Readonly<Record<NotificationKind, IosSound>> = {
  update: 'default',
  question: 'attention',
  done: 'done',
  failed: 'alert',
  blocked: 'attention',
}

/** The sound a kind arrives with absent an explicit choice. */
export function defaultSoundForKind(kind: NotificationKind): IosSound {
  return DEFAULT_SOUND_BY_KIND[kind]
}

export const NotificationDraft = Type.Object(
  {
    schema_version: Type.Literal(NOTIFICATION_SCHEMA_VERSION),
    /** What this notification is. Absent means `update`. */
    kind: Type.Optional(Type.Union(NOTIFICATION_KINDS.map((kind) => Type.Literal(kind)))),
    /** What this notification wants from the user. Absent means `new`. */
    lifecycle: Type.Optional(Lifecycle),
    /** Optional Project identity; lazily recorded server-side. */
    project: Type.Optional(Type.String({ pattern: PROJECT_IDENTIFIER_PATTERN })),
    /** Structured provenance; opaque ids remain machine-only. */
    source: Type.Optional(SourceContext),
    presentation: Presentation,
    targets: TargetSelector,
    delivery: DeliveryPolicy,
    reply: Type.Optional(ReplyRequest),
    platform: Type.Optional(
      Type.Object(
        {
          ios: Type.Optional(IosOptions),
          macos: Type.Optional(MacosOptions),
          android: Type.Optional(AndroidOptions),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

export type MediaItemT = Static<typeof MediaItem>
export type SourceContextT = Static<typeof SourceContext>
export type DeliveryPolicyT = Static<typeof DeliveryPolicy>
export type ReplyRequestT = Static<typeof ReplyRequest>
export type IosOptionsT = Static<typeof IosOptions>
export type MacosOptionsT = Static<typeof MacosOptions>
export type AndroidOptionsT = Static<typeof AndroidOptions>
export type NotificationDraftT = Static<typeof NotificationDraft>

export function defaultDeliveryPolicy(): DeliveryPolicyT {
  return { ttl_seconds: 86400, collapse_key: null }
}
