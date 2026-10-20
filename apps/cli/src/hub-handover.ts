/**
 * A hub that runs a build other than the active one hands over to it.
 *
 * Any change of the active build (a manual, npm or curl update, a rollback)
 * leaves the running hub on its old build until it is replaced. The hub
 * replaces itself as soon as nothing waits (see `Hub.checkBuildHandover`),
 * under the same blockers that hold an automatic activation back. A hub from
 * a build without that check is replaced by the active build instead: a hook
 * notices the older hub, and a detached process asks it for its status and
 * sends `stop` only when that status, read twice, proves nothing waits.
 * Leaving keeps every lease on disk; the session children reconnect and the
 * next hub, started through the stable launcher, continues each lease.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { waitingSessionWork, type WaitingReason } from './automatic-update.js'
import { buildIdentity } from './distribution.js'
import { claimHolderMayRun, readClaimFile } from './hook-question-lock.js'
import { startHub } from './hub-client.js'
import { endsIncarnation, readSessionEndMarker, readSessionIncarnation } from './hook-session-state.js'
import { HUB_IPC_VERSIONS, hubLockPath, hubRunDir, hubStatusPath, hubSupported, requestHub } from './hub-ipc.js'
import { currentRuntimeBuild } from './launch-self.js'
import type { Logger } from './logging.js'
import { accountHome } from './platform.js'
import { pidExists, processIdentityLiveness } from './process-identity.js'
import { packageVersion } from './release.js'
import { hasSessionInputs } from './session-inputs.js'

/** Why a hub on another build has not handed over yet. */
export type HandoverWait = WaitingReason
  /** The running hub's status does not say enough to prove that nothing waits. */
  | 'hub-unverifiable'

/**
 * Two reads of an older hub's status this far apart, both clear: longer than
 * the hub's Codex end confirmation (5 s), so an end it was still classifying
 * at the first read shows by the second.
 */
export const HANDOVER_CONFIRM_MS = 6_000
/** Hooks start the detached check at most this often while an older hub runs. */
export const HANDOVER_CHECK_INTERVAL_MS = 30_000
/** How long the check waits for the older hub to release its lock. */
const HANDOVER_EXIT_WAIT_MS = 15_000

/** The installation's active build (`active.json`), or null when there is none. */
export function readActiveBuild(env: NodeJS.ProcessEnv): string | null {
  try {
    const record = JSON.parse(readFileSync(path.join(accountHome(env), '.notifai', 'active.json'), 'utf8')) as { active?: unknown }
    return typeof record.active === 'string' && /^[a-f0-9]{64}$/.test(record.active) ? record.active : null
  } catch {
    return null
  }
}

export interface ActiveRuntime { build: string; version: string; digest: string | null }

/** This process, when it is the installation's active build: only then may it judge another build's hub. */
export function activeRuntime(env: NodeJS.ProcessEnv): ActiveRuntime | null {
  let running: ReturnType<typeof currentRuntimeBuild>
  try { running = currentRuntimeBuild(env) } catch { return null }
  const version = packageVersion()
  if (running === null || version === null || readActiveBuild(env) !== running.build) return null
  return { build: running.build, version, digest: buildIdentity()?.sourceDigest ?? null }
}

/** A hub that checks its own build reports `runtime_build`; earlier hubs do not. */
export function hubHandsOverItself(status: Record<string, unknown>): boolean {
  return Object.hasOwn(status, 'runtime_build')
}

/** An earlier hub names only its version and source digest. */
function olderHubOnOtherBuild(status: Record<string, unknown>, self: ActiveRuntime): boolean {
  return status['version'] !== self.version || status['build'] !== self.digest
}

/**
 * What holds an earlier hub's handover back, judged from its status and this
 * machine's records: the reasons `Hub.updateBlockers` gives, as far as that
 * status shows them. Anything it cannot show counts as waiting.
 */
