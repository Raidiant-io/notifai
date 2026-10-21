import {
  INTERRUPTION_LEVELS,
  REPLY_MAX_WINDOW_SECONDS,
} from '@raidiant/notifai-protocol'
import { gitQuery } from './git-query.js'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { canonicalPath } from './local-path.js'
import { parse as parseToml } from 'smol-toml'
import { accountHome, configHome, stateHome } from './platform.js'
import { isCliSoundRef } from './sound-ref.js'
import { normalizeOrigin } from './url-policy.js'

/**
 * Layered configuration with provenance. Most specific wins:
 *
 *   flag > session > project-local > machine-global > default
 *
 * `session` holds what the user told the agent in conversation ("stop
 * notifying me for now"). It lives on disk keyed by harness session id rather
 * than in the agent's context, because context is lost to compaction and a
 * preference that evaporates mid-session is worse than none.
 *
 * `project-local` is a personal file under the user's config directory, keyed
 * by the Project root so a checkout does not have to gitignore anything. Every
 * layer belongs to the User: a repository cannot supply configuration, so
 * nothing committed to a checkout is read.
 *
 * `config show --explain` surfaces the winning layer per key.
 */

export type ConfigSource =
  | 'flag'
  | 'env'
  | `session:${string}`
  | `project-local:${string}`
  | `global:${string}`
  | 'default'

export interface ResolvedValue<T> {
  value: T
  source: ConfigSource
}

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
  sound: ResolvedValue<string | null>
  interruption_level: ResolvedValue<CliInterruptionLevel | null>
  /** Project identifier stamped on sends; inferred unless the User configured one. */
  project: ResolvedValue<string | null>
  /** Whether a registered agent question may reach companion devices at all. */
  ask_notifications: ResolvedValue<boolean>
  /**
   * Terminal-first delay, measured from the moment the question was
   * sent: the agent asks in the terminal and starts a timer, and only once it
   * elapses does the question reach companion devices.
   *
   * A timer, and only a timer. Whether the user happens to be at this keyboard
   * decides nothing; the harness-specific owner continues waiting either in
   * the held turn or out of band.
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
  /** How long the server accepts an answer and Question Routing owns its return path. */
  reply_window_seconds: ResolvedValue<number>
  /** Log files kept in total, the active one included. */
  log_max_files: ResolvedValue<number>
  /**
   * Extra origins remote `--image` URLs may use beyond the default public
   * HTTPS policy — the self-host and intranet escape hatch.
   */
  media_origins: ResolvedValue<string[]>
  /**
   * Extra dashboard origins a pairing approval URL may open, for self-hosts
   * whose dashboard lives on a different origin than the API.
   */
  approve_origins: ResolvedValue<string[]>
  /**
   * Whether this machine installs Notifai updates by itself. Machine-wide:
   * only this machine's own configuration file is read (see
   * `MACHINE_ONLY_CONFIG_KEYS`), because the runtime belongs to the machine.
   */
  'updates.automatic': ResolvedValue<boolean>
  /**
   * Reopening a conversation that its app or the machine stopped, when an
   * answer or note arrives for it (see `session-reopen.ts`). Machine-wide,
   * like `updates.automatic`: the master switch, then one policy per place.
   */
  'reopen.automatic': ResolvedValue<boolean>
  'reopen.terminal': ResolvedValue<ReopenTerminalPolicy>
  'reopen.codex_app': ResolvedValue<ReopenCodexAppPolicy>
  'reopen.terminal_app': ResolvedValue<ReopenTerminalApp>
  'reopen.terminal_command': ResolvedValue<string | null>
  'reopen.focus': ResolvedValue<ReopenFocus>
  'reopen.permission_mode': ResolvedValue<ReopenPermissionMode>
}

export const REOPEN_TERMINAL_POLICIES = ['automatic', 'off'] as const
export type ReopenTerminalPolicy = (typeof REOPEN_TERMINAL_POLICIES)[number]
export const REOPEN_CODEX_APP_POLICIES = ['when-running', 'off'] as const
export type ReopenCodexAppPolicy = (typeof REOPEN_CODEX_APP_POLICIES)[number]
export const REOPEN_TERMINAL_APPS = ['auto', 'terminal', 'iterm2', 'ghostty', 'wezterm', 'kitty', 'alacritty', 'gnome-terminal', 'konsole', 'custom'] as const
export type ReopenTerminalApp = (typeof REOPEN_TERMINAL_APPS)[number]
export const REOPEN_FOCUS = ['background', 'front'] as const
export type ReopenFocus = (typeof REOPEN_FOCUS)[number]
export const REOPEN_PERMISSION_MODES = ['same', 'default'] as const
export type ReopenPermissionMode = (typeof REOPEN_PERMISSION_MODES)[number]

