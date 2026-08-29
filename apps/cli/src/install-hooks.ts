import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { atomicWriteFileSync } from './atomic-file.js'
import { withTargetFileLock } from './file-lock.js'
import {
  hookAdapterPath,
  hookHostPlatform,
  inspectHookAdapter,
  type HookHostPlatform,
} from './hook-adapter.js'
import { opencodePluginPath, opencodePluginTarget } from './opencode-plugin.js'
import {
  OPENCLAW_EVENTS,
  openclawHasGlobalEvidence,
  openclawPluginPath,
  openclawPluginTarget,
} from './openclaw-plugin.js'
import { HOOK_INSTALLABLE_HARNESSES, type HookInstallableHarness } from './harnesses.js'
import { accountHome } from './platform.js'
import {
  NON_ROUTING_STOP_TIMEOUT_SECONDS,
  QUESTION_STOP_TIMEOUT_SECONDS,
} from './question-timing.js'

/**
 * The three joints the OpenCode plugin hooks into, as (harness event, the
 * `notifai hook` event it runs). The plugin is a module and has no settings
 * entries to read, so `findInstallations` reconstructs its handlers from this.
 */
const OPENCODE_EVENTS = [
  ['UserPromptSubmit', 'user-prompt-submit'],
  ['Stop', 'stop'],
  ['SessionEnd', 'session-end'],
] as const

/**
 * Harness hook installation.
 *
 * Claude Code's `settings.json` and Codex's hook files use the same shape —
 * `hooks` maps an event name to matcher groups, each holding command handlers
 * with an optional timeout — so one generator serves both. Only the file
 * location and the event set differ. Codex supports either a dedicated
 * `hooks.json` or inline `[hooks]` tables in the same layer's `config.toml`.
 * We default a hook-empty layer to inline config and preserve whichever single
 * representation a populated layer already uses. Notifai lives in one of them,
 * never both.
 *
 * Cursor's native format is flat and lower-camel-cased, while OpenCode's
 * extension point is a JavaScript plugin module. Each therefore has a bounded
 * adapter instead of being forced through this shared document shape.
 */

export interface HookHandler {
  type: 'command'
  command: string
  timeout?: number
  async?: boolean
  statusMessage?: string
}

export interface HookGroup {
  matcher?: string
  hooks: HookHandler[]
}

export type HookConfig = Record<string, HookGroup[]>

export interface InstallPlan {
  harness: HookInstallableHarness
  /** Absolute path of the settings file that will be written. */
  file: string
  /** True when the file is machine-wide rather than per-project. */
  global: boolean
  config: HookConfig
}

export interface HookCommandOptions {
  platform?: NodeJS.Platform | HookHostPlatform
  /** Registered Node used to interpret the Windows adapter. Ignored on POSIX. */
  nodePath?: string
}

/**
 * The command each hook runs. Harness definitions know only the stable
 * user-level adapter. Mutable Node, package-manager, version, and checkout
 * paths live behind that seam and never enter a trusted hook identity —
 * except on Windows, where CreateProcess cannot run the adapter without an
 * explicit Node executable, so the registered interpreter is named first.
 */
export function hookCommand(
  adapterPath: string,
  event: string,
  harness?: HookInstallableHarness,
  options: HookCommandOptions = {},
): string {
  return (
    `${hookCommandPrefix(adapterPath, options)}hook ${event} ${OWNER_MARKER}` +
    (harness === undefined ? '' : ` --harness ${harness}`)
  )
}

/** The leading argv that every Notifai handler must start with. */
export function hookCommandPrefix(
  adapterPath: string,
  options: HookCommandOptions = {},
): string {
  const host = hookHostPlatform(options.platform)
  if (host === 'win32') {
    const nodePath = options.nodePath ?? process.execPath
    return `${quoteWindowsArg(nodePath)} ${quoteWindowsArg(adapterPath)} `
  }
  return `${quote(adapterPath)} `
}

/**
 * Says "Notifai installed this" without saying which checkout did.
 *
 * Ownership used to be matched on the absolute script path, so installing from
 * a second checkout did not recognise the first one's handlers as ours. Both
 * stayed, the harness ran both, and one question produced two notifications;
 * uninstalling the second silently left the first running. A marker that every
 * Notifai build writes and no build's path appears in fixes that by making
 * ownership a property of the handler rather than of the machine it was
 * installed from.
 *
 * It is a real (ignored) CLI flag rather than a comment because not every
 * harness runs the command through a shell.
 */
export const OWNER_MARKER = '--owner notifai'

/**
 * POSIX single-quoting. Double quotes were wrong: they still expand `$(...)`
 * and backticks, so a checkout path containing shell syntax became command
 * execution on every hook event. Single quotes suppress all expansion; the
 * only escape needed is for a literal single quote.
 */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Quote one Windows argv element so CommandLineToArgvW / CreateProcess keep
 * it as a single argument. Always used for the Node and adapter paths, which
 * routinely contain spaces (`Program Files`) and must not use POSIX quotes
 * inside JSON or TOML harness documents.
 */
