/**
 * Whether a running Agent Session still has the guidance Notifai ships.
 *
 * A session keeps what it read: its activation, the Notifai skill and
 * `notifai guidance`. An update, a change to the User's topics or a new
 * activation text replaces files, never what a session already read, and a
 * compacted Claude Code session gets its skill back as it was when it first
 * loaded it. So each owner session's record holds a digest of the guidance it
 * was given. When the current digest differs, the session is told once, at
 * its next turn, to load the skill again and run `notifai guidance` before
 * its next Notification Request; a compacted session is told the same.
 *
 * The digest covers the activation text, the shipped skill and every
 * effective topic, never the version: a release that changes none of them
 * changes nothing a session read. The record outlives the session's own
 * state, which a close deletes, so a conversation resumed after an update is
 * still known to carry older guidance.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'
import { resolveGuidance } from './guidance.js'
import { shippedSkillSourceRoot } from './skill-integrity.js'

/** Recorded for a session started with guidance off: it was given nothing that could change. */
export const GUIDANCE_NOT_GIVEN = 'off'

export interface ShippedSkill {
  /** Content digest from the manifest built beside the bundle; null without one. */
  digest: string | null
  /** The bundled SKILL.md: a pointer that works where no harness copy is installed. */
  file: string | null
}

let cachedSkill: { root: string; skill: ShippedSkill } | undefined

/** The skill this build ships. One small file read per process. */
export function shippedSkill(root: string = shippedSkillSourceRoot()): ShippedSkill {
  if (cachedSkill?.root === root) return cachedSkill.skill
  let digest: string | null = null
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'))
    const value = typeof manifest === 'object' && manifest !== null ? (manifest as { digest?: unknown }).digest : undefined
    digest = typeof value === 'string' ? value : null
  } catch {
    // A build without its bundle still has topics and activation to compare.
  }
  const file = path.join(root, 'notifai', 'SKILL.md')
  const skill = { digest, file: existsSync(file) ? file : null }
  cachedSkill = { root, skill }
  return skill
}

/**
 * What an owner session relies on, as one digest: `activation` is the
 * activation text without anything that varies by installation, so moving
 * to a new version directory is not a change.
 */
export function guidanceDigest(options: { cwd: string; env: NodeJS.ProcessEnv; activation: string; skill?: ShippedSkill }): string {
  const skill = options.skill ?? shippedSkill()
  const topics = resolveGuidance({ cwd: options.cwd, env: options.env })
    .map((topic) => [topic.name, topic.authority, topic.content])
  return createHash('sha256')
    .update(JSON.stringify({ v: 1, activation: options.activation, skill: skill.digest, topics }))
    .digest('hex')
}

/** How to load the skill again: the harness's own copy, or the bundled file where there is none. */
function reload(skill: ShippedSkill): string {
  return `load the Notifai skill again${skill.file === null ? '' : ` (or read \`${skill.file}\`)`} and run \`notifai guidance\``
}

/** Told once, at the next turn, when the guidance this session read changed. */
export function guidanceChangedNotice(skill: ShippedSkill = shippedSkill()): string {
  return `Notifai's guidance changed after this Agent Session read it. Before your next Notification Request, ${reload(skill)}; follow them over what you read earlier.`
}

/** Told when a compacted conversation starts again: what it read before is summarized or out of date. */
export function compactedNotice(skill: ShippedSkill = shippedSkill()): string {
  return `This conversation was compacted. Before your next Notification Request, ${reload(skill)}.`
}

function recordFile(sessionId: string, env: NodeJS.ProcessEnv): string {
  const name = createHash('sha256').update(sessionId).digest('hex').slice(0, 40)
  return path.join(stateDir(env), 'guidance-given', `${name}.json`)
}

/** The digest this session was last given, or undefined when Notifai never recorded one. */
export function guidanceGiven(sessionId: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(recordFile(sessionId, env), 'utf8'))
    const digest = typeof value === 'object' && value !== null ? (value as { digest?: unknown }).digest : undefined
    return typeof digest === 'string' ? digest : undefined
  } catch {
    return undefined
  }
}

/** Record what this session was just given. Never fails a hook. */
export function recordGuidanceGiven(sessionId: string, env: NodeJS.ProcessEnv, digest: string): void {
  try {
    if (guidanceGiven(sessionId, env) === digest) return
    const file = recordFile(sessionId, env)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    atomicWriteFileSync(file, `${JSON.stringify({ digest })}\n`, { mode: 0o600 })
  } catch {
    // A missing record only repeats the notice once more.
  }
}

/**
 * What a starting or resuming owner session must be told about the guidance
 * it already holds, before its record is replaced: a compacted conversation
 * reloads; a conversation that read different guidance, or that Notifai
 * never recorded and is being resumed, reloads too.
 */
export function startingCurrency(options: {
  sessionId: string
  env: NodeJS.ProcessEnv
  digest: string
  source?: string | undefined
  compacted?: boolean
}): string | undefined {
  if (options.source === 'compact' || options.compacted === true) return compactedNotice()
  const given = guidanceGiven(options.sessionId, options.env)
  if (given === undefined) return options.source === 'resume' ? guidanceChangedNotice() : undefined
  return given !== GUIDANCE_NOT_GIVEN && given !== options.digest ? guidanceChangedNotice() : undefined
}

/**
 * The change notice for an owner session's next turn, claimed: returned once
 * per change, and the current digest recorded as given. A session started
 * with guidance off has nothing to change. A session with no record was told
 * nothing by this build: `started` says whether its own SessionStart ran (it
 * was activated by an earlier build, so it is told once), since a prompt hook
 * alone never activates a session.
 */
export function claimGuidanceChange(sessionId: string, env: NodeJS.ProcessEnv, digest: string, started: boolean): string | undefined {
  const given = guidanceGiven(sessionId, env)
  if (given === GUIDANCE_NOT_GIVEN || given === digest || (given === undefined && !started)) return undefined
  recordGuidanceGiven(sessionId, env, digest)
  return guidanceChangedNotice()
}

const RECORD_RETENTION_MS = 30 * 24 * 3600 * 1000

/** Daily maintenance: forget records no session has touched in a month. */
export function pruneGuidanceRecords(env: NodeJS.ProcessEnv, now: number = Date.now()): number {
  const directory = path.join(stateDir(env), 'guidance-given')
  let removed = 0
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(directory, name)
    try {
      if (now - statSync(file).mtimeMs > RECORD_RETENTION_MS) {
        rmSync(file, { force: true })
        removed += 1
      }
    } catch {
      // Gone already, or unreadable; the next run tries again.
    }
  }
  return removed
}
