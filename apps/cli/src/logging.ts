/**
 * Local, agent-facing logs.
 *
 * Most of what this CLI does happens where nobody is looking. A harness hook
 * runs headless in front of every prompt; its stderr is swallowed by the
 * harness, and its most consequential act is usually a decision to do nothing —
 * the question stayed in the terminal, and no line anywhere says why. An agent
 * asked afterwards "did my question reach the phone?" has had no way to find
 * out. This is the record that answers that.
 *
 * Written for an agent to read, which is a different job from writing for a
 * person:
 *
 *   - One JSON object per line, so `grep`, `jq`, and a plain read all work
 *     without a parser and without reading the file whole.
 *   - A closed event vocabulary, so a filter written once keeps matching.
 *   - A run id stamped on every line of one invocation, so "what happened
 *     during that command" is a single query rather than a reconstruction.
 *   - Retrieval bounded by default (`notifai logs`), because an unbounded dump
 *     into a context window is worse than no log at all.
 *
 * Local only. Nothing here is uploaded, and nothing in the record is shaped for
 * a server. If submitting a log for debugging is ever added it will be an
 * explicit, separate act by the user.
 *
 * ## Concurrency
 *
 * Several processes share one file: the hook fires per turn, `send` and `ask`
 * fire whenever an agent calls them, and worktrees run in parallel. Every write
 * takes one short cross-process lock around the shared size check, any rotation,
 * and the append. Without that transaction, several writers can all observe the
 * same remaining budget and independently push the file past its configured cap.
 *
 * The record itself still lands in one `O_APPEND` write. That keeps a line whole
 * if an uncooperating process touches the file, while the lock makes cooperating
 * Notifai processes agree which inode owns the record and when it must rotate.
 *
 * ## Failure
 *
 * Logging may never break the CLI. A read-only home, a full disk, or a
 * directory someone replaced with a file all end the same way: logging switches
 * itself off for the rest of the process and the command carries on. A
 * diagnostic that can take down the thing it observes is not a diagnostic.
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import {
  CONFIG_KEYS,
  LOG_LEVELS,
  loadConfig,
  stateDir,
  type CliConfig,
  type LogLevel,
} from './config.js'
import { withFileLock } from './file-lock.js'

/** Bumped when the record shape changes in a way a reader must notice. */
export const LOG_SCHEMA_VERSION = 1

export { LOG_LEVELS, type LogLevel }
export type RecordLevel = Exclude<LogLevel, 'off'>

/**
 * The levels a record can actually carry.
 *
 * `off` is a setting that stops writing, never a severity anything is written
 * at — so offering it as a retrieval filter accepted a query that could only
 * ever match nothing, and then blamed the result on too narrow a search.
 */
export const RECORD_LEVELS: readonly RecordLevel[] = LOG_LEVELS.filter(
  (level): level is RecordLevel => level !== 'off',
)

const LEVEL_RANK: Record<LogLevel, number> = { off: 0, error: 1, info: 2, debug: 3 }

/**
 * The closed vocabulary. A filter is only worth writing if it keeps matching,
 * so these names are a contract: add to the list rather than rephrasing an
 * existing one, and keep each event answering exactly one question.
 */
export const LOG_EVENTS = [
  /** A CLI invocation began: which command, which flag names, which version. */
  'cli.start',
  /** It ended: exit code and how long it took. */
  'cli.end',
  /** A command failed. Carries the server's own code and rejected paths. */
  'cli.error',
  /** Which config layer won, for the keys that changed the outcome. */
  'config.resolved',
  /** One HTTP call to the service: method, path, status, duration. */
  'http.call',
  /** A send crossed its ambiguous network boundary with this retry identity. */
  'send.attempt',
  /** A notification was accepted by the service. */
  'send.submitted',
  /** What became of it per device. */
  'send.outcome',
  /** `notifai ask` registered a question for the turn-end hook. */
  'ask.registered',
  /** An answer came back from a device. */
  'reply.received',
  /** An agent attempted to acknowledge the user's reply. */
  'acknowledgement.attempted',
  /** The service recorded or replayed an Agent Acknowledgement. */
  'acknowledgement.outcome',
  /** A harness hook started. */
  'hook.start',
  /** A hook decided whether a question may leave the terminal, and why. */
  'hook.gate',
  /** A question reached the user's devices. */
  'hook.pushed',
  /** The hook handed an answer back to the agent. */
  'hook.answer',
  /** The hook finished, with or without a decision. */
  'hook.end',
  /** The active file was rotated. Explains a gap to anyone reading backwards. */
  'log.rotated',
] as const
export type LogEvent = (typeof LOG_EVENTS)[number]

