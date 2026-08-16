import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { REPLY_MAX_WINDOW_SECONDS } from '@raidiant/notifai-protocol'
import type { CLI_SOUNDS, INTERRUPTION_LEVELS } from '@raidiant/notifai-protocol'
import { configHome, stateHome } from './platform.js'

/**
 * Layered configuration with provenance. Most specific wins:
 *
 *   flag > session > project-local > project > machine-global > default
 *
 * `session` holds what the user told the agent in conversation ("stop
 * notifying me for now"). It lives on disk keyed by harness session id rather
 * than in the agent's context, because context is lost to compaction and a
 * preference that evaporates mid-session is worse than none.
 *
 * `project-local` is a personal file under the user's config directory, keyed
 * by the project root so a checkout does not have to gitignore anything. Shared
 * `.notifai/config.toml` stays in the tree for committed project identity.
 *
 * `config show --explain` surfaces the winning layer per key.
 */

export type ConfigSource =
  | 'flag'
  | 'env'
  | `session:${string}`
  | `project-local:${string}`
  | `project:${string}`
  | `global:${string}`
  | 'default'

export interface ResolvedValue<T> {
  value: T
  source: ConfigSource
}

type CliSound = (typeof CLI_SOUNDS)[number]
type CliInterruptionLevel = (typeof INTERRUPTION_LEVELS)[number]

/**
 * How much the local log records. Defined here rather than in `logging.ts`
 * because it is a configuration vocabulary first — `logging.ts` reads config,
 * so the dependency has to point this way.
 */
