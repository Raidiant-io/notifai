/**
 * The terminal reopen: a new terminal window, in the conversation's folder,
 * that runs `claude --resume <id>` or `codex resume <id>` with the permission
 * posture the conversation ran with: never a more permissive one.
 *
 * Everything here is decided from records and settings; nothing is launched.
 * `session-reopen.ts` owns when a reopen happens and runs what this returns.
 *
 * The window runs one small script Notifai writes for it. The script deletes
 * itself, clears the window, sets its title, enters the folder, sets the
 * conversation's config home, asks the native launcher to check once more
 * that nothing else has the conversation open (`--internal-reopen-guard`),
 * and then replaces itself with the harness inside the User's login shell, so
 * PATH and keys load exactly as in a terminal they open themselves; the
 * config home is set again after the login profile, which cannot move it. It
 * holds no prompt, only the options the conversation's own command line
 * showed every process on the machine.
 */
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ReopenFocus, ReopenPermissionMode, ReopenTerminalApp } from './config.js'
import { readSessionState, updateSessionState } from './hook-session-state.js'

/** A terminal app Notifai can open a window in. */
export type TerminalApp = Exclude<ReopenTerminalApp, 'auto' | 'custom'> | 'xterm' | 'x-terminal-emulator' | 'xdg-terminal-exec'

/** What a session's hooks saw of the terminal it ran in; recorded at every prompt. */
export interface TerminalSeen {
  /** The app, when Notifai can open a window in it; null when it cannot (an editor, tmux alone, Orca, unknown). */
  app: TerminalApp | null
  /** A short name for logs and doctor (`vscode`, `tmux`, `orca`), or null. */
  seen: string | null
  /** An Orca terminal pane: Orca resumes it in the same pane itself. */
  orcaPane: boolean
}

const BUNDLES: Readonly<Record<string, TerminalApp>> = {
  'com.apple.Terminal': 'terminal',
  'com.googlecode.iterm2': 'iterm2',
  'com.mitchellh.ghostty': 'ghostty',
  'com.github.wez.wezterm': 'wezterm',
  'net.kovidgoyal.kitty': 'kitty',
  'org.alacritty': 'alacritty',
  'io.alacritty': 'alacritty',
}

/** The terminal a hook ran in, from the environment the terminal gave it. */
export function terminalSeen(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): TerminalSeen {
  const orcaPane = Boolean(env['ORCA_AGENT_PANE'] || env['ORCA_TERMINAL_HANDLE'])
  const program = env['TERM_PROGRAM'] ?? ''
  if (orcaPane || program === 'Orca') return { app: null, seen: 'orca', orcaPane: true }
  if (program === 'vscode') return { app: null, seen: 'editor', orcaPane: false }
  // Variables each terminal sets in its own shells, then the program name.
  if (env['KITTY_WINDOW_ID']) return { app: 'kitty', seen: 'kitty', orcaPane: false }
  if (env['WEZTERM_PANE'] || program === 'WezTerm') return { app: 'wezterm', seen: 'wezterm', orcaPane: false }
  if (env['GHOSTTY_RESOURCES_DIR'] || program === 'ghostty') return { app: 'ghostty', seen: 'ghostty', orcaPane: false }
  if (env['ALACRITTY_WINDOW_ID'] || env['ALACRITTY_SOCKET']) return { app: 'alacritty', seen: 'alacritty', orcaPane: false }
  if (program === 'iTerm.app' || env['ITERM_SESSION_ID']) return { app: 'iterm2', seen: 'iterm2', orcaPane: false }
  if (program === 'Apple_Terminal') return { app: 'terminal', seen: 'terminal', orcaPane: false }
  if (platform === 'linux') {
    if (env['KONSOLE_VERSION']) return { app: 'konsole', seen: 'konsole', orcaPane: false }
    if (env['GNOME_TERMINAL_SCREEN'] || env['GNOME_TERMINAL_SERVICE']) return { app: 'gnome-terminal', seen: 'gnome-terminal', orcaPane: false }
    if (env['XTERM_VERSION']) return { app: 'xterm', seen: 'xterm', orcaPane: false }
  }
  // macOS names the app that started a shell (inside tmux too, which keeps it).
  const bundle = platform === 'darwin' ? BUNDLES[env['__CFBundleIdentifier'] ?? ''] : undefined
  if (bundle !== undefined) return { app: bundle, seen: bundle, orcaPane: false }
  const editor = /^(com\.microsoft\.VSCode|com\.todesktop\.|com\.exafunction\.windsurf|dev\.zed\.)/.test(env['__CFBundleIdentifier'] ?? '')
  if (editor) return { app: null, seen: 'editor', orcaPane: false }
  if (program === 'tmux' || env['TMUX']) return { app: null, seen: 'tmux', orcaPane: false }
  return { app: null, seen: program === '' ? null : program.slice(0, 32), orcaPane: false }
}

