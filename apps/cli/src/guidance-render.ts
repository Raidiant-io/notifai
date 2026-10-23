import { Buffer } from 'node:buffer'
import { describeSource } from './config-schema.js'
import { AGENT_TERMS_FALLBACK, AGENT_TERMS_PREAMBLE, GUIDANCE_TRUST_PREAMBLE, SHIPPED_GUIDANCE } from './guidance-content.js'
import { resolveGuidance, type GuidanceAuthority, type ResolvedGuidanceTopic } from './guidance.js'

const AUTHORITY_LABEL: Record<GuidanceAuthority, string> = {
  user: 'you',
  shipped: 'shipped default',
}

const MARKER_TOKEN = 'notifai:guidance'

export function markerSafe(content: string): string {
  return content.replaceAll(MARKER_TOKEN, `${MARKER_TOKEN.replace(':', '-')} [not a provenance marker]`)
}

/** Render provenance exactly once for both the command and lifecycle hooks. */
export function renderGuidance(topics: readonly ResolvedGuidanceTopic[]): string {
  const blocks = topics.map((topic) => {
    const { path: filePath } = describeSource(topic.source)
    const marker =
      `<!-- ${MARKER_TOKEN} topic=${topic.name} from=${AUTHORITY_LABEL[topic.authority]}` +
      `${filePath === null ? '' : ` file=${encodeURIComponent(filePath)}`} -->`
    return `${marker}\n${markerSafe(topic.content).trimEnd()}`
  })
  return [GUIDANCE_TRUST_PREAMBLE, AGENT_TERMS_PREAMBLE, ...blocks].join('\n\n')
}

/**
 * Hard ceiling for model-visible lifecycle context, including the User's
 * topics and notices. Codex's default hook-output spill threshold is 10,000
 * bytes. Staying at or below it keeps the context inline without adding a hook
 * field that changes the User-approved handler identity.
 */
export const GUIDANCE_CONTEXT_MAX_BYTES = 10_000

/**
 * Topics read just before the first Notification Request rather than carried
 * from the start of every session. They decide how a notification is written,
 * and most sessions never write one; `when-to-notify` and `questions` decide
 * whether one is due, so they stay in session context.
 */
export const FIRST_USE_TOPICS: readonly string[] = ['titles', 'content', 'acknowledgements']

export interface LifecycleGuidance {
  content: string
  /** Topics the content leaves out; it always names them for the agent. */
  omitted: string[]
}

const quotedNames = (names: readonly string[]): string => {
  const quoted = names.map((name) => `\`${name}\``)
  return quoted.length <= 2 ? quoted.join(' and ') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`
}

function firstUsePointer(deferred: readonly string[], extra: readonly string[]): string {
  const missing = extra.length === 0
    ? ''
    : ` The ${extra.length === 1 ? 'topic' : 'topics'} ${quotedNames(extra)} did not fit here either, so read ` +
      'that output before deciding whether to notify, not only before writing.'
  return '# Before your first Notification Request or acknowledgement\n\n' +
    `Run \`notifai guidance\` once and follow it: it adds ${quotedNames(deferred)}, which decide how each is written.` +
    missing
}

const OVERFLOW_FALLBACK =
  'The guidance topics are too long to include here. Before deciding whether or how to notify, ' +
  'run `notifai guidance` once in this session. Do not infer or partially follow the omitted topics.'

/**
 * The guidance a root Agent Session carries from its start, within `maxBytes`.
 *
 * Writing topics wait for first use (`FIRST_USE_TOPICS`). When the rest does
 * not fit, topics outside the shipped set go first, then everything but the
 * trust preamble and terms. Whatever is left out is named, with the command
 * that prints it, so an agent never mistakes part of the guidance for all of it.
 */
export function lifecycleGuidance(options: {
  cwd: string
  env: NodeJS.ProcessEnv
  maxBytes?: number
}): LifecycleGuidance {
  const maxBytes = options.maxBytes ?? GUIDANCE_CONTEXT_MAX_BYTES
  const topics = resolveGuidance(options)
  const deferred = topics.filter((topic) => FIRST_USE_TOPICS.includes(topic.name)).map((topic) => topic.name)
  const inline = topics.filter((topic) => !FIRST_USE_TOPICS.includes(topic.name))
  const shipped = new Set(SHIPPED_GUIDANCE.map((topic) => topic.name))
  const fits = (text: string): boolean => Buffer.byteLength(text, 'utf8') <= maxBytes
  const compose = (kept: readonly ResolvedGuidanceTopic[], extra: readonly string[]): string =>
    `${renderGuidance(kept)}\n\n${firstUsePointer(deferred, extra)}`

  const complete = compose(inline, [])
  if (fits(complete)) return { content: complete, omitted: deferred }
  const extra = inline.filter((topic) => !shipped.has(topic.name)).map((topic) => topic.name)
  const core = compose(inline.filter((topic) => shipped.has(topic.name)), extra)
  if (extra.length > 0 && fits(core)) return { content: core, omitted: [...deferred, ...extra] }
  return {
    content: `${GUIDANCE_TRUST_PREAMBLE}\n\n${AGENT_TERMS_FALLBACK}\n\n${OVERFLOW_FALLBACK}`,
    omitted: topics.map((topic) => topic.name),
  }
}
