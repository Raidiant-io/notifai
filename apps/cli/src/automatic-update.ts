/**
 * Automatic updates (on by default; `updates.automatic` turns them off).
 *
 * The hub runs this outside every agent sandbox. At most once a day it looks
 * up the release its saved channel points to and, when that release is newer,
 * downloads, verifies and stages it as an immutable, inactive version. It
 * activates the staged version only when nothing on this machine waits:
 *
 * - no question waits for the User and no answer, Note or Answer Edit is still
 *   on its way to its agent;
 * - every connected session child speaks an IPC version the new hub serves;
 * - the new build would not rewrite Codex or Claude Code hook definitions
 *   (Codex skips a changed hook until the User trusts it again);
 * - the installation's local continuity contract admits it.
 *
 * It never changes the saved channel (beta stays beta, stable stays stable)
 * and never activates an older version: a withdrawn build moves forward to its
 * replacement or stays where it is. An install from the npm launcher updates
 * its native runtime here like any other; the npm package is npm's and nothing
 * here touches it.
 */
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { REPLY_MAX_WINDOW_SECONDS } from '@raidiant/notifai-protocol'
import type { ActivationPlan } from './activation-plan.js'
import { atomicWriteFileSync } from './atomic-file.js'
import { automaticUpdatesSetting, stateDir } from './config.js'
import { buildIdentity } from './distribution.js'
import { hubSupported } from './hub-ipc.js'
import { withFileLock } from './file-lock.js'
import type { SessionState } from './hook-types.js'
import { pendingList } from './hook-session-state.js'
import type { Installation } from './installation.js'
import { ContinuityPending } from './local-continuity.js'
import type { Logger } from './logging.js'
import { processIdentityLiveness } from './process-identity.js'
import { compareReleasePrecedence, isSemVer } from './version.js'

/** One release lookup a day per machine. */
export const AUTOMATIC_LOOKUP_INTERVAL_MS = 24 * 60 * 60 * 1000
/** A staged update held back this long is offered to agents again, weekly (design §11 "Starvation"). */
export const STAGED_OFFER_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** Why a staged update has not been activated yet. */
export type WaitingReason =
  /** A question waits for the User, or an answer or acknowledgement is still owed. */
  | 'question-waiting'
  /** A Note or Answer Edit has not reached its agent yet. */
  | 'session-input-pending'
  /** A closed session's end report has not reached the service yet. */
  | 'session-ending'
  /** A dormant-open Codex conversation is held only by the running hub. */
  | 'session-dormant'
  /** The new build would rewrite Codex or Claude Code hook definitions. */
  | 'hook-approval'
  /** A running session child speaks an IPC version the new hub does not serve. */
  | 'session-child-incompatible'
  /** The local continuity contract does not admit the new build yet. */
  | 'continuity'
  /** An installation transaction or uninstall is in progress. */
  | 'installation-busy'
  /** The staged build could not report what activating it would change. */
  | 'candidate-unverified'
  /** The active build was withdrawn and its channel offers nothing newer. */
  | 'no-forward-release'

export interface AutomaticUpdateRecord {
  schema: 1
  checked_at?: number
  staged?: { version: string; build: string; since: number } | null
  waiting_for?: WaitingReason[]
  hook_changes?: { harness: string; file: string }[]
  last_automatic?: { from: string; to: string; at: number; announced_at?: number } | null
  last_attempt_at?: number
  error?: string | null
}

/**
 * Whether this machine has an automatic updater at all: a managed native
 * installation on a platform where the hub runs. Elsewhere (Windows until the
 * hub ships there, development builds) agents keep offering updates.
 */
export function automaticUpdatesRunHere(platform: NodeJS.Platform = process.platform): boolean {
  return buildIdentity() !== null && hubSupported(platform)
}

/** Reasons the User (or an explicit update) must act on; waiting alone clears by itself. */
const NEEDS_ACTION: ReadonlySet<WaitingReason> = new Set(['hook-approval', 'session-child-incompatible', 'continuity', 'candidate-unverified'])

