/**
 * Whether this machine is shutting down or restarting, told to the hub
 * before the User's apps and terminals are stopped.
 *
 * In an orderly shutdown the apps quit first and terminal windows send
 * SIGHUP to `claude`; only later is the hub terminated. Without a signal,
 * those ends would be confirmed as closes by the User and expire questions
 * that the shutdown, not the User, interrupted. While a shutdown is in
 * progress the hub holds every new end undecided; the next boot (a different
 * boot identity) then knows the machine went down, and a cancelled shutdown
 * lets the hub decide them as usual.
 *
 * - macOS: the native launcher's `--internal-power-watch` registers for
 *   loginwindow's notify(3) posts (`com.apple.system.loginwindow.*`) and
 *   prints one line per post.
 * - Linux: systemd-logind's `PrepareForShutdown(true)`, watched under a
 *   *delay* inhibitor lock (`systemd-inhibit --mode=delay`) so the hub writes
 *   its state before user processes are stopped; the lock is released at
 *   once after that. `PrepareForShutdown(false)` is a cancellation.
 * - Elsewhere, or without the tools: no signal; ends follow the plain rule.
 *
 * No timers, no network: a child process and the lines it prints.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

export type PowerEventKind = 'shutdown' | 'cancelled' | 'other'

export interface PowerEvent {
  kind: PowerEventKind
  /** What was posted: a notify name, `PrepareForShutdown(true)`. */
  name: string
}

export interface PowerWatchState {
  /** Which signal is watched, or null with the reason none is. */
  source: 'loginwindow' | 'logind' | null
  unavailable: string | null
}

export interface PowerWatch {
  state(): PowerWatchState
  /**
   * The hub has written down what a shutdown must not lose: release the
   * Linux delay lock now so the shutdown is not held back. No-op elsewhere.
   */
  persisted(): void
  stop(): void
}

export type PowerWatchFactory = (onEvent: (event: PowerEvent) => void) => PowerWatch

/** The loginwindow posts that mean the machine is going down, and the one that cancels it. */
const LOGINWINDOW_SHUTDOWN: ReadonlySet<string> = new Set([
  'com.apple.system.loginwindow.shutdownInitiated',
  'com.apple.system.loginwindow.restartinitiated',
  'com.apple.system.loginwindow.likelyShutdown',
  'com.apple.system.loginwindow.shutdownNoReturn',
])
const LOGINWINDOW_CANCELLED = 'com.apple.system.loginwindow.logoutcancelled'

/** One line of `notifai --internal-power-watch`. */
export function parseLoginwindowLine(line: string): PowerEvent | null {
  const matched = /^event (\S+)/.exec(line.trim())
  if (matched === null) return null
  const name = matched[1]!
  if (LOGINWINDOW_SHUTDOWN.has(name)) return { kind: 'shutdown', name }
  if (name === LOGINWINDOW_CANCELLED) return { kind: 'cancelled', name }
  // A logout alone is the User's: its closes expire as usual.
  return { kind: 'other', name }
}

/**
 * Lines of a logind signal monitor. `dbus-monitor` prints the signal header
 * (`… member=PrepareForShutdown`) and then its value on the next line
 * (`   boolean true`); `gdbus monitor` prints one line,
 * `/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForShutdown (true,)`
 * (after a `PrepareForShutdownWithMetadata` line, which is not this one).
 */
export function logindParser(): (line: string) => PowerEvent | null {
  let header = false
  return (line) => {
    const event = (value: string): PowerEvent => value === 'true'
      ? { kind: 'shutdown', name: 'PrepareForShutdown(true)' }
      : { kind: 'cancelled', name: 'PrepareForShutdown(false)' }
    const single = /\.PrepareForShutdown \((true|false),?\)\s*$/.exec(line)
    if (single !== null) { header = false; return event(single[1]!) }
    if (/\bmember=PrepareForShutdown\s*$/.test(line)) { header = true; return null }
    const value = header ? /^\s+boolean (true|false)\s*$/.exec(line) : null
    header = false
    return value === null ? null : event(value[1]!)
  }
}

function lines(child: ChildProcess, each: (line: string) => void): void {
  if (child.stdout === null) return
  createInterface({ input: child.stdout }).on('line', each)
}

/** macOS: the launcher's watcher, kept for the hub's life; it exits when the hub's end of its stdin closes. */
export function loginwindowWatch(launcher: string | null, onEvent: (event: PowerEvent) => void): PowerWatch {
  if (launcher === null) return unavailable('no-launcher')
  let child: ChildProcess | null = null
  let state: PowerWatchState = { source: 'loginwindow', unavailable: null }
  try {
    child = spawn(launcher, ['--internal-power-watch'], { stdio: ['pipe', 'pipe', 'ignore'], env: {} })
  } catch {
    return unavailable('spawn-failed')
  }
  child.once('error', () => { state = { source: null, unavailable: 'spawn-failed' } })
  child.once('exit', () => { if (state.source !== null) state = { source: null, unavailable: 'watcher-exited' } })
  lines(child, (line) => {
    const event = parseLoginwindowLine(line)
    if (event !== null) onEvent(event)
  })
  child.unref()
  ;(child.stdout as unknown as { unref?: () => void } | null)?.unref?.()
  ;(child.stdin as unknown as { unref?: () => void } | null)?.unref?.()
  return {
    state: () => state,
    persisted: () => undefined,
    stop: () => { state = { source: null, unavailable: 'stopped' }; child?.stdin?.end(); child?.kill() },
  }
}

