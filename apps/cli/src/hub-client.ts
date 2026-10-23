/**
 * The CLI's side of the hub: hand it work, start it when nothing answers, tell
 * it when the credential changed, and read its status for `doctor`.
 */
import { existsSync, linkSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { readClaimFile, claimHolderMayRun } from './hook-question-lock.js'
import {
  credentialGenerationPath,
  ensurePrivateDirectory,
  hubLockPath,
  hubRunDir,
  hubStatusPath,
  hubHistoryPath,
  hubSupported,
  readShutdownMarker,
  requestHub,
  SHUTDOWN_MARKER_FRESH_MS,
  writeShutdownMarker,
} from './hub-ipc.js'
import { systemdStopping } from './power-watch.js'
import { launchSelf } from './launch-self.js'
import { pidExists } from './process-identity.js'
import { attendantClaimPath } from './session-attendant-state.js'

/**
 * What the shared hub runs with, whoever starts it: the account, its locale
 * and Notifai's own settings, as the native session child passes them
 * (`session-child.h`). Nothing else the starter had: its API keys and tokens
 * stay where they were, and a session's own variables (its harness homes, the
 * PATH its harness runs on, its desktop) travel with that session's
 * registration instead.
 */
const HUB_VARIABLES = /^(HOME|PATH|USER|LOGNAME|SHELL|LANG|TZ|TMPDIR|LC_[A-Z_]+|XDG_(CONFIG|STATE|DATA|CACHE)_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|NOTIFAI_[A-Z0-9_]+)$/
/** Notifai variables that belong to one harness session or one process. */
const SESSION_VARIABLES = /^NOTIFAI_(HOOK_SOURCE_PID$|ACTIVE_|NATIVE_|INTERNAL_)/

/**
 * How this machine reaches the service: proxy and certificate settings. The
 * hub takes them from one deliberate record, written when the User signs in
 * (`recordHubNetwork`) or, on a machine signed in before there was one, once
 * by the first hub starter (`initHubNetwork`); never from whichever process
 * happens to start it after that.
 * The native session child reads the same record (`session-child.h`).
 */
export const HUB_NETWORK_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
  'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const

export function hubNetworkPath(env: NodeJS.ProcessEnv): string {
  return path.join(hubRunDir(env), 'network.json')
}

function networkVariables(source: Record<string, unknown>): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const name of HUB_NETWORK_VARIABLES) {
    const value = source[name]
    if (typeof value === 'string' && value !== '' && value.length <= 4_096 && !/[\0\r\n]/.test(value)) kept[name] = value
  }
  return kept
}

/** The recorded network settings; none (a direct connection) when nothing was recorded. */
export function readHubNetwork(env: NodeJS.ProcessEnv): Record<string, string> {
  try {
    const value = JSON.parse(readFileSync(hubNetworkPath(env), 'utf8')) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? networkVariables(value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Record the network settings of the command that signed this machine in:
 * the User's own shell, which just reached the service with them. True when
 * they differ from what the hub runs with now. Only the names above are kept;
 * a proxy URL may carry its credentials, so the file is the User's alone.
 */
export function recordHubNetwork(env: NodeJS.ProcessEnv): boolean {
  const next = networkVariables(env)
  const before = readHubNetwork(env)
  ensurePrivateDirectory(hubRunDir(env))
  atomicWriteFileSync(hubNetworkPath(env), `${JSON.stringify(next)}\n`, { mode: 0o600, requireCurrentUserOwner: true })
  return JSON.stringify(Object.entries(before).sort()) !== JSON.stringify(Object.entries(next).sort())
}

/**
 * No record yet (a machine signed in before there was one): write it once
 * from the starting process's own settings, as the native child does, so a
 * proxy that worked before keeps working. A record that exists is never
 * replaced here; only sign-in changes it.
 */
export function initHubNetwork(env: NodeJS.ProcessEnv): void {
  if (existsSync(hubNetworkPath(env))) return
  const file = hubNetworkPath(env)
  const temp = `${file}.${process.pid}.tmp`
  try {
    ensurePrivateDirectory(hubRunDir(env))
    writeFileSync(temp, `${JSON.stringify(networkVariables(env))}\n`, { mode: 0o600, flag: 'wx' })
    // Linked into place: a record another starter wrote first is kept.
    try { linkSync(temp, file) } catch { /* already recorded */ }
  } catch {
    // Unwritable: the hub starts with no network settings, as before.
  } finally {
    rmSync(temp, { force: true })
  }
}

export function hubEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  initHubNetwork(env)
  const clean: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && HUB_VARIABLES.test(name) && !SESSION_VARIABLES.test(name)) clean[name] = value
  }
  return { ...clean, ...readHubNetwork(env) }
}