export function quoteWindowsArg(value: string): string {
  let out = '"'
  let slashes = 0
  for (const ch of value) {
    if (ch === '\\') {
      slashes += 1
      continue
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"'
      slashes = 0
      continue
    }
    out += '\\'.repeat(slashes) + ch
    slashes = 0
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`
}

export interface BuildOptions {
  /** Stable user-level executable installed by the hook adapter module. */
  adapterPath: string
  /** The installed adapter stamps its exact harness into project pointers. */
  harness?: HookInstallableHarness
  platform?: NodeJS.Platform | HookHostPlatform
  /** Registered Node named first in Windows hook commands. */
  nodePath?: string
}

/**
 * Harnesses without asynchronous Question Routing use this short Stop budget.
 * Claude Code and Codex use `QUESTION_STOP_TIMEOUT_SECONDS` instead.
 */
export const NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS = NON_ROUTING_STOP_TIMEOUT_SECONDS
export { QUESTION_STOP_TIMEOUT_SECONDS } from './question-timing.js'

/**
 * Whether this harness's Stop handler runs detached from the turn.
 *
 * The installer and doctor share this predicate so they agree whether Claude
 * runs out of band. Owner lifetime is route-neutral and lives in
 * `question-timing.ts`.
 */
export function stopHandlerIsDetached(
  harness: HookInstallableHarness | undefined,
  platform?: Parameters<typeof hookHostPlatform>[0],
): boolean {
  return harness === 'claude-code' && hookHostPlatform(platform) === 'posix'
}

/**
 * The turn-end handler, whose shape is the whole per-harness difference.
 *
 * Claude Code takes the answer over its own inbox socket, so its Stop hook is
 * `async: true`: it returns immediately, the terminal is never held, and the
 * waiter finishes out of band. Codex and Claude on Windows block and print a
 * continuation to stdout. Every Question Routing owner declares the same
 * complete-window timeout; changing Codex's definition requires one explicit
 * trust approval.
 */
function stopHandler(
  adapterPath: string,
  harness: HookInstallableHarness | undefined,
  options: HookCommandOptions,
): HookHandler {
  const command = hookCommand(adapterPath, 'stop', harness, options)
  if (stopHandlerIsDetached(harness, options.platform)) {
    return { type: 'command', command, timeout: QUESTION_STOP_TIMEOUT_SECONDS, async: true }
  }
  if (harness === 'codex' || harness === 'claude-code') {
    return { type: 'command', command, timeout: QUESTION_STOP_TIMEOUT_SECONDS }
  }
  return { type: 'command', command, timeout: NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS }
}

function commandOptionsFrom(options: BuildOptions): HookCommandOptions {
  return {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
  }
}

export function buildHookConfig(options: BuildOptions): HookConfig {
  const { adapterPath } = options
  const commandOptions = commandOptionsFrom(options)
  return {
    SessionStart: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand(adapterPath, 'session-start', options.harness, commandOptions),
            // Activation is local context only: no config, credentials, or network.
            timeout: 5,
          },
        ],
      },
    ],
    SubagentStart: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand(adapterPath, 'subagent-start', options.harness, commandOptions),
            timeout: 5,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand(adapterPath, 'user-prompt-submit', options.harness, commandOptions),
            // Claude Code defaults UserPromptSubmit to 30s. Choose a shorter
            // explicit budget so a slow network cannot delay the user's prompt.
            timeout: 15,
          },
        ],
      },
    ],
    Stop: [{ hooks: [stopHandler(adapterPath, options.harness, commandOptions)] }],
    SessionEnd: [
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand(adapterPath, 'session-end', options.harness, commandOptions),
            // Both harnesses give SessionEnd a ~1-3s budget, so this handler
            // only touches local state.
            timeout: 3,
          },
        ],
      },
    ],
  }
}

export interface CursorHookHandler {
  command: string
  timeout?: number
  loop_limit?: number | null
}

export type CursorHookConfig = Record<string, CursorHookHandler[]>

interface CursorSettingsDocument {
  version?: number
  hooks?: CursorHookConfig
  [key: string]: unknown
}

/** Cursor's native schema is flat and uses lower-camel lifecycle event names. */
export function buildCursorHookConfig(options: BuildOptions): CursorHookConfig {
  const commandOptions = commandOptionsFrom(options)
  return {
    sessionStart: [
      {
        command: hookCommand(options.adapterPath, 'session-start', 'cursor', commandOptions),
        // Activation only emits local context and must not depend on setup.
        timeout: 5,
      },
    ],
    beforeSubmitPrompt: [
      {
        command: hookCommand(
          options.adapterPath,
          'user-prompt-submit',
          'cursor',
          commandOptions,
        ),
        timeout: 15,
      },
    ],
    stop: [
      {
        command: hookCommand(options.adapterPath, 'activation-stop', 'cursor', commandOptions),
        timeout: 5,
        loop_limit: 1,
      },
      {
        command: hookCommand(options.adapterPath, 'stop', 'cursor', commandOptions),
        timeout: NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS,
        // A continuation may register a real follow-up question. Match the
        // session-state cap so those chains are useful but never unbounded.
        loop_limit: 3,
      },
    ],
    sessionEnd: [
      {
        command: hookCommand(options.adapterPath, 'session-end', 'cursor', commandOptions),
        timeout: 3,
      },
    ],
  }
}

/**
 * Where each harness reads hooks from. Project installs deliberately target the
 * gitignored file where one exists: which devices a person wants their
 * questions pushed to is not a property of the repository.
 */
export function settingsFile(
  harness: HookInstallableHarness,
  global: boolean,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  switch (harness) {
    // OpenCode has no settings document to merge into — its adapter is a
    // generated plugin module, so it owns a whole file instead.
    case 'opencode':
      return opencodePluginPath(global, cwd, env, platform)
    case 'openclaw':
      return openclawPluginPath(global, cwd, env, platform)
    case 'cursor': {
      const home = harnessAccountHome(env, platform)
      return global
        ? path.join(home, '.cursor', 'hooks.json')
        : path.join(cwd, '.cursor', 'hooks.json')
    }
    case 'claude-code':
      return global
        ? path.join(configHome(env, 'CLAUDE_CONFIG_DIR', '.claude', platform), 'settings.json')
        : path.join(cwd, '.claude', 'settings.local.json')
    case 'codex':
      return inspectCodexLayer(codexLayerPaths(global, cwd, env, platform)).writeTarget
    default:
      return assertNeverHarness(harness)
  }
}

/**
 * The account home harness config roots are resolved against.
 *
 * Delegates to the shared process/path `accountHome` so Cursor, OpenCode,
 * Claude, and Codex follow the same Windows USERPROFILE / MSYS HOME rules.
 */
export function harnessAccountHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  return accountHome(env, hookHostPlatform(platform) === 'win32' ? 'win32' : 'linux')
}

function assertNeverHarness(harness: never): never {
  throw new Error(`Unsupported harness: ${String(harness)}`)
}

/**
 * Where Codex looks for a project's hooks — the **main** repository, not the
 * working directory.
 *
 * Run from a linked git worktree, Codex reads `<main repo>/.codex/config.toml`
 * (or a leftover `hooks.json`) and never looks at the worktree's own. Proven 2026-08-03 in an isolated
 * `CODEX_HOME`: with cwd set to a worktree, a handler at the main repo root
 * fired and an identical one at the worktree root did not; removing the main
 * one left nothing firing at all. Writing to cwd therefore produces a silent
 * no-op for anyone whose agent runs in a worktree, which is the normal case
 * under tooling like Orca.
 *
 * Claude Code does not share this behaviour — it reads the worktree's own
 * `.claude/settings.local.json` — so this deliberately applies to Codex only.
 */
export function codexProjectRoot(cwd: string): string {
  const entry = findGitEntry(cwd)
  if (entry === null) return cwd
  try {
    if (statSync(entry).isDirectory()) return path.dirname(entry)
    const linked = worktreeGitDir(entry)
    return linked === null ? cwd : path.dirname(commonGitDir(linked))
  } catch {
    // An unreadable or exotic checkout is not worth failing an install over;
    // cwd is what we used to do and is right for every non-worktree case.
    return cwd
  }
}

/**
 * The `.codex` directory that has to exist for Codex to load project hooks at
 * all, or null when nothing extra is needed.
 *
 * Codex splits the two halves of "which project am I in": it discovers the
 * project layer by walking up from cwd for a `.codex` directory, but resolves
 * the hook file inside that layer against the main repository. In an ordinary
 * checkout both land on the same directory and the split is invisible. In a
 * worktree they diverge, and writing only the main repository's file leaves it
 * unread — Codex never looks, because nothing at or above cwd told it there was
 * a project layer to load. Proven 2026-08-03: with cwd in a worktree, an *empty*
 * `.codex` directory there was the difference between the main repository's
 * handler running and nothing running.
 */
export function codexLayerDir(cwd: string): string | null {
  const entry = findGitEntry(cwd)
  if (entry === null) return null
  const worktreeRoot = path.dirname(entry)
  if (path.resolve(worktreeRoot) === path.resolve(codexProjectRoot(cwd))) return null
  return path.join(worktreeRoot, '.codex')
}

/** The nearest `.git` at or above `from`, or null outside a repository. */
function findGitEntry(from: string): string | null {
  let dir = path.resolve(from)
  for (;;) {
    const entry = path.join(dir, '.git')
    if (existsSync(entry)) return entry
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** `.git` in a linked worktree is a file naming that worktree's git directory. */
function worktreeGitDir(file: string): string | null {
  const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(file, 'utf8'))
  if (match === null) return null
  return path.resolve(path.dirname(file), match[1]!.trim())
}

/**
 * A worktree's git directory records the shared one in `commondir`; that shared
 * directory is the main repository's `.git`, whose parent is its root.
 */
function commonGitDir(gitDir: string): string {
  const marker = path.join(gitDir, 'commondir')
  if (!existsSync(marker)) return gitDir
  return path.resolve(gitDir, readFileSync(marker, 'utf8').trim())
}

/**
 * Harness-specific home variables relocate the whole active harness home.
 * This matters under session managers that give each Codex account its own
 * `CODEX_HOME`: writing to the OS account's ~/.codex would configure a
 * different Codex installation than the one running the command.
 */
export function configHome(
  env: NodeJS.ProcessEnv,
  variable: string,
  fallback: string,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  const override = env[variable]
  if (override !== undefined && override !== '') return override
  const home = harnessAccountHome(env, platform)
  return path.join(home, fallback)
}

/**
 * User-global Codex config directory for the *running* Codex installation.
 *
 * `CODEX_HOME` replaces the home; it does not shadow it. `codex doctor` with
 * the variable set reports that directory for every path it resolves and never
 * consults `~/.codex` at all. So a session manager that points Codex at its own
 * home makes `~/.codex` inert for those sessions, and installing there would
 * write hooks the running agent never reads while reporting success.
 *
 * Following the variable is therefore correct even though it means install and
 * doctor resolve different homes when run from different shells. Doctor names
 * the home it inspected for exactly that reason — see `codexHomeNote`.
 */
export function codexGlobalDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  return configHome(env, 'CODEX_HOME', '.codex', platform)
}

export interface CodexLayerPaths {
  dir: string
  hooksJson: string
  configToml: string
}

/** The two files Codex will look at for one config layer. */
export function codexLayerPaths(
  global: boolean,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): CodexLayerPaths {
  const dir = global
    ? codexGlobalDir(env, platform)
    : path.join(codexProjectRoot(cwd), '.codex')
  return {
    dir,
    hooksJson: path.join(dir, 'hooks.json'),
    configToml: path.join(dir, 'config.toml'),
  }
}

export interface CodexLayerInspection {
  paths: CodexLayerPaths
  /** Every event this file defines a handler for, whoever owns it. */
  jsonEvents: string[]
  tomlEvents: string[]
  /** The subset of those events whose handlers are Notifai's own. */
  ourJsonEvents: string[]
  ourTomlEvents: string[]
  writeTarget: string
}

/**
 * Where Notifai writes in this Codex layer: wherever Notifai already is, then
 * whichever single hook representation the layer already uses, and inline
 * `config.toml` for a hook-empty or already-mixed layer.
 *
 * Codex supports `hooks.json` and inline `[hooks]` side by side, loads both,
 * and runs every matching handler. Reusing the one populated representation is
 * the generic layer contract: it avoids creating Codex's dual-representation
 * warning and, for a managed layer, writes through the same authority that
 * persists the layer rather than a sibling file it may regenerate away.
 *
 * Staying put where Notifai already is also keeps reinstalls idempotent and
 * preserves the `[hooks.state]` trust hash, which Codex keys by file path and
 * handler index. `[hooks.state]` is the trust store, not a hook definition, so
 * it does not count as a representation.
 */
export function inspectCodexLayer(paths: CodexLayerPaths): CodexLayerInspection {
  const jsonDocument = tryLoadSettings(paths.hooksJson)
  const tomlDocument = tryLoadSettings(paths.configToml)
  const jsonEvents = hookEventNames(jsonDocument?.hooks)
  const tomlEvents = hookEventNames(tomlDocument?.hooks)
  const ourJsonEvents = ourHandlerEvents(jsonDocument)
  const ourTomlEvents = ourHandlerEvents(tomlDocument)
  const writeTarget =
    ourJsonEvents.length > 0 && ourTomlEvents.length === 0
      ? paths.hooksJson
      : ourTomlEvents.length > 0
        ? paths.configToml
        : jsonEvents.length > 0 && tomlEvents.length === 0
          ? paths.hooksJson
          : paths.configToml
  return {
    paths,
    jsonEvents,
    tomlEvents,
    ourJsonEvents,
    ourTomlEvents,
    writeTarget,
  }
}

/**
 * Serialize one Notifai transaction across both representations in a Codex
 * layer, then inspect that layer only after acquiring the shared anchor.
 */
export function withCodexLayerTransaction<T>(
  paths: CodexLayerPaths,
  action: (inspection: CodexLayerInspection) => T,
): T {
  return withTargetFileLock(paths.configToml, () => action(inspectCodexLayer(paths)))
}

/** Every file in this layer Codex might already be reading hooks from. */
export function hookDefinitionFiles(
  harness: HookInstallableHarness,
  global: boolean,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string[] {
  if (harness !== 'codex') return [settingsFile(harness, global, cwd, env, platform)]
  const paths = codexLayerPaths(global, cwd, env, platform)
  return [paths.hooksJson, paths.configToml]
}

/**
 * Layers where *Notifai* is installed in both Codex representations.
 *
 * A layer that uses `hooks.json` and inline `[hooks]` at once is not by itself
 * a Notifai fault: Codex supports both, loads both, runs every matching
 * handler, and already prints its own "prefer a single representation" warning
 * at startup. Foreign handlers in the other file are the user's — often written
 * by another tool that manages that file — and repeating Codex's warning as a
 * Notifai failure demanded an edit to configuration Notifai does not own, for a
 * condition where every handler still fires exactly once.
 *
 * What is ours to diagnose is Notifai in both files. Then one event really does
 * send two Notification Requests per turn, and the copy outside the write
 * target keeps firing an older definition after the next install refreshes only
 * the other one. Uninstall strips Notifai from both files, so the remedy is
 * exact — and it never touches a foreign handler.
 */
export function codexRepresentationProblems(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string[] {
  return [false, true].flatMap((global) => {
    const layer = inspectCodexLayer(codexLayerPaths(global, cwd, env, platform))
    if (layer.ourJsonEvents.length === 0 || layer.ourTomlEvents.length === 0) return []
    const doubled = layer.ourJsonEvents.filter((event) => layer.ourTomlEvents.includes(event))
    const consequence =
      doubled.length > 0
        ? `Codex runs every matching handler, so this layer notifies twice per turn for ${doubled.join(', ')}`
        : `Codex runs both files, so this layer's Notifai handlers are split between them (${[...new Set([...layer.ourJsonEvents, ...layer.ourTomlEvents])].join(', ')}) and the next install refreshes only one file`
    const scope = global ? ' --global' : ''
    return [
      `Notifai hooks are installed in both ${layer.paths.hooksJson} and ${layer.paths.configToml}; ${consequence}. Run \`notifai hooks uninstall --harness codex${scope}\` and then \`notifai hooks install --harness codex${scope}\` to leave exactly one copy; foreign hooks in either file are left alone.`,
    ]
  })
}

