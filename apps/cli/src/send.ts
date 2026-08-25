import {
  CLI_SOUNDS,
  COLLAPSE_KEY_MAX_BYTES,
  INTERRUPTION_LEVELS,
  MEDIA_MAX_ITEMS,
  NOTIFICATION_SCHEMA_VERSION,
  QUESTION_TEXT_MAX_LENGTH,
  bannerExcerpt,
  type AndroidOptionsT,
  type IosOptionsT,
  type LifecycleT,
  type MacosOptionsT,
  type MediaItemT,
  type NotificationDraftT,
  NOTIFICATION_KINDS,
  DEFAULT_NOTIFICATION_KIND,
  defaultSoundForKind,
  type NotificationKind,
  PLATFORMS,
  type Platform,
  type QuestionT,
  type SourceContextT,
  type SubmissionReceipt,
} from '@raidiant/notifai-protocol'
import type { CliConfig } from './config.js'

type CliSound = (typeof CLI_SOUNDS)[number]

export interface SendFlags {
  title: string
  /** The one canonical Markdown body. */
  body: string
  subtitle?: string
  /** What this notification is; absent means update. */
  kind?: string
  project?: string
  /** Opaque exact-session override. */
  sessionId?: string
  /** Human-readable session label override. */
  sessionLabel?: string
  device?: string[]
  all?: boolean
  ttl?: number
  collapseKey?: string
  sound?: string
  threadId?: string
  /** Apple interruption level; null is reserved for internal callers that must suppress config. */
  level?: string | null
  data?: string[]
  /** Ready media ids in author-supplied order. Commands resolve paths and URLs first. */
  image?: string[]
  /** Optional alt text paired with images by position. */
  imageAlt?: string[]
  /**
   * Complete canonical media manifest for internal callers that already froze
   * uploads and alt text. Mutually exclusive with the CLI's parallel inputs.
   */
  media?: MediaItemT[]
  /** Enable the inline reply action for this Notification Request. */
  reply?: boolean
  /** How long the server accepts a reply after submission. */
  replyWindow?: number
  /**
   * Answer labels; turns the reply into a closed question. One flag occurrence
   * per label, always — a label is a label, whatever characters it contains.
   */
  choice?: string[]
  /** The user may select several of the offered answers. */
  multi?: boolean
  /**
   * A full question set, overriding the single question the flags describe.
   * Not a user-facing flag: `ask --form` and the hooks build it.
   */
  questions?: QuestionT[]
  /** Platform whose optional notification fields these flags configure. */
  platform?: string
  /**
   * Lifecycle position of this send; not a user-facing flag. Hooks set it so
   * questions and their retirements ride the wire as what they are.
   */
  lifecycle?: LifecycleT
  /**
   * Allow the two-character sequence backslash-n to be sent as visible text.
   * Without this, a likely accidental escaped newline is refused.
   */
  literalBackslashN?: boolean
}

/** A backslash-n pair that was not itself escaped as a literal backslash. */
const ACCIDENTAL_ESCAPED_NEWLINE = /(?:^|[^\\])\\n/

export function hasAccidentalEscapedNewlines(body: string): boolean {
  return ACCIDENTAL_ESCAPED_NEWLINE.test(body)
}

export function accidentalEscapedNewlineMessage(): string {
  return [
    'This body contains the two-character sequence \\n, which is sent literally and shows as \\n on the device.',
    'To send a real line break, pass a multiline --body or --body-file -.',
    'If you meant the visible characters \\n, pass --literal-backslash-n.',
  ].join('\n')
}

export function rejectAccidentalEscapedNewlines(
  body: string | undefined,
  allowLiteral: boolean | undefined,
): string | null {
  if (allowLiteral === true || body === undefined) return null
  return hasAccidentalEscapedNewlines(body) ? accidentalEscapedNewlineMessage() : null
}

export type DraftBuild =
  | { ok: true; draft: NotificationDraftT; platform: Platform }
  | { ok: false; error: string }

/** Invocation-derived values beneath explicit and configured author input. */
export interface DraftInvocation {
  inferredProject?: string | null
  source?: SourceContextT
}

const POSITIONAL_MEDIA_REFERENCE = /media:(\d+)(?![A-Za-z0-9_-])/g