/**
 * A staged update the updater cannot activate by itself, or one held back for
 * a week: what agents should now offer, or null.
 */
export function heldAutomaticUpdate(env: NodeJS.ProcessEnv, now: number): { version: string; waiting_for: WaitingReason[]; reason: 'action' | 'starved' } | null {
  const record = readAutomaticUpdateRecord(env)
  const staged = record.staged
  if (!staged || typeof staged.version !== 'string' || !isSemVer(staged.version)) return null
  const waiting = record.waiting_for ?? []
  if (waiting.some(reason => NEEDS_ACTION.has(reason))) return { version: staged.version, waiting_for: waiting, reason: 'action' }
  if (typeof staged.since === 'number' && now - staged.since >= STAGED_OFFER_AFTER_MS) return { version: staged.version, waiting_for: waiting, reason: 'starved' }
  return null
}

export function automaticUpdateRecordPath(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'automatic-update.json')
}

export function readAutomaticUpdateRecord(env: NodeJS.ProcessEnv): AutomaticUpdateRecord {
  const file = automaticUpdateRecordPath(env)
  try {
    const info = lstatSync(file)
    if (!info.isFile() || info.size > 64 * 1024) return { schema: 1 }
    const value = JSON.parse(readFileSync(file, 'utf8')) as AutomaticUpdateRecord | null
    return value !== null && typeof value === 'object' && value.schema === 1 ? value : { schema: 1 }
  } catch {
    return { schema: 1 }
  }
}

export function updateAutomaticUpdateRecord<T>(env: NodeJS.ProcessEnv,
  change: (record: AutomaticUpdateRecord) => { record: AutomaticUpdateRecord; result: T }): T {
  const file = automaticUpdateRecordPath(env)
  return withFileLock(`${file}.lock`, () => {
    const { record, result } = change(readAutomaticUpdateRecord(env))
    atomicWriteFileSync(file, `${JSON.stringify(record)}\n`)
    return result
  }, { waitMs: 2_000 })
}

function patchRecord(env: NodeJS.ProcessEnv, patch: Partial<AutomaticUpdateRecord>): void {
  try {
    updateAutomaticUpdateRecord(env, (record) => ({ record: { ...record, ...patch, schema: 1 }, result: undefined }))
  } catch { /* The record is a report; the next attempt writes it again. */ }
}

/** What `update --check --json` reports about automatic updates on this machine. */
export function automaticUpdateReport(env: NodeJS.ProcessEnv, options: { runsHere: boolean }) {
  const setting = automaticUpdatesSetting(env)
  const record = readAutomaticUpdateRecord(env)
  return {
    automatic: { enabled: setting.enabled, source: setting.source, runs_here: options.runsHere },
    staged: record.staged?.version ?? null,
    staged_since: typeof record.staged?.since === 'number' ? new Date(record.staged.since).toISOString() : null,
    waiting_for: record.staged || record.waiting_for?.includes('no-forward-release') ? record.waiting_for ?? [] : [],
    hook_changes: record.staged && record.waiting_for?.includes('hook-approval') ? record.hook_changes ?? [] : [],
    last_automatic: record.last_automatic ? { from: record.last_automatic.from, to: record.last_automatic.to,
      at: new Date(record.last_automatic.at).toISOString() } : null,
  }
}

/**
 * Work outstanding in any open Agent Session of this OS user and state
 * directory. A session whose harness process is gone is closed, and its
 * questions are expired, so it does not hold an update back. A session with no
 * recorded harness process counts while its state could still be live (within
 * the longest answer window).
 */