/** Where to look for what can open a window. Tests replace it. */
export interface TerminalProbe {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** A macOS app bundle by name (`Ghostty`), installed in /Applications or ~/Applications. */
  hasApp(name: string): boolean
  /** An executable on the hub's PATH, as an absolute path, or null. */
  which(name: string): string | null
}

export function systemTerminalProbe(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): TerminalProbe {
  return {
    platform,
    env,
    hasApp: (name) => [path.join('/Applications', `${name}.app`), path.join(env['HOME'] ?? os.homedir(), 'Applications', `${name}.app`)]
      .some((candidate) => existsSync(candidate)),
    which: (name) => {
      for (const directory of (env['PATH'] ?? '').split(path.delimiter)) {
        if (!path.isAbsolute(directory)) continue
        const candidate = path.join(directory, name)
        try {
          const info = statSync(candidate)
          if (info.isFile() && (info.mode & 0o111) !== 0) return candidate
        } catch { /* next */ }
      }
      return null
    },
  }
}

const TERMINAL_APPS: ReadonlySet<string> = new Set<TerminalApp>(['terminal', 'iterm2', 'ghostty', 'wezterm', 'kitty', 'alacritty', 'gnome-terminal',
  'konsole', 'xterm', 'x-terminal-emulator', 'xdg-terminal-exec'])

/** The T3 Code thread a conversation runs in, as T3 Code tells the harness it starts. */
export interface T3ThreadFacts {
  /** `T3CODE_THREAD_ID`: the thread `t3 thread send` addresses. */
  thread: string
  /** `T3CODE_CLI_PATH`: the `t3` of the T3 Code that runs it. */
  cli: string | null
  /** `T3CODE_HOME`, when T3 Code runs from a data directory other than the default one. */
  home: string | null
}

/** A T3 thread id: a UUID, or a prefixed one such as `mcp:<uuid>` or a delegated task's percent-encoded id. */
export const T3_THREAD = /^[A-Za-z0-9][A-Za-z0-9:%._-]{0,511}$/

function t3Cli(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 1_024 && path.isAbsolute(value) && /^t3(\.exe|\.cmd)?$/i.test(path.basename(value)) ? value : null
}

function t3Home(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 1_024 && path.isAbsolute(value) ? value : null
}

/** What T3 Code put in this hook's environment, or null outside T3 Code. */
export function t3ThreadOf(env: NodeJS.ProcessEnv): T3ThreadFacts | null {
  const thread = env['T3CODE_THREAD_ID']
  if (thread === undefined || !T3_THREAD.test(thread)) return null
  return { thread, cli: t3Cli(env['T3CODE_CLI_PATH']), home: t3Home(env['T3CODE_HOME']) }
}

/**
 * Keep what a session's prompt and start hooks see that a reopen needs: the
 * terminal (from the hook's own environment), the T3 Code thread it runs in,
 * and the permission mode the harness reports. Written only when it changed.
 */
export function recordReopenLaunch(sessionId: string, env: NodeJS.ProcessEnv, permissionMode: unknown, platform: NodeJS.Platform = process.platform): void {
  const seen = terminalSeen(env, platform)
  const mode = typeof permissionMode === 'string' && /^[A-Za-z]{1,32}$/.test(permissionMode) ? permissionMode : null
  const current = readSessionState(sessionId, env).reopen_launch
  const t3 = t3ThreadOf(env)
  const next = { terminal: seen.app, terminal_seen: seen.seen, orca_pane: seen.orcaPane, permission_mode: mode ?? current?.permission_mode ?? null,
    ...(t3 === null ? {} : { t3 }) }
  if (current !== undefined && current.terminal === next.terminal && current.terminal_seen === next.terminal_seen &&
      current.orca_pane === next.orca_pane && current.permission_mode === next.permission_mode &&
      JSON.stringify(current.t3 ?? null) === JSON.stringify(t3)) return
  updateSessionState(sessionId, env, (state) => ({ ...state, reopen_launch: next }))
}