/** Validate media cardinality and positional alt pairing before any upload starts. */
export function validateMediaInputs(
  images: readonly string[] | undefined,
  alts: readonly string[] | undefined,
): string | null {
  const imageCount = images?.length ?? 0
  const imageAlts = alts ?? []
  if (imageCount > MEDIA_MAX_ITEMS) return `Attach at most ${MEDIA_MAX_ITEMS} images.`
  if (imageAlts.length > imageCount) {
    return `Received ${imageAlts.length} --image-alt values for ${imageCount} --image values.`
  }
  if (imageAlts.some((alt) => alt.length < 1 || alt.length > 256)) {
    return '--image-alt must be 1-256 characters.'
  }
  return null
}

/** Validate a frozen value-object manifest without collapsing sparse alt text. */
function validateMediaManifest(media: readonly MediaItemT[]): string | null {
  if (media.length > MEDIA_MAX_ITEMS) return `Attach at most ${MEDIA_MAX_ITEMS} images.`
  if (media.some((item) => item.alt !== undefined && (item.alt.length < 1 || item.alt.length > 256))) {
    return 'Media alt text must be 1-256 characters.'
  }
  return null
}

/** Rewrite authorable 1-based media positions to canonical ready media ids. */
export function rewriteMediaReferences(
  body: string,
  mediaIds: readonly string[],
): { ok: true; body: string } | { ok: false; error: string } {
  let error: string | undefined
  const rewritten = body.replace(POSITIONAL_MEDIA_REFERENCE, (reference, digits: string) => {
    const position = Number(digits)
    if (
      !Number.isSafeInteger(position) ||
      position < 1 ||
      position > MEDIA_MAX_ITEMS ||
      digits !== String(position) ||
      mediaIds[position - 1] === undefined
    ) {
      error = `Body reference "${reference}" has no matching --image occurrence.`
      return reference
    }
    return `media:${mediaIds[position - 1]}`
  })
  return error === undefined ? { ok: true, body: rewritten } : { ok: false, error }
}

