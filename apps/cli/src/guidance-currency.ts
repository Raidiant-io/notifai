/** Content notices and read receipts are separate: only `guidance` records a read. */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'
import { resolveGuidance, type ResolvedGuidanceTopic } from './guidance.js'
import { markerSafe } from './guidance-render.js'
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
export function guidanceDigest(options: { cwd: string; env: NodeJS.ProcessEnv; activation: string; skill?: ShippedSkill; snapshot?: GuidanceSnapshot }): string {
  const skill = options.skill ?? installedSkill(options.cwd, options.env)
  const snapshot = options.snapshot ?? guidanceText(options)
  const release = snapshot.release
  const topics = snapshot.topics.map(topic => [topic.name, topic.authority, topic.content])
  return createHash('sha256')
    .update(JSON.stringify({ v: 1, activation: options.activation, skill: skill.digest, release, topics }))
    .digest('hex')
}

/** Transient content is resolved afresh; receipts retain only its digests. */
export interface GuidanceSnapshot {
  release?: string | undefined
  topics: Array<{ name: string; digest: string; content: string; authority: string }>
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
export function guidanceText(options: { cwd: string; env: NodeJS.ProcessEnv; activation: string }, topics: readonly ResolvedGuidanceTopic[] = resolveGuidance(options)): GuidanceSnapshot {
  const bundle = verifySkillBundle(shippedSkillSourceRoot())
  return {
    release: bundle.ok ? bundle.bundle.manifest.guidance?.current : undefined,
    topics: topics.map(topic => ({ ...topic, digest: hash(JSON.stringify([topic.authority, topic.content])) })),
  }
}

export interface GuidanceDelivery {
  /** Digest computed after the generation fence was captured. */
  digest?: string
  text?: GuidanceSnapshot
  skill?: ShippedSkill
  /** Generation observed before computing this claim's content. */
  generation?: number | undefined
  needsToken?: boolean
  initialContext?: string | undefined
}

function bounded(text: string): string {
  const tail = '\n… Run `notifai guidance changes` for full release notes; `notifai guidance` for topics.'
  if (Buffer.byteLength(text) <= 800) return text
  let result = ''
  for (const char of text) {
    if (Buffer.byteLength(result + char + tail) > 800) break
    result += char
  }
  return result + tail
}

function changesSince(prior: GuidanceReceipt, current?: GuidanceSnapshot): string | undefined {
  if (current === undefined) return undefined
  const parts: string[] = []
  const bundle = verifySkillBundle(shippedSkillSourceRoot())
  const releases = bundle.ok ? bundle.bundle.manifest.guidance?.releases ?? [] : []
  if (current.release !== prior.readRelease) {
    const start = releases.findIndex(release => release.digest === prior.readRelease)
    for (const release of releases.slice(start + 1)) parts.push(`Release guidance change:\n${markerSafe(release.note)}`)
  }
  for (const topic of current.topics) {
    if (prior.readTopics?.[hash(topic.name)] === topic.digest) continue
    if (topic.authority === 'user' || prior.readTopics?.[hash(topic.name)] !== undefined) {
      parts.push(`Changed topic ${topic.name} (current ${topic.authority === 'user' ? "User's" : 'shipped default'} text):\n${markerSafe(topic.content)}`)
    }
  }
  return parts.length === 0 ? undefined : bounded('Changed Notifai guidance:\n' + parts.join('\n\n'))
}

/** Load through native skills first, with the same verified pointer as start. */
function reload(skill: ShippedSkill, needsToken = false): string {
  const command = needsToken ? 'notifai guidance check' : 'notifai guidance'
  return `load the Notifai skill again${skill.file === null ? ' (repair it with `notifai init --skills` if missing)' : ` (from \`${skill.file}\`)`} and run \`${command}\`${needsToken ? ' and follow its output' : ''}`
}

/** Told once at a model-visible boundary, with changed lines before the pointer. */
export function guidanceChangedNotice(skill: ShippedSkill = shippedSkill(), changes?: string, needsToken = false): string {
  return ["Notifai's guidance changed after this Agent Session read it.", changes,
    `Before your next Notification Request, ${reload(skill, needsToken)}; follow them over what you read earlier.`].filter(Boolean).join('\n\n')
}

export function compactedNotice(skill: ShippedSkill = shippedSkill(), changes?: string, needsToken = false): string {
  return ['This conversation was compacted.', changes,
    `Before your next Notification Request, ${reload(skill, needsToken)}.`].filter(Boolean).join('\n\n')
}

function recordFile(sessionId: string, env: NodeJS.ProcessEnv): string {
  const name = createHash('sha256').update(sessionId).digest('hex').slice(0, 40)
  return path.join(stateDir(env), 'guidance-given', `${name}.json`)
}

/** The digest this session was last given, or undefined when Notifai never recorded one. */
export function guidanceGiven(sessionId: string, env: NodeJS.ProcessEnv): string | undefined {
  return readReceipt(recordFile(sessionId, env)).digest
}

export function guidanceGeneration(sessionId: string, env: NodeJS.ProcessEnv): number {
  return readReceipt(recordFile(sessionId, env)).generation ?? 0
}

function save(file: string, receipt: GuidanceReceipt): void {
  atomicWriteFileSync(file, `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
}

/** Record activation, never mark it read. A changed activation advances the fence. */
export function recordGuidanceGiven(sessionId: string, env: NodeJS.ProcessEnv, digest: string, _text?: GuidanceSnapshot, generation = guidanceGeneration(sessionId, env)): boolean {
  try {
    if (digest !== GUIDANCE_NOT_GIVEN && !validDigest(digest)) return false
    const file = recordFile(sessionId, env)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    return withTargetFileLock(file, () => {
      const prior = readReceipt(file)
      if (generation !== (prior.generation ?? 0)) return false
      if (prior.digest !== digest) save(file, { ...prior, digest, generation: (prior.generation ?? 0) + 1 })
      else {
        const now = Date.now()
        if (now - statSync(file).mtimeMs > 6 * 3600_000) utimesSync(file, new Date(now), new Date(now))
      }
      return true
    })
  } catch { return false }
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
    digest = options.digest ?? digest
    if (!validDigest(digest)) return undefined
    const file = recordFile(sessionId, env)
    const generation = options.generation ?? guidanceGeneration(sessionId, env)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    return withTargetFileLock(file, () => {
      const prior = readReceipt(file)
      if (generation !== (prior.generation ?? 0)) return undefined
      const changes = changesSince(prior, options.text)
      if (options.compacted) {
        delete prior.read
        save(file, { ...prior, digest, generation: generation + 1 })
        return compactedNotice(options.skill, changes, options.needsToken)
      }
      if (prior.digest === digest || prior.digest === GUIDANCE_NOT_GIVEN || (prior.digest === undefined && !started)) return undefined
      save(file, { ...prior, digest, generation: generation + 1 })
      return prior.digest === undefined ? options.initialContext : guidanceChangedNotice(options.skill, changes, options.needsToken)
    })
  } catch { return undefined }
}

interface GuidanceReceipt {
  digest?: string
  read?: string
  generation?: number | undefined
  readRelease?: string
  readTopics?: Record<string, string>
}
const validDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

/** Reject legacy text-bearing, oversized and malformed receipts in their entirety. */
function readReceipt(file: string): GuidanceReceipt {
  try {
    if (statSync(file).size > 24_000) return {}
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    const record = value as Record<string, unknown>
    if (Object.keys(record).some(key => !['digest', 'read', 'generation', 'readRelease', 'readTopics'].includes(key))) return {}
    if (record['digest'] !== undefined && record['digest'] !== GUIDANCE_NOT_GIVEN && !validDigest(record['digest'])) return {}
    for (const key of ['read', 'readRelease']) if (record[key] !== undefined && !validDigest(record[key])) return {}
    if (!Number.isSafeInteger(record['generation']) || (record['generation'] as number) < 0) return {}
    if (record['readTopics'] !== undefined) {
      const topics = record['readTopics']
      if (topics === null || typeof topics !== 'object' || Array.isArray(topics) || Object.keys(topics).length > 128 ||
        Object.entries(topics).some(([key, digest]) => !/^[a-f0-9]{64}$/.test(key) || !validDigest(digest))) return {}
    }
    return record as GuidanceReceipt
  } catch { return {} }
}

export function pendingGuidanceChanges(sessionId: string, env: NodeJS.ProcessEnv, current: GuidanceSnapshot): string | undefined {
  return changesSince(readReceipt(recordFile(sessionId, env)), current)
}

export function guidanceRead(sessionId: string, env: NodeJS.ProcessEnv): string | undefined {
  return readReceipt(recordFile(sessionId, env)).read
}

/** Called only after the CLI printed freshly resolved guidance. */
export function recordGuidanceRead(sessionId: string, env: NodeJS.ProcessEnv, digest: string, text?: GuidanceSnapshot, generation = guidanceGeneration(sessionId, env)): boolean {
  try {
    if (!validDigest(digest)) return false
    const file = recordFile(sessionId, env)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    return withTargetFileLock(file, () => {
      const prior = readReceipt(file)
      if (generation !== (prior.generation ?? 0)) return false
      save(file, { ...prior, read: digest, generation: (prior.generation ?? 0) + 1,
        ...(text?.release === undefined ? {} : { readRelease: text.release }),
        ...(text === undefined ? {} : { readTopics: Object.fromEntries(text.topics.slice(0, 128).map(topic => [hash(topic.name), topic.digest])) }),
      })
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
      atomicWriteFileSync(file, `${JSON.stringify({ ...prior, generation: (prior.generation ?? 0) + 1 })}\n`, { mode: 0o600 })
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
      ? readReceipt(receipt).generation ?? 'invalid'
      : 'initial'
    if (token !== undefined) {
      if (!/^[a-f0-9]{48}$/.test(token)) return null
      const stored = JSON.parse(readFileSync(path.join(directory, token), 'utf8')) as { token?: string; owner?: string; generation?: string | number }
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