/** The recorded facts, validated. */
export function readReopenLaunch(value: unknown): { terminal: TerminalApp | null; terminal_seen: string | null; orca_pane: boolean; permission_mode: string | null;
  t3: T3ThreadFacts | null } | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const terminal = typeof record['terminal'] === 'string' && TERMINAL_APPS.has(record['terminal']) ? record['terminal'] as TerminalApp : null
  const seen = typeof record['terminal_seen'] === 'string' && record['terminal_seen'].length <= 32 ? record['terminal_seen'] : null
  const mode = typeof record['permission_mode'] === 'string' && /^[A-Za-z]{1,32}$/.test(record['permission_mode']) ? record['permission_mode'] : null
  const rawT3 = typeof record['t3'] === 'object' && record['t3'] !== null ? record['t3'] as Record<string, unknown> : null
  const t3 = rawT3 !== null && typeof rawT3['thread'] === 'string' && T3_THREAD.test(rawT3['thread'])
    ? { thread: rawT3['thread'], cli: t3Cli(rawT3['cli']), home: t3Home(rawT3['home']) } : null
  return { terminal, terminal_seen: seen, orca_pane: record['orca_pane'] === true, permission_mode: mode, t3 }
}

const MAC_APPS: Readonly<Partial<Record<TerminalApp, string>>> = {
  terminal: 'Terminal', iterm2: 'iTerm', ghostty: 'Ghostty', wezterm: 'WezTerm', kitty: 'kitty', alacritty: 'Alacritty',
}
const LINUX_DEFAULTS: readonly TerminalApp[] = ['xdg-terminal-exec', 'x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']

/** How a window opens: the program, its arguments, and whether `open` returns at once with the outcome. */
export interface TerminalLaunch {
  app: TerminalApp | 'custom'
  command: string
  args: string[]
  /** `open` exits once the app took the document; a terminal program on Linux keeps running. */
  waits: boolean
}

export type TerminalChoice = { ok: true; launch: (script: string, cwd: string, title: string) => TerminalLaunch } | { ok: false; reason: 'no-display' | 'terminal-unavailable' }

function available(app: TerminalApp, probe: TerminalProbe): boolean {
  if (probe.platform === 'darwin') {
    const name = MAC_APPS[app]
    return name !== undefined && (app === 'terminal' || probe.hasApp(name))
  }
  return probe.platform === 'linux' && probe.which(app === 'wezterm' ? 'wezterm' : app) !== null
}

/** The window-opening command for one terminal app. */
export function terminalLaunch(app: TerminalApp, probe: TerminalProbe, focus: ReopenFocus, script: string, cwd: string, title: string): TerminalLaunch {
  if (probe.platform === 'darwin') {
    const background = focus === 'background' ? ['-g'] : []
    const name = MAC_APPS[app]!
    // A `.command` document opens in a new window of the running app: no
    // Automation permission, no second instance.
    if (app === 'terminal' || app === 'iterm2') return { app, command: '/usr/bin/open', args: [...background, '-a', name, script], waits: true }
    const appArgs = app === 'ghostty' ? [`--working-directory=${cwd}`, '-e', script]
      : app === 'wezterm' ? ['start', '--cwd', cwd, '--', script]
        : app === 'kitty' ? ['--directory', cwd, script]
          : ['--working-directory', cwd, '-e', script]
    return { app, command: '/usr/bin/open', args: [...background, '-n', '-a', name, '--args', ...appArgs], waits: true }
  }
  const command = probe.which(app) ?? app
  const args = app === 'gnome-terminal' ? [`--working-directory=${cwd}`, '--', script]
    : app === 'konsole' ? ['--workdir', cwd, '-e', script]
      : app === 'kitty' ? ['--directory', cwd, script]
        : app === 'alacritty' ? ['--working-directory', cwd, '-e', script]
          : app === 'wezterm' ? ['start', '--cwd', cwd, '--', script]
            : app === 'ghostty' ? [`--working-directory=${cwd}`, '-e', script]
              : app === 'xterm' ? ['-T', title, '-e', script]
                : app === 'x-terminal-emulator' ? ['-e', script]
                  : [script]
  return { app, command, args, waits: false }
}

