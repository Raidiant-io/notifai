import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { globalConfigDir, personalProjectIdentity } from './config.js'
import { SHIPPED_GUIDANCE } from './guidance-content.js'

/**
 * Layered notification-writing guidance with provenance. Most specific wins,
 * per topic, exactly the discipline config keys follow:
 *
 *   project-local > project > global > shipped default
 *
 * A topic is one Markdown file named `<topic>.md`. A user file replaces the
 * shipped topic of the same name wholesale — their words outrank the default,
 * not annotate it — and a file whose name matches no shipped topic is purely
 * additive house rules. There is no session layer: an instruction given in
 * conversation tunes the session by being followed, not persisted.
 */

export type GuidanceSource =
  | `project-local:${string}`
  | `project:${string}`
  | `global:${string}`
  | 'default'

export interface ResolvedGuidanceTopic {
  name: string
  source: GuidanceSource
  /** One line for lists; user-authored topics describe themselves by content. */
  summary: string
  content: string
}

/**
 * Topic names double as filenames, and the project layer arrives from a
 * repository — untrusted input. Anything that does not match is not a topic,
 * the same way `coerce` drops an unrecognised config value.
 */
export const GUIDANCE_TOPIC_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * One topic is capped at the body limit. Guidance is read into agent context
 * on every session, and a repository could otherwise feed it without bound.
 */
export const GUIDANCE_TOPIC_MAX_BYTES = 16_000

export function globalGuidanceDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(globalConfigDir(env), 'guidance')
}

/** Walk up from cwd looking for `.notifai/guidance` (shared, committed). */
export function findProjectGuidanceDir(startDir: string): string | null {
  let dir = path.resolve(startDir)
  for (;;) {
    const candidate = path.join(dir, '.notifai', 'guidance')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Personal project guidance lives beside the personal project config file,
 * under the user's config home rather than the repository:
 * `$XDG_CONFIG_HOME/notifai/projects/<identity>/guidance`.
 */
export function personalProjectGuidanceDir(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(globalConfigDir(env), 'projects', personalProjectIdentity(cwd), 'guidance')
}

function topicsInDir(dir: string): Map<string, string> {
  const topics = new Map<string, string>()
  if (!existsSync(dir)) return topics
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return topics
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue
    const name = entry.slice(0, -'.md'.length)
    if (!GUIDANCE_TOPIC_PATTERN.test(name)) continue
    topics.set(name, path.join(dir, entry))
  }
  return topics
}

function readTopicFile(filePath: string): string | null {
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  if (content.trim() === '') return null
  if (content.length > GUIDANCE_TOPIC_MAX_BYTES) {
    return `${content.slice(0, GUIDANCE_TOPIC_MAX_BYTES)}\n\n[Truncated: this guidance file exceeds ${GUIDANCE_TOPIC_MAX_BYTES} bytes.]\n`
  }
  return content
}

/**
 * Every effective topic, shipped reading order first, additive user topics
 * after it in name order. Each carries the layer that supplied it.
 */
export function resolveGuidance(options: {
  cwd?: string
  env?: NodeJS.ProcessEnv
}): ResolvedGuidanceTopic[] {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()

  // Ascending precedence: a later layer overwrites an earlier one per topic.
  const layers: { dir: string | null; label: 'global' | 'project' | 'project-local' }[] = [
    { dir: globalGuidanceDir(env), label: 'global' },
    { dir: findProjectGuidanceDir(cwd), label: 'project' },
    { dir: personalProjectGuidanceDir(cwd, env), label: 'project-local' },
  ]

  const winners = new Map<string, { source: GuidanceSource; content: string }>()
  for (const layer of layers) {
    if (layer.dir === null) continue
    for (const [name, filePath] of topicsInDir(layer.dir)) {
      const content = readTopicFile(filePath)
      if (content === null) continue
      winners.set(name, { source: `${layer.label}:${filePath}`, content })
    }
  }

  const resolved: ResolvedGuidanceTopic[] = SHIPPED_GUIDANCE.map((topic) => {
    const override = winners.get(topic.name)
    winners.delete(topic.name)
    return override === undefined
      ? { name: topic.name, source: 'default', summary: topic.summary, content: topic.content }
      : { name: topic.name, source: override.source, summary: topic.summary, content: override.content }
  })
  for (const name of [...winners.keys()].sort()) {
    const extra = winners.get(name)!
    resolved.push({
      name,
      source: extra.source,
      summary: 'User-added guidance',
      content: extra.content,
    })
  }
  return resolved
}