export const CONFIG_KEYS = [
  'wait_seconds',
  'ttl_seconds',
  'collapse_key',
  'devices',
  'sound',
  'interruption_level',
  'project',
  'ask_notifications',
  'ask_grace_seconds',
  'reply_window_seconds',
  'log_level',
  'log_max_bytes',
  'log_max_files',
  'media_origins',
  'approve_origins',
  'updates.automatic',
  'reopen.automatic',
  'reopen.terminal',
  'reopen.codex_app',
  'reopen.terminal_app',
  'reopen.terminal_command',
  'reopen.focus',
  'reopen.permission_mode',
] as const
export type ConfigKey = (typeof CONFIG_KEYS)[number]

/**
 * Keys that belong to the machine rather than to any Project or Agent Session.
 * Only the machine-global file is read for them, and `config set` refuses the
 * personal-project and session layers. The Notifai runtime is shared by every
 * Project on the machine, so no single Project or conversation may decide what
 * runs on it.
 */
export const MACHINE_ONLY_CONFIG_KEYS: readonly ConfigKey[] = ['updates.automatic', 'reopen.automatic', 'reopen.terminal', 'reopen.codex_app',
  'reopen.terminal_app', 'reopen.terminal_command', 'reopen.focus', 'reopen.permission_mode']

/** Keys whose TOML value must be a list of normalized http(s) origins. */
export const ORIGIN_LIST_CONFIG_KEYS: readonly ConfigKey[] = ['media_origins', 'approve_origins']

/** Keys whose TOML value must parse as a boolean; used by `config set`. */
export const BOOLEAN_CONFIG_KEYS: readonly ConfigKey[] = ['ask_notifications', 'updates.automatic', 'reopen.automatic']

/** Machine-wide switches that also read naturally as `on` and `off`. */
export const ON_OFF_CONFIG_KEYS: readonly ConfigKey[] = ['updates.automatic', 'reopen.automatic']

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
 * An unrecognised value is dropped by `coerce` and the layer below wins, the
 * same discipline the numeric bounds follow: a hand-edited typo never reaches a
 * send.
 */
export const ENUM_CONFIG_VALUES: Partial<Record<ConfigKey, readonly string[]>> = {
  interruption_level: INTERRUPTION_LEVELS,
  log_level: LOG_LEVELS,
  'reopen.terminal': REOPEN_TERMINAL_POLICIES,
  'reopen.codex_app': REOPEN_CODEX_APP_POLICIES,
  'reopen.terminal_app': REOPEN_TERMINAL_APPS,
  'reopen.focus': REOPEN_FOCUS,
  'reopen.permission_mode': REOPEN_PERMISSION_MODES,
}

/** Compiled service origin. Not a user-facing setting; login may override with `--base-url` or `NOTIFAI_BASE_URL`. */
export const DEFAULT_BASE_URL = 'https://api.notifai.sh'

const DEFAULTS = {
  wait_seconds: 10,
  ttl_seconds: 86400,
  collapse_key: null,
  devices: null,
  sound: null,
  interruption_level: null,
  project: null,
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
  // Empty by default: remote images use public HTTPS and pairing approval
  // uses the canonical dashboard, the pairing origin, or loopback. Entries
  // here are the User widening that.
  media_origins: [],
  approve_origins: [],
  // On by default ("Fully automatic, toggleable", 2026-10-19). The
  // hub installs a newer build on the saved channel unless it would change hooks.
  'updates.automatic': true,
  // Reopen in place by default (2026-10-20): a terminal the machine took down
  // comes back in a new window, in the background, in the mode it last ran in.
  'reopen.automatic': true,
  'reopen.terminal': 'automatic',
  'reopen.codex_app': 'when-running',
  'reopen.terminal_app': 'auto',
  'reopen.terminal_command': null,
  'reopen.focus': 'background',
  'reopen.permission_mode': 'same',
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
 * Machine-local mutable state: presence markers, pending questions, frozen
 * session names, and session config overrides. Separate from the config dir
 * because none of it should ever be synced or committed.
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
 * Pointer from a Project directory to the Agent Session currently working in
 * it, written by the UserPromptSubmit hook. Without it `notifai ask` has no way
 * to learn its own Agent Session id: an ordinary agent shell command receives no hook
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
  return canonicalPath(path.resolve(dir))
}

