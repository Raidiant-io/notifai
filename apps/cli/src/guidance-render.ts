import { Buffer } from 'node:buffer'
import { describeSource } from './config-schema.js'
import { AGENT_TERMS_FALLBACK, AGENT_TERMS_PREAMBLE, GUIDANCE_TRUST_PREAMBLE } from './guidance-content.js'
import { resolveGuidance, type GuidanceAuthority, type ResolvedGuidanceTopic } from './guidance.js'

const AUTHORITY_LABEL: Record<GuidanceAuthority, string> = {
  user: 'you',
  repository: 'this repository',
  shipped: 'shipped default',
}

const MARKER_TOKEN = 'notifai:guidance'

function markerSafe(content: string): string {
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

/** Hard ceiling for model-visible lifecycle context, including repository topics. */
export const GUIDANCE_CONTEXT_MAX_BYTES = 24_000

export type BoundedGuidance =
  | { ok: true; content: string; bytes: number }
  | { ok: false; fallback: string; bytes: number; max_bytes: number }

export function boundedEffectiveGuidance(options: {
  cwd: string
  env: NodeJS.ProcessEnv
  maxBytes?: number
}): BoundedGuidance {
  const content = renderGuidance(resolveGuidance(options))
  const bytes = Buffer.byteLength(content, 'utf8')
  const maxBytes = options.maxBytes ?? GUIDANCE_CONTEXT_MAX_BYTES
  if (bytes <= maxBytes) return { ok: true, content, bytes }
  return {
    ok: false,
    bytes,
    max_bytes: maxBytes,
    fallback:
      `${GUIDANCE_TRUST_PREAMBLE}\n\n${AGENT_TERMS_FALLBACK}\n\n` +
      `Notifai guidance is ${bytes} bytes, above the ${maxBytes}-byte lifecycle limit. ` +
      'Before deciding whether or how to notify, run `notifai guidance` once in this session. ' +
      'Do not infer or partially follow the omitted topics.',
  }
}
