import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describeSource } from './config-schema.js'
import { EXIT, type CommandDeps } from './commands-core.js'
import {
  GUIDANCE_TRUST_PREAMBLE,
  SHIPPED_GUIDANCE,
  shippedGuidanceTopic,
} from './guidance-content.js'
import {
  GUIDANCE_TOPIC_MAX_BYTES,
  GUIDANCE_TOPIC_PATTERN,
  findProjectGuidanceDir,
  globalGuidanceDir,
  personalProjectGuidanceDir,
  resolveGuidance,
  type GuidanceAuthority,
} from './guidance.js'

// ---------------------------------------------------------------------------
// guidance show / set / unset
// ---------------------------------------------------------------------------

/** How each authority is named in the marker above a topic. */
const AUTHORITY_LABEL: Record<GuidanceAuthority, string> = {
  user: 'you',
  repository: 'this repository',
  shipped: 'shipped default',
}

/**
 * The token that makes a marker line ours.
 *
 * Without it, a repository topic could open with a handwritten
 * `<!-- when-to-notify · this machine · /Users/... -->` and everything after
 * it would read as the User's own standing word. The marker therefore carries
 * a fixed token, and any occurrence of that token inside file content is
 * defanged below — so the only lines that can claim to be provenance are the
 * ones this command wrote.
 */
const MARKER_TOKEN = 'notifai:guidance'

function markerSafe(content: string): string {
  return content.replaceAll(MARKER_TOKEN, `${MARKER_TOKEN.replace(':', '-')} [not a provenance marker]`)
}

/**
 * The whole effective guidance, ready to be followed as read.
 *
 * The trust preamble comes first and belongs to the CLI: it says who supplied
 * each topic and what no topic may ask for. Each topic then follows its own
 * marker, so a reader can tell the User's standing word from a repository's
 * house rules from the shipped default without the output stopping being
 * Markdown.
 */
export function guidanceShowCommand(deps: CommandDeps, flags: { json?: boolean }): number {
  const topics = resolveGuidance({ cwd: deps.cwd, env: deps.env })
  if (flags.json) {
    deps.io.out(
      JSON.stringify(
        {
          trust: GUIDANCE_TRUST_PREAMBLE,
          topics: topics.map((topic) => ({
            name: topic.name,
            source: topic.source,
            authority: topic.authority,
            summary: topic.summary,
            content: topic.content,
          })),
        },
        null,
        2,
      ),
    )
    return EXIT.ok
  }
  const blocks = topics.map((topic) => {
    const { path: filePath } = describeSource(topic.source)
    const marker =
      `<!-- ${MARKER_TOKEN} topic=${topic.name} from=${AUTHORITY_LABEL[topic.authority]}` +
      `${filePath === null ? '' : ` file=${encodeURIComponent(filePath)}`} -->`
    return `${marker}\n${markerSafe(topic.content).trimEnd()}`
  })
  deps.io.out([GUIDANCE_TRUST_PREAMBLE, ...blocks].join('\n\n'))
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
): Promise<{ path: string; layer: GuidanceLayer } | null> {
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
      { value: 'global', label: 'This machine', hint: 'your standing word, applies across projects' },
      { value: 'project', label: 'This project (shared)', hint: '.notifai/guidance/ — committed, read as project policy' },
      { value: 'local', label: 'This project (personal)', hint: 'your standing word here, stored outside the repo' },
    ])
    if (selected === null) {
      deps.io.err('No guidance layer selected.')
      return null
    }
    layer = selected as GuidanceLayer
  }
  return { path: path.join(guidanceLayerDir(deps, layer), `${topic}.md`), layer }
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
    const confirmed = await deps.io.confirm(`${replaces} at ${target.path}?`)
    if (!confirmed) {
      deps.io.err('Not confirmed. Pass --yes to skip the confirmation gate.')
      return EXIT.usage
    }
  }

  mkdirSync(path.dirname(target.path), { recursive: true })
  writeFileSync(target.path, text.endsWith('\n') ? text : `${text}\n`)
  deps.io.out(`Wrote ${topic} to ${target.path}`)
  if (shipped !== undefined) {
    deps.io.out(`This file now replaces the shipped "${topic}" guidance wherever it applies.`)
  }
  // A shared file is committed and travels to everyone who clones this
  // repository, where it is read as the project's policy rather than as
  // anyone's personal standing word. Worth saying at the moment of writing:
  // the same sentence means something different in the two locations.
  if (target.layer === 'project') {
    deps.io.out(
      'This is shared project policy: it is committed, everyone working here reads it, and it is never read as the User\'s own standing word. Use --local for a personal preference.',
    )
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
  if (!existsSync(target.path)) {
    deps.io.out(`${topic} is not set at ${target.path}`)
    return EXIT.ok
  }
  if (!flags.yes) {
    const confirmed = await deps.io.confirm(`Remove ${target.path}?`)
    if (!confirmed) {
      deps.io.err('Not confirmed. Pass --yes to skip the confirmation gate.')
      return EXIT.usage
    }
  }
  rmSync(target.path, { force: true })
  deps.io.out(`Removed ${target.path}; the inherited guidance now applies.`)
  return EXIT.ok
}