export const LOG_LEVELS = ['off', 'error', 'info', 'debug'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export interface CliConfig {
  base_url: ResolvedValue<string>
  wait_seconds: ResolvedValue<number>
  ttl_seconds: ResolvedValue<number>
  collapse_key: ResolvedValue<string | null>
  devices: ResolvedValue<string[] | null>
  sound: ResolvedValue<CliSound | null>
  interruption_level: ResolvedValue<CliInterruptionLevel | null>
  /** Project identifier stamped on sends; typically set in .notifai/config.toml. */
  project: ResolvedValue<string | null>
  /** Free-text notification criteria agents consult before sending. */
  notify_criteria: ResolvedValue<string | null>
  /** Whether a registered agent question may reach companion devices at all. */
  ask_notifications: ResolvedValue<boolean>
  /**
   * Terminal-first grace window, measured from the moment the question was
   * sent: the agent asks in the terminal and starts a timer, and only once it
   * elapses does the question reach companion devices.
   *
   * A timer, and only a timer. Whether the user happens to be at this keyboard
   * decides nothing — the waiter no longer holds their terminal, so there is
   * nothing for their presence to protect them from.
   */
  ask_grace_seconds: ResolvedValue<number>
  /**
   * How much of what this CLI does is recorded to the local log.
   *
   * The log exists for agents: a hook runs headless and its most consequential
   * act is usually a decision to do nothing, which leaves no other trace. `off`
   * disables the sink entirely; `debug` adds config resolution and request
   * detail, which is verbose enough to want a reason.
   */
  log_level: ResolvedValue<LogLevel>
  /**
   * Bytes the active log file may reach before it is rotated. With
   * `log_max_files` this is the whole disk budget — nothing here grows without
   * a ceiling, because a log that fills a disk is a bug that outlives its
   * usefulness.
   */
  log_max_bytes: ResolvedValue<number>
  /** How long the server keeps accepting an answer to a question. */
  reply_window_seconds: ResolvedValue<number>
  /** Log files kept in total, the active one included. */
  log_max_files: ResolvedValue<number>
}

export const CONFIG_KEYS = [
  'wait_seconds',
  'ttl_seconds',
  'collapse_key',
  'devices',
  'sound',
  'interruption_level',
  'project',
  'notify_criteria',
  'ask_notifications',
  'ask_grace_seconds',
  'reply_window_seconds',
  'log_level',
  'log_max_bytes',
  'log_max_files',
] as const
export type ConfigKey = (typeof CONFIG_KEYS)[number]

/** Keys whose TOML value must parse as a boolean; used by `config set`. */
export const BOOLEAN_CONFIG_KEYS: readonly ConfigKey[] = ['ask_notifications']

/** Keys whose TOML value must parse as an integer within its configured bounds. */
export const NUMERIC_CONFIG_KEYS: readonly ConfigKey[] = [
  'wait_seconds',
  'ttl_seconds',
  'ask_grace_seconds',
  'reply_window_seconds',
  'log_max_bytes',
  'log_max_files',
]

/**
 * Keys whose value must be one of a fixed set.
 *
 * Config is readable from a repository, so an unrecognised value is untrusted
 * input rather than a typo — `coerce` drops it and the layer below wins, which
 * is the same discipline the numeric bounds follow.
 */
export const ENUM_CONFIG_VALUES: Partial<Record<ConfigKey, readonly string[]>> = {
  log_level: LOG_LEVELS,
}

/** Compiled service origin. Not a user-facing setting; override with `--base-url` or `NOTIFAI_BASE_URL`. */
export const DEFAULT_BASE_URL = 'https://notifai.fly.dev'

const DEFAULTS = {
  wait_seconds: 10,
  ttl_seconds: 86400,
  collapse_key: null,
  devices: null,
  sound: null,
  interruption_level: null,
  project: null,
  notify_criteria: null,
  // Installing the hooks is the opt-in; these exist to switch the behaviour
  // back off for a project or a session without uninstalling anything.
  ask_notifications: true,
  // Questions reach devices as soon as the turn ends. A terminal-first grace
  // window is an opt-in delay on top of that.
  ask_grace_seconds: 0,
  // A day. The wire contract's own default, and long enough that a question
  // asked before someone steps away is still answerable when they come back.
  reply_window_seconds: 86_400,
  // On by default: the log is the only account of what a headless hook did, and
  // a diagnostic nobody switched on before the thing went wrong is not one.
  log_level: 'info',
  // 2 MB × 3 files caps the logs at roughly 6 MB, which is weeks of ordinary
  // agent traffic and small enough that nobody has to think about it.
  log_max_bytes: 2_000_000,
  log_max_files: 3,
} satisfies Record<ConfigKey, unknown>

/** The shipped value beneath every user-controlled configuration layer. */
export function configDefaultValue(key: ConfigKey): unknown {
  return DEFAULTS[key]
}

export function globalConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(configHome(env, platform), 'notifai')
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(globalConfigDir(env), 'config.toml')
}

/**
 * Machine-local mutable state: presence markers, pending questions, and
 * session config overrides. Separate from the config dir because none of it is
 * user-authored and none of it should ever be synced or committed.
 */
export function stateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(stateHome(env, platform), 'notifai')
}

