import {
  COLLAPSE_KEY_MAX_BYTES,
  rewriteMediaReferences,
  INTERRUPTION_LEVELS,
  MEDIA_MAX_ITEMS,
  NOTIFICATION_SCHEMA_VERSION,
  CHOICE_DESCRIPTION_MAX_LENGTH,
  QUESTION_TEXT_MAX_LENGTH,
  SUMMARY_MAX_LENGTH,
  type AndroidOptionsT,
  type IosOptionsT,
  type LifecycleT,
  type DesktopOptionsT,
  type MediaItemT,
  type NotificationDraftT,
  NOTIFICATION_KINDS,
  isDesktopPlatform,
  PLATFORMS,
  type Platform,
  type QuestionT,
  type ReplyChoiceT,
  type SourceContextT,
  type SubmissionReceipt,
} from '@raidiant/notifai-protocol'
import type { CliConfig } from './config.js'
import { isCliSoundRef, unknownSoundMessage } from './sound-ref.js'

export interface SendFlags {
  title: string
  /** Purpose-written plain text for native banners and notification lists. */
  summary: string
  /** Optional standalone focused content. Always interpreted as Markdown. */
  body?: string
  /** What this notification is; absent means update. */
  kind?: string
  project?: string
  /** Deliberately omit Project identity even when config or cwd could supply one. */
  projectless?: boolean
  /** Opaque exact Agent Session override. */
  sessionId?: string
  /** Human-readable Agent Session label override. */
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
  /**
   * This draft is a question. Not a user-facing flag: `ask` and the hooks set
   * it; `send` cannot ask.
   */
  reply?: boolean
  /**
   * How long the server accepts an answer after submission. Not a user-facing
   * flag: a held `ask --wait` ends its window at the wait's deadline; every
   * other question keeps `reply_window_seconds`.
   */
  replyWindow?: number
  /**
   * Answer labels; turns the question into a closed one. One occurrence per
   * label, always — a label is a label, whatever characters it contains.
   */
  choice?: string[]
  /** One-line consequence of each choice, attached to the `--choice` before it. */
  choiceDescription?: ChoiceDescriptionInput[]
  /** Exact label of the choice the sender recommends. */
  recommended?: string[]
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

export { rewriteMediaReferences } from '@raidiant/notifai-protocol'

/**
 * Where a send note starts. Measured on local transcripts (2026-10-22): the
 * median Summary was 153 characters and the 90th percentile 196; the 90th
 * percentile Body was 1,310 characters. Every Body over eight lines already
 * had Markdown structure, so structure gets no note.
 */
export const SUMMARY_NOTE_LENGTH = 200
export const BODY_NOTE_LENGTH = 1_500

/** A non-blocking stderr note for the agent's next notification; never a refusal. */
export function contentLengthNotes(summary: string, body: string | undefined): string[] {
  const notes: string[] = []
  const summaryLength = Array.from(summary).length
  if (summaryLength >= SUMMARY_NOTE_LENGTH) {
    notes.push(`Note: this Summary is ${summaryLength} characters. A banner shows about one short sentence: write your next Summary as one.`)
  }
  const bodyLength = body === undefined ? 0 : Array.from(body).length
  if (bodyLength > BODY_NOTE_LENGTH) {
    notes.push(`Note: this Body is ${bodyLength} characters. Write your next Body shorter: the result, what the User needs to do, and a list where it helps.`)
  }
  return notes
}

/** Merge flags over resolved config into a Notification Request draft. */
/**
 * The title of a question that reached registration without one and without an
 * Agent Session name to take: only a harness form the agent opened itself in a
 * session that carries no Source Context. It never copies the question.
 */
export const UNTITLED_FORM_TITLE = 'Question'

export function buildDraft(
  config: CliConfig,
  flags: SendFlags,
  invocation: DraftInvocation = {},
): DraftBuild {
  if (!flags.title || !flags.summary || flags.summary.trim() === '') {
    return { ok: false, error: 'Both --title and --summary are required.' }
  }
  if (Array.from(flags.summary).length > SUMMARY_MAX_LENGTH) {
    return {
      ok: false,
      error: `--summary must be at most ${SUMMARY_MAX_LENGTH} Unicode characters.`,
    }
  }
  if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(flags.summary)) {
    return { ok: false, error: '--summary must be one line of plain text.' }
  }
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
  const body =
    flags.body === undefined
      ? undefined
      : rewriteMediaReferences(flags.body, imageIds)
  if (body !== undefined && !body.ok) return body

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