/**
 * After sign-in: record the network settings, and when they changed, ask a
 * running hub to hand over to one started with them. A process's proxy and
 * certificate settings are read once, when it starts.
 */
export async function adoptHubNetwork(env: NodeJS.ProcessEnv): Promise<void> {
  if (!hubSupported()) return
  let changed: boolean
  try { changed = recordHubNetwork(env) } catch { return }
  if (!changed) return
  const holder = readClaimFile(hubLockPath(env))
  if (holder === null || !claimHolderMayRun(holder)) return
  await requestHub(env, { type: 'stop', reason: 'network-changed' }, { timeoutMs: 2_000 })
}

/** Start the hub detached, outside this process's group, in the user's home. */
export function startHub(env: NodeJS.ProcessEnv): void {
  launchSelf(['hub', '--owner', 'notifai'], { cwd: os.homedir(), env: hubEnvironment(env), retain: () => undefined })
}

/**
 * Deliver one request to the hub, starting it when nothing answers and
 * retrying for up to `startWaitMs`. Null when no hub could be reached.
 */
export async function handToHub(
  env: NodeJS.ProcessEnv,
  message: Record<string, unknown>,
  options: { startWaitMs?: number; start?: (env: NodeJS.ProcessEnv) => void } = {},
): Promise<Record<string, unknown> | null> {
  const first = await requestHub(env, message, { timeoutMs: 1_000 })
  if (first !== null) return first
  try {
    (options.start ?? startHub)(env)
  } catch {
    return null
  }
  const deadline = Date.now() + (options.startWaitMs ?? 5_000)
  for (let delay = 100; Date.now() < deadline; delay = Math.min(delay * 2, 1_000)) {
    await new Promise((resolve) => setTimeout(resolve, delay))
    const reply = await requestHub(env, message, { timeoutMs: 1_000 })
    if (reply !== null) return reply
  }
  return null
}

/**
 * Whether the hub, through this session's native child, attends it now. Only
 * then may a Claude Code Stop hand its answer window over: the hub cannot write
 * Claude's inbox itself, and without a child the Stop hook (Claude's own child)
 * keeps the wait.
 */
/**
 * The hub noted that the machine is shutting down (and has not seen it
 * cancelled). A SessionEnd that cannot reach a hub then cleans up nothing:
 * the hub may already have been terminated, and the next one decides (the
 * machine went down, or the conversation closed: late, never early).
 */
export function shutdownUnderway(env: NodeJS.ProcessEnv, now: number = Date.now()): boolean {
  const marker = readShutdownMarker(env)
  if (marker !== null && now - marker.since >= 0 && now - marker.since < SHUTDOWN_MARKER_FRESH_MS) return true
  // Linux, a shutdown logind did not announce (`systemctl start reboot.target`): systemd still says so. Noted
  // for the next boot, like the hub's.
  if (!systemdStopping()) return false
  let boot: string | null = null
  try { boot = `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}` } catch { /* unknown */ }
  writeShutdownMarker(env, { boot, since: now, name: 'systemd-stopping' })
  return true
}

export function hubAttendsSession(sessionId: string, env: NodeJS.ProcessEnv): boolean {
  const holder = readClaimFile(attendantClaimPath(sessionId, env))
  return holder?.['role'] === 'hub' && typeof holder['pid'] === 'number' && pidExists(holder['pid'])
}

/** Best effort and bounded: tell a running hub that a session ended. Never starts one. */
export async function notifyHubSessionEnded(env: NodeJS.ProcessEnv, sessionId: string, timeoutMs = 300): Promise<boolean> {
  if (!hubSupported()) return false
  return (await requestHub(env, { type: 'session-end', session_id: sessionId }, { timeoutMs })) !== null
}

/**
 * A Claude Code or Codex SessionEnd: ask the hub that attends the session to
 * decide after the end confirmation whether it closed, came back at once (a
 * reload, a handoff to another place), goes on in another place it is open
 * in, or was only unloaded by its app. `harnessPid` is the process that ran
 * the hook, when known. `held` only when the hub holds the decision;
 * `refused` when it attends no such session; `unreachable` when no hub
 * answered in time (a slow hub may still take the request it was sent).
 * Never starts a hub: a hub that is not running attends nothing it could
 * keep open.
 */