/** Merge flags over resolved config into a Notification Request draft. */
export function buildDraft(
  config: CliConfig,
  flags: SendFlags,
  invocation: DraftInvocation = {},
): DraftBuild {
  if (!flags.title || !flags.body) return { ok: false, error: 'Both --title and --body are required.' }
  const platform = resolvePlatform(flags.platform)
  if (!platform) {
    return { ok: false, error: `Unknown platform "${flags.platform}" — use ${PLATFORMS.join(' or ')}.` }
  }

  if (flags.media !== undefined && (flags.image !== undefined || flags.imageAlt !== undefined)) {
    return { ok: false, error: 'Internal media manifests cannot be combined with --image or --image-alt.' }
  }
  const imageIds = flags.media?.map((item) => item.media_id) ?? flags.image ?? []
  const imageAlts = flags.imageAlt ?? []
  const mediaInputError =
    flags.media === undefined
      ? validateMediaInputs(imageIds, imageAlts)
      : validateMediaManifest(flags.media)
  if (mediaInputError !== null) return { ok: false, error: mediaInputError }
  const media =
    flags.media ??
    imageIds.map((media_id, index) => ({
      media_id,
      ...(imageAlts[index] !== undefined ? { alt: imageAlts[index] } : {}),
    }))
  const body = rewriteMediaReferences(flags.body, imageIds)
  if (!body.ok) return body

  const deviceIds = flags.all ? null : (flags.device?.length ? flags.device : config.devices.value)
  const targets: NotificationDraftT['targets'] =
    deviceIds && deviceIds.length > 0 ? { mode: 'selected', device_ids: deviceIds } : { mode: 'all' }

  if (
    flags.kind !== undefined &&
    !NOTIFICATION_KINDS.includes(flags.kind as (typeof NOTIFICATION_KINDS)[number])
  ) {
    return {
      ok: false,
      error: `Unknown kind "${flags.kind}" — supported: ${NOTIFICATION_KINDS.map((kind) => `"${kind}"`).join(', ')}.`,
    }
  }

  // Kind states what happened; the sound table turns that truth into the
  // attention it deserves, so an honest sender gets the right sound without
  // reasoning about audio. An explicit --sound and the user's saved preference
  // both outrank it, and `none` still means silent.
  const kindForSound: NotificationKind = flags.reply
    ? 'question'
    : ((flags.kind as NotificationKind | undefined) ?? DEFAULT_NOTIFICATION_KIND)
  const sound = flags.sound ?? config.sound.value ?? defaultSoundForKind(kindForSound)
  if (sound !== null && sound !== undefined && !CLI_SOUNDS.includes(sound as CliSound)) {
    return {
      ok: false,
      error: `Unknown sound "${sound}" — supported: ${CLI_SOUNDS.map((value) => `"${value}"`).join(', ')}.`,
    }
  }
  const level =
    flags.level !== undefined ? flags.level : config.interruption_level.value
  if (
    level !== null &&
    level !== undefined &&
    !INTERRUPTION_LEVELS.includes(level as (typeof INTERRUPTION_LEVELS)[number])
  ) {
    return { ok: false, error: `Unknown interruption level "${level}".` }
  }
  if (platform === 'android' && level !== null && level !== undefined) {
    return {
      ok: false,
      error:
        'Android does not support caller-selected interruption levels. Remove --level or unset the configured interruption_level; kind, notification channels, and device settings own attention on Android.',
    }
  }

  const appleOptions: IosOptionsT & MacosOptionsT = {}
  const androidOptions: AndroidOptionsT = {}
  if (sound === 'none') {
    appleOptions.sound = null
    androidOptions.sound = null
  } else if (sound !== null && sound !== undefined) {
    const semanticSound = sound as Exclude<(typeof CLI_SOUNDS)[number], 'none'>
    appleOptions.sound = semanticSound
    androidOptions.sound = semanticSound
  }
  if (flags.threadId !== undefined) {
    appleOptions.thread_id = flags.threadId
    androidOptions.thread_id = flags.threadId
  }
  if (level !== null && level !== undefined) {
    appleOptions.interruption_level = level as (typeof INTERRUPTION_LEVELS)[number]
  }
  if (flags.data?.length) {
    const data: Record<string, string> = {}
    for (const pair of flags.data) {
      const eq = pair.indexOf('=')
      if (eq <= 0) return { ok: false, error: `--data expects key=value, got "${pair}".` }
      data[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    appleOptions.custom_data = data
    androidOptions.custom_data = data
  }

  const ttl = flags.ttl ?? config.ttl_seconds.value
  const collapse = flags.collapseKey ?? config.collapse_key.value
  if (
    collapse !== null &&
    collapse !== undefined &&
    Buffer.byteLength(collapse, 'utf8') > COLLAPSE_KEY_MAX_BYTES
  ) {
    return {
      ok: false,
      error: `--collapse-key must be at most ${COLLAPSE_KEY_MAX_BYTES} UTF-8 bytes.`,
    }
  }

  const project = flags.project ?? config.project.value ?? invocation.inferredProject

  // Ids are derived from labels so an agent writing a one-liner does not have
  // to invent them, but they stay the stable thing it branches on afterwards.
  const choices = parseChoices(flags.choice)
  if (choices === 'invalid') {
    return {
      ok: false,
      error: CHOICE_USAGE,
    }
  }
  if (flags.multi && choices === null && flags.questions === undefined) {
    return { ok: false, error: '--multi needs answers to select between; add --choice.' }
  }
  // A single reply question is the first readable block of the canonical body.
  // Context may follow after a blank line without changing what the user answers.
  const derivedQuestion = bannerExcerpt(body.body).split('\n', 1)[0]!.trim()
  if (
    flags.reply &&
    flags.questions === undefined &&
    derivedQuestion.length > QUESTION_TEXT_MAX_LENGTH
  ) {
    return {
      ok: false,
      error:
        `Keep the question within ${QUESTION_TEXT_MAX_LENGTH} characters and put ` +
        'the longer context after a blank line — the first paragraph is the question.',
    }
  }

  const hasAppleOptions = Object.keys(appleOptions).length > 0
  const hasAndroidOptions = Object.keys(androidOptions).length > 0
  let platformOptions: NonNullable<NotificationDraftT['platform']> | undefined
  if (flags.platform === undefined) {
    if (hasAppleOptions || hasAndroidOptions) {
      platformOptions = {
        ...(hasAppleOptions ? { ios: appleOptions, macos: appleOptions } : {}),
        ...(hasAndroidOptions ? { android: androidOptions } : {}),
      }
    }
  } else if (platform === 'android') {
    if (hasAndroidOptions) platformOptions = { android: androidOptions }
  } else if (hasAppleOptions) {
    platformOptions =
      platform === 'ios' ? { ios: appleOptions } : { macos: appleOptions }
  }

  const draft: NotificationDraftT = {
    schema_version: NOTIFICATION_SCHEMA_VERSION,
    ...(flags.kind !== undefined
      ? { kind: flags.kind as (typeof NOTIFICATION_KINDS)[number] }
      : {}),
    ...(flags.lifecycle !== undefined ? { lifecycle: flags.lifecycle } : {}),
    ...(project !== null && project !== undefined ? { project } : {}),
    ...(invocation.source !== undefined ? { source: invocation.source } : {}),
    presentation: {
      title: flags.title,
      body: body.body,
      ...(flags.subtitle !== undefined ? { subtitle: flags.subtitle } : {}),
      ...(media.length > 0 ? { media } : {}),
    },
    targets,
    delivery: { ttl_seconds: ttl, collapse_key: collapse },
    ...(flags.reply
      ? {
          reply: {
            expires_in_seconds: flags.replyWindow ?? config.reply_window_seconds.value,
            questions: flags.questions ?? [
              {
                id: 'q1',
                text: derivedQuestion,
                ...(choices !== null ? { choices } : {}),
                ...(flags.multi ? { multi: true } : {}),
              },
            ],
          },
        }
      : {}),
    ...(platformOptions !== undefined ? { platform: platformOptions } : {}),
  }
  return { ok: true, draft, platform }
}

function resolvePlatform(value: string | undefined): Platform | null {
  if (value === undefined) return 'ios'
  return (PLATFORMS as readonly string[]).includes(value) ? (value as Platform) : null
}

/** Human one-screen receipt summary; agents use --json instead. */
export function formatReceipt(receipt: SubmissionReceipt): string {
  const lines: string[] = []
  const overall =
    receipt.overall === 'provider_accepted_all'
      ? 'accepted by the push provider for every device'
      : receipt.overall === 'provider_accepted_partial'
        ? 'accepted for some devices'
        : receipt.overall === 'provider_rejected_all'
          ? 'rejected for every device'
          : 'still in flight'
  lines.push(`request ${receipt.request_id}${receipt.replayed ? ' (replayed)' : ''}: ${overall}`)
  for (const d of receipt.deliveries) {
    const detail = d.provider_reason ? ` (${d.provider_reason})` : ''
    lines.push(`  ${d.device_name}: ${d.state}${detail}`)
  }
  lines.push(
    `  device receipt is not assessed here; run notifai status ${receipt.request_id} for Companion Receipt evidence`,
  )
  for (const w of receipt.warnings) lines.push(`  warning ${w.path}: ${w.message}`)
  return lines.join('\n')
}

/** Stable exit codes: 0 ok/pending, 1 rejected everywhere. */
export function receiptExitCode(receipt: SubmissionReceipt): number {
  return receipt.overall === 'provider_rejected_all' ? 1 : 0
}

/**
 * One flag occurrence, one answer: `--choice Staging --choice Production` ->
 * `[{id:'staging',label:'Staging'}, ...]`.
 *
 * Commas are ordinary characters. The old single-value comma split produced
 * buttons the agent never intended ("Nothing, I'll review" became two answers)
 * and nothing downstream could detect it, so the delimiter form is gone
 * rather than guarded: a label is a label.
 */
export function parseChoices(
  value: string[] | undefined,
): { id: string; label: string }[] | null | 'invalid' {
  if (value === undefined || value.length === 0) return null
  const labels = value.map((part) => part.trim()).filter((part) => part.length > 0)
  if (labels.length < 2 || labels.length > 6) return 'invalid'
  const choices = labels.map((label) => ({ id: slugify(label), label }))
  if (choices.some((choice) => choice.id === '')) return 'invalid'
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length) return 'invalid'
  return choices
}

/** Message shared by every surface that accepts choice labels. */
export const CHOICE_USAGE =
  'Offer 2-6 answers, one --choice flag per answer, unique once slugified — ' +
  'e.g. --choice "Yes, ship it" --choice "Not yet".'

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}