export function olderHubWaits(env: NodeJS.ProcessEnv, status: Record<string, unknown>, now: number = Date.now()): HandoverWait[] {
  const settlements = status['settlements'], owed = status['pending_end_reports'], sessions = status['sessions'], ipc = status['ipc_version']
  if (typeof settlements !== 'number' || typeof owed !== 'number' || !Array.isArray(sessions) || typeof ipc !== 'number') return ['hub-unverifiable']
  const waits = new Set<HandoverWait>(waitingSessionWork(env, now))
  // Its children speak the version it serves.
  if (ipc < HUB_IPC_VERSIONS.min || ipc > HUB_IPC_VERSIONS.max) waits.add('session-child-incompatible')
  if (settlements > 0) waits.add('question-waiting')
  if (owed > 0) waits.add('session-ending')
  for (const entry of sessions as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return ['hub-unverifiable']
    const session = entry as Record<string, unknown>
    const id = session['session_id']
    if (typeof id !== 'string') return ['hub-unverifiable']
    // Dormant-open, or a Codex end it may still be classifying: only that hub holds it.
    if (session['reason'] === 'dormant-open' || (session['harness'] === 'codex' && session['child'] !== true)) waits.add('session-dormant')
    const record = readSessionIncarnation(id, env)
    if (record === null) { waits.add('hub-unverifiable'); continue }
    // An end it may still owe the service: the end marker, or its harness gone.
    if (endsIncarnation(readSessionEndMarker(id, env), record) ||
        (record.harness_process !== undefined && processIdentityLiveness(record.harness_process) === 'gone')) waits.add('session-ending')
    const generation = session['generation']
    if (typeof generation === 'number' && hasSessionInputs(id, env, { incarnation: record.incarnation, generation })) {
      waits.add('session-input-pending')
    }
  }
  return [...waits]
}