export async function holdSessionEnd(env: NodeJS.ProcessEnv, sessionId: string,
  details: { harnessPid?: number | undefined; transcriptPath?: string | undefined; closeReason?: string | undefined } = {}, timeoutMs = 800): Promise<'held' | 'refused' | 'unreachable'> {
  if (!hubSupported()) return 'unreachable'
  const reply = await requestHub(env, { type: 'session-end-candidate', session_id: sessionId,
    ...(details.harnessPid === undefined ? {} : { harness_pid: details.harnessPid }),
    ...(details.transcriptPath === undefined ? {} : { transcript_path: details.transcriptPath }),
    ...(details.closeReason === undefined ? {} : { close_reason: details.closeReason }) }, { timeoutMs })
  if (reply === null) return 'unreachable'
  return reply['type'] === 'ok' && reply['held'] === true ? 'held' : 'refused'
}

/** Best effort: a session sent its first Notification Request; the hub starts attending it. */
export async function notifyHubSessionNotified(env: NodeJS.ProcessEnv, sessionId: string): Promise<void> {
  if (!hubSupported()) return
  await requestHub(env, { type: 'notified', session_id: sessionId }, { timeoutMs: 300 })
}

/**
 * The credential changed (sign-out, re-pair). Bump the non-secret marker the
 * hub checks before every exchange, ask a running hub to drop the credential
 * and wait for its acknowledgement. A hub that does not acknowledge within two
 * seconds is terminated: it must never keep sending after a sign-out.
 */
export async function notifyCredentialChanged(env: NodeJS.ProcessEnv): Promise<'no-hub' | 'acknowledged' | 'terminated'> {
  if (!hubSupported()) return 'no-hub'
  try {
    ensurePrivateDirectory(hubRunDir(env))
    atomicWriteFileSync(credentialGenerationPath(env), `${Date.now()}-${process.pid}\n`)
  } catch {
    // The acknowledgement below is the primary path; the marker is the backstop.
  }
  const holder = readClaimFile(hubLockPath(env))
  if (holder === null || !claimHolderMayRun(holder)) return 'no-hub'
  const reply = await requestHub(env, { type: 'credential-changed' }, { timeoutMs: 2_000 })
  if (reply?.['type'] === 'ack') return 'acknowledged'
  const pid = holder['pid']
  if (typeof pid === 'number' && pidExists(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* Already gone. */ }
  }
  return 'terminated'
}

export interface HubReport {
  supported: boolean
  running: boolean
  pid: number | null
  status: Record<string, unknown> | null
  fault: { reason: string; since: string } | null
  recent_crashes: number
}

/** What `doctor` shows about the hub, from local files only (never starts it). */
export function readHubReport(env: NodeJS.ProcessEnv): HubReport {
  if (!hubSupported()) return { supported: false, running: false, pid: null, status: null, fault: null, recent_crashes: 0 }
  const holder = readClaimFile(hubLockPath(env))
  const running = holder !== null && claimHolderMayRun(holder)
  let status: Record<string, unknown> | null = null
  try {
    if (existsSync(hubStatusPath(env)) && statSync(hubStatusPath(env)).isFile()) {
      status = JSON.parse(readFileSync(hubStatusPath(env), 'utf8')) as Record<string, unknown>
    }
  } catch { status = null }
  let fault: HubReport['fault'] = null
  let crashes = 0
  try {
    const history = JSON.parse(readFileSync(hubHistoryPath(env), 'utf8')) as { starts?: { at: number; pid: number; clean: boolean }[]; fault?: { reason: string; since: number } }
    const now = Date.now()
    crashes = (history.starts ?? []).filter((start) => now - start.at < 10 * 60_000 && !start.clean && !pidExists(start.pid)).length
    if (history.fault && now - history.fault.since < 10 * 60_000) fault = { reason: history.fault.reason, since: new Date(history.fault.since).toISOString() }
  } catch { /* No history yet. */ }
  return { supported: true, running, pid: running && typeof holder?.['pid'] === 'number' ? holder['pid'] : null,
    status: running ? status : status === null ? null : { ...status, state: 'exited' }, fault, recent_crashes: crashes }
}

