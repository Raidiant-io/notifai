/**
 * The terminal reopen: a new terminal window, in the conversation's folder,
 * that runs `claude --resume <id>` or `codex resume <id>` in the permission
 * mode the conversation last ran in, never a more permissive one.
 *
 * Everything here is decided from records and settings; nothing is launched.
 * `session-reopen.ts` owns when a reopen happens and runs what this returns.
 *
 * The window runs one small script Notifai writes for it. The script deletes
 * itself, clears the window, sets its title, enters the folder, sets the
 * conversation's config home, asks the native launcher to check once more
 * that nothing else has the conversation open (`--internal-reopen-guard`),
 * and then replaces itself with the harness inside the User's login shell, so
 * PATH and keys load exactly as in a terminal they open themselves. It holds
 * no secret and no prompt.
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

/**
 * Keep what a session's prompt and start hooks see that a reopen needs: the
 * terminal (from the hook's own environment) and the permission mode the
 * harness reports. Written only when it changed.
 */
export function recordReopenLaunch(sessionId: string, env: NodeJS.ProcessEnv, permissionMode: unknown, platform: NodeJS.Platform = process.platform): void {
  const seen = terminalSeen(env, platform)
  const mode = typeof permissionMode === 'string' && /^[A-Za-z]{1,32}$/.test(permissionMode) ? permissionMode : null
  const current = readSessionState(sessionId, env).reopen_launch
  const next = { terminal: seen.app, terminal_seen: seen.seen, orca_pane: seen.orcaPane, permission_mode: mode ?? current?.permission_mode ?? null }
  if (current !== undefined && current.terminal === next.terminal && current.terminal_seen === next.terminal_seen &&
      current.orca_pane === next.orca_pane && current.permission_mode === next.permission_mode) return
  updateSessionState(sessionId, env, (state) => ({ ...state, reopen_launch: next }))
}

/** The recorded facts, validated. */
export function readReopenLaunch(value: unknown): { terminal: TerminalApp | null; terminal_seen: string | null; orca_pane: boolean; permission_mode: string | null } | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const terminal = typeof record['terminal'] === 'string' && TERMINAL_APPS.has(record['terminal']) ? record['terminal'] as TerminalApp : null
  const seen = typeof record['terminal_seen'] === 'string' && record['terminal_seen'].length <= 32 ? record['terminal_seen'] : null
  const mode = typeof record['permission_mode'] === 'string' && /^[A-Za-z]{1,32}$/.test(record['permission_mode']) ? record['permission_mode'] : null
  return { terminal, terminal_seen: seen, orca_pane: record['orca_pane'] === true, permission_mode: mode }
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

/** Claude Code permission modes a reopen may pass on; anything else resumes in the ordinary mode. */
const CLAUDE_MODES: ReadonlySet<string> = new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'])

/** Options a reopen keeps from the original command line: never the prompt, never `-c`. */
const CLAUDE_KEPT: Readonly<Record<string, 'value' | 'values'>> = { '--model': 'value', '--add-dir': 'values' }
const CODEX_KEPT: Readonly<Record<string, 'value' | 'flag'>> = {
  '--no-daemon': 'flag', '-p': 'value', '--profile': 'value', '-m': 'value', '--model': 'value', '--add-dir': 'value',
  '-s': 'value', '--sandbox': 'value', '-a': 'value', '--ask-for-approval': 'value',
}

/**
 * The options of a Claude Code command line a reopen keeps: the model and
 * extra directories. Permission options are not kept: the mode the
 * conversation last ran in decides them (see `claudeResumeArgs`).
 */
export function claudeKeptOptions(argv: readonly string[]): string[] {
  const kept: string[] = []
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index]!
    const [name, inline] = word.startsWith('--') && word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, null]
    const kind = CLAUDE_KEPT[name]
    if (kind === undefined) continue
    if (inline !== null) { kept.push(name, inline); continue }
    if (kind === 'value') {
      if (index + 1 < argv.length) kept.push(name, argv[++index]!)
      continue
    }
    const values: string[] = []
    while (index + 1 < argv.length && !argv[index + 1]!.startsWith('-')) values.push(argv[++index]!)
    if (values.length > 0) kept.push(name, ...values)
  }
  return kept
}