  // Explicit --sound and the saved sound key outrank kind. The server is the
  // one that applies kind, Project, and Account maps — stamping a kind default
  // here would look like an explicit choice and skip those layers. `none` is
  // still silent.
  const sound = flags.sound !== undefined ? flags.sound : config.sound.value
  if (sound !== null && sound !== undefined && !isCliSoundRef(sound)) {
    return {
      ok: false,
      error: unknownSoundMessage(sound),
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

  if (
    isDesktopPlatform(platform) &&
    ((level !== null && level !== undefined) || flags.threadId !== undefined || flags.data?.length)
  ) {
    return {
      ok: false,
      error:
        'The desktop Companion App takes only a sound. Remove --level, --thread-id and --data, or unset the configured interruption_level; the Edge owns every other presentation choice.',
    }
  }

  const appleOptions: IosOptionsT = {}
  const androidOptions: AndroidOptionsT = {}
  const desktopOptions: DesktopOptionsT = {}
  if (sound === 'none') {
    appleOptions.sound = null
    androidOptions.sound = null
    desktopOptions.sound = null
  } else if (sound !== null && sound !== undefined) {
    appleOptions.sound = sound
    androidOptions.sound = sound
    desktopOptions.sound = sound
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

  if (flags.projectless === true && flags.project !== undefined) {
    return { ok: false, error: 'Choose either --project or --projectless, not both.' }
  }
  const project = flags.projectless === true
    ? undefined
    : flags.project ?? config.project.value ?? invocation.inferredProject

  // Ids are derived from labels so an agent writing a one-liner does not have
  // to invent them, but they stay the stable thing it branches on afterwards.
  const parsedChoices = parseChoices(flags.choice, {
    ...(flags.choiceDescription !== undefined ? { descriptions: flags.choiceDescription } : {}),
    ...(flags.recommended !== undefined ? { recommended: flags.recommended } : {}),
  })
  if (!parsedChoices.ok) return parsedChoices
  const choices = parsedChoices.choices
  if (flags.multi && choices === null && flags.questions === undefined) {
    return { ok: false, error: '--multi needs answers to select between; add --choice.' }
  }
  if (
    flags.reply &&
    flags.questions === undefined &&
    Array.from(flags.summary).length > QUESTION_TEXT_MAX_LENGTH
  ) {
    return {
      ok: false,
      error:
        `Keep the question within ${QUESTION_TEXT_MAX_LENGTH} characters and put ` +
        'the longer explanation in the optional Markdown Body.',
    }
  }

  const hasAppleOptions = Object.keys(appleOptions).length > 0
  const hasAndroidOptions = Object.keys(androidOptions).length > 0
  const hasDesktopOptions = Object.keys(desktopOptions).length > 0
  let platformOptions: NonNullable<NotificationDraftT['platform']> | undefined
  if (flags.platform === undefined) {
    if (hasAppleOptions || hasAndroidOptions || hasDesktopOptions) {
      platformOptions = {
        ...(hasAppleOptions ? { ios: appleOptions } : {}),
        ...(hasAndroidOptions ? { android: androidOptions } : {}),
        ...(hasDesktopOptions
          ? { macos: desktopOptions, windows: desktopOptions, linux: desktopOptions }
          : {}),
      }
    }
  } else if (platform === 'android') {
    if (hasAndroidOptions) platformOptions = { android: androidOptions }
  } else if (isDesktopPlatform(platform)) {
    if (hasDesktopOptions) platformOptions = { [platform]: desktopOptions }
  } else if (hasAppleOptions) {
    platformOptions = { ios: appleOptions }
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
      summary: flags.summary,
      ...(body !== undefined ? { body: body.body } : {}),
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
                text: flags.summary,
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

/** One `--choice-description` occurrence and how many `--choice` flags preceded it. */
export interface ChoiceDescriptionInput {
  after: number
  text: string
}

/** What a closed question may say about its choices beyond their labels. */
export interface ChoiceDetails {
  /** `--choice-description` occurrences in command-line order. */
  descriptions?: ChoiceDescriptionInput[]
  /** `--recommended` values: the exact label of the recommended choice. */
  recommended?: string[]
}

/**
 * One flag occurrence, one answer: `--choice Staging --choice Production` ->
 * `[{id:'staging',label:'Staging'}, ...]`.
 *
 * Commas are ordinary characters. The old single-value comma split produced
 * buttons the agent never intended ("Nothing, I'll review" became two answers)
 * and nothing downstream could detect it, so the delimiter form is gone
 * rather than guarded: a label is a label.
 *
 * A description belongs to the `--choice` written just before it, so a
 * description can never drift onto a neighbour; anything ambiguous is refused.
 * The recommended choice is named by its exact label.
 */
export function parseChoices(
  value: string[] | undefined,
  details: ChoiceDetails = {},
): { ok: true; choices: ReplyChoiceT[] | null } | { ok: false; error: string } {
  const descriptions = details.descriptions ?? []
  const recommended = details.recommended ?? []
  if (value === undefined || value.length === 0) {
    if (descriptions.length > 0) return { ok: false, error: '--choice-description describes a --choice; add the choices.' }
    if (recommended.length > 0) return { ok: false, error: '--recommended names a --choice; add the choices.' }
    return { ok: true, choices: null }
  }
  const labels = value.map((part) => part.trim())
  if (labels.some((label) => label.length === 0) || labels.length < 2 || labels.length > 6) {
    return { ok: false, error: CHOICE_USAGE }
  }
  const choices: ReplyChoiceT[] = labels.map((label) => ({ id: slugify(label), label }))
  if (choices.some((choice) => choice.id === '')) return { ok: false, error: CHOICE_USAGE }
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length) return { ok: false, error: CHOICE_USAGE }

  for (const { after, text } of descriptions) {
    const choice = choices[after - 1]
    if (choice === undefined || choice.description !== undefined) return { ok: false, error: CHOICE_DESCRIPTION_USAGE }
    const description = oneLine(text)
    if (description === '' || [...description].length > CHOICE_DESCRIPTION_MAX_LENGTH) {
      return {
        ok: false,
        error: `A choice description is one line of plain text, at most ${CHOICE_DESCRIPTION_MAX_LENGTH} characters: say what choosing it does.`,
      }
    }
    choice.description = description
  }

  if (recommended.length > 1) return { ok: false, error: 'Recommend at most one choice: pass --recommended once.' }
  if (recommended.length === 1) {
    const choice = choices.find((entry) => entry.label === recommended[0]!.trim())
    if (choice === undefined) {
      return { ok: false, error: `--recommended ${JSON.stringify(recommended[0])} must repeat one --choice label exactly.` }
    }
    choice.recommended = true
  }
  return { ok: true, choices }
}

/** Whitespace runs, line breaks included, become single spaces. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** Message shared by every surface that accepts choice labels. */
export const CHOICE_USAGE =
  'Offer 2-6 answers, one --choice flag per answer, unique once slugified — ' +
  'e.g. --choice "Yes, ship it" --choice "Not yet".'

const CHOICE_DESCRIPTION_USAGE =
  'Put each --choice-description right after the --choice it describes, at most one per choice — ' +
  'e.g. --choice "Deploy now" --choice-description "Two minutes of downtime." --choice "Wait".'

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}