/**
 * Layers where Notifai and someone else each own one Codex representation.
 *
 * This is not a fault and never fails a check. Codex loads `hooks.json` and
 * inline `[hooks]` together and runs every matching handler, so both sets fire
 * exactly once — but Codex also prints "prefer one representation per layer"
 * at startup, and a user who sees that warning deserves to know which file is
 * Notifai's, which is not, and that Notifai will not touch the one it does not
 * own. Saying nothing here is what made the warning look like Notifai's bug.
 */
export function codexCoexistenceNotes(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string[] {
  return [false, true].flatMap((global) => {
    const layer = inspectCodexLayer(codexLayerPaths(global, cwd, env, platform))
    const inJson = layer.ourJsonEvents.length > 0
    const inToml = layer.ourTomlEvents.length > 0
    if (inJson === inToml) return []
    const ours = inJson ? layer.paths.hooksJson : layer.paths.configToml
    const theirs = inJson ? layer.paths.configToml : layer.paths.hooksJson
    const theirEvents = inJson ? layer.tomlEvents : layer.jsonEvents
    if (theirEvents.length === 0) return []
    const stop = theirEvents.includes('Stop')
      ? " That file's Stop handler can end a turn before Notifai's answer arrives, because Codex lets any Stop handler stop continuation."
      : ''
    return [
      `Notifai's Codex hooks are in ${ours}. ${theirs} defines hooks Notifai does not own (${theirEvents.join(', ')}) and Notifai will not modify it. Codex loads both files and runs every matching handler, so each set fires exactly once; its "prefer one representation per layer" startup warning is reporting that, not a Notifai fault.${stop}`,
    ]
  })
}

/**
 * What `CODEX_HOME` is doing to this shell, when it is doing anything.
 *
 * Codex replaces its whole home when the variable is set, so hooks installed
 * from a shell without it are simply absent here, and its trust store is keyed
 * by absolute file path — a config copied between homes arrives untrusted.
 * Both facts turn into "Notifai is not wired" reports that look like a bug in
 * the installer, so doctor names the home it actually inspected.
 */
export function codexHomeNote(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string | null {
  const effective = codexGlobalDir(env, platform)
  const accountDefault = path.join(harnessAccountHome(env, platform), '.codex')
  if (effective === accountDefault) return null
  return `CODEX_HOME points Codex at ${effective}, so ${accountDefault} is not read by Codex in this shell at all. Global hooks installed from a shell without CODEX_HOME live there and are invisible here; Codex also keys hook trust by absolute file path, so hooks copied between homes need approving again in each one.`
}

function tryLoadSettings(file: string): SettingsDocument | null {
  if (!existsSync(file)) return null
  try {
    return loadSettings(file)
  } catch {
    return null
  }
}

function hookEventNames(hooks: SettingsDocument['hooks']): string[] {
  return Object.entries(hooks ?? {})
    .filter(([, value]) => Array.isArray(value))
    .map(([event]) => event)
}

/** Events this document defines a Notifai handler for, by their event key. */
function ourHandlerEvents(document: SettingsDocument | null): string[] {
  if (document === null) return []
  return [...new Set(locateHandlers(document).map((handler) => handler.event))]
}

/** Best-effort detection so `hooks install` usually needs no flags. */
/**
 * Harnesses this *project* shows evidence of, in the working directory only.
 *
 * `CLAUDE.md` counts because it is Claude Code's own project file and is
 * frequently the only marker: a repository can be worked in daily through
 * Claude Code and never accumulate a `.claude/` directory.
 *
 * `AGENTS.md` deliberately counts for nothing. It began as a Codex
 * convention and is now read by most agent tooling — including Claude Code,
 * and including this repository, where the two filenames are the same
 * document. Treating it as evidence of any one harness would be a guess
 * dressed up as detection.
 */
function localHarnessEvidence(cwd: string): HookInstallableHarness[] {
  const found: HookInstallableHarness[] = []
  if (existsSync(path.join(cwd, '.claude')) || existsSync(path.join(cwd, 'CLAUDE.md'))) {
    found.push('claude-code')
  }
  if (existsSync(path.join(cwd, '.codex'))) found.push('codex')
  if (existsSync(path.join(cwd, '.cursor'))) found.push('cursor')
  if (existsSync(path.join(cwd, '.opencode'))) found.push('opencode')
  if (existsSync(path.join(cwd, '.openclaw'))) found.push('openclaw')
  return found
}

/** Harnesses installed anywhere on this machine — a much weaker signal. */
function globalHarnessEvidence(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): HookInstallableHarness[] {
  const home = harnessAccountHome(env, platform)
  const found: HookInstallableHarness[] = []
  if (existsSync(path.join(home, '.claude'))) found.push('claude-code')
  if (existsSync(codexGlobalDir(env, platform))) found.push('codex')
  if (existsSync(path.join(home, '.cursor'))) found.push('cursor')
  if (existsSync(path.join(home, '.config', 'opencode'))) found.push('opencode')
  if (openclawHasGlobalEvidence(existsSync, env, platform)) found.push('openclaw')
  return found
}

/**
 * Every supported harness this project or machine shows evidence of, in
 * declared order. Project markers come first, then machine installs that the
 * project did not already name.
 *
 * `AGENTS.md` still counts for nothing — see `localHarnessEvidence`.
 */
export function detectedHarnesses(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): HookInstallableHarness[] {
  const seen = new Set<HookInstallableHarness>([
    ...localHarnessEvidence(cwd),
    ...globalHarnessEvidence(env, platform),
  ])
  return HOOK_INSTALLABLE_HARNESSES.filter((harness) => seen.has(harness))
}

/**
 * Which *single* harness to wire when a caller still needs exactly one, or
 * null when it is genuinely unclear.
 *
 * Project evidence decides, and machine evidence is consulted only when the
 * project offers none. Several markers are not a failure of detection — they
 * are several harnesses. `detectedHarnesses` is the default for install;
 * this helper stays for uninstall and any caller that cannot take a list.
 */
export function detectHarness(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): HookInstallableHarness | null {
  const local = localHarnessEvidence(cwd)
  if (local.length > 0) return local.length === 1 ? local[0]! : null
  const global = globalHarnessEvidence(env, platform)
  return global.length === 1 ? global[0]! : null
}

export interface SettingsDocument {
  hooks?: HookConfig
  [key: string]: unknown
}

function readCursorSettings(file: string): CursorSettingsDocument {
  if (!existsSync(file)) return { version: 1 }
  const source = readOwnedRegularFile(file)
  try {
    const parsed: unknown = JSON.parse(source)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as CursorSettingsDocument)
      : { version: 1 }
  } catch {
    throw new Error(`Could not parse ${file}; fix or move it before installing hooks.`)
  }
}

function isOurCommand(command: string, scriptPath: string): boolean {
  if (command.includes(OWNER_MARKER)) return true
  return (
    command.includes(`${scriptPath}' hook `) ||
    command.includes(`${scriptPath}" hook `) ||
    command.includes(`${scriptPath} hook `) ||
    isLegacyNotifaiCommand(command)
  )
}

/** Cleanup-only recognition for unmistakable pre-marker Notifai commands. */
function isLegacyNotifaiCommand(command: string): boolean {
  const hook = `['"]?\\s+hook (?:session-start|subagent-start|activation-stop|user-prompt-submit|stop|session-end)\\b`
  return (
    new RegExp(`(?:^|[\\s'"])notifai(?:\\.cmd)?${hook}`).test(command) ||
    new RegExp(
      `(?:^|[/\\\\])(?:notifai-public|notifai)[/\\\\]apps[/\\\\]cli[/\\\\]dist[/\\\\]main\\.js${hook}`,
      'i',
    ).test(command) ||
    new RegExp(
      `[/\\\\]node_modules[/\\\\]@raidiant[/\\\\]notifai[/\\\\]dist[/\\\\]main\\.js${hook}`,
      'i',
    ).test(command)
  )
}

export function mergeCursorHooks(
  existing: CursorSettingsDocument,
  incoming: CursorHookConfig,
  scriptPath: string,
): { document: CursorSettingsDocument; added: string[]; replaced: string[]; removed: string[] } {
  const hooks: CursorHookConfig = {}
  const added: string[] = []
  const replaced: string[] = []
  const removed: string[] = []

  for (const [event, handlers] of Object.entries(existing.hooks ?? {})) {
    const foreign = handlers.filter((handler) => !isOurCommand(handler.command, scriptPath))
    if (foreign.length !== handlers.length) {
      if (event in incoming) replaced.push(event)
      else removed.push(event)
    }
    if (foreign.length > 0) hooks[event] = foreign
  }
  for (const [event, handlers] of Object.entries(incoming)) {
    if (!replaced.includes(event)) added.push(event)
    hooks[event] = [...(hooks[event] ?? []), ...handlers]
  }
  return { document: { ...existing, version: 1, hooks }, added, replaced, removed }
}

export function removeCursorHooks(
  existing: CursorSettingsDocument,
  scriptPath: string,
): { document: CursorSettingsDocument; added: string[]; replaced: string[]; removed: string[] } {
  const hooks: CursorHookConfig = {}
  const replaced: string[] = []
  for (const [event, handlers] of Object.entries(existing.hooks ?? {})) {
    const foreign = handlers.filter((handler) => !isOurCommand(handler.command, scriptPath))
    if (foreign.length !== handlers.length) replaced.push(event)
    if (foreign.length > 0) hooks[event] = foreign
  }
  return { document: { ...existing, version: 1, hooks }, added: [], replaced, removed: [] }
}

function readSettings(file: string): SettingsDocument {
  if (!existsSync(file)) return {}
  const source = readOwnedRegularFile(file)
  try {
    const parsed: unknown = JSON.parse(source)
    return typeof parsed === 'object' && parsed !== null ? (parsed as SettingsDocument) : {}
  } catch {
    throw new Error(`Could not parse ${file}; fix or move it before installing hooks.`)
  }
}

/**
 * True when a single handler is ours. Deliberately per-handler, not per-group:
 * removing a whole group destroyed a user's own handler if they had added one
 * beside ours inside the same matcher group.
 */
function isOurHandler(handler: HookHandler, scriptPath: string): boolean {
  return isOurCommand(handler.command, scriptPath)
}

/** Drops only our handlers, keeping the group and anyone else's handlers. */
function withoutOurs(groups: HookGroup[], scriptPath: string): { groups: HookGroup[]; removed: boolean } {
  let removed = false
  const kept: HookGroup[] = []
  for (const group of groups) {
    const hooks = group.hooks.filter((handler) => {
      const ours = isOurHandler(handler, scriptPath)
      if (ours) removed = true
      return !ours
    })
    if (hooks.length > 0) kept.push({ ...group, hooks })
  }
  return { groups: kept, removed }
}

export interface MergeResult {
  document: SettingsDocument
  added: string[]
  replaced: string[]
  /** Events an older build installed that this one no longer serves. */
  removed: string[]
}

/**
 * Adds our handlers without disturbing anyone else's. Re-running replaces only
 * the groups we previously wrote, so an upgrade that changes a timeout does not
 * accumulate duplicate hooks.
 *
 * Handlers are stripped from EVERY event, not just the ones being installed.
 * Only rewriting incoming events left a dropped event's handler in place for
 * ever, and since the binary no longer implements it, it exited 2 with
 * "Unknown hook event" every time the harness fired it — a permanent hook
 * failure that reinstalling could not clear.
 */
export function mergeHooks(
  existing: SettingsDocument,
  incoming: HookConfig,
  scriptPath: string,
): MergeResult {
  const hooks: HookConfig = {}
  const added: string[] = []
  const replaced: string[] = []
  const removed: string[] = []

  for (const [event, groups] of Object.entries(existing.hooks ?? {})) {
    if (!Array.isArray(groups)) {
      // Codex keeps `[hooks.state]` beside event tables. It is not a matcher list.
      ;(hooks as Record<string, unknown>)[event] = groups
      continue
    }
    const { groups: foreign, removed: hadOurs } = withoutOurs(groups, scriptPath)
    if (hadOurs) {
      if (event in incoming) replaced.push(event)
      else removed.push(event)
    }
    if (foreign.length > 0) hooks[event] = foreign
  }

  for (const [event, groups] of Object.entries(incoming)) {
    if (!replaced.includes(event)) added.push(event)
    hooks[event] = [...(hooks[event] ?? []), ...groups]
  }

  return { document: { ...existing, hooks }, added, replaced, removed }
}

export function removeHooks(existing: SettingsDocument, scriptPath: string): MergeResult {
  const hooks: HookConfig = {}
  const replaced: string[] = []
  for (const [event, groups] of Object.entries(existing.hooks ?? {})) {
    if (!Array.isArray(groups)) {
      ;(hooks as Record<string, unknown>)[event] = groups
      continue
    }
    const { groups: foreign, removed } = withoutOurs(groups, scriptPath)
    if (removed) replaced.push(event)
    if (foreign.length > 0) hooks[event] = foreign
  }
  const remaining = Object.keys(hooks).length > 0 ? hooks : undefined
  const document = { ...existing }
  if (remaining === undefined) delete document.hooks
  else document.hooks = remaining
  return { document, added: [], replaced, removed: [] }
}

/**
 * Writes the settings file the way a tool that does not own it should.
 *
 * Truncating in place lost the user's whole harness configuration if the write
 * failed halfway, and clobbered a concurrent editor's changes; following a
 * symlink wrote through to a target they never named. So: refuse
 * anything that is not a regular file, write a sibling temp file, fsync it, and
 * rename over the original — atomic within a directory on every platform we
 * support.
 */
export function applyPlan(file: string, document: SettingsDocument | CursorSettingsDocument): void {
  const body = isTomlSettingsPath(file)
    ? tomlBody(file, document as SettingsDocument)
    : `${JSON.stringify(document, null, 2)}\n`
  if (
    (path.basename(file) === 'hooks.json' && isEmptyJsonDocument(body)) ||
    (isTomlSettingsPath(file) && body.trim() === '')
  ) {
    if (existsSync(file)) rmSync(file, { force: true })
    return
  }
  if (existsSync(file)) {
    try {
      if (readOwnedRegularFile(file) === body) return
    } catch {
      // A file we cannot re-read still needs the replacement below.
    }
  }
  atomicWriteFileSync(file, body, {
    requireCurrentUserOwner: true,
  })
}

function isEmptyJsonDocument(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 0
  } catch {
    return false
  }
}

