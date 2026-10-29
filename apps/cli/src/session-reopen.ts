/**
 * Reopening a stopped conversation in place.
 *
 * A conversation its app or the machine stopped (never one the User closed)
 * keeps its questions open, and what is answered meanwhile waits for it. When
 * an answer or note arrives, this module decides whether to open the
 * conversation again where it was, so the agent gets it at once, and does it.
 * Nothing else in Notifai starts, opens or wakes a conversation that is not
 * running.
 *
 * Everything that decides it sits here, so the behaviour is one switch and
 * one policy per place:
 *
 * - `reopen.automatic`: off, and every stopped conversation waits for the User;
 * - a place's policy: `reopen.terminal` (a new terminal window, see
 *   `reopen-terminal.ts`), `reopen.codex_app` (the Codex app runs the
 *   thread's queued wake while it is running, see `reopen-codex-app.ts`) and
 *   `reopen.t3` (T3 Code's thread gets a Notifai wake while T3 Code runs,
 *   see `reopen-t3.ts`). Every other place waits.
 *
 * Rules that no setting changes:
 * - Notifai never moves a conversation: it reopens only in the place the
 *   conversation was last in, through that place's adapter.
 * - Never a scripted run, never an Orca pane (Orca resumes those itself in the
 *   same pane), never a conversation open anywhere else (a live Claude Code
 *   process with its id; a Codex thread some process has loaded, unless the
 *   shared server holds it and no terminal shows it).
 * - Each item causes at most one attempt; a later item may try once more, so
 *   a stopped conversation is reopened at most twice. Several items at once
 *   cause one reopen, and the machine opens at most three windows a minute.
 * - Outcomes go to the log (`hub.reopen`) and `notifai doctor`; the phone
 *   shows nothing new.
 */
import { randomBytes } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { parseDescriptor } from './claude-wake.js'
import { machineSetting, type ReopenCodexAppPolicy, type ReopenFocus, type ReopenPermissionMode, type ReopenT3Policy, type ReopenTerminalApp,
  type ReopenTerminalPolicy } from './config.js'
import type { CodexAttachState } from './codex-attach-signal.js'
import { codexSubcommand, codexThreadHolders } from './codex-session-end.js'
import { fnv64Hex, hubRunDir } from './hub-ipc.js'
import type { Logger } from './logging.js'
import { accountHome } from './platform.js'
import { descriptorStartMatches, pidExists, processStartTime, type ProcessIdentity } from './process-identity.js'
import {
  claimWakeLink,
  codexAppFaulted,
  codexAppPlan,
  recordCodexAppFault,
  sendCodexAppUrl,
  systemCodexAppHost,
  type CodexAppHost,
  type CodexAppWait,
} from './reopen-codex-app.js'
import {
  chooseTerminal,
  claudeLaunchOptions,
  claudeResumeArgs,
  codexLaunchOptions,
  codexPostureOptions,
  codexResumeArgs,
  REPLAY_MAX_WORD,
  REPLAY_MAX_WORDS,
  reopenScript,
  reopenTitle,
  systemTerminalProbe,
  terminalEnvironment,
  type TerminalApp,
  type TerminalLaunch,
  type T3ThreadFacts,
  type TerminalProbe,
} from './reopen-terminal.js'
import { sendT3Wake, systemT3Host, t3Plan, type T3Host, type T3Wait } from './reopen-t3.js'
import type { SessionPlace } from './session-place.js'

/** A reopen not confirmed by the conversation coming back within this long counts as no response (Proposal). */
export const REOPEN_CONFIRM_MS = 60_000
/**
 * A reopened conversation that came back but has not taken what it was
 * reopened for after this long is stalled: most likely at a prompt in its
 * window (a permission or a resume question). Recorded for `notifai doctor`.
 */
export const REOPEN_STALL_MS = 3 * 60_000
/** At most this many reopens per stopped period (Proposal). */
export const REOPEN_ATTEMPTS = 2
/** At most this many windows per minute on the machine; more wait (Proposal). */
export const REOPEN_BURST = 3
/** A guard record is good for this long after it was written. */
const GUARD_TTL_MS = 2 * 60_000
/** Outcome records are kept this long for `notifai doctor`. */
const RECORD_KEEP_MS = 7 * 24 * 60 * 60_000

// -- settings ---------------------------------------------------------------------

export interface ReopenSettings {
  automatic: boolean
  terminal: ReopenTerminalPolicy
  codexApp: ReopenCodexAppPolicy
  t3: ReopenT3Policy
  terminalApp: ReopenTerminalApp
  terminalCommand: string | null
  focus: ReopenFocus
  permissionMode: ReopenPermissionMode
}

/** This machine's reopen settings: its own configuration file only, never a Project's or a session's. */
export function reopenSettings(env: NodeJS.ProcessEnv): ReopenSettings {
  return {
    automatic: machineSetting('reopen.automatic', env).value,
    terminal: machineSetting('reopen.terminal', env).value,
    codexApp: machineSetting('reopen.codex_app', env).value,
    t3: machineSetting('reopen.t3', env).value,
    terminalApp: machineSetting('reopen.terminal_app', env).value,
    terminalCommand: machineSetting('reopen.terminal_command', env).value,
    focus: machineSetting('reopen.focus', env).value,
    permissionMode: machineSetting('reopen.permission_mode', env).value,
  }
}

/** The adapter that may reopen a place, and whether its policy lets it; null for a place that always waits. */
export type ReopenAdapterId = 'terminal' | 'codex-app' | 't3'

export function placeAdapter(place: SessionPlace): ReopenAdapterId | null {
  if (place === 'terminal') return 'terminal'
  if (place === 'codex-app') return 'codex-app'
  if (place === 't3') return 't3'
  return null
}

/** Whether the settings let this adapter act at all. */
export function adapterAllowed(settings: ReopenSettings, adapter: ReopenAdapterId): boolean {
  if (!settings.automatic) return false
  if (adapter === 'terminal') return settings.terminal === 'automatic'
  return adapter === 'codex-app' ? settings.codexApp !== 'off' : settings.t3 !== 'off'
}