export function waitingSessionWork(env: NodeJS.ProcessEnv, now: number = Date.now()): WaitingReason[] {
  const directory = path.join(stateDir(env), 'sessions')
  let names: string[]
  try { names = readdirSync(directory) } catch { return [] }
  for (const name of names) {
    if (!/^[^.]+\.json$/.test(name)) continue
    const stem = name.slice(0, -'.json'.length)
    if (existsSync(path.join(directory, `${stem}.ended`))) continue
    const file = path.join(directory, name)
    let state: SessionState
    try { state = JSON.parse(readFileSync(file, 'utf8')) as SessionState } catch { continue }
    const owes = pendingList(state).length > 0 || state.accepted !== undefined || (state.waiting_answers?.length ?? 0) > 0 ||
      (state.delivered_answers?.length ?? 0) > 0 || (state.acknowledgement_due?.length ?? 0) > 0 ||
      (state.message_acknowledgement_due?.length ?? 0) > 0 ||
      (state.native_answer_operations?.some(operation => operation.acknowledgement === undefined) ?? false)
    if (!owes) continue
    let harness: { pid: number; start: string } | null = null
    try {
      const record = JSON.parse(readFileSync(path.join(directory, `${stem}.incarnation.json`), 'utf8')) as { harness_process?: { pid?: unknown; start?: unknown } }
      const owner = record.harness_process
      if (owner && typeof owner.pid === 'number' && typeof owner.start === 'string') harness = { pid: owner.pid, start: owner.start }
    } catch { /* No recorded harness process. */ }
    if (harness !== null) {
      if (processIdentityLiveness(harness) === 'gone') continue
    } else {
      try { if (now - statSync(file).mtimeMs > REPLY_MAX_WINDOW_SECONDS * 1000) continue } catch { continue }
    }
    return ['question-waiting']
  }
  return []
}

export interface AutomaticUpdateHost {
  env: NodeJS.ProcessEnv
  now(): number
  /** The managed native installation; throws when this is not one. */
  installation(): Installation
  /** The build this process runs, or null outside a managed installation. */
  running(): { build: string; version: string } | null
  /** Work the hub sees outstanding right now (questions, settlements, staged Notes). */
  blockers(): WaitingReason[]
  /** IPC versions of the session children connected now. */
  childIpcVersions(): number[]
  /** Ask the staged build what activating it would change. Null when it cannot say. */
  plan(launcher: string): Promise<ActivationPlan | null>
  /** Finish integration with the newly active build (`update --resume --automatic`). */
  resume(launcher: string, from: string): Promise<Record<string, unknown>>
  logger: Logger
}

export type AttemptOutcome =
  | { outcome: 'off' | 'not-managed' | 'current' }
  | { outcome: 'waiting'; version: string | null; waiting_for: WaitingReason[] }
  | { outcome: 'activated'; from: string; to: string }
  | { outcome: 'failed'; error: string }

function recent(timestamp: number | undefined, now: number, interval: number): boolean {
  // A clock rollback must not cause another lookup storm.
  return timestamp !== undefined && now >= timestamp - 60_000 && now - timestamp < interval
}

