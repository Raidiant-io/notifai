import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { EXIT, type CommandDeps } from './commands-core.js'
import { GUIDANCE_TRUST_PREAMBLE, SHIPPED_GUIDANCE, shippedGuidanceTopic } from './guidance-content.js'
import {
  GUIDANCE_TOPIC_MAX_BYTES,
  GUIDANCE_TOPIC_PATTERN,
  globalGuidanceDir,
  personalProjectGuidanceDir,
} from './guidance.js'
import { renderGuidance } from './guidance-render.js'
import { projectBinding, projectEnablementState } from './project-enablement.js'
import { loadConfig } from './config.js'
import { rootGuidanceDigest, requestGuidanceContext } from './session-activation.js'
import { shippedSkillSourceRoot, verifySkillBundle } from './skill-integrity.js'
import { markerSafe } from './guidance-render.js'
import { conversationToken, guidanceChangedNotice, guidanceRead, installedSkill, pendingGuidanceChanges } from './guidance-currency.js'
import { commandGuidanceChanges, commandGuidanceOwner, prepareCommandGuidanceRead, recordCommandGuidanceRead } from './command-guidance.js'

// ---------------------------------------------------------------------------
// guidance show / set / unset
// ---------------------------------------------------------------------------

/** Full notes are release-authored bundle content, never local receipts. */
export function guidanceChangesCommand(deps: CommandDeps): number {
  const bundle = verifySkillBundle(shippedSkillSourceRoot())
  if (!bundle.ok) { deps.io.err(bundle.error); return EXIT.failed }
  deps.io.out((bundle.bundle.manifest.guidance?.releases ?? []).map(release =>
    `Release guidance ${release.digest}\n${markerSafe(release.note)}`).join('\n\n'))
  return EXIT.ok
}

/** A conversation-held receipt for hosts that discard hook context and expose
 * no exact session identity to tools. Never guesses an identity from cwd. */
export function guidanceCheckCommand(deps: CommandDeps, seen?: string): number {
  const config = loadConfig({ cwd: deps.cwd, env: deps.env })
  const state = projectEnablementState(projectBinding(deps.cwd, deps.env, config.project.value))
  const enabled = state === 'enabled'
  if (state === 'disabled') {
    deps.io.out(JSON.stringify({ enabled: false, disabled: true }))
    return EXIT.ok
  }
  const digest = rootGuidanceDigest(deps.cwd, deps.env)
  const token = conversationToken(deps.env, seen, commandGuidanceOwner(deps)) ?? conversationToken(deps.env, undefined, commandGuidanceOwner(deps))
  if (token === null) { deps.io.err('Could not store the local guidance token.'); return EXIT.failed }
  const changed = guidanceRead(`conversation/${token}`, deps.env) !== digest
  const output = changed ? requestGuidanceContext(deps.cwd, deps.env, seen === undefined ? undefined : guidanceChangedNotice(installedSkill(deps.cwd, deps.env), commandGuidanceChanges(deps, token))) : undefined
  deps.io.out(JSON.stringify({ enabled, token, read_command: `notifai guidance --session-token ${token}`, request_flag: `--guidance-token ${token}`, skill_file: installedSkill(deps.cwd, deps.env).file,
    ...(output === undefined ? {} : { context: output }) }))
  return EXIT.ok
}

/**
 * The whole effective guidance, ready to be followed as read.
 *
 * The trust preamble comes first and belongs to the CLI: it says who supplied
 * each topic and what no instruction may ask for. Each topic then follows its
 * own marker, so a reader can tell the User's standing word from the shipped
 * default without the output stopping being Markdown.
 */
export async function guidanceShowCommand(deps: CommandDeps, flags: { json?: boolean; sessionToken?: string }): Promise<number> {
  const read = prepareCommandGuidanceRead(deps, flags.sessionToken)
  const topics = read.topics
  const changes = read.session === null ? undefined : pendingGuidanceChanges(read.session, deps.env, read.text)
  if (flags.json) {
    deps.io.out(
      JSON.stringify(
        {
          ...(changes === undefined ? {} : { changes }),
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
    return recordCommandGuidanceRead(deps, read, flags.sessionToken) ? EXIT.ok : EXIT.failed
  }
  deps.io.out([changes, renderGuidance(topics)].filter(Boolean).join('\n\n'))
  return recordCommandGuidanceRead(deps, read, flags.sessionToken) ? EXIT.ok : EXIT.failed
}

type GuidanceMutationFlags = {
  local?: boolean | undefined
  yes?: boolean | undefined
}
type GuidanceLayer = 'global' | 'local'

/** Where a topic file for one layer lives; both are under the User's config home. */
function guidanceLayerDir(deps: CommandDeps, layer: GuidanceLayer): string {
  return layer === 'local' ? personalProjectGuidanceDir(deps.cwd, deps.env) : globalGuidanceDir(deps.env)
}

async function guidanceMutationTarget(
  deps: CommandDeps,
  topic: string,
  flags: GuidanceMutationFlags,
): Promise<{ path: string } | null> {
  if (!GUIDANCE_TOPIC_PATTERN.test(topic)) {
    deps.io.err(
      `"${topic}" is not a topic name. Use lowercase letters, digits, "-" and "_", e.g. ${SHIPPED_GUIDANCE.map((t) => t.name).join(', ')}.`,
    )
    return null
  }
  let layer: GuidanceLayer = flags.local ? 'local' : 'global'
  if (
    flags.local !== true &&
    flags.yes !== true &&
    deps.io.interactive === true &&
    deps.io.select
  ) {
    const selected = await deps.io.select('Where should this guidance live?', [
      { value: 'global', label: 'This machine', hint: 'your standing word, applies across projects' },
      { value: 'local', label: 'This project', hint: 'your standing word here, stored outside the repo' },
    ])
    if (selected === null) {
      deps.io.err('No guidance layer selected.')
      return null
    }
    layer = selected === 'local' ? 'local' : 'global'
  }
  return { path: path.join(guidanceLayerDir(deps, layer), `${topic}.md`) }
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
      deps.io.err('Not confirmed. When the User asked for this change directly, rerun with --yes.')
      return EXIT.usage
    }
  }

  mkdirSync(path.dirname(target.path), { recursive: true })
  writeFileSync(target.path, text.endsWith('\n') ? text : `${text}\n`)
  deps.io.out(`Wrote ${topic} to ${target.path}`)
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
  if (!existsSync(target.path)) {
    deps.io.out(`${topic} is not set at ${target.path}`)
    return EXIT.ok
  }
  if (!flags.yes) {
    const confirmed = await deps.io.confirm(`Remove ${target.path}?`)
    if (!confirmed) {
      deps.io.err('Not confirmed. When the User asked for this change directly, rerun with --yes.')
      return EXIT.usage
    }
  }
  rmSync(target.path, { force: true })
  deps.io.out(`Removed ${target.path}; the inherited guidance now applies.`)
  return EXIT.ok
}