/** The permission mode a Claude Code command line starts in, when it names one. */
export function claudeStartMode(argv: readonly string[]): string | null {
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index]!
    if (word === '--dangerously-skip-permissions') return 'bypassPermissions'
    if (word === '--permission-mode' && index + 1 < argv.length) return argv[index + 1]!
    if (word.startsWith('--permission-mode=')) return word.slice('--permission-mode='.length)
  }
  return null
}

/** The options of a Codex command line a reopen keeps; permission options follow `codexResumeArgs`. */
export function codexKeptOptions(argv: readonly string[]): string[] {
  const kept: string[] = []
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index]!
    const [name, inline] = word.startsWith('--') && word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, null]
    const kind = CODEX_KEPT[name]
    if (kind === undefined) continue
    if (kind === 'flag') { kept.push(name); continue }
    const value = inline ?? (index + 1 < argv.length ? argv[++index]! : null)
    if (value !== null) kept.push(name, value)
  }
  return kept
}

/**
 * `claude --resume <id>` with the kept options and the permission mode, always
 * named (a resume otherwise restores the mode the transcript last recorded):
 * `same` resumes in the mode the conversation last ran in (its hooks report it
 * at every prompt; before any, the mode its command line started in), never a
 * more permissive one; `default` and an unknown mode resume in the ordinary
 * mode.
 */
export function claudeResumeArgs(sessionId: string, kept: readonly string[], lastMode: string | null, setting: ReopenPermissionMode): string[] {
  const args = ['--resume', sessionId, ...kept]
  const mode = setting === 'same' && lastMode !== null && CLAUDE_MODES.has(lastMode) ? lastMode : 'default'
  if (mode === 'bypassPermissions') args.push('--dangerously-skip-permissions')
  else args.push('--permission-mode', mode)
  return args
}

/**
 * `codex resume <id>` with the kept options. Codex reports only whether a
 * thread bypasses approvals and the sandbox; so `same` passes the bypass only
 * when the thread last ran with it, and otherwise keeps the approval and
 * sandbox options of the command line minus full access. `default` keeps no
 * permission option.
 */
export function codexResumeArgs(sessionId: string, kept: readonly string[], lastMode: string | null, setting: ReopenPermissionMode): string[] {
  const args = ['resume', sessionId]
  const permission = new Set(['-s', '--sandbox', '-a', '--ask-for-approval'])
  for (let index = 0; index < kept.length; index += 1) {
    const word = kept[index]!
    if (!permission.has(word)) {
      args.push(word)
      if (word !== '--no-daemon') args.push(kept[++index]!)
      continue
    }
    const value = kept[++index]!
    if (setting === 'same' && lastMode !== null && !(value === 'danger-full-access' || value === 'never')) args.push(word, value)
  }
  if (setting === 'same' && lastMode === 'bypassPermissions') args.push('--dangerously-bypass-approvals-and-sandbox')
  return args
}

// -- the script ---------------------------------------------------------------------

/** One word for a POSIX shell, single-quoted. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** Shells whose login form takes `-l -c 'exec "$@"' name args…`; any other runs the harness without the login profile. */
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
  /** Variables the conversation needs that a fresh login shell would not set (its config home, Notifai's own state). */
  exports: Readonly<Record<string, string>>
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
  for (const [name, value] of Object.entries(input.exports)) lines.push(`${name}=${shellQuote(value)}; export ${name}`)
  lines.push(`${shellQuote(input.launcher)} --internal-reopen-guard ${shellQuote(input.record)} || exit 0`)
  const command = input.command.map(shellQuote).join(' ')
  const shell = input.loginShell
  if (shell !== null && path.isAbsolute(shell) && POSIX_LOGIN_SHELLS.has(path.basename(shell))) {
    lines.push(`exec ${shellQuote(shell)} -l -c 'exec "$@"' notifai ${command}`)
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
