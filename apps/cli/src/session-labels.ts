import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { SESSION_LABEL_MAX_LENGTH } from '@raidiant/notifai-protocol'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'
import { withFileLock } from './file-lock.js'
import { generatedSessionLabel } from './generated-session-label.js'
import { HARNESS_LABELS, type Harness } from './harnesses.js'

const STORE_VERSION = 1
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

type SessionLabelSource = 'explicit' | 'harness' | 'fallback'

interface SessionLabelCandidate {
  label: string
  source: SessionLabelSource
}

interface StoredSessionLabel {
  label: string
  source: SessionLabelSource
  first_seen_at: number
  harness?: Harness
}

interface SessionLabelStore {
  version: typeof STORE_VERSION
  sessions: Record<string, StoredSessionLabel>
}

export interface SessionLabelInput {
  env: NodeJS.ProcessEnv
  sessionId: string
  harness?: Harness
  explicitLabel?: string
  harnessLabel?: string
  harnessLabelPending?: boolean
  now?: number
}

export type SessionLabelResolution =
  | { ok: true; label: string; source: SessionLabelSource }
  | { ok: false; error: string }

function storePath(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'session-labels.json')
}

/** The state key cannot reveal the harness's opaque session identifier. */
function sessionKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex')
}

function emptyStore(): SessionLabelStore {
  return { version: STORE_VERSION, sessions: {} }
}

function storedRecord(candidate: unknown): StoredSessionLabel | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  const value = candidate as Partial<StoredSessionLabel>
  if (
    typeof value.label !== 'string' ||
    value.label.length === 0 ||
    value.label.length > SESSION_LABEL_MAX_LENGTH ||
    !['explicit', 'harness', 'fallback'].includes(value.source ?? '') ||
    typeof value.first_seen_at !== 'number' ||
    !Number.isFinite(value.first_seen_at)
  ) {
    return null
  }
  const harness = value.harness
  if (harness !== undefined && !Object.hasOwn(HARNESS_LABELS, harness)) return null
  return {
    label: value.label,
    source: value.source as SessionLabelSource,
    first_seen_at: value.first_seen_at,
    ...(harness === undefined ? {} : { harness }),
  }
}