/** Delete an emptied Codex hooks.json and a now-empty layer directory. */
export function cleanupEmptiedCodexLayer(paths: CodexLayerPaths): void {
  if (existsSync(paths.hooksJson)) {
    try {
      const document = loadSettings(paths.hooksJson)
      const keys = Object.keys(document)
      const hooksEmpty = document.hooks === undefined || Object.keys(document.hooks).length === 0
      if (keys.every((key) => key === 'hooks') && hooksEmpty) {
        rmSync(paths.hooksJson, { force: true })
      }
    } catch {
      // Leave a file uninstall could not parse; the caller already reported it.
    }
  }
  if (!existsSync(paths.dir)) return
  try {
    if (readdirSync(paths.dir).length === 0) rmdirSync(paths.dir)
  } catch {
    // A concurrently replaced directory is not ours to fight.
  }
}

/**
 * A TOML file rewritten around its `[hooks]` tables, not over them.
 *
 * `config.toml` is the user's, and for most of them it is hand-written: model
 * choices, sandbox settings, MCP servers, and the comments explaining why. A
 * parse-and-restringify write returns all of that as data and none of it as
 * the document they wrote — comments gone, order normalized, spacing theirs no
 * longer. Notifai adds three hook handlers; it has no business reflowing the
 * rest.
 *
 * So everything outside `[hooks...]` is carried across as the exact bytes it
 * came in as, and only the hooks tables are regenerated — re-emitted at the end
 * of the file, because TOML does not care where a table sits and splicing into
 * the middle would mean reasoning about a region line by line. If the result
 * cannot be proven to parse back to the document asked for, this falls back to
 * the whole-file rewrite rather than risk a file it half-understood.
 */