export interface LogRecord {
  /** Schema version. On every line, so a line pulled out by grep still parses. */
  v: number
  /** ISO 8601, UTC. */
  ts: string
  level: RecordLevel
  event: LogEvent
  /** Correlation id for one CLI invocation. */
  run: string
  /** The command path, e.g. `send` or `config set`. */
  cmd: string
  pid: number
  project?: string
  session?: string
  data?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * A record must fit in one write to stay atomic against other processes, and
 * must fit in a reader's context window to be worth writing at all. Both point
 * at the same answer: keep them small and truncate loudly.
 */
const MAX_RECORD_BYTES = 8_000
const MAX_STRING_CHARS = 400
const MAX_ARRAY_ITEMS = 20
const MAX_DEPTH = 4

/**
 * Redaction is unconditional, not a level. A log is the artefact most likely to
 * be pasted into a conversation, an issue, or a future upload, and a bearer
 * token that only leaks at `debug` still leaks.
 */
const SECRET_KEY_PATTERN = /secret|token|password|authorization|credential|verifier|api[_-]?key/i
const MACHINE_TOKEN_PATTERN = /nfm_[A-Za-z0-9._-]{6,}/g
/** Notification and question content: persist length, never the words. */
const CONTENT_STRING_KEYS = new Set(['title', 'subtitle', 'body', 'text', 'question'])
/** Choice labels, reply answers, and raw argv: persist counts, never values. */
const CONTENT_LIST_KEYS = new Set(['answers', 'choices', 'argv'])

export const REDACTED = '[redacted]'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function logsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), 'logs')
}

export function activeLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(logsDir(env), 'notifai.jsonl')
}

/**
 * Archives are timestamp-named so lexical order is chronological order — the
 * reader needs no `stat` to walk them, and two processes rotating at once
 * cannot collide on a name.
 */
const ARCHIVE_PATTERN = /^notifai-\d{8}T\d{9}Z-[0-9a-f]{4}\.jsonl$/

function archiveName(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, '')
  return `notifai-${stamp}-${randomBytes(2).toString('hex')}.jsonl`
}

/** Archives, oldest first. */
export function archiveLogPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = logsDir(env)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((name) => ARCHIVE_PATTERN.test(name))
    .sort()
    .map((name) => path.join(dir, name))
}

// ---------------------------------------------------------------------------
// Redaction and shaping
// ---------------------------------------------------------------------------

function redactString(value: string): string {
  const scrubbed = value.replace(MACHINE_TOKEN_PATTERN, 'nfm_[redacted]')
  if (scrubbed.length <= MAX_STRING_CHARS) return scrubbed
  return `${scrubbed.slice(0, MAX_STRING_CHARS)}…(+${scrubbed.length - MAX_STRING_CHARS} chars)`
}

/**
 * Flag names only — argv values are notification content and user text.
 *
 * `--title=SECRET` must become `--title`. Filtering on a `--` prefix is not
 * enough: inline assignment would otherwise persist the value.
 */
export function argvFlagNames(argv: readonly string[]): string[] {
  const names: string[] = []
  for (const token of argv) {
    if (!token.startsWith('--') || token === '--') continue
    const eq = token.indexOf('=')
    names.push(eq === -1 ? token : token.slice(0, eq))
  }
  return names
}

/**
 * Shape a value for the record: drop what must never be written, truncate what
 * would flood a reader, and refuse to recurse for ever into a cyclic object.
 */
export function shape(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (value instanceof Error) return redactString(`${value.name}: ${value.message}`)
  if (depth >= MAX_DEPTH) return '[deep]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => shape(item, depth + 1))
    return value.length > MAX_ARRAY_ITEMS ? [...items, `…(+${value.length - MAX_ARRAY_ITEMS} more)`] : items
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested === undefined) continue
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = REDACTED
        continue
      }
      if (CONTENT_STRING_KEYS.has(key) && typeof nested === 'string') {
        out[`${key}_chars`] = nested.length
        continue
      }
      if (key === 'argv' && Array.isArray(nested)) {
        out.flags = argvFlagNames(
          nested.filter((token): token is string => typeof token === 'string'),
        )
        out.argv_count = nested.length
        continue
      }
      if (CONTENT_LIST_KEYS.has(key) && Array.isArray(nested)) {
        out[`${key}_count`] = nested.length
        continue
      }
      out[key] = shape(nested, depth + 1)
    }
    return out
  }
  return String(value)
}