/** Git-owned anchor shared by every linked worktree of one local checkout. */
export function gitCommonDirectory(cwd: string): string | null {
  const raw = gitQuery(cwd, ['rev-parse', '--git-common-dir'])
  if (raw === null || raw === '') return null
  try {
    return canonicalDir(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw))
  } catch {
    return null
  }
}

/** Walk up from a directory to the nearest `.git` file or directory (a checkout, linked worktree or submodule). */
function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir)
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return canonicalDir(dir)
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function canonicalHome(env: NodeJS.ProcessEnv): string | null {
  try {
    return canonicalDir(accountHome(env))
  } catch {
    return null
  }
}

/**
 * Which Project a folder belongs to: the one answer Project identity,
 * personal configuration and Project Enablement all use.
 *
 * - The folder's nearest Git checkout (a clone, linked worktree or submodule)
 *   is the root, and outside Git the folder itself is. Nothing committed to a
 *   checkout can move the root: a repository does not configure Notifai.
 * - The home folder is never a Project root: `~/.notifai` is where Notifai
 *   installs itself, and a Project there would contain every other folder.
 *
 * `null` means the folder belongs to no Project.
 */
export interface ProjectLocation {
  /** The directory the Project is identified and keyed by. */
  root: string
  /** Whether the root is a Git checkout, whose linked worktrees share one Project. */
  checkout: boolean
}

export function projectLocation(cwd: string, env: NodeJS.ProcessEnv = process.env): ProjectLocation | null {
  let start: string
  try {
    start = canonicalDir(cwd)
  } catch {
    start = path.resolve(cwd)
  }
  const home = canonicalHome(env)
  const checkoutRoot = findGitRoot(start)
  if (checkoutRoot !== null) return checkoutRoot === home ? null : { root: checkoutRoot, checkout: true }
  return start === home ? null : { root: start, checkout: false }
}

/**
 * The Git common directory a Project's personal records are keyed by, so
 * linked worktrees share them; the root itself outside Git.
 */
export function projectRepositoryAnchor(location: ProjectLocation): string {
  return (location.checkout ? gitCommonDirectory(location.root) : null) ?? location.root
}

/** Stable identity for personal project preferences. */
export function personalProjectIdentity(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const location = projectLocation(cwd, env)
  let anchor: string
  if (location !== null) anchor = projectRepositoryAnchor(location)
  else {
    try { anchor = canonicalDir(cwd) } catch { anchor = path.resolve(cwd) }
  }
  return createHash('sha256').update(anchor).digest('hex').slice(0, 32)
}