/** `reopen.terminal_command`: words with `{cwd}` and `{script}`; no shell reads it. */
export function customTerminalLaunch(template: string, script: string, cwd: string): TerminalLaunch | null {
  const words = template.trim().split(/\s+/).filter((word) => word !== '')
  if (words.length === 0 || !words.some((word) => word.includes('{script}'))) return null
  const filled = words.map((word) => word.replaceAll('{cwd}', cwd).replaceAll('{script}', script))
  return { app: 'custom', command: filled[0]!, args: filled.slice(1), waits: false }
}

/**
 * Which window opens: the setting when it names an app, else the app the
 * conversation ran in when Notifai can open a window there, else the system
 * terminal. On Linux nothing opens without a desktop session.
 */
export function chooseTerminal(setting: ReopenTerminalApp, command: string | null, recorded: TerminalApp | null, probe: TerminalProbe,
  focus: ReopenFocus): TerminalChoice {
  if (probe.platform === 'linux' && !probe.env['DISPLAY'] && !probe.env['WAYLAND_DISPLAY']) return { ok: false, reason: 'no-display' }
  if (probe.platform !== 'darwin' && probe.platform !== 'linux') return { ok: false, reason: 'terminal-unavailable' }
  if (setting === 'custom') {
    if (command === null || customTerminalLaunch(command, 'x', 'x') === null) return { ok: false, reason: 'terminal-unavailable' }
    return { ok: true, launch: (script, cwd) => customTerminalLaunch(command, script, cwd)! }
  }
  const pick = (app: TerminalApp): TerminalChoice => ({ ok: true, launch: (script, cwd, title) => terminalLaunch(app, probe, focus, script, cwd, title) })
  if (setting !== 'auto') return available(setting, probe) ? pick(setting) : { ok: false, reason: 'terminal-unavailable' }
  if (recorded !== null && available(recorded, probe)) return pick(recorded)
  if (probe.platform === 'darwin') return pick('terminal')
  const fallback = LINUX_DEFAULTS.find((app) => probe.which(app) !== null)
  return fallback === undefined ? { ok: false, reason: 'terminal-unavailable' } : pick(fallback)
}

// -- the harness command ---------------------------------------------------------
//
// A reopen runs the conversation the way it ran: the same permission posture,
// never a more permissive one and not needlessly a narrower one. So the
// options a terminal harness was started with are read exactly from its
// process when it registers (`launchRecordOf`) and replayed: the permission
// options and everything that narrows or shapes them (denied and allowed
// tools, settings, MCP servers, system prompts, `-c` overrides, profiles).
// Only what would start something else is left out: the prompt, the
// conversation picker, a new worktree, a session name. A command line with an
// option this build does not know is not replayed at all, and the
// conversation waits for the User: guessing could widen what it may do.

type OptionKind = 'flag' | 'value' | 'values' | 'optional'
/** `keep`: replayed; `drop`: never replayed; `refuse`: the command line is not one a reopen can repeat. */
type OptionRule = readonly [OptionKind, 'keep' | 'drop' | 'refuse']

interface OptionEntry { rule: OptionRule; canonical: string }

function table(groups: Readonly<Record<string, OptionRule>>, aliases: Readonly<Record<string, string>> = {}): ReadonlyMap<string, OptionEntry> {
  const map = new Map<string, OptionEntry>(Object.entries(groups).map(([name, rule]) => [name, { rule, canonical: name }]))
  for (const [alias, name] of Object.entries(aliases)) map.set(alias, { rule: groups[name]!, canonical: name })
  return map
}

