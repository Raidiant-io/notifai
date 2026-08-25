import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  type Dirent,
} from 'node:fs'
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
 *
 * Two of those layers are the User's own word and one is not. `global` and
 * `project-local` live under the User's config home: only they can write
 * there. `project` is `.notifai/guidance` inside the repository, so it
 * arrives with a clone and is written by whoever wrote the repository —
 * which may be nobody the User has ever met. It remains authoritative about
 * *how this project's notifications should read*, because shared house rules
 * are the feature; it is never the User speaking. `authority` carries that
 * distinction to every reader so a cloned repository cannot borrow the
 * User's voice.
 */

export type GuidanceSource =
  | `project-local:${string}`
  | `project:${string}`
  | `global:${string}`
  | 'default'

/**
 * Who is speaking in a topic.
 *
 * - `user` — the User's own standing word, from a location only they can write.
 * - `repository` — this checkout's shared house rules; committed content, and
 *   therefore untrusted input that speaks for the project, not the User.
 * - `shipped` — the default that applies when nobody said otherwise.
 */
export type GuidanceAuthority = 'user' | 'repository' | 'shipped'

export interface ResolvedGuidanceTopic {
  name: string
  source: GuidanceSource
  authority: GuidanceAuthority
  /** One line for lists; user-authored topics describe themselves by content. */
  summary: string
  content: string
}

export function guidanceAuthority(source: GuidanceSource): GuidanceAuthority {
  if (source === 'default') return 'shipped'
  return source.startsWith('project:') ? 'repository' : 'user'
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

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

/** Walk up from cwd looking for `.notifai/guidance` (shared, committed). */
export function findProjectGuidanceDir(startDir: string): string | null {
  let dir = path.resolve(startDir)
  for (;;) {
    const candidate = path.join(dir, '.notifai', 'guidance')
    if (existsSync(candidate)) {
      try {
        // A clone may contain symlinks. Repository guidance may read only
        // regular content rooted in that repository; it must never turn a
        // local private file into model context by pointing outside the tree.
        const candidateStat = lstatSync(candidate)
        const repositoryRoot = realpathSync(dir)
        const resolved = realpathSync(candidate)
        if (candidateStat.isDirectory() && isWithin(repositoryRoot, resolved)) return candidate
      } catch {
        // An unreadable or unstable candidate is not guidance. Keep walking.
      }
    }
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
  let entries: Dirent[]
  try {
    if (!lstatSync(dir).isDirectory()) return topics
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return topics
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    // In particular, refuse symlinks. A committed link to a User-owned file
    // must not make that file part of repository guidance output.
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const name = entry.name.slice(0, -'.md'.length)
    if (!GUIDANCE_TOPIC_PATTERN.test(name)) continue
    topics.set(name, path.join(dir, entry.name))
  }
  return topics
}

function readTopicFile(filePath: string): string | null {
  let descriptor: number | null = null
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    if (!fstatSync(descriptor).isFile()) return null
    const bytes = Buffer.alloc(GUIDANCE_TOPIC_MAX_BYTES + 1)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    const truncated = offset > GUIDANCE_TOPIC_MAX_BYTES
    const content = bytes.subarray(0, Math.min(offset, GUIDANCE_TOPIC_MAX_BYTES)).toString('utf8')
    if (content.trim() === '') return null
    return truncated
      ? `${content}\n\n[Truncated: this guidance file exceeds ${GUIDANCE_TOPIC_MAX_BYTES} bytes.]\n`
      : content
  } catch {
    return null
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
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
      ? {
          name: topic.name,
          source: 'default' as const,
          authority: 'shipped' as const,
          summary: topic.summary,
          content: topic.content,
        }
      : {
          name: topic.name,
          source: override.source,
          authority: guidanceAuthority(override.source),
          summary: topic.summary,
          content: override.content,
        }
  })
  for (const name of [...winners.keys()].sort()) {
    const extra = winners.get(name)!
    const authority = guidanceAuthority(extra.source)
    resolved.push({
      name,
      source: extra.source,
      authority,
      summary: authority === 'repository' ? 'Project house rules' : 'User-added guidance',
      content: extra.content,
    })
  }
  return resolved
}