function tomlBody(file: string, document: SettingsDocument): string {
  const whole = `${stringifyToml(document)}\n`
  if (!existsSync(file)) return whole
  let previous: string
  try {
    previous = readOwnedRegularFile(file)
  } catch {
    return whole
  }
  return spliceTomlHooks(previous, document) ?? whole
}

/** A TOML table header line, e.g. `[hooks.state."…"]` or `[[hooks.Stop]]`. */
const TOML_TABLE_HEADER = /^\s*\[\[?([^[\]]+)\]\]?\s*(?:#.*)?$/

/**
 * The first key in a dotted TOML key path, unquoting it if it is quoted.
 * `hooks.state."/a/b:stop:0:0"` is rooted at `hooks`, and so is `hooks.Stop`.
 */
function firstTomlKey(keyPath: string): string {
  const trimmed = keyPath.trim()
  const quote = trimmed[0]
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1)
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)
  }
  const dot = trimmed.indexOf('.')
  return (dot === -1 ? trimmed : trimmed.slice(0, dot)).trim()
}

/**
 * `source` with its hooks tables replaced by `document`'s, or null when that
 * cannot be done safely — an inline top-level `hooks` key, or a result that
 * does not parse back to exactly the document asked for.
 */
function spliceTomlHooks(source: string, document: SettingsDocument): string | null {
  const kept: string[] = []
  let inHooks = false
  for (const line of source.split('\n')) {
    const header = TOML_TABLE_HEADER.exec(line)
    if (header !== null) inHooks = firstTomlKey(header[1] ?? '') === 'hooks'
    // A root-level `hooks = …` or `hooks.x = …` would survive the splice and
    // then collide with the tables appended below.
    if (!inHooks && /^\s*hooks\s*[.=]/.test(line)) return null
    if (!inHooks) kept.push(line)
  }

  const hooks = document.hooks
  const body = hooks === undefined ? '' : stringifyToml({ hooks })
  const head = kept.join('\n').trimEnd()
  const spliced =
    body === '' ? `${head}\n` : head === '' ? `${body}\n` : `${head}\n\n${body}\n`

  try {
    if (!sameTomlValue(parseToml(spliced), document)) return null
  } catch {
    return null
  }
  return spliced
}