const INHIBIT = ['--what=shutdown', '--mode=delay', '--who=Notifai', '--why=Notifai is saving conversation state']
const MATCH = "type='signal',sender='org.freedesktop.login1',interface='org.freedesktop.login1.Manager',member='PrepareForShutdown'"

function onPath(tool: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync('sh', ['-c', `command -v ${tool}`], { env: { PATH: env['PATH'] ?? '/usr/bin:/bin' }, stdio: 'ignore', timeout: 2_000 })
  return result.status === 0
}

/**
 * Linux: `systemd-inhibit --mode=delay … dbus-monitor` holds a delay lock
 * while it watches (any user may take one; logind waits for it, at most its
 * InhibitDelayMaxSec). After a `PrepareForShutdown(true)` the hub persists and
 * calls `persisted()`: an unlocked monitor starts first, then the locked one
 * goes, which releases the lock and lets the shutdown go on; after a
 * cancellation (`false`) the locked one comes back. `dbus-monitor` rather
 * than `gdbus`: an orphaned `dbus-monitor` dies at the next shutdown signal
 * and frees the lock, an orphaned `gdbus` ignores SIGPIPE and would hold it.
 */
export function logindWatch(env: NodeJS.ProcessEnv, onEvent: (event: PowerEvent) => void,
  tools: { available?: (tool: string) => boolean; spawnImpl?: typeof spawn } = {}): PowerWatch {
  const available = tools.available ?? ((tool: string) => onPath(tool, env))
  if (!available('systemd-inhibit')) return unavailable('no-systemd-inhibit')
  if (!available('dbus-monitor')) return unavailable('no-dbus-monitor')
  const run = tools.spawnImpl ?? spawn
  const childEnv = { PATH: env['PATH'] ?? '/usr/bin:/bin', ...(env['DBUS_SYSTEM_BUS_ADDRESS'] === undefined ? {} : { DBUS_SYSTEM_BUS_ADDRESS: env['DBUS_SYSTEM_BUS_ADDRESS'] }) }
  let stopped = false
  let locked: ChildProcess | null = null
  let watching: ChildProcess | null = null
  let state: PowerWatchState = { source: 'logind', unavailable: null }
  const start = (withLock: boolean): ChildProcess | null => {
    if (stopped) return null
    const current = withLock ? run('systemd-inhibit', [...INHIBIT, '--', 'dbus-monitor', '--system', MATCH], { stdio: ['ignore', 'pipe', 'ignore'], env: childEnv })
      : run('dbus-monitor', ['--system', MATCH], { stdio: ['ignore', 'pipe', 'ignore'], env: childEnv })
    current.once('error', () => { if (current === locked || current === watching) state = { source: null, unavailable: 'spawn-failed' } })
    current.once('exit', () => {
      if (stopped || (current !== locked && current !== watching)) return
      if (current === locked) locked = null
      if (current === watching) watching = null
      if (locked === null && watching === null) state = { source: null, unavailable: 'watcher-exited' }
    })
    const parse = logindParser()
    lines(current, (line) => {
      const event = parse(line)
      if (event === null) return
      // Both monitors see the signal while the lock is being let go: only the current one speaks.
      if (current !== (locked ?? watching)) return
      if (event.kind === 'cancelled' && locked === null) {
        // The shutdown is off: watch under the lock again.
        const previous = watching
        locked = start(true)
        watching = null
        previous?.kill()
      }
      onEvent(event)
    })
    current.unref()
    ;(current.stdout as unknown as { unref?: () => void } | null)?.unref?.()
    return current
  }
  locked = start(true)
  return {
    state: () => state,
    persisted: () => {
      if (stopped || locked === null) return
      // Watch for a cancellation first, then release the lock so the shutdown goes on.
      watching = start(false)
      const previous = locked
      locked = null
      previous.kill()
    },
    stop: () => { stopped = true; state = { source: null, unavailable: 'stopped' }; locked?.kill(); watching?.kill(); locked = watching = null },
  }
}

function unavailable(reason: string): PowerWatch {
  return { state: () => ({ source: null, unavailable: reason }), persisted: () => undefined, stop: () => undefined }
}

/** The production watcher for this platform. */
export function systemPowerWatch(env: NodeJS.ProcessEnv, launcher: string | null): PowerWatchFactory {
  return (onEvent) => process.platform === 'darwin' ? loginwindowWatch(launcher, onEvent)
    : process.platform === 'linux' ? logindWatch(env, onEvent)
      : unavailable('unsupported-platform')
}

/**
 * Linux's backstop: systemd says it is stopping. A shutdown started without
 * logind (`systemctl start reboot.target`) sends no signal; this still tells
 * it from a logout.
 */
export function systemdStopping(): boolean {
  if (process.platform !== 'linux') return false
  try {
    const result = spawnSync('systemctl', ['is-system-running'], { encoding: 'utf8', timeout: 1_000, env: { PATH: '/usr/bin:/bin' } })
    return result.stdout.trim() === 'stopping'
  } catch {
    return false
  }
}