/** The hub's own status file while it says it runs. */
function hubStatusFile(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  try {
    const status = JSON.parse(readFileSync(hubStatusPath(env), 'utf8')) as unknown
    return typeof status === 'object' && status !== null && !Array.isArray(status) &&
      (status as Record<string, unknown>)['state'] === 'running' ? status as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Whether the hub lock's holder still runs (a process-table read). */
function hubLockHeld(env: NodeJS.ProcessEnv): boolean {
  const holder = readClaimFile(hubLockPath(env))
  return holder !== null && claimHolderMayRun(holder)
}

function runningHubStatus(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  const status = hubStatusFile(env)
  return status !== null && hubLockHeld(env) ? status : null
}

/**
 * For a hook: whether an earlier hub runs beside this newer active build and
 * a check is due. One small file read otherwise. The stamp moves first, so
 * concurrent hooks start one check. Real clock: it compares a file mtime.
 */
export function claimOlderHubHandover(env: NodeJS.ProcessEnv, now: number = Date.now()): boolean {
  if (!hubSupported() || buildIdentity() === null) return false
  const status = hubStatusFile(env)
  if (status === null || hubHandsOverItself(status)) return false
  if (status['version'] === packageVersion() && status['build'] === (buildIdentity()?.sourceDigest ?? null)) return false
  if (!hubLockHeld(env)) return false
  const self = activeRuntime(env)
  if (self === null || !olderHubOnOtherBuild(status, self)) return false
  const stamp = path.join(hubRunDir(env), 'handover-check')
  try {
    // A negative age means the clock moved, not that the stamp is old.
    const age = now - statSync(stamp).mtimeMs
    if (age >= 0 && age < HANDOVER_CHECK_INTERVAL_MS) return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  try {
    writeFileSync(stamp, '', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export type OlderHubOutcome =
  | { outcome: 'not-active-build' | 'no-hub' | 'self-managed' | 'current' | 'failed' }
  | { outcome: 'waiting'; hub_version: string | null; waiting_for: HandoverWait[] }
  | { outcome: 'handed-over'; hub_version: string | null; successor: boolean }

export interface OlderHubHandoverSeams {
  /** This process as the active build; production reads its own build and `active.json`. */
  self?: ActiveRuntime | null
  request?: typeof requestHub
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Start the next hub; production starts this (active) build's hub. */
  start?: (env: NodeJS.ProcessEnv) => void
  confirmMs?: number
  exitWaitMs?: number
  logger?: Logger
}

/**
 * The detached check: replace an earlier hub that runs another build, only
 * once two reads of its status, `confirmMs` apart, show nothing waiting.
 * Otherwise wait: a later hook checks again.
 */
export async function handOverOlderHub(env: NodeJS.ProcessEnv, seams: OlderHubHandoverSeams = {}): Promise<OlderHubOutcome> {
  const request = seams.request ?? requestHub
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = seams.now ?? Date.now
  const self = seams.self !== undefined ? seams.self : activeRuntime(env)
  if (self === null) return { outcome: 'not-active-build' }
  const read = async (): Promise<Record<string, unknown> | null> => {
    const reply = await request(env, { type: 'status' }, { timeoutMs: 2_000 })
    const status = reply?.['type'] === 'status' ? reply['status'] : null
    return typeof status === 'object' && status !== null && !Array.isArray(status) ? status as Record<string, unknown> : null
  }
  const first = await read()
  if (first === null) return { outcome: 'no-hub' }
  if (hubHandsOverItself(first)) return { outcome: 'self-managed' }
  if (!olderHubOnOtherBuild(first, self)) return { outcome: 'current' }
  const hubVersion = typeof first['version'] === 'string' ? first['version'] : null
  const waiting = (waits: HandoverWait[]): OlderHubOutcome => {
    seams.logger?.info('hub.handover', { event: 'waiting', hub_version: hubVersion, active_version: self.version, waiting_for: waits })
    return { outcome: 'waiting', hub_version: hubVersion, waiting_for: waits }
  }
  const before = olderHubWaits(env, first, now())
  if (before.length > 0) return waiting(before)
  await sleep(seams.confirmMs ?? HANDOVER_CONFIRM_MS)
  const second = await read()
  if (second === null) return { outcome: 'no-hub' }
  if (second['pid'] !== first['pid']) return { outcome: 'current' }
  const after = olderHubWaits(env, second, now())
  if (after.length > 0) return waiting(after)
  const ack = await request(env, { type: 'stop', reason: 'build-superseded' }, { timeoutMs: 2_000 })
  if (ack?.['type'] !== 'ack') return { outcome: 'failed' }
  // It keeps every lease on disk, releases its lock and leaves.
  const pid = second['pid']
  const deadline = now() + (seams.exitWaitMs ?? HANDOVER_EXIT_WAIT_MS)
  for (;;) {
    const holder = readClaimFile(hubLockPath(env))
    if (holder === null || holder['pid'] !== pid || !claimHolderMayRun(holder) || (typeof pid === 'number' && !pidExists(pid))) break
    if (now() >= deadline) return { outcome: 'failed' }
    await sleep(100)
  }
  // Its children reconnect and would start the next hub; start it now so none waits for that.
  const attended = (Array.isArray(second['sessions']) && second['sessions'].length > 0) ||
    (typeof second['children'] === 'number' && second['children'] > 0)
  if (attended) {
    try {
      (seams.start ?? startHub)(env)
    } catch {
      // The children start it.
    }
  }
  seams.logger?.info('hub.handover', { event: 'handed-over', hub_version: hubVersion, active_version: self.version, successor: attended })
  return { outcome: 'handed-over', hub_version: hubVersion, successor: attended }
}

/** What `doctor` and `update --check --json` say about a hub on another build. */
export interface HubHandoverReport {
  hub_version: string | null
  active_version: string | null
  /** `hub`: the hub replaces itself; `active-build`: an earlier hub, replaced by this build at a hook. */
  replaced_by: 'hub' | 'active-build'
  /** `due`: nothing waits, the next check replaces it. */
  state: 'waiting' | 'due'
  waiting_for: HandoverWait[]
}

/** Null while the running hub runs the active build (or no hub runs). */
export function hubHandoverReport(env: NodeJS.ProcessEnv, now: number = Date.now()): HubHandoverReport | null {
  if (!hubSupported()) return null
  const status = runningHubStatus(env)
  if (status === null) return null
  const hubVersion = typeof status['version'] === 'string' ? status['version'] : null
  const self = activeRuntime(env)
  if (hubHandsOverItself(status)) {
    const active = readActiveBuild(env), running = status['runtime_build']
    if (typeof running !== 'string' || active === null || active === running) return null
    const handover = status['handover'] as { waiting_for?: unknown } | null | undefined
    const waits = Array.isArray(handover?.waiting_for) ? handover.waiting_for.filter((reason): reason is HandoverWait => typeof reason === 'string') : []
    return { hub_version: hubVersion, active_version: self?.build === active ? self.version : null, replaced_by: 'hub',
      state: waits.length > 0 ? 'waiting' : 'due', waiting_for: waits }
  }
  if (self === null || !olderHubOnOtherBuild(status, self)) return null
  const waits = olderHubWaits(env, status, now)
  return { hub_version: hubVersion, active_version: self.version, replaced_by: 'active-build',
    state: waits.length > 0 ? 'waiting' : 'due', waiting_for: waits }
}

const WAIT_TEXT: Record<HandoverWait, string> = {
  'question-waiting': 'a question or answer waits',
  'session-input-pending': 'a Note or answer is on its way to its agent',
  'session-ending': 'a closed session\'s end is still being reported',
  'session-dormant': 'a Codex conversation is held open',
  'session-child-incompatible': 'a session child speaks a protocol the new build does not serve',
  'candidate-unverified': 'the active build could not be checked',
  'hub-unverifiable': 'the running hub does not report enough to show nothing waits',
  'hook-approval': 'hook changes need approval',
  continuity: 'local state is not compatible yet',
  'installation-busy': 'an installation change is in progress',
  'no-forward-release': 'no newer release is available',
}

/** One line for people. */
export function describeHubHandover(report: HubHandoverReport): string {
  const what = `running ${report.hub_version ?? 'an earlier build'} while ${report.active_version ?? 'another build'} is active`
  if (report.state === 'due') return `${what}; it hands over at the next check`
  return `${what}; it hands over once nothing waits (${report.waiting_for.map((reason) => WAIT_TEXT[reason] ?? reason).join('; ')})`
}