function readStore(file: string): SessionLabelStore {
  if (!existsSync(file)) return emptyStore()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(
      `the session-name store is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('the session-name store is not a JSON object')
  }
  const raw = parsed as { version?: unknown; sessions?: unknown }
  if (raw.version !== STORE_VERSION) {
    throw new Error(`unsupported session-name store version ${String(raw.version)}`)
  }
  if (typeof raw.sessions !== 'object' || raw.sessions === null) {
    throw new Error('the session-name store has no sessions object')
  }
  const sessions: Record<string, StoredSessionLabel> = {}
  for (const [key, candidate] of Object.entries(raw.sessions)) {
    const record = storedRecord(candidate)
    if (!/^[a-f0-9]{64}$/.test(key) || record === null) {
      throw new Error('the session-name store contains an invalid record')
    }
    sessions[key] = record
  }
  return { version: STORE_VERSION, sessions }
}

function writeStore(file: string, store: SessionLabelStore): void {
  atomicWriteFileSync(file, `${JSON.stringify(store, null, 2)}\n`)
}

function normalizeWhitespace(value: string): string {
  return value.trim().replaceAll(/\s+/gu, ' ')
}

/** Match the same UTF-16 length TypeBox enforces at the wire boundary. */
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  let prefix = value.slice(0, Math.max(0, maxLength - 1))
  const last = prefix.charCodeAt(prefix.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1)
  return `${prefix}…`
}

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu
const HASH_PATTERN = /\b[0-9a-f]{12,}\b/iu
const HARNESS_ID_PATTERN = /\b(?:ses|thread)_[A-Za-z0-9_-]{8,}\b/iu
const FILESYSTEM_PATH_PATTERN =
  /(?:^|[\s("'=:])(?:~[\\/]|[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|tmp|var|Volumes|opt|etc|usr|workspace|workspaces)(?:[\\/]|$))/u
const OPENCODE_PENDING_TITLE =
  /^New session(?:\s*-\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/iu

function containsPrivatePath(value: string, env: NodeJS.ProcessEnv): boolean {
  if (FILESYSTEM_PATH_PATTERN.test(value)) return true
  const folded = value.toLocaleLowerCase('en-US')
  for (const key of ['HOME', 'USERPROFILE', 'TMPDIR'] as const) {
    const candidate = env[key]?.trim().replace(/[\\/]+$/u, '')
    if (
      candidate !== undefined &&
      candidate.length > 1 &&
      folded.includes(candidate.toLocaleLowerCase('en-US'))
    ) {
      return true
    }
  }
  return false
}

function violatesLabelPrivacy(value: string, input: SessionLabelInput): boolean {
  const sessionId = input.sessionId.trim()
  const exposesCurrentId =
    sessionId.length > 0 &&
    (value === sessionId || (sessionId.length >= 8 && value.includes(sessionId)))
  return (
    exposesCurrentId ||
    UUID_PATTERN.test(value) ||
    HASH_PATTERN.test(value) ||
    HARNESS_ID_PATTERN.test(value) ||
    containsPrivatePath(value, input.env)
  )
}

function explicitCandidate(
  value: string | undefined,
  input: SessionLabelInput,
): SessionLabelCandidate | { error: string } | null {
  if (value === undefined) return null
  const normalized = normalizeWhitespace(value)
  if (normalized.length === 0) {
    return { error: '--session-label (or NOTIFAI_SESSION_LABEL) must not be empty.' }
  }
  if (normalized.length > SESSION_LABEL_MAX_LENGTH) {
    return {
      error: `--session-label (or NOTIFAI_SESSION_LABEL) must be at most ${SESSION_LABEL_MAX_LENGTH} characters.`,
    }
  }
  if (violatesLabelPrivacy(normalized, input)) {
    return {
      error:
        '--session-label (or NOTIFAI_SESSION_LABEL) must not contain a session identifier, hash, or filesystem path.',
    }
  }
  return { label: normalized, source: 'explicit' }
}

function harnessLabelIsPending(
  value: string | undefined,
  input: SessionLabelInput,
): boolean {
  if (input.harnessLabelPending === true) return true
  if (input.harness !== 'opencode' || value === undefined) return false
  return OPENCODE_PENDING_TITLE.test(normalizeWhitespace(value))
}

function harnessCandidate(
  value: string | undefined,
  input: SessionLabelInput,
): SessionLabelCandidate | null {
  if (value === undefined) return null
  const normalized = normalizeWhitespace(value)
  if (normalized.length === 0 || violatesLabelPrivacy(normalized, input)) return null
  return {
    label: truncate(normalized, SESSION_LABEL_MAX_LENGTH),
    source: 'harness',
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Stable English shape using the machine's local calendar and clock. */
export function formatSessionFirstSeen(now: number): string {
  const date = new Date(now)
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fallbackCandidate(sessionId: string): SessionLabelCandidate {
  return {
    label: generatedSessionLabel(sessionId),
    source: 'fallback',
  }
}

function isLegacyDateFallback(record: StoredSessionLabel): boolean {
  if (record.source !== 'fallback') return false
  const owner = record.harness === undefined ? 'Agent' : HARNESS_LABELS[record.harness]
  return record.label.startsWith(`${owner} session · `)
}

function withSuffix(base: string, suffix: string): string {
  const room = SESSION_LABEL_MAX_LENGTH - suffix.length
  return `${truncate(base, room)}${suffix}`
}

function collisionKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
}

function uniqueLabel(
  base: string,
  source: SessionLabelSource,
  harness: Harness | undefined,
  now: number,
  used: ReadonlySet<string>,
): string {
  if (!used.has(collisionKey(base))) return base

  if (source === 'fallback') {
    for (let ordinal = 2; ; ordinal += 1) {
      const candidate = withSuffix(base, ` · ${ordinal}`)
      if (!used.has(collisionKey(candidate))) return candidate
    }
  }

  const owner = harness === undefined ? 'Agent' : HARNESS_LABELS[harness]
  const ownerCandidate = withSuffix(base, ` · ${owner}`)
  if (!used.has(collisionKey(ownerCandidate))) return ownerCandidate

  const timed = withSuffix(base, ` · ${owner} · ${formatSessionFirstSeen(now)}`)
  if (!used.has(collisionKey(timed))) return timed

  for (let ordinal = 2; ; ordinal += 1) {
    const candidate = withSuffix(timed, ` · ${ordinal}`)
    if (!used.has(collisionKey(candidate))) return candidate
  }
}

/**
 * Freeze the first accepted human name for one immutable session.
 *
 * Explicit agent/User input wins, then a title supplied by a trusted harness
 * adapter, then a generated fallback. Later sends reuse the frozen value
 * even when their branch, worktree, title candidate, or notification changes.
 */
export function resolveSessionLabel(input: SessionLabelInput): SessionLabelResolution {
  const now = input.now ?? Date.now()
  const file = storePath(input.env)
  const key = sessionKey(input.sessionId)

  try {
    return withFileLock(`${file}.lock`, () => {
      const store = readStore(file)
      const existing = store.sessions[key]
      if (existing !== undefined) {
        if (!isLegacyDateFallback(existing)) {
          return { ok: true, label: existing.label, source: existing.source }
        }
        const used = new Set(
          Object.entries(store.sessions)
            .filter(([storedKey]) => storedKey !== key)
            .map(([, record]) => collisionKey(record.label)),
        )
        const label = uniqueLabel(
          generatedSessionLabel(input.sessionId),
          'fallback',
          input.harness ?? existing.harness,
          now,
          used,
        )
        store.sessions[key] = { ...existing, label }
        writeStore(file, store)
        return { ok: true, label, source: existing.source }
      }

      const explicit = explicitCandidate(input.explicitLabel, input)
      if (explicit !== null && 'error' in explicit) {
        return { ok: false, error: explicit.error }
      }
      const nativePending = harnessLabelIsPending(input.harnessLabel, input)
      const native = nativePending ? null : harnessCandidate(input.harnessLabel, input)
      if (explicit === null && nativePending) {
        return {
          ok: false,
          error:
            "OpenCode is still generating this session's title; retry shortly or pass --session-label.",
        }
      }
      const candidate: SessionLabelCandidate =
        explicit ?? native ?? fallbackCandidate(input.sessionId)
      const used = new Set(
        Object.values(store.sessions).map((record) => collisionKey(record.label)),
      )
      const label = uniqueLabel(candidate.label, candidate.source, input.harness, now, used)
      store.sessions[key] = {
        label,
        source: candidate.source,
        first_seen_at: now,
        ...(input.harness === undefined ? {} : { harness: input.harness }),
      }
      writeStore(file, store)
      return { ok: true, label, source: candidate.source }
    })
  } catch (err) {
    return {
      ok: false,
      error: `Could not persist this session's name: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