/** Personal project layer: `$XDG_CONFIG_HOME/notifai/projects/<identity>.toml`. */
export function personalProjectConfigPath(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(globalConfigDir(env), 'projects', `${personalProjectIdentity(cwd, env)}.toml`)
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
 * Ranges every layer is clamped to, so a hand-edited value out of range can
 * never reach a send.
 */
const NUMERIC_BOUNDS: Partial<Record<ConfigKey, { min: number; max: number }>> = {
  wait_seconds: { min: 0, max: 300 },
  ttl_seconds: { min: 0, max: 7 * 24 * 3600 },
  // Six minutes is the supported terminal-first preference bound. The Stop
  // owner carries separate startup headroom, so this never shortens the answer
  // window that begins after submission.
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
  if (ORIGIN_LIST_CONFIG_KEYS.includes(key)) {
    // A trust rule is all-or-nothing: one malformed entry drops the whole
    // value rather than silently enforcing a subset of what was written.
    if (!Array.isArray(value)) return undefined
    const origins = value.map((entry) => (typeof entry === 'string' ? normalizeOrigin(entry) : null))
    return origins.every((origin): origin is string => origin !== null) ? origins : undefined
  }
  if (key === 'sound') {
    return typeof value === 'string' && isCliSoundRef(value) ? value : undefined
  }
  if (key === 'reopen.terminal_command') {
    return typeof value === 'string' && value.trim() !== '' && value.length <= 1024 ? value : undefined
  }
  const allowed = ENUM_CONFIG_VALUES[key]
  if (allowed !== undefined) {
    return typeof value === 'string' && allowed.includes(value) ? value : undefined
  }
  return value
}

export function configBounds(key: ConfigKey): { min: number; max: number } | undefined {
  return NUMERIC_BOUNDS[key]
}

/**
 * A key's raw value in one parsed file. Dotted keys are read both as written by
 * `config set` (a quoted `"updates.automatic"` key) and as a person would write
 * them by hand (an `[updates]` table holding `automatic`).
 */
function rawLayerValue(raw: Record<string, unknown>, key: ConfigKey): unknown {
  if (Object.prototype.hasOwnProperty.call(raw, key)) return raw[key]
  const dot = key.indexOf('.')
  if (dot === -1) return undefined
  const table = raw[key.slice(0, dot)]
  return typeof table === 'object' && table !== null && !Array.isArray(table)
    ? (table as Record<string, unknown>)[key.slice(dot + 1)]
    : undefined
}

/**
 * One machine-wide key, from this machine's own configuration file only. No
 * working directory is involved: a Project can never change it. An unreadable
 * or invalid value decides nothing new: the shipped default stands.
 */
export function machineSetting<K extends ConfigKey>(key: K, env: NodeJS.ProcessEnv = process.env): { value: CliConfig[K]['value']; source: 'default' | 'user' } {
  const fallback = { value: DEFAULTS[key] as CliConfig[K]['value'], source: 'default' as const }
  const file = globalConfigPath(env)
  try {
    if (!existsSync(file)) return fallback
    const value = coerce(key, rawLayerValue(readTomlFile(file), key))
    return value === undefined ? fallback : { value: value as CliConfig[K]['value'], source: 'user' }
  } catch {
    return fallback
  }
}

/** The automatic-update switch, from this machine's own configuration only. */
export function automaticUpdatesSetting(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; source: 'default' | 'user' } {
  const setting = machineSetting('updates.automatic', env)
  return { enabled: setting.value, source: setting.source }
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
  sound?: string
  interruption_level?: CliInterruptionLevel
}

/**
 * Service origin is not a user setting. Flag and env are pairing/self-host
 * overrides for unsigned-in traffic (login). Signed-in traffic always uses
 * the origin stored with the Machine Credential.
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
  /** Agent Session id; enables the Agent Session override layer when present. */
  sessionId?: string | undefined
}): CliConfig {
  const env = options.env ?? process.env
  const flags = options.flags ?? {}
  const globalPath = globalConfigPath(env)
  const globalRaw = existsSync(globalPath) ? readTomlFile(globalPath) : {}
  const cwd = options.cwd ?? process.cwd()
  const projectLocalPath = findProjectLocalConfigPath(cwd, env)
  const projectLocalRaw = projectLocalPath ? readTomlFile(projectLocalPath) : {}
  const sessionId = options.sessionId ?? env['NOTIFAI_SESSION_ID']
  const sessionPath = sessionId ? sessionConfigPath(sessionId, env) : null
  const sessionRaw = sessionPath && existsSync(sessionPath) ? readTomlFile(sessionPath) : {}

  function resolve<K extends ConfigKey>(key: K): ResolvedValue<never> {
    // Machine-only keys read nothing but this machine's own file.
    const scopedLayersReadable = !MACHINE_ONLY_CONFIG_KEYS.includes(key)
    const layers: [unknown, ConfigSource][] = [
      [scopedLayersReadable ? (flags as Record<string, unknown>)[key] : undefined, 'flag'],
      [sessionPath && scopedLayersReadable ? rawLayerValue(sessionRaw, key) : undefined, `session:${sessionPath ?? ''}`],
      [projectLocalPath && scopedLayersReadable ? rawLayerValue(projectLocalRaw, key) : undefined, `project-local:${projectLocalPath ?? ''}`],
      [rawLayerValue(globalRaw, key), `global:${globalPath}`],
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
    ask_notifications: resolve('ask_notifications'),
    ask_grace_seconds: resolve('ask_grace_seconds'),
    reply_window_seconds: resolve('reply_window_seconds'),
    log_level: resolve('log_level'),
    log_max_bytes: resolve('log_max_bytes'),
    log_max_files: resolve('log_max_files'),
    media_origins: resolve('media_origins'),
    approve_origins: resolve('approve_origins'),
    'updates.automatic': resolve('updates.automatic'),
    'reopen.automatic': resolve('reopen.automatic'),
    'reopen.terminal': resolve('reopen.terminal'),
    'reopen.codex_app': resolve('reopen.codex_app'),
    'reopen.terminal_app': resolve('reopen.terminal_app'),
    'reopen.terminal_command': resolve('reopen.terminal_command'),
    'reopen.focus': resolve('reopen.focus'),
    'reopen.permission_mode': resolve('reopen.permission_mode'),
  }
}