/** Claude Code 2.1 options by what a reopen does with them. */
const CLAUDE_OPTIONS = table({
  '--add-dir': ['values', 'keep'], '--allowedTools': ['values', 'keep'], '--disallowedTools': ['values', 'keep'],
  '--betas': ['values', 'keep'], '--mcp-config': ['values', 'keep'], '--tools': ['values', 'keep'],
  '--agent': ['value', 'keep'], '--agents': ['value', 'keep'], '--append-system-prompt': ['value', 'keep'],
  '--append-system-prompt-file': ['value', 'keep'], '--system-prompt': ['value', 'keep'], '--system-prompt-file': ['value', 'keep'],
  '--effort': ['value', 'keep'], '--fallback-model': ['value', 'keep'], '--model': ['value', 'keep'], '--permission-mode': ['value', 'keep'],
  '--permission-prompt-tool': ['value', 'keep'], '--plugin-dir': ['value', 'keep'], '--plugin-url': ['value', 'keep'],
  '--setting-sources': ['value', 'keep'], '--settings': ['value', 'keep'], '--autocompact': ['value', 'keep'],
  '--system-prompt-snapshot': ['value', 'keep'],
  '--allow-dangerously-skip-permissions': ['flag', 'keep'], '--dangerously-skip-permissions': ['flag', 'keep'],
  '--strict-mcp-config': ['flag', 'keep'], '--restricted': ['flag', 'keep'], '--safe-mode': ['flag', 'keep'], '--bare': ['flag', 'keep'],
  '--disable-slash-commands': ['flag', 'keep'], '--chrome': ['flag', 'keep'], '--no-chrome': ['flag', 'keep'], '--ide': ['flag', 'keep'],
  '--verbose': ['flag', 'keep'], '--brief': ['flag', 'keep'], '--ax-screen-reader': ['flag', 'keep'],
  '--exclude-dynamic-system-prompt-sections': ['flag', 'keep'],
  '--name': ['value', 'drop'], '--session-id': ['value', 'drop'], '--debug-file': ['value', 'drop'],
  '--remote-control-session-name-prefix': ['value', 'drop'], '--file': ['values', 'drop'],
  '--continue': ['flag', 'drop'], '--fork-session': ['flag', 'drop'], '--tmux': ['flag', 'drop'],
  '--resume': ['optional', 'drop'], '--debug': ['optional', 'drop'], '--from-pr': ['optional', 'drop'], '--remote-control': ['optional', 'drop'],
  '--worktree': ['optional', 'drop'], '--teleport': ['optional', 'drop'], '--prompt-suggestions': ['optional', 'drop'],
  '--print': ['flag', 'refuse'], '--bg': ['flag', 'refuse'], '--cloud': ['optional', 'refuse'], '--environment': ['value', 'refuse'],
  '--desktop': ['flag', 'refuse'],
}, {
  '--allowed-tools': '--allowedTools', '--disallowed-tools': '--disallowedTools', '-n': '--name', '-c': '--continue', '-r': '--resume',
  '-d': '--debug', '-w': '--worktree', '-p': '--print', '--background': '--bg',
})

/** Codex CLI 0.163 options (`codex` and `codex resume`) by what a reopen does with them. */
const CODEX_OPTIONS = table({
  '--config': ['value', 'keep'], '--enable': ['value', 'keep'], '--disable': ['value', 'keep'], '--model': ['value', 'keep'],
  '--local-provider': ['value', 'keep'], '--profile': ['value', 'keep'], '--sandbox': ['value', 'keep'], '--ask-for-approval': ['value', 'keep'],
  '--add-dir': ['value', 'keep'],
  '--oss': ['flag', 'keep'], '--approve-for-me': ['flag', 'keep'], '--dangerously-bypass-approvals-and-sandbox': ['flag', 'keep'],
  '--dangerously-bypass-hook-trust': ['flag', 'keep'], '--search': ['flag', 'keep'], '--no-alt-screen': ['flag', 'keep'],
  '--no-daemon': ['flag', 'keep'], '--strict-config': ['flag', 'keep'],
  '--cd': ['value', 'drop'], '--image': ['values', 'drop'],
  '--worktree': ['flag', 'drop'], '--last': ['flag', 'drop'], '--all': ['flag', 'drop'], '--include-non-interactive': ['flag', 'drop'],
  '--remote': ['value', 'refuse'], '--remote-auth-token-env': ['value', 'refuse'],
}, { '-c': '--config', '-m': '--model', '-p': '--profile', '-s': '--sandbox', '-a': '--ask-for-approval', '-C': '--cd', '-i': '--image' })