/**
 * A record as one line, guaranteed to fit a single write. An oversized payload
 * loses its data rather than its line: knowing an event happened and that its
 * detail was too large beats losing the event.
 */
export function serialize(record: LogRecord): string {
  const line = `${JSON.stringify(record)}\n`
  if (Buffer.byteLength(line) <= MAX_RECORD_BYTES) return line
  const trimmed: LogRecord = {
    ...record,
    data: { dropped: 'record exceeded the per-line cap', bytes: Buffer.byteLength(line) },
  }
  return `${JSON.stringify(trimmed)}\n`
}

// ---------------------------------------------------------------------------
// The logger
// ---------------------------------------------------------------------------

export interface LogSettings {
  level: LogLevel
  maxBytes: number
  /** Files kept in total, active included. */
  maxFiles: number
}

export interface LoggerBindings {
  cmd?: string
  project?: string | null
  session?: string | null
}

export interface Logger {
  /** Correlation id for this invocation; print it in error messages. */
  readonly runId: string
  /** False when the level is `off` or the sink has failed. */
  readonly enabled: boolean
  error(event: LogEvent, data?: Record<string, unknown>): void
  info(event: LogEvent, data?: Record<string, unknown>): void
  debug(event: LogEvent, data?: Record<string, unknown>): void
  /** Attach fields to every later record: command, project, session. */
  bind(fields: LoggerBindings): void
  /** Adopt settings from a config resolved later (a hook's project, not ours). */
  adopt(settings: Partial<LogSettings>): void
}

/** Everything the sink needs, so tests can drive it without a clock or a disk. */
export interface LoggerOptions {
  env?: NodeJS.ProcessEnv
  settings?: Partial<LogSettings>
  now?: () => number
  cmd?: string
  runId?: string
}

export const DEFAULT_LOG_SETTINGS: LogSettings = {
  level: 'info',
  maxBytes: 2_000_000,
  maxFiles: 3,
}

/** A logger that records nothing, for tests and for `log_level = off`. */
export function nullLogger(runId = 'r_none'): Logger {
  return {
    runId,
    enabled: false,
    error: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    bind: () => undefined,
    adopt: () => undefined,
  }
}

export function newRunId(): string {
  return `r_${randomBytes(6).toString('hex')}`
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  const runId = options.runId ?? newRunId()
  const settings: LogSettings = { ...DEFAULT_LOG_SETTINGS, ...options.settings }
  const bindings: LoggerBindings = { cmd: options.cmd ?? 'notifai' }

  const dir = logsDir(env)
  const active = activeLogPath(env)
  const lock = `${active}.lock`
  let broken = false

  function currentSize(): number {
    try {
      return statSync(active).size
    } catch {
      return 0
    }
  }

  /**
   * Keep the inode handoff and retention prune inside the caller's byte-budget
   * transaction, so every writer agrees which history the fresh file replaces.
   */
  function rotate(): string | null {
    const target = path.join(dir, archiveName(now()))
    try {
      renameSync(active, target)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw err
      return null
    }
    const keep = Math.max(0, settings.maxFiles - 1)
    const archives = archiveLogPaths(env)
    for (const stale of archives.slice(0, Math.max(0, archives.length - keep))) {
      try {
        unlinkSync(stale)
      } catch {
        // An external cleaner removed it; the retained-file bound still holds.
      }
    }
    return path.basename(target)
  }

  function write(level: RecordLevel, event: LogEvent, data?: Record<string, unknown>): void {
    if (broken || LEVEL_RANK[settings.level] < LEVEL_RANK[level]) return
    try {
      const record: LogRecord = {
        v: LOG_SCHEMA_VERSION,
        ts: new Date(now()).toISOString(),
        level,
        event,
        run: runId,
        cmd: bindings.cmd ?? 'notifai',
        pid: process.pid,
        ...(bindings.project ? { project: bindings.project } : {}),
        ...(bindings.session ? { session: bindings.session } : {}),
        ...(data === undefined ? {} : { data: shape(data) as Record<string, unknown> }),
      }
      const line = serialize(record)
      const bytes = Buffer.byteLength(line)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      withFileLock(lock, () => {
        let payload = line
        if (currentSize() + bytes > settings.maxBytes) {
          const rotated = rotate()
          if (rotated !== null) {
            const marker = serialize({
              ...record,
              event: 'log.rotated',
              data: { archived_to: rotated },
            })
            // A marker is diagnostic, not permission to violate the cap. The
            // product configuration cannot make this branch drop it — maxBytes
            // is at least 64 KB and each line is at most 8 KB — but tiny injected
            // test settings may not have room for both atomic records.
            if (Buffer.byteLength(marker) + bytes <= settings.maxBytes) payload = marker + line
          }
        }
        // One record cannot be split without corrupting JSONL. If an internal
        // caller injects maxBytes below that record's size, this one-record file
        // is the only unavoidable overshoot. Valid CLI configuration makes the
        // invariant unreachable (64 KB minimum versus an 8 KB record cap).
        appendFileSync(active, payload, { mode: 0o600, flag: 'a' })
      })
    } catch {
      // One failure is enough: a sink that cannot write will not start working
      // mid-command, and retrying it on every event would cost the hook path
      // real time for nothing.
      broken = true
    }
  }

  return {
    runId,
    get enabled() {
      return !broken && settings.level !== 'off'
    },
    error: (event, data) => write('error', event, data),
    info: (event, data) => write('info', event, data),
    debug: (event, data) => write('debug', event, data),
    bind: (fields) => Object.assign(bindings, fields),
    adopt: (next) => Object.assign(settings, next),
  }
}

