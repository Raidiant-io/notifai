/**
 * Reopening a stopped Codex app conversation in place (`reopen.codex_app`).
 *
 * When the Codex app unloads a conversation, an answer or note for it waits
 * in the thread's own queue as Notifai's content-free wake. The app runs a
 * queued wake when it is handed `codex://threads/wake/<id>`: in its own
 * server, with no window, no focus change and no navigation. This adapter
 * hands it that link, and only when every one of these holds (each fails
 * closed):
 *
 * 1. macOS;
 * 2. the conversation was last in the Codex app (the hub's place), and its
 *    rollout says the app started it (originator `Codex Desktop` or
 *    `codex_work_desktop`): a terminal, IDE, Orca or T3 conversation never
 *    comes up in the app;
 * 3. it is not archived (its rollout is still in `sessions/`);
 * 4. the same Codex app that hosted it still runs (process id and start time),
 *    it is `com.openai.codex`, and the app-server it started for the
 *    conversation is alive with that Codex home open;
 * 5. nobody has the thread loaded (its writer lock is free);
 * 6. Notifai's own wake is queued in the thread and not yet consumed;
 * 7. this wake has had no link before (one link per wake, across hubs);
 * 8. the app has not ignored a link before on this app version.
 *
 * The link goes as an Apple Event addressed to that app's process id
 * (`--internal-codex-app-url`), which cannot start an app that has quit.
 * When macOS would first ask the User to allow it, it goes through
 * LaunchServices instead (`open -g -b com.openai.codex`), checked before and
 * after: a Codex app process that was not there before means the call started
 * the app, which is recorded as a fault, and the app gets no more links until
 * its version changes. Notifai never starts the Codex app.
 */
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { codexAppSurface, codexThreadHolders, locateCodexRollout, readCodexThreadOriginator } from './codex-session-end.js'
import { readSessionState } from './hook-session-state.js'
import { processIdentityLiveness, type ProcessIdentity } from './process-identity.js'

export const CODEX_APP_BUNDLE_ID = 'com.openai.codex'
/** Codex thread ids are UUIDs; nothing else is put in a link. */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The link that runs a thread's queued wake in the running app: no window, no focus, no navigation. */
export function codexWakeUrl(threadId: string): string | null {
  return THREAD_ID.test(threadId) ? `codex://threads/wake/${threadId.toLowerCase()}` : null
}

/** The launcher's pid-addressed Apple Event: reaches that process or nothing. */
export function codexAppEventArgs(pid: number, url: string): string[] {
  return ['--internal-codex-app-url', String(pid), url]
}

/** LaunchServices, in the background, to the Codex app by its bundle id. */
export function codexAppOpenArgs(url: string): string[] {
  return ['-g', '-b', CODEX_APP_BUNDLE_ID, url]
}

/** Why a Codex app conversation was left waiting for the User. */
export type CodexAppWait = 'not-macos' | 'not-app-thread' | 'archived' | 'app-not-running' | 'app-unrecognised' | 'app-server-gone' |
  'live-elsewhere' | 'live-unknown' | 'no-wake-queued' | 'wake-linked' | 'app-ignored-links' | 'launcher-missing'

/** One stopped Codex app conversation, as the hub knows it. */
export interface CodexAppTarget {
  sessionId: string
  codexHome: string | null
  transcriptPath: string | null
  /** The Codex app process that hosted it. */
  hostApp: ProcessIdentity | null
  /** The app-server the app started for it. */
  appServer: ProcessIdentity | null
  env: NodeJS.ProcessEnv
}

export interface CodexAppBundle { bundleId: string; version: string; executable: string }

