/**
 * The CLI's side of the hub: hand it work, start it when nothing answers, tell
 * it when the credential changed, and read its status for `doctor`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
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
  requestHub,
} from './hub-ipc.js'
import { launchSelf } from './launch-self.js'
import { pidExists } from './process-identity.js'
import { attendantClaimPath } from './session-attendant-state.js'

/** Variables that belong to one harness session and never reach the shared hub. */
const SESSION_VARIABLES = /^(CLAUDE_CODE_|CLAUDECODE$|CODEX_THREAD_ID$|CODEX_SESSION_ID$|NOTIFAI_HOOK_SOURCE_PID$|NOTIFAI_ACTIVE_|NOTIFAI_NATIVE_|NOTIFAI_INTERNAL_)/

export function hubEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) if (!SESSION_VARIABLES.test(name)) clean[name] = value
  return clean
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
 * A Codex SessionEnd for a conversation of the Codex app or IDE extension:
 * ask the hub that attends it to decide whether it closed or was only
 * unloaded. True only when the hub holds the decision; otherwise the caller
 * ends the session as before. Never starts a hub: a hub that is not running
 * attends nothing it could keep open.
 */
export async function holdCodexSessionEnd(env: NodeJS.ProcessEnv, sessionId: string, transcriptPath: string | undefined,
  timeoutMs = 800): Promise<boolean> {
  if (!hubSupported()) return false
  const reply = await requestHub(env, { type: 'session-end-candidate', session_id: sessionId,
    ...(transcriptPath === undefined ? {} : { transcript_path: transcriptPath }) }, { timeoutMs })
  return reply?.['type'] === 'ok' && reply['held'] === true
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