/** Log settings as the layered config resolved them. */
export function logSettingsFrom(config: CliConfig): LogSettings {
  return {
    level: config.log_level.value,
    maxBytes: config.log_max_bytes.value,
    maxFiles: config.log_max_files.value,
  }
}

const lastResolvedConfig = new WeakMap<Logger, string>()

/** Record each distinct resolution once per invocation when debug logging is on. */
export function logConfigResolved(logger: Logger, config: CliConfig): void {
  const values = Object.fromEntries(
    CONFIG_KEYS.map((key) => [
      key,
      { value: config[key].value, source: config[key].source },
    ]),
  )
  const fingerprint = JSON.stringify(values)
  if (lastResolvedConfig.get(logger) === fingerprint) return
  lastResolvedConfig.set(logger, fingerprint)
  logger.debug('config.resolved', { values })
}

/**
 * The logger for a CLI invocation, configured from disk.
 *
 * It loads config itself rather than being handed one, because the earliest
 * thing worth logging is the command starting — which is before any command has
 * resolved anything, and sometimes before a config file that fails to parse has
 * been discovered. A config that throws leaves the defaults in place; it is
 * reported by the command that needed it, not silently swallowed here.
 */
export function bootstrapLogger(options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Logger {
  const env = options.env ?? process.env
  let settings: Partial<LogSettings> = {}
  let project: string | null = null
  try {
    const config = loadConfig({ cwd: options.cwd ?? process.cwd(), env })
    settings = logSettingsFrom(config)
    project = config.project.value
  } catch {
    // Defaults, and the command reports the parse failure in its own words.
  }
  // Keep a real, mutable logger even when this bootstrap directory says off.
  // Harness payloads can resolve a more-specific project or session later and
  // adopt settings that legitimately re-enable the same invocation.
  const logger = createLogger({ env, settings })
  if (project !== null) logger.bind({ project })
  return logger
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface LogQuery {
  /** Newest N matching records. Bounded on purpose. */
  limit?: number
  /** Epoch milliseconds; records older than this are not returned. */
  since?: number
  /** Minimum severity, e.g. `error` for failures only. */
  level?: LogLevel
  event?: readonly string[]
  run?: string
  session?: string
  project?: string
  /** Matches a notification request id exactly in structured event data. */
  request?: string
  /** Free-text match over the serialized record. */
  contains?: string
}

export interface LogReadResult {
  /** Oldest first, so the result reads as a narrative and ends with `tail`. */
  records: LogRecord[]
  /** Files consulted, newest first. */
  files: string[]
  /** True when the limit cut the result short — there is more history behind it. */
  more: boolean
}

function containsExactString(value: unknown, expected: string): boolean {
  if (typeof value === 'string') return value === expected
  if (Array.isArray(value)) return value.some((item) => containsExactString(item, expected))
  return false
}

const REQUEST_ID_KEYS = new Set(['request_id', 'request_ids', 'retires_request_id'])

/** Match identity fields, never prose that happens to mention the same token. */
function containsRequestIdentity(value: unknown, expected: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (REQUEST_ID_KEYS.has(key) && containsExactString(nested, expected)) return true
    if (containsRequestIdentity(nested, expected)) return true
  }
  return false
}

function matches(record: LogRecord, raw: string, query: LogQuery): boolean {
  if (query.level !== undefined && LEVEL_RANK[record.level] > LEVEL_RANK[query.level]) return false
  if (query.event !== undefined && query.event.length > 0 && !query.event.includes(record.event)) return false
  if (query.run !== undefined && record.run !== query.run) return false
  if (query.session !== undefined && record.session !== query.session) return false
  if (query.project !== undefined && record.project !== query.project) return false
  if (query.request !== undefined && !containsRequestIdentity(record.data, query.request)) return false
  if (query.contains !== undefined && !raw.toLowerCase().includes(query.contains.toLowerCase())) return false
  return true
}

function isRecord(parsed: unknown): parsed is LogRecord {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { v?: unknown }).v === LOG_SCHEMA_VERSION &&
    typeof (parsed as { event?: unknown }).event === 'string' &&
    typeof (parsed as { ts?: unknown }).ts === 'string'
  )
}