// -- what a reopen needs to know ------------------------------------------------------

/**
 * How the harness was started, read exactly from its process at
 * registration (kept only for a terminal): the executable when it was named
 * by path, the options a reopen replays (see `reopen-terminal.ts`), and for
 * Codex whether the thread ran in its own terminal or on the shared
 * background server. `options` is null for the shared server, whose
 * terminal's command line Notifai cannot read: the thread's own record of its
 * permission posture stands in for it. A conversation with no record of this
 * version (it started before this build, or its command line could not be
 * read exactly) is not reopened: it waits for the User.
 */
export interface LaunchRecord {
  v: 2
  exe: string | null
  options: string[] | null
  codex_host: 'tui' | 'shared-server' | null
}

export function parseLaunchRecord(value: unknown): LaunchRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record['v'] !== 2) return null
  const host = record['codex_host'] === 'tui' || record['codex_host'] === 'shared-server' ? record['codex_host'] : null
  const raw = record['options']
  let options: string[] | null = null
  if (Array.isArray(raw)) {
    if (raw.length > REPLAY_MAX_WORDS || !raw.every((word): word is string => typeof word === 'string' && word.length <= REPLAY_MAX_WORD)) return null
    options = raw
  } else if (raw !== null || host !== 'shared-server') {
    return null
  }
  const exe = typeof record['exe'] === 'string' && path.isAbsolute(record['exe']) ? record['exe'] : null
  return { v: 2, exe, options, codex_host: host }
}

/** A process's command line as `ps` shows it: exact on Linux; split on spaces on macOS, so only for telling what a process is. */
export function processArguments(pid: number, platform: NodeJS.Platform = process.platform): string[] | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  if (platform === 'linux') return linuxArguments(pid)
  if (platform !== 'darwin') return null
  try {
    const line = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' },
    }).trim()
    return line === '' ? null : line.split(/\s+/)
  } catch {
    return null
  }
}

function linuxArguments(pid: number): string[] | null {
  try {
    const words = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    if (words.at(-1) === '') words.pop()
    return words.length === 0 ? null : words
  } catch {
    return null
  }
}

/**
 * A process's exact command line, word by word: from `/proc` on Linux, and
 * from the kernel through the native launcher on macOS
 * (`--internal-process-args`). Null when it cannot be read exactly.
 */
export function exactProcessArguments(pid: number, launcher: string | null, platform: NodeJS.Platform = process.platform): string[] | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  if (platform === 'linux') return linuxArguments(pid)
  if (platform !== 'darwin' || launcher === null) return null
  try {
    const output = execFileSync(launcher, ['--internal-process-args', String(pid)], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'], env: {}, maxBuffer: 4 * 1024 * 1024,
    })
    if (!output.endsWith('\0')) return null
    const words = output.slice(0, -1).split('\0')
    return words.length === 0 || words[0] === '' ? null : words
  } catch {
    return null
  }
}

/** The launch record of a terminal harness, from its exact command line; null when a reopen could not repeat it. */
export function launchRecordOf(harness: 'claude-code' | 'codex', argv: readonly string[] | null): LaunchRecord | null {
  if (argv === null || argv.length === 0) return null
  // The harness's own executable; not an interpreter running it (`node …/cli.js`), which the login shell's `claude` or `codex` replaces.
  const exe = path.isAbsolute(argv[0]!) && /^(claude|codex)(\.|-|$)/.test(path.basename(argv[0]!)) ? argv[0]! : null
  if (harness === 'claude-code') {
    const options = claudeLaunchOptions(argv)
    return options === null ? null : { v: 2, exe, options, codex_host: null }
  }
  const subcommand = codexSubcommand(argv)
  // The shared server runs its own managed copy of Codex: a terminal resumes with the `codex` the User runs.
  if (argv.includes('app-server') || subcommand === 'daemon' || argv.includes('--listen')) return { v: 2, exe: null, options: null, codex_host: 'shared-server' }
  const options = codexLaunchOptions(argv)
  return options === null ? null : { v: 2, exe, options, codex_host: 'tui' }
}

/**
 * A Codex thread's permission posture as its rollout records it: the
 * `turn_context` of its first and of its last turn. Null when the rollout
 * cannot be read or records none.
 */
export interface CodexTurnPostures {
  /** The first turn's posture, as a comparable string. */
  first: string
  /** The last turn's context. */
  last: Record<string, unknown>
}

const POSTURE_KEYS = ['approval_policy', 'approvals_reviewer', 'sandbox_policy', 'permission_profile'] as const
const ROLLOUT_HEAD_BYTES = 8 * 1024 * 1024
const ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024

export function postureKey(context: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(POSTURE_KEYS.map((key) => context[key] ?? null))
}