/** What the adapter asks of the machine; tests replace all of it. */
export interface CodexAppHost {
  platform: NodeJS.Platform
  launcher: string | null
  alive(identity: ProcessIdentity): boolean
  /** The app bundle a process runs from (its main executable only), or null. */
  bundleOf(pid: number): CodexAppBundle | null
  /** Whether the process has a file open under this folder. */
  hasOpenUnder(pid: number, folder: string): boolean
  /** The processes running this executable, or unknown. */
  processesOf(executable: string): number[] | 'unknown'
  holders(codexHome: string | null, threadId: string): number[] | 'unknown'
  originator(codexHome: string | null, threadId: string, transcriptPath: string | null): { place: 'sessions' | 'archived' | 'missing' | 'unknown'; originator: string | null }
  /** Notifai's own queued wake for the thread, unconsumed: its token, or null. */
  queuedWake(sessionId: string, env: NodeJS.ProcessEnv): string | null
  /** Pid-addressed Apple Event through the launcher. */
  sendEvent(pid: number, url: string): Promise<'sent' | 'needs-consent' | 'gone' | 'failed'>
  /** `open -g -b com.openai.codex <url>`. */
  openUrl(url: string): Promise<true | string>
}

export type CodexAppPlan =
  | { wait: CodexAppWait }
  | { url: string; wakeToken: string; app: ProcessIdentity; bundle: CodexAppBundle }

/** Every precondition, cheapest first; the link to hand over when all hold. */
export function codexAppPlan(target: CodexAppTarget, host: CodexAppHost, faults: (version: string) => boolean): CodexAppPlan {
  if (host.platform !== 'darwin') return { wait: 'not-macos' }
  const url = codexWakeUrl(target.sessionId)
  if (url === null) return { wait: 'not-app-thread' }
  const rollout = host.originator(target.codexHome, target.sessionId, target.transcriptPath)
  if (rollout.place === 'archived') return { wait: 'archived' }
  if (rollout.place !== 'sessions' || codexAppSurface(rollout.originator) !== 'app') return { wait: 'not-app-thread' }
  const app = target.hostApp
  if (app === null || !host.alive(app)) return { wait: 'app-not-running' }
  const bundle = host.bundleOf(app.pid)
  if (bundle === null || bundle.bundleId !== CODEX_APP_BUNDLE_ID) return { wait: 'app-unrecognised' }
  const home = target.codexHome ?? path.join(os.homedir(), '.codex')
  if (target.appServer === null || !host.alive(target.appServer) || !host.hasOpenUnder(target.appServer.pid, home)) return { wait: 'app-server-gone' }
  const holders = host.holders(target.codexHome, target.sessionId)
  if (holders === 'unknown') return { wait: 'live-unknown' }
  if (holders.length > 0) return { wait: 'live-elsewhere' }
  const wakeToken = host.queuedWake(target.sessionId, target.env)
  if (wakeToken === null) return { wait: 'no-wake-queued' }
  if (faults(bundle.version)) return { wait: 'app-ignored-links' }
  if (host.launcher === null) return { wait: 'launcher-missing' }
  return { url, wakeToken, app, bundle }
}

/** What a handed link did: `sent`, or why not. A cold launch is a fault. */
export type CodexAppSend = { sent: true; route: 'apple-event' | 'launch-services' } | { sent: false; reason: string; coldLaunch?: true }

/** Hand the link to the app that is running now; never start one. */
export async function sendCodexAppUrl(plan: Extract<CodexAppPlan, { url: string }>, host: CodexAppHost): Promise<CodexAppSend> {
  const event = await host.sendEvent(plan.app.pid, plan.url)
  if (event === 'sent') return { sent: true, route: 'apple-event' }
  if (event !== 'needs-consent') return { sent: false, reason: event === 'gone' ? 'app-not-running' : 'apple-event-failed' }
  // macOS would ask the User first: LaunchServices instead, only with the same app still running, checked after.
  const before = host.processesOf(plan.bundle.executable)
  if (before === 'unknown' || !before.includes(plan.app.pid) || !host.alive(plan.app)) return { sent: false, reason: 'app-not-running' }
  const opened = await host.openUrl(plan.url)
  const after = host.processesOf(plan.bundle.executable)
  if (after !== 'unknown' && after.some((pid) => !before.includes(pid))) return { sent: false, reason: 'app-started', coldLaunch: true }
  if (opened !== true) return { sent: false, reason: 'open-failed' }
  return { sent: true, route: 'launch-services' }
}

// -- records ------------------------------------------------------------------------