/** Structural equality for parsed TOML, which carries dates as well as data. */
function sameTomlValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => sameTomlValue(item, b[index]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => key in right && sameTomlValue(left[key], right[key]))
}

export function loadSettings(file: string): SettingsDocument {
  return isTomlSettingsPath(file) ? readTomlSettings(file) : readSettings(file)
}

function isTomlSettingsPath(file: string): boolean {
  return file.endsWith('.toml')
}

function readTomlSettings(file: string): SettingsDocument {
  if (!existsSync(file)) return {}
  const source = readOwnedRegularFile(file)
  try {
    const parsed: unknown = parseToml(source)
    return typeof parsed === 'object' && parsed !== null ? (parsed as SettingsDocument) : {}
  } catch {
    throw new Error(`Could not parse ${file}; fix or move it before installing hooks.`)
  }
}

export function loadCursorSettings(file: string): CursorSettingsDocument {
  return readCursorSettings(file)
}

// ---------------------------------------------------------------------------
// Discovery — answering "will my hooks actually run?" without a live test
// ---------------------------------------------------------------------------

/** One of our handlers as it sits in a settings file, with its position. */
export interface InstalledHandler {
  event: string
  /** Index of the matcher group within the event, as the harness sees it. */
  groupIndex: number
  /** Index of the handler within its group. */
  handlerIndex: number
  command: string
  /** Declared process lifetime, used to detect config/install drift. */
  timeout?: number
  async?: boolean
  statusMessage?: string
}