export function readCodexTurnPostures(transcriptPath: string | null): CodexTurnPostures | null {
  if (transcriptPath === null || !path.isAbsolute(transcriptPath)) return null
  let fd: number | undefined
  try {
    fd = openSync(transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const size = fstatSync(fd).size
    const read = (at: number, count: number): string[] => {
      const bytes = Buffer.alloc(count)
      const got = readSync(fd!, bytes, 0, count, at)
      return bytes.subarray(0, got).toString('utf8').split('\n')
    }
    const context = (line: string): Record<string, unknown> | null => {
      if (!line.includes('"turn_context"')) return null
      try {
        const record = JSON.parse(line) as { type?: unknown; payload?: unknown }
        return record.type === 'turn_context' && typeof record.payload === 'object' && record.payload !== null ? record.payload as Record<string, unknown> : null
      } catch {
        return null
      }
    }
    const head = read(0, Math.min(size, ROLLOUT_HEAD_BYTES))
    if (size > ROLLOUT_HEAD_BYTES) head.pop()
    let first: Record<string, unknown> | null = null
    for (const line of head) if ((first = context(line)) !== null) break
    const tailAt = Math.max(0, size - ROLLOUT_TAIL_BYTES)
    const tail = read(tailAt, size - tailAt)
    if (tailAt > 0) tail.shift()
    let last: Record<string, unknown> | null = null
    for (let index = tail.length - 1; index >= 0 && last === null; index -= 1) last = context(tail[index]!)
    return first === null || last === null ? null : { first: postureKey(first), last }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** What a session's hooks last saw: the terminal, the permission mode and the T3 Code thread (kept in its session state as `reopen_launch`). */
export interface HookLaunchFacts {
  terminal: TerminalApp | null
  terminal_seen: string | null
  orca_pane: boolean
  permission_mode: string | null
  t3?: T3ThreadFacts | null
}

/** One stopped conversation, as the hub knows it. */
export interface ReopenTarget {
  sessionId: string
  harness: 'claude-code' | 'codex'
  place: SessionPlace
  /** When it stopped: one stopped period. */
  stoppedSince: number
  cwd: string | null
  /** Recorded config homes (null: the default one). */
  claudeConfigDir: string | null
  codexHome: string | null
  /** An Orca pane's terminal host was recorded. */
  orcaPane: boolean
  launch: LaunchRecord | null
  hooks: HookLaunchFacts | null
  /** The rollout a Codex thread was last seen in. */
  transcriptPath: string | null
  /** The app that hosted it (the Codex app, for `codex-app`). */
  hostApp: ProcessIdentity | null
  /** The harness process (the Codex app's app-server, for `codex-app`). */
  harnessProcess: ProcessIdentity | null
  /** What waits for it: answers, notes and edits, by id. */
  items: readonly string[]
  /** The session's own desktop (Linux: `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`), where its window opens. */
  display?: Readonly<Record<string, string>>
}

export type ReopenTrigger = 'answer' | 'note' | 'hub-start'

/** Why a conversation was left waiting for the User. */
export type ReopenWait = 'off' | 'place-waits' | 'orca-pane' | 'folder-missing' | 'live-elsewhere' | 'live-unknown' |
  'attach-unknown' | 'harness-missing' | 'no-display' | 'terminal-unavailable' | 'launcher-missing' | 'attempts-used' | 'launch-failed' |
  /** How it was started is not known exactly (it started before this build, or its command line could not be read or repeated). */
  'launch-unknown' |
  /** Its permission posture cannot be reproduced exactly; or (Codex) it changed since the thread started, so its command line no longer says it. */
  'permission-unknown' | 'permission-changed' |
  CodexAppWait | 'app-started' | T3Wait

/** What a Codex app attempt records in place of a terminal's name. */
const CODEX_APP = 'codex-app'
/** What a T3 Code attempt records in place of a terminal's name. */
const T3_CODE = 't3'

export type ReopenOutcome =
  | { outcome: 'launched'; token: string; terminal: string }
  | { outcome: 'waiting'; reason: ReopenWait }
  /** Nothing new to reopen for, one already under way, or the minute's windows used: decided again later. */
  | { outcome: 'skipped'; reason: 'nothing-new' | 'in-progress' | 'burst' }

// -- the shared Codex server ---------------------------------------------------------

/**
 * Whether a terminal shows a Codex thread the shared background server has
 * loaded (`codex-attach-signal.ts`). The hub asks with the confirming request
 * when the passive check sees no terminal: only a confirmed `closed` (the
 * server holds it with nobody attached) lets a reopen's `codex resume` join
 * it in place; `not-loaded` means it is not held after all; `attached` means
 * a terminal shows it; anything else (`unknown`, an unconfirmed `closed`)
 * reopens nothing.
 */
export type CodexAttachCheck = (input: { sessionId: string; codexHome: string | null; holder: number }) => Promise<CodexAttachState>

// -- the host -------------------------------------------------------------------------

/** What the module asks of the machine; the hub supplies the real ones, tests replace them. */
export interface ReopenHost {
  env: NodeJS.ProcessEnv
  logger: Logger
  now(): number
  /** The native launcher that runs the last check inside the window; null in a build without one. */
  launcher: string | null
  /** The User's login shell, from the account database. */
  loginShell: string | null
  terminal: TerminalProbe
  /** A live Claude Code process with this conversation open, in any of these config homes. */
  claudeLive(configDirs: readonly string[], sessionId: string): boolean
  /** The processes that have a Codex thread loaded. */
  codexHolders(codexHome: string | null, sessionId: string): number[] | 'unknown'
  /** Whether a process is the shared Codex background server. */
  codexSharedServer(pid: number): boolean
  codexAttach: CodexAttachCheck
  /** The harness executable as the User's login shell finds it, or null. */
  resolveHarness(name: 'claude' | 'codex'): string | null
  /** A Codex thread's recorded permission posture (its rollout's turn contexts). */
  codexPostures(transcriptPath: string | null): CodexTurnPostures | null
  /** Queue the content-free wake into an unloaded Codex thread, so the reopened terminal runs it at once. */
  queueCodexWake(sessionId: string): Promise<void>
  /** Open the window on the session's desktop: true, or why it did not open. */
  open(launch: TerminalLaunch, cwd: string, display?: Readonly<Record<string, string>>): Promise<true | string>
  /** The running Codex app, for its own conversations. */
  codexApp: CodexAppHost
  /** T3 Code's own CLI, for its threads. */
  t3: T3Host
}

/** The real machine, for the hub. */
export function systemReopenHost(env: NodeJS.ProcessEnv, logger: Logger, launcher: string | null,
  overrides: Partial<ReopenHost> = {}): ReopenHost {
  const loginShell = accountShell()
  return {
    env,
    logger,
    now: () => Date.now(),
    launcher,
    loginShell,
    terminal: systemTerminalProbe(env),
    claudeLive: liveClaudeProcess,
    codexHolders: codexThreadHolders,
    codexSharedServer: (pid) => {
      const argv = processArguments(pid)
      return argv !== null && (argv.includes('app-server') || codexSubcommand(argv) === 'daemon' || argv.includes('--listen'))
    },
    codexAttach: async () => ({ state: 'unknown', confirmed: false, reason: 'not-asked' }),
    resolveHarness: (name) => resolveInLoginShell(loginShell, name, env),
    codexPostures: readCodexTurnPostures,
    queueCodexWake: async () => undefined,
    open: (launch, cwd, display) => openWindow(launch, cwd, { ...env, ...display }),
    codexApp: systemCodexAppHost(launcher),
    t3: systemT3Host(env),
    ...overrides,
  }
}

function accountShell(): string | null {
  try {
    const shell = os.userInfo().shell
    return typeof shell === 'string' && path.isAbsolute(shell) ? shell : null
  } catch {
    return null
  }
}

/** `command -v <name>` in the User's login shell: the harness as a terminal they open would find it. */
function resolveInLoginShell(shell: string | null, name: 'claude' | 'codex', env: NodeJS.ProcessEnv): string | null {
  const ask = (command: string, args: string[]): string | null => {
    try {
      const found = execFileSync(command, args, { encoding: 'utf8', timeout: 8_000, stdio: ['ignore', 'pipe', 'ignore'],
        env: terminalEnvironment(env), cwd: env['HOME'] ?? os.homedir() }).trim().split('\n').at(-1)?.trim() ?? ''
      return path.isAbsolute(found) && existsSync(found) ? found : null
    } catch {
      return null
    }
  }
  const viaLogin = shell !== null && ['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh'].includes(path.basename(shell))
    ? ask(shell, ['-l', '-c', `command -v ${name}`]) : null
  return viaLogin ?? ask('/bin/sh', ['-c', `command -v ${name}`])
}

/** A live Claude Code process whose own descriptor names this conversation. */
export function liveClaudeProcess(configDirs: readonly string[], sessionId: string): boolean {
  for (const configDir of new Set(configDirs)) {
    const directory = path.join(configDir, 'sessions')
    let names: string[]
    try { names = readdirSync(directory).filter((name) => /^\d+\.json$/.test(name)) } catch { continue }
    for (const name of names) {
      let descriptor: ReturnType<typeof parseDescriptor>
      try { descriptor = parseDescriptor(JSON.parse(readFileSync(path.join(directory, name), 'utf8'))) } catch { continue }
      if (descriptor === null || descriptor.sessionId !== sessionId || !pidExists(descriptor.pid)) continue
      const start = processStartTime(descriptor.pid)
      if (start !== null && descriptorStartMatches(descriptor.procStart, { pid: descriptor.pid, start })) return true
    }
  }
  return false
}

function openWindow(launch: TerminalLaunch, cwd: string, env: NodeJS.ProcessEnv): Promise<true | string> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(launch.command, launch.args, { cwd, env: terminalEnvironment(env), detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
      resolve(err instanceof Error ? err.message : String(err))
      return
    }
    let settled = false
    let stderr = ''
    const done = (outcome: true | string): void => { if (!settled) { settled = true; resolve(outcome) } }
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 400) stderr += chunk.toString('utf8') })
    child.once('error', (err) => done(err.message))
    const exited = (code: number | null): void => done(code === 0 ? true : `${path.basename(launch.command)} exited ${code}: ${stderr.trim().slice(0, 200)}`)
    if (launch.waits) {
      // `open` returns once the app has the document.
      const timer = setTimeout(() => done(true), 15_000)
      child.once('exit', (code) => { clearTimeout(timer); exited(code) })
    } else {
      // A terminal program keeps running with its window: running a moment later is enough.
      child.once('exit', exited)
      child.once('spawn', () => setTimeout(() => { child.stderr?.destroy(); child.unref(); done(true) }, 500))
    }
  })
}