/** Claim the one link a wake may have: the first claimant across hubs wins (an exclusive create). */
export function claimWakeLink(directory: string, wakeToken: string): boolean {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const name = `codex-app-link-${createHash('sha256').update(wakeToken).digest('hex').slice(0, 32)}`
  try {
    writeFileSync(path.join(directory, name), `${Date.now()}\n`, { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

interface FaultRecord { v: 1; version: string; reason: string; at: number }

function faultPath(directory: string): string {
  return path.join(directory, 'codex-app-fault.json')
}

/** The app ignored a link or a link started it: no more links until its version changes. */
export function recordCodexAppFault(directory: string, version: string, reason: string, at: number): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  atomicWriteFileSync(faultPath(directory), `${JSON.stringify({ v: 1, version, reason, at } satisfies FaultRecord)}\n`)
}

/** Whether links are stopped for this app version. */
export function codexAppFaulted(directory: string, version: string): boolean {
  try {
    const record = JSON.parse(readFileSync(faultPath(directory), 'utf8')) as FaultRecord
    return record.v === 1 && record.version === version
  } catch {
    return false
  }
}

// -- the real machine -------------------------------------------------------------------

const TOOL_ENV = { PATH: '/usr/sbin:/usr/bin:/bin:/sbin', LC_ALL: 'C' }

function run(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 3_000, maxBuffer: 8 * 1024 * 1024, env: TOOL_ENV, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** `<X>.app/Contents/MacOS/<exe>` → the bundle's identifier and version, from its own Info.plist. */
export function bundleOfExecutable(executable: string): CodexAppBundle | null {
  const match = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable)
  if (match === null) return null
  const plist = path.join(match[1]!, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return null
  const read = (key: string): string | null => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])?.trim() || null
  const bundleId = read('CFBundleIdentifier')
  if (bundleId === null) return null
  return { bundleId, version: `${read('CFBundleShortVersionString') ?? '?'} (${read('CFBundleVersion') ?? '?'})`, executable }
}

export function systemCodexAppHost(launcher: string | null): CodexAppHost {
  return {
    platform: process.platform,
    launcher,
    alive: (identity) => processIdentityLiveness(identity) === 'alive',
    bundleOf: (pid) => {
      const executable = run('/bin/ps', ['-o', 'comm=', '-p', String(pid)])?.trim() ?? ''
      return executable === '' ? null : bundleOfExecutable(executable)
    },
    hasOpenUnder: (pid, folder) => {
      const output = run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-Fn'])
      if (output === null) return false
      const prefix = `n${folder.endsWith('/') ? folder : `${folder}/`}`
      return output.split('\n').some((line) => line.startsWith(prefix))
    },
    processesOf: (executable) => {
      const output = run('/bin/ps', ['-A', '-o', 'pid=,comm='])
      if (output === null) return 'unknown'
      return output.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line)
        return match !== null && match[2]!.trim() === executable ? [Number(match[1])] : []
      })
    },
    holders: (home, id) => codexThreadHolders(home, id),
    originator: (home, id, transcriptPath) => {
      const located = locateCodexRollout(home, id, transcriptPath)
      return { place: located.place, originator: readCodexThreadOriginator(located.path) }
    },
    queuedWake: (sessionId, env) => {
      const state = readSessionState(sessionId, env)
      const wake = state.input_wake
      if (wake?.queued !== true) return null
      const attempt = state.input_wake_attempts?.find((item) => item.token === wake.token)
      return attempt === undefined || attempt.phase === 'consumed' || attempt.phase === 'cancelled' ? null : wake.token
    },
    sendEvent: (pid, url) => new Promise((resolve) => {
      if (launcher === null) { resolve('failed'); return }
      execFile(launcher, codexAppEventArgs(pid, url), { timeout: 15_000, env: TOOL_ENV }, (err) => {
        const code = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1
        resolve(code === 0 ? 'sent' : code === 3 ? 'needs-consent' : code === 4 ? 'gone' : 'failed')
      })
    }),
    openUrl: (url) => new Promise((resolve) => {
      execFile('/usr/bin/open', codexAppOpenArgs(url), { timeout: 15_000, env: TOOL_ENV }, (err) => {
        resolve(err === null ? true : err.message.slice(0, 200))
      })
    }),
  }
}