export interface Installation {
  harness: HookInstallableHarness
  file: string
  global: boolean
  handlers: InstalledHandler[]
  /** Structural defects that require reinstalling this generated adapter. */
  problems?: string[]
}

/** Codex's canonical event spelling inside its persisted trust keys. */
function codexEventName(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/** Recursively sort object keys before hashing, matching Codex's canonical JSON. */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  )
}

/**
 * Best-effort mirror of the identity current Codex builds compare with
 * `hooks.state.*.trusted_hash`. This persisted format is diagnostic evidence,
 * not an API: Codex's `/hooks` UI remains authoritative and Notifai never
 * writes the trust store.
 */
export function codexHookIdentityHash(handler: InstalledHandler): string {
  const command = {
    type: 'command',
    command: handler.command,
    timeout: Math.max(1, handler.timeout ?? 600),
    async: handler.async ?? false,
    ...(handler.statusMessage === undefined ? {} : { statusMessage: handler.statusMessage }),
  }
  const normalized = canonicalValue({
    event_name: codexEventName(handler.event),
    hooks: [command],
  })
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`
}

function codexTrustState(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const file = path.join(codexGlobalDir(env), 'config.toml')
  if (!existsSync(file)) return {}
  try {
    const parsed = parseToml(readFileSync(file, 'utf8')) as Record<string, unknown>
    const hooks = parsed['hooks']
    if (typeof hooks !== 'object' || hooks === null) return {}
    const state = (hooks as Record<string, unknown>)['state']
    return typeof state === 'object' && state !== null ? state as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Best-effort mirror of current Codex's persisted key for one handler. */
export function codexTrustKey(
  installation: Installation,
  handler: InstalledHandler,
): string {
  let source = installation.file
  try {
    source = path.join(realpathSync(path.dirname(source)), path.basename(source))
  } catch {
    // Codex falls back to the logical source path when canonicalization fails,
    // so the diagnostic must do the same.
  }
  return `${source}:${codexEventName(handler.event)}:${handler.groupIndex}:${handler.handlerIndex}`
}

/**
 * Trust defects that make installed Codex handlers look present while Codex
 * skips them. Trust is user-owned; the supported repair is Codex's `/hooks`
 * review UI, never writing the trust store on the user's behalf. Because the
 * persisted shape is not a public Codex contract, this diagnosis can drift;
 * `/hooks` remains the source of truth.
 */
export function codexTrustProblems(
  installations: Installation[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const state = codexTrustState(env)
  return installations
    .filter((installation) => installation.harness === 'codex')
    .flatMap((installation) =>
      installation.handlers.flatMap((handler) => {
        const key = codexTrustKey(installation, handler)
        const entry = state[key]
        const trustedHash =
          typeof entry === 'object' && entry !== null
            ? (entry as Record<string, unknown>)['trusted_hash']
            : undefined
        const currentHash = codexHookIdentityHash(handler)
        if (
          typeof entry === 'object' &&
          entry !== null &&
          (entry as Record<string, unknown>)['enabled'] === false
        ) {
          return [
            `${handler.event} in ${installation.file} is disabled in Codex; open \`/hooks\` and enable the Notifai handler`,
          ]
        }
        if (trustedHash === currentHash) return []
        return [
          `${handler.event} in ${installation.file} is ${typeof trustedHash === 'string' ? 'changed since it was trusted' : 'not trusted'}; open \`/hooks\` in Codex and approve the Notifai handler`,
        ]
      }),
    )
}