// -- records ---------------------------------------------------------------------------

/** `<state>/run/reopen`: one record per stopped conversation, and each attempt's guard record and script. */
export function reopenDir(env: NodeJS.ProcessEnv): string {
  return path.join(hubRunDir(env), 'reopen')
}

interface SessionRecord {
  v: 1
  session_id: string
  stopped_since: number
  attempts: number
  /** Items already considered: each causes at most one attempt. */
  seen: string[]
  last: { at: number; trigger: ReopenTrigger | null; outcome: 'launched' | 'confirmed' | 'resumed' | 'no-response' | 'waiting' | 'stalled';
    reason?: string; token?: string; terminal?: string; pid?: number; items?: string[] } | null
  updated_at: number
}

function sessionRecordPath(env: NodeJS.ProcessEnv, sessionId: string): string {
  return path.join(reopenDir(env), `session-${fnv64Hex(sessionId)}.json`)
}

function readSessionRecord(env: NodeJS.ProcessEnv, sessionId: string): SessionRecord | null {
  try {
    const record = JSON.parse(readFileSync(sessionRecordPath(env, sessionId), 'utf8')) as SessionRecord
    return record.v === 1 && record.session_id === sessionId && Array.isArray(record.seen) ? record : null
  } catch {
    return null
  }
}

function writeSessionRecord(env: NodeJS.ProcessEnv, record: SessionRecord): void {
  ensureReopenDir(env)
  atomicWriteFileSync(sessionRecordPath(env, record.session_id), `${JSON.stringify(record)}\n`)
}

function ensureReopenDir(env: NodeJS.ProcessEnv): void {
  const directory = reopenDir(env)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
}

function attemptFiles(env: NodeJS.ProcessEnv, token: string): { record: string; pid: string; script: string } {
  const directory = reopenDir(env)
  return { record: path.join(directory, `${token}.json`), pid: path.join(directory, `${token}.pid`), script: path.join(directory, `${token}.command`) }
}

function removeAttempt(env: NodeJS.ProcessEnv, token: string | undefined): void {
  if (token === undefined || !/^[0-9a-f]{32}$/.test(token)) return
  for (const file of Object.values(attemptFiles(env, token))) rmSync(file, { force: true })
}