interface OptionGroup { name: string; values: string[] }

/**
 * The options of a command line, each under its canonical name, with the
 * words that belong to it; null when one is unknown or refused. Words that
 * belong to no option (the prompt, a subcommand, a session id) are left out.
 */
function parseOptions(argv: readonly string[], options: ReadonlyMap<string, OptionEntry>, from = 1): { kept: OptionGroup[] } | null {
  const kept: OptionGroup[] = []
  for (let index = from; index < argv.length; index += 1) {
    const word = argv[index]!
    if (word === '--') break
    if (!word.startsWith('-') || word === '-') continue
    let name = word
    let inline: string | null = null
    if (word.startsWith('--') && word.includes('=')) {
      name = word.slice(0, word.indexOf('='))
      inline = word.slice(word.indexOf('=') + 1)
    } else if (!word.startsWith('--') && word.length > 2) {
      // `-anever`, `-a=never`: a short option with its value attached.
      name = word.slice(0, 2)
      inline = word.slice(2).replace(/^=/, '')
      if (options.get(name)?.rule[0] !== 'value') return null
    }
    const entry = options.get(name)
    if (entry === undefined || entry.rule[1] === 'refuse') return null
    const [kind, action] = entry.rule
    const values: string[] = []
    if (kind === 'flag') {
      if (inline !== null && action === 'keep') return null
    } else if (kind === 'value') {
      if (inline !== null) values.push(inline)
      else if (index + 1 < argv.length) values.push(argv[++index]!)
      else return null
    } else {
      if (inline !== null) values.push(inline)
      while (index + 1 < argv.length && !argv[index + 1]!.startsWith('-')) {
        const next = argv[++index]!
        values.push(next)
        if (kind === 'optional') break
      }
      if (kind === 'values' && values.length === 0) return null
    }
    if (action === 'keep') kept.push({ name: entry.canonical, values })
  }
  return { kept }
}

const flatten = (groups: readonly OptionGroup[]): string[] => groups.flatMap((group) => [group.name, ...group.values])

/** At most this many replayed words, each at most this long: a longer command line is not replayed. */
export const REPLAY_MAX_WORDS = 128
export const REPLAY_MAX_WORD = 16_384

function bounded(options: string[]): string[] | null {
  return options.length <= REPLAY_MAX_WORDS && options.every((word) => word.length <= REPLAY_MAX_WORD) ? options : null
}

/** The options of a Claude Code command line a reopen replays; null when it cannot repeat them. */
export function claudeLaunchOptions(argv: readonly string[]): string[] | null {
  const parsed = parseOptions(argv, CLAUDE_OPTIONS)
  return parsed === null ? null : bounded(flatten(parsed.kept))
}

/** The options of a Codex command line a reopen replays; null when it cannot repeat them. */
export function codexLaunchOptions(argv: readonly string[]): string[] | null {
  const parsed = parseOptions(argv, CODEX_OPTIONS)
  return parsed === null ? null : bounded(flatten(parsed.kept))
}

/** Claude Code permission modes a reopen may name. */
const CLAUDE_MODES: ReadonlySet<string> = new Set(['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'])
/** The modes no wider than the ordinary one: `reopen.permission_mode = "default"` keeps them. */
const CLAUDE_NARROW_MODES: ReadonlySet<string> = new Set(['default', 'manual', 'plan', 'dontAsk'])

/** The permission mode a Claude Code command line starts in, when it names one. */
export function claudeStartMode(options: readonly string[]): string | null {
  const parsed = parseOptions(['claude', ...options], CLAUDE_OPTIONS)
  let mode: string | null = null
  for (const group of parsed?.kept ?? []) {
    if (group.name === '--dangerously-skip-permissions') return 'bypassPermissions'
    if (group.name === '--permission-mode') mode = group.values[0] ?? null
  }
  return mode
}

/**
 * `claude --resume <id>` with the replayed options, in the mode the
 * conversation last ran in (its hooks report it at every prompt; before any,
 * the mode its command line started in), always named. Where it could reach
 * full bypass by switching modes, it still can. `default` resumes in the ordinary mode, or a
 * narrower one it last ran in, without the options that widen it.
 */
