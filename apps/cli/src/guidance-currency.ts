/** Content notices and read receipts are separate: only `guidance` records a read. */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'
import { resolveGuidance } from './guidance.js'
import { skillTreeDigest, shippedSkillSourceRoot, verifySkillBundle } from './skill-integrity.js'
import { skillDestination } from './native-skills.js'
import { SOURCE_CONTEXT_HARNESSES } from './harnesses.js'
import { withTargetFileLock } from './file-lock.js'

/** Recorded for a session started with guidance off: it was given nothing that could change. */
export const GUIDANCE_NOT_GIVEN = 'off'

export interface ShippedSkill {
  /** Content digest from the manifest built beside the bundle; null without one. */
  digest: string | null
  /** The bundled SKILL.md: a pointer that works where no harness copy is installed. */
  file: string | null
}

let cachedSkill: { root: string; skill: ShippedSkill } | undefined

/** The verified skill this build ships, inspected once per process. */
export function shippedSkill(root: string = shippedSkillSourceRoot()): ShippedSkill {
  if (cachedSkill?.root === root) return cachedSkill.skill
  const verified = verifySkillBundle(root)
  const digest = verified.ok ? verified.bundle.manifest.digest : null
  const file = path.join(root, 'notifai', 'SKILL.md')
  const skill = { digest, file: verified.ok && !file.startsWith('/$bunfs/') && !/^[A-Za-z]:[\\/]~BUN[\\/]/i.test(file) ? file : null }
  cachedSkill = { root, skill }
  return skill
}

/** Hash the actual harness copies. A bundled fallback never advertises a virtual FS path. */
export function installedSkill(cwd: string, env: NodeJS.ProcessEnv): ShippedSkill {
  const copies: Array<[string, string]> = []
  const shipped = shippedSkill()
  let file: string | null = null
  for (const harness of SOURCE_CONTEXT_HARNESSES) {
    for (const scope of ['project', 'global'] as const) {
      const root = skillDestination(scope, harness, cwd, env)
      if (root === null || !existsSync(path.join(root, 'SKILL.md'))) continue
      const digest = skillTreeDigest(root)
      copies.push([`${harness}/${scope}`, digest ?? 'unreadable'])
      if (scope === 'global' && digest !== null && digest === shipped.digest) file ??= path.join(root, 'SKILL.md')
    }
  }
  return copies.length === 0 ? shippedSkill() : {
    digest: createHash('sha256').update(JSON.stringify(copies)).digest('hex'), file: file ?? shipped.file,
  }
}

/**
 * What an owner session relies on, as one digest: `activation` is the
 * activation text without anything that varies by installation, so moving
 * to a new version directory is not a change.
 */
export function guidanceDigest(options: { cwd: string; env: NodeJS.ProcessEnv; activation: string; skill?: ShippedSkill }): string {
  const skill = options.skill ?? installedSkill(options.cwd, options.env)
  const topics = resolveGuidance({ cwd: options.cwd, env: options.env })
    .map((topic) => [topic.name, topic.authority, topic.content])
  return createHash('sha256')
    .update(JSON.stringify({ v: 1, activation: options.activation, skill: skill.digest, topics }))
    .digest('hex')
}