/** The process the window's last check named: the shell that then became the harness. */
function guardPid(env: NodeJS.ProcessEnv, token: string): number | null {
  try {
    const pid = Number(readFileSync(attemptFiles(env, token).pid, 'utf8').trim())
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

/**
 * The guard record the native launcher reads (`--internal-reopen-guard`): a
 * fixed one-line grammar, so it needs no JSON parser. Paths with a quote or a
 * backslash are not written (no reopen then).
 */
export function guardRecord(input: { token: string; harness: 'claude-code' | 'codex'; sessionId: string; home: string; defaultHome: string;
  allowHolder: number | null; expiresAt: number }): string | null {
  const plain = (value: string): boolean => !/["\\\n\r]/.test(value)
  if (![input.sessionId, input.home, input.defaultHome].every(plain) || !/^[A-Za-z0-9._-]{1,128}$/.test(input.sessionId)) return null
  return `{"v":1,"token":"${input.token}","harness":"${input.harness}","session_id":"${input.sessionId}","home":"${input.home}",` +
    `"default_home":"${input.defaultHome}","allow_holder":${input.allowHolder ?? 0},"expires_at":${Math.trunc(input.expiresAt)}}\n`
}

// -- the module -----------------------------------------------------------------------

export class SessionReopen {
  private readonly inFlight = new Set<string>()
  /** Conversations that came back from a reopen and have not yet taken what they were reopened for. */
  private readonly delivering = new Set<string>()

  constructor(private readonly host: ReopenHost) {}

  get busy(): boolean {
    return this.inFlight.size > 0
  }

  /**
   * An answer or note waits for a stopped conversation: reopen it in place
   * if the settings, the place and the machine allow; otherwise it waits for
   * the User. Called at every arrival; only items not considered before count.
   */
  async reopenFor(target: ReopenTarget, trigger: ReopenTrigger): Promise<ReopenOutcome> {
    const { env } = this.host
    if (this.inFlight.has(target.sessionId)) return { outcome: 'skipped', reason: 'in-progress' }
    const now = this.host.now()
    const previous = readSessionRecord(env, target.sessionId)
    const record: SessionRecord = previous !== null && previous.stopped_since === target.stoppedSince ? previous
      : { v: 1, session_id: target.sessionId, stopped_since: target.stoppedSince, attempts: 0, seen: [], last: null, updated_at: now }
    if (record.last?.outcome === 'launched' && now - record.last.at < REOPEN_CONFIRM_MS) return { outcome: 'skipped', reason: 'in-progress' }
    const fresh = target.items.filter((item) => !record.seen.includes(item))
    if (fresh.length === 0) return { outcome: 'skipped', reason: 'nothing-new' }
    this.inFlight.add(target.sessionId)
    try {
      const waiting = (reason: ReopenWait): ReopenOutcome => {
        record.seen = [...record.seen, ...fresh].slice(-200)
        record.last = { at: now, trigger, outcome: 'waiting', reason }
        record.updated_at = now
        this.save(record)
        this.host.logger.info('hub.reopen', { event: 'waiting', session: target.sessionId, trigger, reason, place: target.place })
        return { outcome: 'waiting', reason }
      }
      const settings = reopenSettings(env)
      const adapter = placeAdapter(target.place)
      if (adapter === null) return waiting('place-waits')
      if (!adapterAllowed(settings, adapter)) return waiting('off')
      if (record.attempts >= REOPEN_ATTEMPTS) return waiting('attempts-used')
      if (this.recentLaunches(now) >= REOPEN_BURST) {
        this.host.logger.info('hub.reopen', { event: 'queued', session: target.sessionId, trigger, reason: 'burst' })
        return { outcome: 'skipped', reason: 'burst' }
      }
      if (adapter === 'codex-app') {
        if (target.harness !== 'codex') return waiting('place-waits')
        return await this.codexAppReopen(target, trigger, record, fresh, now, waiting)
      }
      if (adapter === 't3') {
        // Claude Code only: how T3 Code brings back a Codex thread it unloaded is not yet witnessed.
        if (target.harness !== 'claude-code') return waiting('place-waits')
        return await this.t3Reopen(target, trigger, record, fresh, now, waiting)
      }
      const plan = await this.terminalPlan(target, settings)
      if ('wait' in plan) return waiting(plan.wait)
      const token = randomBytes(16).toString('hex')
      const files = attemptFiles(env, token)
      const home = target.harness === 'claude-code'
        ? target.claudeConfigDir ?? path.join(accountHome(env), '.claude')
        : target.codexHome ?? path.join(accountHome(env), '.codex')
      const defaultHome = path.join(accountHome(env), target.harness === 'claude-code' ? '.claude' : '.codex')
      const guard = guardRecord({ token, harness: target.harness, sessionId: target.sessionId, home, defaultHome,
        allowHolder: plan.loaded, expiresAt: now + GUARD_TTL_MS })
      if (guard === null) return waiting('launch-failed')
      // An unloaded Codex thread gets its wake first: the reopened terminal runs it at once, in view.
      if (target.harness === 'codex' && plan.loaded === null) await this.host.queueCodexWake(target.sessionId)
      ensureReopenDir(env)
      writeFileSync(files.record, guard, { mode: 0o600 })
      writeFileSync(files.script, plan.script(files.record), { mode: 0o700 })
      const launch = plan.launch(files.script)
      // Recorded before the window opens: the conversation can come back before `open` returns.
      const before = { attempts: record.attempts, seen: record.seen, last: record.last }
      record.attempts += 1
      record.seen = [...record.seen, ...fresh].slice(-200)
      record.last = { at: now, trigger, outcome: 'launched', token, terminal: launch.app, items: fresh.slice(0, 50) }
      record.updated_at = now
      this.save(record)
      const opened = await this.host.open(launch, target.cwd!, target.display)
      if (opened !== true) {
        removeAttempt(env, token)
        Object.assign(record, before)
        this.host.logger.info('hub.reopen', { event: 'launch-failed', session: target.sessionId, terminal: launch.app, detail: opened })
        return waiting('launch-failed')
      }
      this.host.logger.info('hub.reopen', { event: 'launched', session: target.sessionId, trigger, harness: target.harness, terminal: launch.app,
        attempt: record.attempts, codex_host: target.launch?.codex_host ?? null, loaded: plan.loaded !== null })
      return { outcome: 'launched', token, terminal: launch.app }
    } finally {
      this.inFlight.delete(target.sessionId)
    }
  }

  /** The conversation came back: from the window this module opened (confirmed), or some other way. */
  resumed(sessionId: string, harnessPid: number): void {
    const { env } = this.host
    const record = readSessionRecord(env, sessionId)
    if (record?.last?.outcome !== 'launched' || record.last.token === undefined) return
    const pid = guardPid(env, record.last.token)
    // A T3 Code thread comes back in the thread Notifai sent to: there is no window to confirm it.
    const outcome = pid !== null || record.last.terminal === T3_CODE ? 'confirmed' : 'resumed'
    removeAttempt(env, record.last.token)
    const now = this.host.now()
    record.last = { ...record.last, outcome, ...(pid === null ? {} : { pid }) }
    record.updated_at = now
    this.save(record)
    if ((record.last.items ?? []).length > 0) this.delivering.add(sessionId)
    this.host.logger.info('hub.reopen', { event: outcome, session: sessionId, same_process: pid === harnessPid,
      after_ms: Math.max(0, now - record.last.at) })
  }

  /** Whether a conversation that came back from a reopen is still to take what it was reopened for. */
  watching(sessionId: string): boolean {
    return this.delivering.has(sessionId)
  }

  /**
   * A reopened conversation that came back: once none of what it was
   * reopened for still waits, it is done; if some still waits after
   * `REOPEN_STALL_MS`, it is stalled (at a prompt in its window, most
   * likely), and `hub.reopen` and `notifai doctor` say so.
   */
  progress(sessionId: string, pending: readonly string[]): void {
    if (!this.delivering.has(sessionId)) return
    const record = readSessionRecord(this.host.env, sessionId)
    const last = record?.last
    if (record === null || last === null || last === undefined || !['confirmed', 'resumed', 'stalled'].includes(last.outcome)) {
      this.delivering.delete(sessionId)
      return
    }
    const now = this.host.now()
    const waiting = (last.items ?? []).filter((item) => pending.includes(item))
    if (waiting.length === 0) {
      this.delivering.delete(sessionId)
      if (last.outcome !== 'stalled') return
      record.last = { ...last, outcome: 'confirmed', reason: 'taken-late' }
      record.updated_at = now
      this.save(record)
      this.host.logger.info('hub.reopen', { event: 'unstalled', session: sessionId, after_ms: Math.max(0, now - last.at) })
      return
    }
    if (last.outcome === 'stalled' || now - last.at < REOPEN_STALL_MS) return
    record.last = { ...last, outcome: 'stalled', reason: 'not-taken' }
    record.updated_at = now
    this.save(record)
    this.host.logger.info('hub.reopen', { event: 'stalled', session: sessionId, waiting: waiting.length, after_ms: Math.max(0, now - last.at) })
  }

  /** A reopen nothing confirmed within its minute: no response. The window, if any, is the User's now. */
  check(sessionId: string): void {
    const { env } = this.host
    const record = readSessionRecord(env, sessionId)
    const now = this.host.now()
    if (record?.last?.outcome !== 'launched' || now - record.last.at < REOPEN_CONFIRM_MS) return
    // The Codex app took the link and did not load the conversation: it gets no more until its version changes.
    if (record.last.terminal === CODEX_APP && record.last.token !== undefined) {
      const version = attemptAppVersion(env, record.last.token)
      if (version !== null) recordCodexAppFault(reopenDir(env), version, 'no-response', now)
    }
    // A T3 Code send has no window: what ran is the send itself.
    const ran = record.last.terminal === T3_CODE || (record.last.token === undefined ? false : guardPid(env, record.last.token) !== null)
    removeAttempt(env, record.last.token)
    record.last = { ...record.last, outcome: 'no-response', reason: ran ? 'not-back' : 'window-did-not-run' }
    record.updated_at = now
    this.save(record)
    this.host.logger.info('hub.reopen', { event: 'no-response', session: sessionId, reason: record.last.reason })
  }

  /** Old outcome records and attempts nobody finished. */
  prune(): void {
    const { env } = this.host
    const now = this.host.now()
    let names: string[]
    try { names = readdirSync(reopenDir(env)) } catch { return }
    for (const name of names) {
      const file = path.join(reopenDir(env), name)
      try {
        if (now - statSync(file).mtimeMs > (name.startsWith('session-') ? RECORD_KEEP_MS : GUARD_TTL_MS + REOPEN_CONFIRM_MS)) rmSync(file, { force: true })
      } catch { /* gone */ }
    }
  }

  private save(record: SessionRecord): void {
    try { writeSessionRecord(this.host.env, record) } catch (err) {
      this.host.logger.error('hub.reopen', { event: 'record-failed', session: record.session_id, message: err instanceof Error ? err.message : String(err) })
    }
  }

  private recentLaunches(now: number): number {
    let count = 0
    for (const record of sessionRecords(this.host.env)) if (record.last !== null && record.last.token !== undefined && now - record.last.at < 60_000) count += 1
    return count
  }

  /**
   * The Codex app adapter (`reopen-codex-app.ts`): Notifai's wake goes into
   * the thread's queue first, then the running app is handed the link that
   * runs it, once per wake. The app-server's pid stands in for the window's
   * guard pid, so its conversation coming back confirms the attempt.
   */
  private async codexAppReopen(target: ReopenTarget, trigger: ReopenTrigger, record: SessionRecord, fresh: string[], now: number,
    waiting: (reason: ReopenWait) => ReopenOutcome): Promise<ReopenOutcome> {
    const { env } = this.host
    const directory = reopenDir(env)
    await this.host.queueCodexWake(target.sessionId)
    const plan = codexAppPlan({ sessionId: target.sessionId, codexHome: target.codexHome, transcriptPath: target.transcriptPath,
      hostApp: target.hostApp, appServer: target.harnessProcess, env }, this.host.codexApp, (version) => codexAppFaulted(directory, version))
    if ('wait' in plan) return waiting(plan.wait)
    if (!claimWakeLink(directory, plan.wakeToken)) return waiting('wake-linked')
    const token = randomBytes(16).toString('hex')
    const files = attemptFiles(env, token)
    ensureReopenDir(env)
    writeFileSync(files.record, `${JSON.stringify({ v: 1, app_version: plan.bundle.version })}\n`, { mode: 0o600 })
    writeFileSync(files.pid, `${target.harnessProcess!.pid}\n`, { mode: 0o600 })
    const before = { attempts: record.attempts, seen: record.seen, last: record.last }
    record.attempts += 1
    record.seen = [...record.seen, ...fresh].slice(-200)
    record.last = { at: now, trigger, outcome: 'launched', token, terminal: CODEX_APP, items: fresh.slice(0, 50) }
    record.updated_at = now
    this.save(record)
    const sent = await sendCodexAppUrl(plan, this.host.codexApp)
    if (!sent.sent) {
      removeAttempt(env, token)
      Object.assign(record, before)
      if (sent.coldLaunch === true) recordCodexAppFault(directory, plan.bundle.version, 'app-started', now)
      this.host.logger.info('hub.reopen', { event: 'launch-failed', session: target.sessionId, terminal: CODEX_APP, detail: sent.reason })
      return waiting(sent.reason === 'app-not-running' ? 'app-not-running' : sent.reason === 'app-started' ? 'app-started' : 'launch-failed')
    }
    this.host.logger.info('hub.reopen', { event: 'launched', session: target.sessionId, trigger, harness: target.harness, terminal: CODEX_APP,
      route: sent.route, attempt: record.attempts })
    return { outcome: 'launched', token, terminal: CODEX_APP }
  }

  /**
   * The T3 Code adapter (`reopen-t3.ts`): the thread the conversation runs in
   * gets a Notifai wake through T3 Code's own CLI, and T3 Code brings the
   * conversation back in that thread. Its coming back confirms the attempt.
   */
  private async t3Reopen(target: ReopenTarget, trigger: ReopenTrigger, record: SessionRecord, fresh: string[], now: number,
    waiting: (reason: ReopenWait) => ReopenOutcome): Promise<ReopenOutcome> {
    const { env } = this.host
    const homes = [target.claudeConfigDir ?? path.join(accountHome(env), '.claude'), path.join(accountHome(env), '.claude')]
    if (this.host.claudeLive(homes, target.sessionId)) return waiting('live-elsewhere')
    const thread = target.hooks?.t3 ?? null
    const plan = t3Plan(thread, env, this.host.t3)
    if ('wait' in plan) return waiting(plan.wait)
    const token = randomBytes(16).toString('hex')
    const before = { attempts: record.attempts, seen: record.seen, last: record.last }
    record.attempts += 1
    record.seen = [...record.seen, ...fresh].slice(-200)
    record.last = { at: now, trigger, outcome: 'launched', token, terminal: T3_CODE, items: fresh.slice(0, 50) }
    record.updated_at = now
    // Recorded before the send: the conversation can come back before it returns.
    this.save(record)
    const sent = await sendT3Wake(plan, thread!.home, this.host.t3)
    if (sent !== true) {
      Object.assign(record, before)
      this.host.logger.info('hub.reopen', { event: 'launch-failed', session: target.sessionId, terminal: T3_CODE, detail: sent })
      return waiting('launch-failed')
    }
    this.host.logger.info('hub.reopen', { event: 'launched', session: target.sessionId, trigger, harness: target.harness, terminal: T3_CODE,
      attempt: record.attempts })
    return { outcome: 'launched', token, terminal: T3_CODE }
  }

  /** The terminal adapter's preflight and its launch, or why it waits. */
  private async terminalPlan(target: ReopenTarget, settings: ReopenSettings): Promise<{ wait: ReopenWait } |
    { loaded: number | null; script: (record: string) => string; launch: (script: string) => TerminalLaunch }> {
    const host = this.host
    // On the shared Codex server, hooks run with the server's environment: what they saw of a terminal is not this conversation's.
    const shared = target.launch?.codex_host === 'shared-server'
    if (target.orcaPane || (!shared && target.hooks?.orca_pane === true)) return { wait: 'orca-pane' }
    if (target.cwd === null) return { wait: 'folder-missing' }
    try { if (!statSync(target.cwd).isDirectory()) return { wait: 'folder-missing' } } catch { return { wait: 'folder-missing' } }
    // The shared server holding the thread with no terminal attached: `codex resume` joins it in place.
    let loaded: number | null = null
    if (target.harness === 'claude-code') {
      const homes = [target.claudeConfigDir ?? path.join(accountHome(host.env), '.claude'), path.join(accountHome(host.env), '.claude')]
      if (host.claudeLive(homes, target.sessionId)) return { wait: 'live-elsewhere' }
    } else {
      const holders = host.codexHolders(target.codexHome, target.sessionId)
      if (holders === 'unknown') return { wait: 'live-unknown' }
      for (const holder of holders) {
        if (!host.codexSharedServer(holder)) return { wait: 'live-elsewhere' }
        const attach = await host.codexAttach({ sessionId: target.sessionId, codexHome: target.codexHome, holder })
        if (attach.state === 'attached') return { wait: 'live-elsewhere' }
        if (attach.state === 'not-loaded') continue
        if (attach.state !== 'closed' || !attach.confirmed) return { wait: 'attach-unknown' }
        loaded = holder
      }
    }
    if (host.launcher === null) return { wait: 'launcher-missing' }
    // The session's desktop, not the hub's: the hub serves every session and has none of its own.
    const terminal = target.display === undefined ? host.terminal : { ...host.terminal, env: { ...host.terminal.env, ...target.display } }
    const choice = chooseTerminal(settings.terminalApp, settings.terminalCommand, shared ? null : target.hooks?.terminal ?? null, terminal, settings.focus)
    if (!choice.ok) return { wait: choice.reason }
    const launch = target.launch
    if (launch === null) return { wait: 'launch-unknown' }
    const recordedExe = launch.exe
    const exe = recordedExe !== null && existsSync(recordedExe) ? recordedExe : host.resolveHarness(target.harness === 'claude-code' ? 'claude' : 'codex')
    if (exe === null) return { wait: 'harness-missing' }
    let args: string[]
    if (target.harness === 'claude-code') {
      if (launch.options === null) return { wait: 'launch-unknown' }
      args = claudeResumeArgs(target.sessionId, launch.options, target.hooks?.permission_mode ?? null, settings.permissionMode)
    } else {
      // Codex records each turn's posture: a terminal's command line says it only while it is unchanged.
      const postures = host.codexPostures(target.transcriptPath)
      if (postures === null) return { wait: 'permission-unknown' }
      let options = launch.options
      if (options === null) options = codexPostureOptions(postures.last)
      else if (postures.first !== postureKey(postures.last)) return { wait: 'permission-changed' }
      if (options === null) return { wait: 'permission-unknown' }
      args = codexResumeArgs(target.sessionId, options, settings.permissionMode)
    }
    // Set again after the User's login profile, so it cannot move the conversation to another home; unset for the default home.
    const pinned: Record<string, string | null> = target.harness === 'claude-code'
      ? { CLAUDE_CONFIG_DIR: target.claudeConfigDir }
      : { CODEX_HOME: target.codexHome }
    // Which Notifai the conversation used, when not the default one.
    for (const name of ['XDG_STATE_HOME', 'XDG_CONFIG_HOME']) {
      const value = host.env[name]
      if (value !== undefined && path.isAbsolute(value)) pinned[name] = value
    }
    const cwd = target.cwd
    const title = reopenTitle(target.harness, cwd)
    return {
      loaded,
      script: (record) => reopenScript({ launcher: host.launcher!, record, cwd, title, command: [exe, ...args],
        loginShell: host.loginShell, pinned }),
      launch: (script) => choice.launch(script, cwd, title),
    }
  }
}

/** The Codex app version an attempt handed its link to. */
function attemptAppVersion(env: NodeJS.ProcessEnv, token: string): string | null {
  try {
    const record = JSON.parse(readFileSync(attemptFiles(env, token).record, 'utf8')) as { app_version?: unknown }
    return typeof record.app_version === 'string' ? record.app_version : null
  } catch {
    return null
  }
}

function sessionRecords(env: NodeJS.ProcessEnv): SessionRecord[] {
  let names: string[]
  try { names = readdirSync(reopenDir(env)).filter((name) => /^session-[0-9a-f]{16}\.json$/.test(name)) } catch { return [] }
  const records: SessionRecord[] = []
  for (const name of names) {
    try {
      const record = JSON.parse(readFileSync(path.join(reopenDir(env), name), 'utf8')) as SessionRecord
      if (record.v === 1 && typeof record.session_id === 'string') records.push(record)
    } catch { /* skip */ }
  }
  return records
}

// -- doctor ------------------------------------------------------------------------------

const TERMINAL_NAMES: Readonly<Record<string, string>> = {
  terminal: 'Terminal', iterm2: 'iTerm2', ghostty: 'Ghostty', wezterm: 'WezTerm', kitty: 'kitty', alacritty: 'Alacritty',
  'gnome-terminal': 'GNOME Terminal', konsole: 'Konsole', custom: 'your custom command',
}

/** What `notifai doctor` says about reopening: the settings in force and each recent outcome. */
export function reopenReport(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform) {
  const settings = reopenSettings(env)
  const sources = {
    automatic: machineSetting('reopen.automatic', env).source,
    terminal: machineSetting('reopen.terminal', env).source,
    codex_app: machineSetting('reopen.codex_app', env).source,
    t3: machineSetting('reopen.t3', env).source,
  }
  const sessions = sessionRecords(env)
    .filter((record) => record.last !== null)
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 20)
    .map((record) => ({ session_id: record.session_id, at: new Date(record.last!.at).toISOString(), outcome: record.last!.outcome,
      reason: record.last!.reason ?? null, terminal: record.last!.terminal ?? null, attempts: record.attempts }))
  // Reopened, back, and still not taking what it was reopened for: most likely at a prompt in its window.
  const stalled = sessions.filter((session) => session.outcome === 'stalled').map((session) => session.session_id)
  return {
    available: platform === 'darwin' || platform === 'linux',
    automatic: settings.automatic,
    terminal: settings.terminal,
    codex_app: settings.codexApp,
    codex_app_available: platform === 'darwin',
    t3: settings.t3,
    terminal_app: settings.terminalApp,
    focus: settings.focus,
    permission_mode: settings.permissionMode,
    sources,
    sessions,
    stalled,
  }
}

/** Doctor's line for reopened conversations that stalled, or null. */
export function reopenStalledLine(report: ReturnType<typeof reopenReport>): string | null {
  const count = report.stalled.length
  if (count === 0) return null
  return count === 1 ? 'Reopen: a reopened conversation is waiting at a prompt in its window'
    : `Reopen: ${count} reopened conversations are waiting at a prompt in their windows`
}

/** Doctor's one line: what happens to a stopped conversation when its answer arrives. */
export function reopenLine(report: ReturnType<typeof reopenReport>): string {
  if (!report.automatic) return 'Reopen: off; every stopped conversation waits for you'
  const where = report.terminal_app === 'auto' ? '' : ` (in ${TERMINAL_NAMES[report.terminal_app] ?? report.terminal_app})`
  const places = [
    ...(report.terminal === 'automatic' ? [`terminals automatically${where}`] : []),
    ...(report.codex_app_available && report.codex_app !== 'off' ? ['the Codex app while it runs'] : []),
    ...(report.t3 !== 'off' ? ['T3 Code threads while T3 Code runs'] : []),
  ]
  if (places.length === 0) return 'Reopen: off; every stopped conversation waits for you'
  return `Reopen: ${places.join('; ')}; other apps wait for you`
}
