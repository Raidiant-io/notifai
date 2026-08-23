import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describeSource } from './config-schema.js'
import { EXIT, type CommandDeps } from './commands-core.js'
import { SHIPPED_GUIDANCE, shippedGuidanceTopic } from './guidance-content.js'
import {
  GUIDANCE_TOPIC_MAX_BYTES,
  GUIDANCE_TOPIC_PATTERN,
  findProjectGuidanceDir,
  globalGuidanceDir,
  personalProjectGuidanceDir,
  resolveGuidance,
} from './guidance.js'

// ---------------------------------------------------------------------------
// guidance show / set / unset
// ---------------------------------------------------------------------------

/**
 * The whole effective guidance, ready to be followed as read. Each topic is
 * printed under a provenance comment so a reader can tell the user's standing
 * word from the shipped default without the output stopping being Markdown.
 */
export function guidanceShowCommand(deps: CommandDeps, flags: { json?: boolean }): number {
  const topics = resolveGuidance({ cwd: deps.cwd, env: deps.env })
  if (flags.json) {
    deps.io.out(
      JSON.stringify(
        topics.map((topic) => ({
          name: topic.name,
          source: topic.source,
          summary: topic.summary,
          content: topic.content,
        })),
        null,
        2,
      ),
    )
    return EXIT.ok
  }
  const blocks = topics.map((topic) => {
    const { label, path: filePath } = describeSource(topic.source)
    const origin = topic.source === 'default' ? 'shipped default' : label
    const provenance = filePath === null ? origin : `${origin} · ${filePath}`
    return `<!-- ${topic.name} · ${provenance} -->\n${topic.content.trimEnd()}`
  })
  deps.io.out(blocks.join('\n\n'))
  return EXIT.ok
}

type GuidanceMutationFlags = {
  project?: boolean | undefined
  local?: boolean | undefined
  yes?: boolean | undefined
}
type GuidanceLayer = 'global' | 'project' | 'local'

/**
 * Where a topic file for one layer lives. The project layer prefers an
 * existing `.notifai/guidance` up the tree and otherwise starts one at cwd,
 * the same anchoring `config set --project` uses for its file.
 */
function guidanceLayerDir(deps: CommandDeps, layer: GuidanceLayer): string {
  if (layer === 'local') return personalProjectGuidanceDir(deps.cwd, deps.env)
  if (layer === 'project') {
    return findProjectGuidanceDir(deps.cwd) ?? path.join(deps.cwd, '.notifai', 'guidance')
  }
  return globalGuidanceDir(deps.env)
}

async function guidanceMutationTarget(
  deps: CommandDeps,
  topic: string,
  flags: GuidanceMutationFlags,
): Promise<string | null> {
  if (!GUIDANCE_TOPIC_PATTERN.test(topic)) {
    deps.io.err(
      `"${topic}" is not a topic name. Use lowercase letters, digits, "-" and "_", e.g. ${SHIPPED_GUIDANCE.map((t) => t.name).join(', ')}.`,
    )
    return null
  }
  let layer: GuidanceLayer = flags.local ? 'local' : flags.project ? 'project' : 'global'
  if (
    flags.local !== true &&
    flags.project !== true &&
    flags.yes !== true &&
    deps.io.interactive === true &&
    deps.io.select
  ) {
    const selected = await deps.io.select('Where should this guidance live?', [
      { value: 'global', label: 'This machine', hint: 'applies across projects' },
      { value: 'project', label: 'This project (shared)', hint: '.notifai/guidance/' },
      { value: 'local', label: 'This project (personal)', hint: 'stored on this machine, not in the repo' },
    ])
    if (selected === null) {
      deps.io.err('No guidance layer selected.')
      return null
    }
    layer = selected as GuidanceLayer
  }
  return path.join(guidanceLayerDir(deps, layer), `${topic}.md`)
}

/**
 * Writes one topic at one layer, replacing the shipped topic of that name for
 * this scope. The confirmation gate is the same one `config set` holds: the
 * user owns their standing word, so an agent writes it only with their words
 * and their say-so.
 */
export async function guidanceSetCommand(
  deps: CommandDeps,
  topic: string,
  text: string,
  flags: GuidanceMutationFlags,
): Promise<number> {
  if (text.trim() === '') {
    deps.io.err('Guidance text is empty. Pass the text, or --file <path|-> to read it.')
    return EXIT.usage
  }
  if (text.length > GUIDANCE_TOPIC_MAX_BYTES) {
    deps.io.err(`Guidance for one topic is capped at ${GUIDANCE_TOPIC_MAX_BYTES} bytes.`)
    return EXIT.usage
  }
  const target = await guidanceMutationTarget(deps, topic, flags)
  if (target === null) return EXIT.usage

  const shipped = shippedGuidanceTopic(topic)
  if (!flags.yes) {
    const replaces =
      shipped === undefined
        ? `Add guidance topic "${topic}"`
        : `Replace the shipped "${topic}" guidance for this scope`
    const confirmed = await deps.io.confirm(`${replaces} at ${target}?`)
    if (!confirmed) {
      deps.io.err('Not confirmed. Pass --yes to skip the confirmation gate.')
      return EXIT.usage
    }
  }

  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text.endsWith('\n') ? text : `${text}\n`)
  deps.io.out(`Wrote ${topic} to ${target}`)
  if (shipped !== undefined) {
    deps.io.out(`This file now replaces the shipped "${topic}" guidance wherever it applies.`)
  }
  return EXIT.ok
}

export async function guidanceUnsetCommand(
  deps: CommandDeps,
  topic: string,
  flags: GuidanceMutationFlags,
): Promise<number> {
  const target = await guidanceMutationTarget(deps, topic, flags)
  if (target === null) return EXIT.usage
  if (!existsSync(target)) {
    deps.io.out(`${topic} is not set at ${target}`)
    return EXIT.ok
  }
  if (!flags.yes) {
    const confirmed = await deps.io.confirm(`Remove ${target}?`)
    if (!confirmed) {
      deps.io.err('Not confirmed. Pass --yes to skip the confirmation gate.')
      return EXIT.usage
    }
  }
  rmSync(target, { force: true })
  deps.io.out(`Removed ${target}; the inherited guidance now applies.`)
  return EXIT.ok
}