/** How to load the skill again: the harness's own copy, or the bundled file where there is none. */
function reload(skill: ShippedSkill): string {
  return `${skill.file === null ? 'repair the Notifai skill with \`notifai init --skills\`, then load its verified copy' : `read \`${skill.file}\` again`} and run \`notifai guidance\``
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
export function recordGuidanceGiven(sessionId: string, env: NodeJS.ProcessEnv, digest: string): boolean {
  try {
    const file = recordFile(sessionId, env)
    if (guidanceGiven(sessionId, env) === digest) {
      // Active, unchanged sessions must not age out as abandoned records.
      const now = Date.now()
      if (now - statSync(file).mtimeMs > 6 * 3600_000) utimesSync(file, new Date(now), new Date(now))
      return true
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const prior = readReceipt(file)
    atomicWriteFileSync(file, `${JSON.stringify({ ...prior, digest })}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
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
  return claimGuidanceChange(options.sessionId, options.env, options.digest, options.source === 'resume', {
    compacted: options.source === 'compact' || options.compacted === true,
  })
}

/**
 * The change notice for an owner session's next turn, claimed: returned once
 * per change, and the current digest recorded as given. A session started
 * with guidance off has nothing to change. A session with no record was told
 * nothing by this build: `started` says whether its own SessionStart ran (it
 * was activated by an earlier build, so it is told once), since a prompt hook
 * alone never activates a session.
 */
export function claimGuidanceChange(sessionId: string, env: NodeJS.ProcessEnv, digest: string, started: boolean, options: { compacted?: boolean } = {}): string | undefined {
  try {
    const file = recordFile(sessionId, env)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    return withTargetFileLock(file, () => {
      if (options.compacted) {
        const prior = readReceipt(file)
        delete prior.read
        atomicWriteFileSync(file, `${JSON.stringify({ ...prior, digest, generation: randomBytes(16).toString('hex') })}\n`, { mode: 0o600 })
        return compactedNotice()
      }
      const given = guidanceGiven(sessionId, env)
      if (given === digest) {
        recordGuidanceGiven(sessionId, env, digest)
        return undefined
      }
      if (given === GUIDANCE_NOT_GIVEN || (given === undefined && !started)) return undefined
      return recordGuidanceGiven(sessionId, env, digest) ? guidanceChangedNotice() : undefined
    })
  } catch {
    // Keep the prior receipt: the next boundary can retry the claim.
    return undefined
  }
}

function readReceipt(file: string): { digest?: string; read?: string; generation?: string } {
  try { return JSON.parse(readFileSync(file, 'utf8')) as { digest?: string; read?: string; generation?: string } } catch { return {} }
}

export function guidanceRead(sessionId: string, env: NodeJS.ProcessEnv): string | undefined {
  return readReceipt(recordFile(sessionId, env)).read
}

/** Called only after `notifai guidance` printed the current text. */
export function recordGuidanceRead(sessionId: string, env: NodeJS.ProcessEnv, digest: string): boolean {
  try {
    const file = recordFile(sessionId, env)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    return withTargetFileLock(file, () => {
      atomicWriteFileSync(file, `${JSON.stringify({ ...readReceipt(file), read: digest })}\n`, { mode: 0o600 })
      return true
    })
  } catch { return false }
}

export function invalidateGuidanceRead(sessionId: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const file = recordFile(sessionId, env)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    return withTargetFileLock(file, () => {
      const prior = readReceipt(file)
      delete prior.read
      atomicWriteFileSync(file, `${JSON.stringify({ ...prior, generation: randomBytes(16).toString('hex') })}\n`, { mode: 0o600 })
      return true
    })
  } catch { return false }
}

/** Random local capabilities bound to the shell's owning session and its
 * compaction generation. A child sharing a root id still gets its own token;
 * compacting that root conservatively expires every token it could own. */
export function conversationToken(env: NodeJS.ProcessEnv, token: string | undefined, owner: string): string | null {
  const directory = path.join(stateDir(env), 'guidance-tokens')
  const receipt = recordFile(owner, env)
  try {
    // Missing state is the initial generation; unreadable state is never one.
    const generation = existsSync(receipt)
      ? (JSON.parse(readFileSync(receipt, 'utf8')) as { generation?: string }).generation ?? 'initial'
      : 'initial'
    if (token !== undefined) {
      if (!/^[a-f0-9]{48}$/.test(token)) return null
      const stored = JSON.parse(readFileSync(path.join(directory, token), 'utf8')) as { token?: string; owner?: string; generation?: string }
      return stored.token === token && stored.owner === owner && stored.generation === generation ? token : null
    }
    const fresh = randomBytes(24).toString('hex')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    atomicWriteFileSync(path.join(directory, fresh), JSON.stringify({ token: fresh, owner, generation }), { mode: 0o600 })
    return fresh
  } catch { return null }
}

/** Child hooks can carry their parent's session id. Never spend the parent's
 * guidance notice on a context only its child reads. */
export function guidanceSessionKey(sessionId: string, agentId?: string): string {
  return agentId === undefined ? sessionId : `${sessionId}/agent/${agentId}`
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