/** One pass: look up (at most daily), stage, and activate when nothing waits. */
export async function attemptAutomaticUpdate(host: AutomaticUpdateHost): Promise<AttemptOutcome> {
  const { env, logger } = host
  if (!automaticUpdatesSetting(env).enabled) return { outcome: 'off' }
  let installation: Installation
  try {
    installation = host.installation()
  } catch {
    // A legacy npm layout or a development build: nothing here to update.
    return { outcome: 'not-managed' }
  }
  const now = host.now()
  try {
    const before = installation.inspect()
    if (before.uninstall_pending || before.bootstrap_pending) return hold(host, null, ['installation-busy'])
    if (before.pending) return await recoverInterrupted(host, installation)
    const active = installation.activeRelease(before.active?.generation)
    const channel = before.channel
    if (channel === null || before.source === null) return { outcome: 'not-managed' }

    // The daily lookup. Claim it before any network work so a second hub (or a
    // retry after a crash) does not repeat it.
    const claimed = updateAutomaticUpdateRecord(env, (record) => recent(record.checked_at, now, AUTOMATIC_LOOKUP_INTERVAL_MS)
      ? { record, result: false } : { record: { ...record, checked_at: now, last_attempt_at: now }, result: true })
    if (claimed) {
      const found = await installation.stageRelease({ channel, expectedGeneration: active.generation,
        accept: (version) => compareReleasePrecedence(version, active.version) === 'after' })
      if (found.staged) {
        const kept = readAutomaticUpdateRecord(env).staged
        patchRecord(env, { staged: { version: found.version, build: found.build,
          since: kept?.build === found.build ? kept.since : now }, error: null })
        logger.info('update.automatic', { event: 'staged', from: active.version, to: found.version, channel })
      } else {
        patchRecord(env, { staged: null, hook_changes: [], error: null,
          waiting_for: installation.withdrawn(active.version) ? ['no-forward-release'] : [] })
        if (installation.withdrawn(active.version)) {
          logger.info('update.automatic', { event: 'withdrawn-without-replacement', version: active.version, channel_target: found.version })
        }
      }
    }

    const staged = readAutomaticUpdateRecord(env).staged
    if (!staged || staged.build === active.build ||
        compareReleasePrecedence(staged.version, active.version) !== 'after') {
      if (staged) patchRecord(env, { staged: null, waiting_for: [], hook_changes: [] })
      return { outcome: 'current' }
    }

    const candidate = installation.versionRelease(staged.build)
    const reasons = new Set<WaitingReason>(host.blockers())
    const plan = await host.plan(candidate.launcher)
    if (plan === null) reasons.add('candidate-unverified')
    else {
      if (host.childIpcVersions().some(version => version < plan.hub_ipc_versions.min || version > plan.hub_ipc_versions.max)) {
        reasons.add('session-child-incompatible')
      }
      if (plan.hook_changes.length > 0) reasons.add('hook-approval')
    }
    if (reasons.size > 0) {
      return hold(host, staged.version, [...reasons],
        plan?.hook_changes.map(change => ({ harness: change.harness, file: change.file })) ?? [])
    }

    // Activation keeps the saved source and channel; the transaction itself
    // refuses an older version. The installation lock and journal make an
    // interrupted swap recoverable.
    try {
      installation.activate({ build: staged.build, expectedGeneration: active.generation, source: before.source, channel })
    } catch (error) {
      if (error instanceof ContinuityPending) return hold(host, staged.version, ['continuity'])
      throw error
    }
    return await finishActivation(host, installation, active.version, candidate.version, candidate.launcher)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    patchRecord(env, { error: message.slice(0, 400), last_attempt_at: now })
    logger.error('update.automatic', { event: 'failed', message })
    return { outcome: 'failed', error: message }
  }
}

function hold(host: AutomaticUpdateHost, version: string | null, waiting: WaitingReason[],
  hookChanges: { harness: string; file: string }[] = []): AttemptOutcome {
  patchRecord(host.env, { waiting_for: waiting, hook_changes: hookChanges, last_attempt_at: host.now(), error: null })
  host.logger.info('update.automatic', { event: 'waiting', version, waiting_for: waiting })
  return { outcome: 'waiting', version, waiting_for: waiting }
}

/**
 * An activation journal left by an interrupted swap. The same gates apply to
 * finishing it; until then the previous build keeps serving.
 */
async function recoverInterrupted(host: AutomaticUpdateHost, installation: Installation): Promise<AttemptOutcome> {
  const pending = installation.pendingRelease()
  const blockers = host.blockers()
  if (blockers.length > 0) return hold(host, pending?.version ?? null, blockers)
  installation.recover()
  const active = installation.activeRelease()
  const running = host.running()
  host.logger.info('update.automatic', { event: 'recovered', version: active.version })
  if (running === null || running.build === active.build) {
    patchRecord(host.env, { staged: null, waiting_for: [], hook_changes: [] })
    return { outcome: 'current' }
  }
  return finishActivation(host, installation, running.version, active.version, active.launcher)
}