/**
 * Any Notifai handler, whatever checkout wrote it.
 *
 * Deliberately looser than `isOurHandler`: this answers "has Notifai been set
 * up here at all", and a handler installed from a second checkout is still
 * evidence that it has (and is itself worth reporting).
 */
function isNotifaiCommand(command: string): boolean {
  return / hook (session-start|subagent-start|activation-stop|user-prompt-submit|stop|session-end)\b/.test(command)
}

/** Every place either harness would read a Notifai handler from. */
export function findInstallations(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  adapterHome?: string,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): Installation[] {
  const nodePath = inspectHookAdapter(adapterHome, platform).target?.execPath
  const commandOptions: HookCommandOptions = {
    platform,
    ...(nodePath === undefined ? {} : { nodePath }),
  }
  const found: Installation[] = []
  for (const harness of HOOK_INSTALLABLE_HARNESSES) {
    for (const global of [false, true]) {
      const files = hookDefinitionFiles(harness, global, cwd, env, platform)
      for (const file of files) {
      if (!existsSync(file)) continue
      // OpenCode's adapter is a plugin module, not a settings document, so it
      // is reported as one installation covering all three events rather than
      // parsed for handlers.
      if (harness === 'opencode' || harness === 'openclaw') {
        let source: string
        try {
          source = readOwnedRegularFile(file)
        } catch {
          continue
        }
        const target =
          harness === 'openclaw' ? openclawPluginTarget(source) : opencodePluginTarget(source)
        if (target === null) continue
        const label = harness === 'openclaw' ? 'OpenClaw' : 'OpenCode'
        const problems = [
          ...(!target.current
            ? [`obsolete ${label} event wiring; rerun \`notifai hooks install --harness ${harness}\``]
            : []),
          ...(target.adapter !== hookAdapterPath(adapterHome)
            ? [
                `${label} still names a mutable CLI or runtime path; rerun \`notifai hooks install --harness ${harness}\``,
              ]
            : []),
        ]
        const events = harness === 'openclaw' ? OPENCLAW_EVENTS : OPENCODE_EVENTS
        found.push({
          harness,
          file,
          global,
          ...(problems.length > 0 ? { problems } : {}),
          handlers: events.map(([event, hookEvent]) => ({
            event,
            groupIndex: 0,
            handlerIndex: 0,
            command: hookCommand(target.adapter, hookEvent, harness, {
              ...commandOptions,
              ...(target.nodePath === undefined ? {} : { nodePath: target.nodePath }),
            }),
            ...(target.timeoutSeconds === undefined ? {} : { timeout: target.timeoutSeconds }),
          })),
        })
        continue
      }
      if (harness === 'cursor') {
        let document: CursorSettingsDocument
        try {
          document = readCursorSettings(file)
        } catch {
          continue
        }
        const handlers = locateCursorHandlers(document)
        if (handlers.length > 0) {
          const problems = harnessMarkerProblems(harness, handlers, adapterHome, commandOptions)
          found.push({ harness, file, global, handlers, ...(problems.length > 0 ? { problems } : {}) })
        }
        continue
      }
      let document: SettingsDocument
      try {
        document = loadSettings(file)
      } catch {
        continue
      }
      const handlers = locateHandlers(document)
      if (handlers.length > 0) {
        const problems = harnessMarkerProblems(harness, handlers, adapterHome, commandOptions)
        found.push({ harness, file, global, handlers, ...(problems.length > 0 ? { problems } : {}) })
      }
      }
    }
  }
  return found
}

function harnessMarkerProblems(
  harness: HookInstallableHarness,
  handlers: InstalledHandler[],
  adapterHome?: string,
  options: HookCommandOptions = {},
): string[] {
  const problems: string[] = []
  if (!handlers.every((handler) => handler.command.includes(`--harness ${harness}`))) {
    problems.push(
      `installed commands do not stamp the ${harness} routing identity; rerun \`notifai hooks install --harness ${harness}\``,
    )
  }
  const expected = `${hookCommandPrefix(hookAdapterPath(adapterHome), options)}hook `
  if (!handlers.every((handler) => handler.command.startsWith(expected))) {
    problems.push(
      'installed commands still name a mutable CLI or runtime path; rerun `notifai hooks install` to migrate to the stable adapter',
    )
  }
  return problems
}

function locateCursorHandlers(document: CursorSettingsDocument): InstalledHandler[] {
  const handlers: InstalledHandler[] = []
  for (const [event, eventHandlers] of Object.entries(document.hooks ?? {})) {
    eventHandlers.forEach((handler, handlerIndex) => {
      if (isNotifaiCommand(handler.command)) {
        handlers.push({
          event,
          groupIndex: 0,
          handlerIndex,
          command: handler.command,
          ...(handler.timeout === undefined ? {} : { timeout: handler.timeout }),
        })
      }
    })
  }
  return handlers
}

function locateAllHandlers(document: SettingsDocument): InstalledHandler[] {
  const handlers: InstalledHandler[] = []
  for (const [event, groups] of Object.entries(document.hooks ?? {})) {
    if (!Array.isArray(groups)) continue
    groups.forEach((group, groupIndex) => {
      group.hooks?.forEach((handler, handlerIndex) => {
        if (typeof handler?.command !== 'string') return
        handlers.push({
          event,
          groupIndex,
          handlerIndex,
          command: handler.command,
          ...(handler.timeout === undefined ? {} : { timeout: handler.timeout }),
          ...(handler.async === undefined ? {} : { async: handler.async }),
          ...(handler.statusMessage === undefined ? {} : { statusMessage: handler.statusMessage }),
        })
      })
    })
  }
  return handlers
}

function locateHandlers(document: SettingsDocument): InstalledHandler[] {
  return locateAllHandlers(document).filter((handler) => isNotifaiCommand(handler.command))
}

/** The hook event a handler's command actually invokes, e.g. `stop`. */
export function handlerEvent(command: string): string | null {
  return / hook ([a-z-]+)/.exec(command)?.[1] ?? null
}

function readOwnedRegularFile(file: string): string {
  const stat = lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${file} is not a regular file; refusing to read it.`)
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${file} is owned by uid ${stat.uid}, not the current user.`)
  }
  return readFileSync(file, 'utf8')
}
