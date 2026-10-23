/** Content notices and read receipts are separate: only `guidance` records a read. */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'
import { resolveGuidance } from './guidance.js'
import { renderGuidance } from './guidance-render.js'
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

/** Exact trusted content, independent of installation paths. Repository skill
 * copies affect admission but never become instructions in a change notice. */
export function guidanceText(options: { cwd: string; env: NodeJS.ProcessEnv; activation: string }): string {
  const bundle = verifySkillBundle(shippedSkillSourceRoot())
  const files = bundle.ok ? bundle.bundle.manifest.files.map(file =>
    `# Shipped skill: ${file.path}\n${readFileSync(path.join(bundle.bundle.skillRoot, file.path), 'utf8')}`) : []
  return [options.activation, renderGuidance(resolveGuidance(options)), ...files].join('\n\n')
}

export interface GuidanceDelivery {
  text?: string
  skill?: ShippedSkill
  /** Full activation if SessionStart was cancelled before it printed. */
  initialContext?: string | undefined
}

/** Keep additions first and removals explicit. Count occurrences so repeated
 * lines do not hide an insertion. Reflow is a change too; order alone is not. */
function changedLines(before: string | undefined, after: string | undefined): string | undefined {
  if (before === undefined || after === undefined || before === after) return undefined
  const difference = (a: string, b: string): string[] => {
    const counts = new Map<string, number>()
    for (const line of b.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
    return a.split('\n').filter(line => {
      const count = counts.get(line) ?? 0
      if (count > 0) { counts.set(line, count - 1); return false }
      return line.trim() !== ''
    })
  }
  const lines = [...difference(after, before).map(line => `+ ${line}`), ...difference(before, after).map(line => `- ${line}`)]
  if (lines.length === 0) return undefined
  const full = `Changed Notifai guidance (apply additions; retire removals):\n${lines.join('\n')}`
  if (Buffer.byteLength(full, 'utf8') <= 800) return full
  let bounded = ''
  const tail = '\n… Full guidance follows the reload pointer.'
  for (const char of full) {
    if (Buffer.byteLength(bounded + char + tail, 'utf8') > 800) break
    bounded += char
  }
  return bounded + tail
}

/** Load through native skills first, with the same verified pointer as start. */
function reload(skill: ShippedSkill): string {
  return `load the Notifai skill again${skill.file === null ? ' (repair it with `notifai init --skills` if missing)' : ` (use your Skill tool, or read \`${skill.file}\` again)`} and run \`notifai guidance\``
}

/** Told once at a model-visible boundary, with changed lines before the pointer. */
export function guidanceChangedNotice(skill: ShippedSkill = shippedSkill(), changes?: string): string {
  return ["Notifai's guidance changed after this Agent Session read it.", changes,
    `Before your next Notification Request, ${reload(skill)}; follow them over what you read earlier.`].filter(Boolean).join('\n\n')
}

export function compactedNotice(skill: ShippedSkill = shippedSkill(), changes?: string): string {
  return ['This conversation was compacted.', changes,
    `Before your next Notification Request, ${reload(skill)}.`].filter(Boolean).join('\n\n')
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
export function recordGuidanceGiven(sessionId: string, env: NodeJS.ProcessEnv, digest: string, text?: string): boolean {
  try {
    const file = recordFile(sessionId, env)
    if (guidanceGiven(sessionId, env) === digest && (text === undefined || readReceipt(file).text !== undefined)) {
      // Active, unchanged sessions must not age out as abandoned records.
      const now = Date.now()
      if (now - statSync(file).mtimeMs > 6 * 3600_000) utimesSync(file, new Date(now), new Date(now))
      return true
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const prior = readReceipt(file)
    atomicWriteFileSync(file, `${JSON.stringify({ ...prior, digest, ...(text === undefined ? {} : { text }), changes: changedLines(prior.text, text) })}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * What a starting or resuming owner session must be told about the guidance
 * it already holds, before its record is replaced: a compacted conversation
 * reloads; a conversation that read different guidance, or that Notifai
 * never recorded receives its full activation from the starting caller.
 */
export function startingCurrency(options: {
  sessionId: string
  env: NodeJS.ProcessEnv
  digest: string
  source?: string | undefined
  compacted?: boolean
  delivery?: GuidanceDelivery
}): string | undefined {
  return claimGuidanceChange(options.sessionId, options.env, options.digest, options.source === 'resume', {
    ...options.delivery, initialContext: undefined, compacted: options.source === 'compact' || options.compacted === true,
  })
}

/**
 * The change notice for an owner session's next turn, claimed: returned once
 * per change, and the current digest recorded as given. A session started
 * with guidance off has nothing to change. A session with no record was told
 * nothing by this build: `started` says whether its own SessionStart ran (it
 * may have been cancelled before printing, so it gets full start context), since a prompt hook
 * alone never activates a session.
 */
export function claimGuidanceChange(sessionId: string, env: NodeJS.ProcessEnv, digest: string, started: boolean, options: GuidanceDelivery & { compacted?: boolean } = {}): string | undefined {
  try {
    const file = recordFile(sessionId, env)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    return withTargetFileLock(file, () => {
      const prior = readReceipt(file)
      const changes = changedLines(prior.text, options.text) ?? prior.changes
      if (options.compacted) {
        delete prior.read
        atomicWriteFileSync(file, `${JSON.stringify({ ...prior, digest, ...(options.text === undefined ? {} : { text: options.text }), changes, generation: randomBytes(16).toString('hex') })}\n`, { mode: 0o600 })
        return compactedNotice(options.skill, changes)
      }
      const given = guidanceGiven(sessionId, env)
      if (given === digest) {
        recordGuidanceGiven(sessionId, env, digest, options.text)
        return undefined
      }
      if (given === GUIDANCE_NOT_GIVEN || (given === undefined && !started)) return undefined
      if (!recordGuidanceGiven(sessionId, env, digest, options.text)) return undefined
      return given === undefined ? options.initialContext : guidanceChangedNotice(options.skill, changes)
    })
  } catch {
    // Keep the prior receipt: the next boundary can retry the claim.
    return undefined
  }
}

interface GuidanceReceipt { digest?: string; read?: string; generation?: string; text?: string; changes?: string }

function readReceipt(file: string): GuidanceReceipt {
  try { return JSON.parse(readFileSync(file, 'utf8')) as GuidanceReceipt } catch { return {} }
}

/** A hook has already advanced `digest`; retain its delta until the CLI read. */
export function pendingGuidanceChanges(sessionId: string, env: NodeJS.ProcessEnv, text: string): string | undefined {
  const prior = readReceipt(recordFile(sessionId, env))
  return changedLines(prior.text, text) ?? prior.changes
}

export function guidanceRead(sessionId: string, env: NodeJS.ProcessEnv): string | undefined {
  return readReceipt(recordFile(sessionId, env)).read
}

/** Called only after `notifai guidance` printed the current text. */
export function recordGuidanceRead(sessionId: string, env: NodeJS.ProcessEnv, digest: string, text?: string): boolean {
  try {
    const file = recordFile(sessionId, env)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    return withTargetFileLock(file, () => {
      atomicWriteFileSync(file, `${JSON.stringify({ ...readReceipt(file), read: digest, ...(text === undefined ? {} : { text }), changes: undefined })}\n`, { mode: 0o600 })
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