export function claudeResumeArgs(sessionId: string, options: readonly string[], lastMode: string | null, setting: ReopenPermissionMode): string[] {
  const groups = parseOptions(['claude', ...options], CLAUDE_OPTIONS)?.kept ?? []
  const started = claudeStartMode(options)
  const could = started === 'bypassPermissions' || groups.some((group) => group.name === '--allow-dangerously-skip-permissions')
  const known = lastMode !== null && CLAUDE_MODES.has(lastMode) ? lastMode : null
  // Nothing reported nor named: the ordinary mode, never whatever the transcript last recorded.
  let mode = known ?? started ?? 'default'
  const widening = new Set(['--permission-mode', '--dangerously-skip-permissions',
    ...(setting === 'default' ? ['--allow-dangerously-skip-permissions', '--allowedTools'] : [])])
  const args = ['--resume', sessionId, ...flatten(groups.filter((group) => !widening.has(group.name)))]
  if (setting === 'default') mode = mode !== null && CLAUDE_NARROW_MODES.has(mode) ? mode : 'default'
  else if (could && mode !== 'bypassPermissions' && !groups.some((group) => group.name === '--allow-dangerously-skip-permissions')) {
    args.push('--allow-dangerously-skip-permissions')
  }
  if (mode === 'bypassPermissions') args.push('--dangerously-skip-permissions')
  else if (mode !== null) args.push('--permission-mode', mode)
  return args
}