/**
 * Newest matching records, walking the active file and then the archives
 * backwards and stopping as soon as the limit is met.
 *
 * A partially written or corrupt line is skipped rather than fatal. The point
 * of a line-oriented log is that damage stays on its own line, and a reader
 * that throws on one bad byte throws away everything else that was fine.
 */
export function readLogRecords(
  env: NodeJS.ProcessEnv = process.env,
  query: LogQuery = {},
): LogReadResult {
  const limit = query.limit ?? 50
  const files = [activeLogPath(env), ...archiveLogPaths(env).reverse()]
  const collected: LogRecord[] = []
  const consulted: string[] = []
  let more = false

  for (const file of files) {
    if (collected.length >= limit) {
      more = true
      break
    }
    let contents: string
    try {
      contents = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    consulted.push(file)
    const lines = contents.split('\n')
    let reachedFloor = false
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const raw = lines[index]
      if (raw === undefined || raw.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      if (!isRecord(parsed)) continue
      if (query.since !== undefined && Date.parse(parsed.ts) < query.since) {
        // Files are chronological, so everything behind this is older too.
        reachedFloor = true
        break
      }
      if (!matches(parsed, raw, query)) continue
      if (collected.length >= limit) {
        more = true
        break
      }
      collected.push(parsed)
    }
    if (reachedFloor) break
  }

  return { records: collected.reverse(), files: consulted, more }
}

/** Bytes currently held by the logs, for `doctor` and for `logs --path`. */
export function logsDiskUsage(env: NodeJS.ProcessEnv = process.env): { files: number; bytes: number } {
  let bytes = 0
  let files = 0
  for (const file of [activeLogPath(env), ...archiveLogPaths(env)]) {
    try {
      bytes += statSync(file).size
      files += 1
    } catch {
      // Not there; it simply does not count.
    }
  }
  return { files, bytes }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LEVEL_MARK: Record<RecordLevel, string> = { error: '!', info: ' ', debug: '·' }

/** `key=value` pairs for the parts of `data` worth a glance, bounded in width. */
function summarize(data: Record<string, unknown> | undefined, width: number): string {
  if (data === undefined) return ''
  const parts: string[] = []
  let used = 0
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue
    const rendered =
      typeof value === 'object' ? JSON.stringify(value) : String(value)
    const flattened = rendered.replace(/\s+/g, ' ')
    const piece = `${key}=${flattened.length > 60 ? `${flattened.slice(0, 60)}…` : flattened}`
    if (used + piece.length > width) {
      parts.push('…')
      break
    }
    parts.push(piece)
    used += piece.length + 1
  }
  return parts.join(' ')
}

/**
 * One record, one line. The fixed left columns matter more than they look:
 * aligned columns are what let a reader — human or model — scan for the one
 * line that differs instead of reading every line.
 */
export function renderRecord(record: LogRecord): string {
  const when = record.ts.replace('T', ' ').replace(/\.\d+Z$/, '')
  const event = record.event.padEnd(15)
  const summary = summarize(record.data, 110)
  return `${when} ${LEVEL_MARK[record.level]} ${event} ${summary}`.trimEnd()
}