/** Per-harness-session override file; see the ConfigSource doc comment. */
export function sessionConfigPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.config.toml`)
}

/**
 * Session ids come from harness JSON, so they reach the filesystem from
 * outside. Hash rather than merely sanitising: replacing unsafe characters
 * collapsed distinct ids onto one file — `a/b` and `a?b` both became `a_b`, and
 * two sessions would then share presence, pending questions and overrides.
 * A readable prefix is kept only so the directory is debuggable.
 */
export function sanitizeSessionId(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
  const readable = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
  return readable === '' ? digest : `${readable}-${digest}`
}

/**
 * Pointer from a project directory to the harness session currently working in
 * it, written by the UserPromptSubmit hook. Without it `notifai ask` has no way
 * to learn its own session id: an ordinary agent shell command receives no hook
 * payload, and no harness exports one into the environment.
 */
export function projectSessionPointerPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const digest = createHash('sha256').update(canonicalDir(cwd)).digest('hex').slice(0, 32)
  return path.join(stateDir(env), 'projects', `${digest}.json`)
}

/**
 * Resolve symlinks before hashing. The harness reports `cwd` as it knows it
 * while a shell reports `process.cwd()` already resolved — on macOS `/tmp` and
 * `/private/tmp` are the same directory, so hashing the unresolved paths gave
 * two different keys and `notifai ask` could never find the pointer the hook
 * had just written.
 */
function canonicalDir(dir: string): string {
  try {
    return realpathSync(path.resolve(dir))
  } catch {
    return path.resolve(dir)
  }
}

/** Walk up from cwd looking for .notifai/<name> (Project Override). */
function findProjectFile(startDir: string, name: string): string | null {
  let dir = path.resolve(startDir)
  for (;;) {
    const candidate = path.join(dir, '.notifai', name)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function findProjectConfigPath(startDir: string): string | null {
  return findProjectFile(startDir, 'config.toml')
}

/** Walk up from cwd looking for a `.git` file or directory (worktree or checkout). */
function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir)
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return canonicalDir(dir)
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Stable identity for personal project preferences.
 *
 * Prefer the directory that owns the shared `.notifai/config.toml`, then the
 * git checkout root, then cwd. Subdirectories of one project therefore share
 * one personal file, and nothing is written inside the repository.
 */
export function personalProjectIdentity(cwd: string): string {
  const projectConfig = findProjectConfigPath(cwd)
  const root =
    projectConfig !== null ? path.dirname(path.dirname(projectConfig)) : (findGitRoot(cwd) ?? cwd)
  return createHash('sha256').update(canonicalDir(root)).digest('hex').slice(0, 32)
}

/** Personal project layer: `$XDG_CONFIG_HOME/notifai/projects/<identity>.toml`. */
export function personalProjectConfigPath(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(globalConfigDir(env), 'projects', `${personalProjectIdentity(cwd)}.toml`)
}

/** Existing personal project file, or null when this checkout has none. */
export function findProjectLocalConfigPath(
  startDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const file = personalProjectConfigPath(startDir, env)
  return existsSync(file) ? file : null
}

/**
 * Ranges every layer is clamped to. Config is readable from a repository, so an
 * out-of-range value is attacker input, not a typo: an unbounded grace window
 * would consume the waiter's whole ceiling and silently leave no time at all in
 * which the user's answer could still be accepted.
 */
const NUMERIC_BOUNDS: Partial<Record<ConfigKey, { min: number; max: number }>> = {
  wait_seconds: { min: 0, max: 300 },
  ttl_seconds: { min: 0, max: 7 * 24 * 3600 },
  // A plain number, no longer derived from a hook budget's leftovers. Six
  // minutes leaves two clear minutes of the waiter's 480s ceiling, so the
  // longest window a user can choose still leaves an answer window the server
  // will accept — with room to spare for a timer that wakes late.
  ask_grace_seconds: { min: 0, max: 360 },
  // The floor is the shortest window the wire contract accepts; the ceiling is
  // the point past which a question would outlive the retained content it
  // refers to.
  reply_window_seconds: { min: 60, max: REPLY_MAX_WINDOW_SECONDS },
  // The floor keeps rotation from thrashing (a file smaller than a handful of
  // records would rotate on nearly every write); the ceiling is the point past
  // which "local diagnostics" has become "a database on your disk".
  log_max_bytes: { min: 64_000, max: 100_000_000 },
  log_max_files: { min: 1, max: 20 },
}

/** Drops values a layer must not be trusted to supply, rather than throwing. */
function coerce(key: ConfigKey, value: unknown): unknown | undefined {
  const bounds = NUMERIC_BOUNDS[key]
  if (bounds !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)))
  }
  if (BOOLEAN_CONFIG_KEYS.includes(key)) return typeof value === 'boolean' ? value : undefined
  const allowed = ENUM_CONFIG_VALUES[key]
  if (allowed !== undefined) {
    return typeof value === 'string' && allowed.includes(value) ? value : undefined
  }
  return value
}

export function configBounds(key: ConfigKey): { min: number; max: number } | undefined {
  return NUMERIC_BOUNDS[key]
}

function readTomlFile(filePath: string): Record<string, unknown> {
  try {
    return parseToml(readFileSync(filePath, 'utf8')) as Record<string, unknown>
  } catch (err) {
    throw new Error(`Could not parse ${filePath}: ${String(err)}`)
  }
}

export interface FlagOverrides {
  base_url?: string
  wait_seconds?: number
  ttl_seconds?: number
  collapse_key?: string | null
  devices?: string[]
  sound?: CliSound
  interruption_level?: CliInterruptionLevel
}

/**
 * Service origin is not a user setting. Flag and env are developer/self-host
 * overrides; signed-in traffic still pins to the credential origin elsewhere.
 */
function resolveServiceUrl(
  flags: FlagOverrides,
  env: NodeJS.ProcessEnv,
): ResolvedValue<string> {
  if (typeof flags.base_url === 'string' && flags.base_url !== '') {
    return { value: flags.base_url, source: 'flag' }
  }
  const fromEnv = env['NOTIFAI_BASE_URL']
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return { value: fromEnv, source: 'env' }
  }
  return { value: DEFAULT_BASE_URL, source: 'default' }
}

export function loadConfig(options: {
  cwd?: string
  env?: NodeJS.ProcessEnv
  flags?: FlagOverrides
  /** Harness session id; enables the session override layer when present. */
  sessionId?: string | undefined
}): CliConfig {
  const env = options.env ?? process.env
  const flags = options.flags ?? {}
  const globalPath = globalConfigPath(env)
  const globalRaw = existsSync(globalPath) ? readTomlFile(globalPath) : {}
  const cwd = options.cwd ?? process.cwd()
  const projectPath = findProjectConfigPath(cwd)
  const projectRaw = projectPath ? readTomlFile(projectPath) : {}
  const projectLocalPath = findProjectLocalConfigPath(cwd, env)
  const projectLocalRaw = projectLocalPath ? readTomlFile(projectLocalPath) : {}
  const sessionId = options.sessionId ?? env['NOTIFAI_SESSION_ID']
  const sessionPath = sessionId ? sessionConfigPath(sessionId, env) : null
  const sessionRaw = sessionPath && existsSync(sessionPath) ? readTomlFile(sessionPath) : {}

  function resolve<K extends ConfigKey>(key: K): ResolvedValue<never> {
    const layers: [unknown, ConfigSource][] = [
      [(flags as Record<string, unknown>)[key], 'flag'],
      [sessionPath ? sessionRaw[key] : undefined, `session:${sessionPath ?? ''}`],
      [projectLocalPath ? projectLocalRaw[key] : undefined, `project-local:${projectLocalPath ?? ''}`],
      [projectPath ? projectRaw[key] : undefined, `project:${projectPath ?? ''}`],
      [globalRaw[key], `global:${globalPath}`],
    ]
    for (const [raw, source] of layers) {
      if (raw === undefined) continue
      const coerced = coerce(key, raw)
      if (coerced === undefined) continue
      return { value: coerced as never, source }
    }
    return { value: DEFAULTS[key] as never, source: 'default' }
  }

  return {
    base_url: resolveServiceUrl(flags, env),
    wait_seconds: resolve('wait_seconds'),
    ttl_seconds: resolve('ttl_seconds'),
    collapse_key: resolve('collapse_key'),
    devices: resolve('devices'),
    sound: resolve('sound'),
    interruption_level: resolve('interruption_level'),
    project: resolve('project'),
    notify_criteria: resolve('notify_criteria'),
    ask_notifications: resolve('ask_notifications'),
    ask_grace_seconds: resolve('ask_grace_seconds'),
    reply_window_seconds: resolve('reply_window_seconds'),
    log_level: resolve('log_level'),
    log_max_bytes: resolve('log_max_bytes'),
    log_max_files: resolve('log_max_files'),
  }
}