/** A `-c key=value` override's key and its value without TOML quotes. */
function configOverride(text: string): { key: string; value: string } | null {
  const at = text.indexOf('=')
  if (at <= 0) return null
  return { key: text.slice(0, at).trim(), value: text.slice(at + 1).trim().replace(/^(["'])(.*)\1$/, '$2') }
}

/** Whether one replayed Codex option widens what the conversation may do beyond Codex's ordinary posture. */
function codexWidens(group: OptionGroup): boolean {
  const value = group.values[0] ?? ''
  if (group.name === '--dangerously-bypass-approvals-and-sandbox' || group.name === '--approve-for-me') return true
  if (group.name === '--ask-for-approval') return value === 'never'
  if (group.name === '--sandbox') return value === 'danger-full-access'
  if (group.name !== '--config') return false
  const override = configOverride(value)
  if (override === null) return false
  if (override.key === 'approval_policy') return override.value === 'never'
  if (override.key === 'sandbox_mode') return override.value === 'danger-full-access'
  if (override.key === 'sandbox_workspace_write.network_access') return override.value === 'true'
  return override.key === 'approvals_reviewer' && override.value !== 'user'
}

/**
 * `codex resume <id>` with the replayed options: exactly as the thread ran
 * with `same`; with `default`, without the options that widen Codex's
 * ordinary posture (full access, no approvals, network, automatic review).
 */
export function codexResumeArgs(sessionId: string, options: readonly string[], setting: ReopenPermissionMode): string[] {
  const groups = parseOptions(['codex', ...options], CODEX_OPTIONS)?.kept ?? []
  return ['resume', sessionId, ...flatten(setting === 'default' ? groups.filter((group) => !codexWidens(group)) : groups)]
}

const APPROVAL_POLICIES: ReadonlySet<string> = new Set(['untrusted', 'on-failure', 'on-request', 'never'])
const SANDBOX_MODES: ReadonlySet<string> = new Set(['read-only', 'workspace-write', 'danger-full-access'])

/**
 * A Codex thread's permission posture as Codex recorded it for its last
 * turn (the rollout's `turn_context`), as `-c` overrides: what a thread on
 * the shared background server, whose terminal's command line Notifai cannot
 * read, resumes with. Null when any part is one this build cannot express
 * exactly.
 */
export function codexPostureOptions(context: Readonly<Record<string, unknown>>): string[] | null {
  const approval = context['approval_policy']
  const reviewer = context['approvals_reviewer']
  const sandbox = context['sandbox_policy']
  if (typeof approval !== 'string' || !APPROVAL_POLICIES.has(approval)) return null
  if (reviewer !== undefined && reviewer !== 'user') return null
  if (typeof sandbox !== 'object' || sandbox === null || Array.isArray(sandbox)) return null
  const policy = sandbox as Record<string, unknown>
  const type = policy['type']
  if (typeof type !== 'string' || !SANDBOX_MODES.has(type)) return null
  const options = ['--config', `approval_policy="${approval}"`, '--config', `sandbox_mode="${type}"`]
  for (const [key, value] of Object.entries(policy)) {
    if (key === 'type') continue
    if (type !== 'workspace-write') return null
    if (['network_access', 'exclude_tmpdir_env_var', 'exclude_slash_tmp'].includes(key) && typeof value === 'boolean') {
      options.push('--config', `sandbox_workspace_write.${key}=${value}`)
    } else if (key === 'writable_roots' && Array.isArray(value) && value.every((root) => typeof root === 'string' && path.isAbsolute(root))) {
      options.push('--config', `sandbox_workspace_write.writable_roots=${JSON.stringify(value)}`)
    } else {
      return null
    }
  }
  return options
}

// -- the script ---------------------------------------------------------------------

/** One word for a POSIX shell, single-quoted. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** Shells whose login form takes `-l -c '<pins>; exec "$@"' name args…`; any other runs the harness without the login profile. */
const POSIX_LOGIN_SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh'])

export interface ReopenScript {
  /** The native launcher that runs the last check. */
  launcher: string
  /** The record the launcher checks and marks. */
  record: string
  cwd: string
  title: string
  /** The harness executable and its arguments. */
  command: readonly string[]
  /** The User's login shell (from the account database). */
  loginShell: string | null
  /**
   * Variables the conversation runs with whatever the User's profile sets:
   * its config home and Notifai's own folders, or null to unset one (a
   * conversation in the default home). Applied before the last check and
   * again after the login profile has run.
   */
  pinned: Readonly<Record<string, string | null>>
}

/** The one-line note a window shows when its folder is gone; nothing else runs. */
export const FOLDER_GONE_LINE = 'Notifai did not reopen this conversation: its folder no longer exists.'

export function reopenScript(input: ReopenScript): string {
  const lines = [
    '#!/bin/sh',
    '# Notifai wrote this to reopen one conversation; it deletes itself.',
    'rm -f -- "$0"',
    // A clean window with a clear title: no prompt or path left from opening it.
    `printf '\\033]0;%s\\007\\033[H\\033[2J' ${shellQuote(input.title)}`,
    `cd -- ${shellQuote(input.cwd)} 2>/dev/null || { printf '%s\\n' ${shellQuote(FOLDER_GONE_LINE)}; exit 0; }`,
  ]
  const pins = Object.entries(input.pinned).map(([name, value]) => value === null ? `unset ${name}` : `${name}=${shellQuote(value)}; export ${name}`)
  lines.push(...pins)
  lines.push(`${shellQuote(input.launcher)} --internal-reopen-guard ${shellQuote(input.record)} || exit 0`)
  const command = input.command.map(shellQuote).join(' ')
  const shell = input.loginShell
  if (shell !== null && path.isAbsolute(shell) && POSIX_LOGIN_SHELLS.has(path.basename(shell))) {
    // The login profile loads PATH and keys as in a terminal the User opens; the pins come after it, so it cannot move the conversation's home.
    lines.push(`exec ${shellQuote(shell)} -l -c ${shellQuote([...pins, 'exec "$@"'].join('; '))} notifai ${command}`)
  } else {
    lines.push(`exec ${command}`)
  }
  return `${lines.join('\n')}\n`
}

/** The window title: what it is and where, so a window that appeared by itself explains itself. */
export function reopenTitle(harness: 'claude-code' | 'codex', cwd: string): string {
  const folder = path.basename(cwd) || cwd
  return `${harness === 'claude-code' ? 'Claude Code' : 'Codex'} · ${folder} · reopened by Notifai`
}

/**
 * The environment a Linux terminal starts with: the desktop session and the
 * account, nothing from whichever terminal happened to start the hub.
 */
export function terminalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = /^(HOME|USER|LOGNAME|SHELL|PATH|LANG|LANGUAGE|LC_[A-Z_]+|TZ|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_[A-Z_]+|TMPDIR)$/
  const clean: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) if (kept.test(name) && value !== undefined) clean[name] = value
  return clean
}