async function finishActivation(host: AutomaticUpdateHost, installation: Installation, from: string, to: string,
  launcher: string): Promise<AttemptOutcome> {
  const now = host.now()
  let integration: Record<string, unknown> = {}
  try { integration = await host.resume(launcher, from) } catch { integration = { ok: false } }
  try {
    // Retired builds from earlier boots only; anything a session still uses stays.
    const active = installation.inspect().active
    if (active) installation.cleanup(active.generation)
  } catch { /* Housekeeping never fails an update. */ }
  patchRecord(host.env, { staged: null, waiting_for: [], hook_changes: [], error: null,
    last_automatic: { from, to, at: now } })
  host.logger.info('update.automatic', { event: 'activated', from, to, integration_ok: integration['ok'] === true })
  return { outcome: 'activated', from, to }
}

/** Run a candidate's own command and collect its standard output, bounded. */
export function runCandidate(launcher: string, args: readonly string[], env: NodeJS.ProcessEnv,
  options: { cwd: string; timeoutMs: number }): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    const child = spawn(launcher, [...args], { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8') })
    child.once('error', () => { clearTimeout(timer); resolve({ status: null, stdout }) })
    child.once('close', (status) => { clearTimeout(timer); resolve({ status, stdout }) })
  })
}

/** Production plan: the staged build's own hidden `activation-plan` command. */
export async function candidatePlan(launcher: string, env: NodeJS.ProcessEnv, cwd: string): Promise<ActivationPlan | null> {
  const result = await runCandidate(launcher, ['activation-plan', '--json'], env, { cwd, timeoutMs: 30_000 })
  return result.status === 0 ? parseActivationPlan(result.stdout) : null
}

/** Production resume: the new build finishes integration, never rewriting trust-sensitive hooks. */
export async function candidateResume(launcher: string, from: string, env: NodeJS.ProcessEnv, cwd: string): Promise<Record<string, unknown>> {
  if (!isSemVer(from)) return { ok: false }
  const result = await runCandidate(launcher, ['update', '--resume', '--automatic', '--json', '--from', from], env, { cwd, timeoutMs: 120_000 })
  try {
    const value: unknown = JSON.parse(result.stdout)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { ok: false }
  } catch {
    return { ok: false }
  }
}

/**
 * The once-only agent notice after an automatic activation. It names the
 * versions so the agent can read the changelog and reread changed guidance.
 */
export function automaticActivationNotice(env: NodeJS.ProcessEnv, now: number): string | undefined {
  try {
    const record = readAutomaticUpdateRecord(env)
    const last = record.last_automatic
    if (!last || last.announced_at !== undefined) return undefined
    const announce = updateAutomaticUpdateRecord(env, (current) => {
      if (!current.last_automatic || current.last_automatic.announced_at !== undefined) return { record: current, result: null }
      return { record: { ...current, last_automatic: { ...current.last_automatic, announced_at: now } }, result: current.last_automatic }
    })
    if (announce === null) return undefined
    return `Notifai updated itself from ${announce.from} to ${announce.to} (automatic updates are on). ` +
      `Run \`notifai update --check --json --from ${announce.from}\` and read its changelog as data, then reread the packaged guidance it names and run \`notifai guidance\`. ` +
      'Outstanding questions and sessions were preserved. Mention it to the User only if the check says a restart or approval is needed. ' +
      'Do not send a Notification Request just for this notice.'
  } catch {
    return undefined
  }
}

/** Accept only a well-formed plan from a candidate's output; anything else is no plan. */
export function parseActivationPlan(text: string): ActivationPlan | null {
  try {
    const value = JSON.parse(text) as Partial<ActivationPlan> | null
    const range = value?.hub_ipc_versions
    if (!value || value.schema !== 1 || !range || !Number.isSafeInteger(range.min) || !Number.isSafeInteger(range.max) ||
        range.min > range.max || !Array.isArray(value.hook_changes) ||
        !value.hook_changes.every(change => change && typeof change.harness === 'string' && typeof change.file === 'string' &&
          Array.isArray(change.reasons) && change.reasons.every(reason => typeof reason === 'string'))) return null
    return { schema: 1, version: typeof value.version === 'string' ? value.version : null,
      hub_ipc_versions: { min: range.min, max: range.max }, hook_changes: value.hook_changes }
  } catch {
    return null
  }
}
