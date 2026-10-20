/**
 * What a hub needs to take over a session that no session child will bring
 * back, written where it survives the hub.
 *
 * A conversation its app or the machine stopped, or one whose end was still
 * being decided, has no child: nothing re-registers it with the next hub. The
 * hub that attends it writes this record into the session's attendance status
 * (`adoption`), and the next hub, whatever ended the previous one (a
 * handover, a crash, a reboot), adopts every such session at start. A status
 * without the record is rebuilt from the session's incarnation and its
 * recorded rollout.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { stateDir } from './config.js'
import { codexHomeOfRollout, locateCodexRollout } from './codex-session-end.js'
import { claimHolderMayRun, readClaimFile } from './hook-question-lock.js'
import { endsIncarnation, readSessionEndMarker, readSessionIncarnation, readSessionState } from './hook-session-state.js'
import { childLockPath, writerLockPath } from './hub-ipc.js'
import { pidExists, processIdentityLiveness, type ProcessIdentity } from './process-identity.js'
import { attendantClaimPath } from './session-attendant-state.js'
import { parseLaunchRecord, type LaunchRecord } from './session-reopen.js'
import type { SessionPlace } from './session-place.js'

const PLACES: ReadonlySet<string> = new Set<SessionPlace>(['terminal', 'claude-desktop', 'claude-ide', 'claude-background', 'orca-chat',
  'headless', 'unknown', 'unreported', 'codex-app', 'codex-ide', 't3'])

/** Which process quitting, while a conversation is stopped, means the User quit its app: the harness (an app-server) or the app that started it. */
export type StoppedWatch = 'harness' | 'host-app' | null

export interface StoppedRecord {
  since: number
  cause: 'app' | 'machine'
  boot: string | null
  watch: StoppedWatch
}

export interface AdoptionRecord {
  harness: 'claude-code' | 'codex'
  harness_process: ProcessIdentity
  harness_ticks: string | null
  boot: string | null
  cwd: string | null
  transcript_path: string | null
  claude_config_dir: string | null
  codex_home: string | null
  /** Wall-clock milliseconds of the last hook the hub saw for it (the idle stop of Orca chats and T3 Code); null when unknown. */
  last_activity_at: number | null
  /** The rollout existed at some point, so its absence means an archive or delete. */
  transcript_seen: boolean
  /**
   * Wall-clock milliseconds an end signal arrived that the hub was still
   * confirming; null when none was pending. The next hub confirms it.
   */
  end_candidate_since: number | null
  /** Where the conversation ran; `unreported` when it was not recorded. */
  place: SessionPlace
  /** The process that started the harness (the Claude desktop app, T3 Code's server, Orca's supervisor), when known. */
  host_app: ProcessIdentity | null
  /** An Orca pane's terminal host, when the harness ran in one. */
  terminal_host: ProcessIdentity | null
  /**
   * Stopped by its app or by the machine, not closed by the User (wall-clock
   * milliseconds, and the boot it stopped in): the next hub keeps it open for
   * its windows. Null while it is not stopped.
   */
  stopped: StoppedRecord | null
  /** How the harness was started, for a terminal: what a reopen runs (see `session-reopen.ts`). */
  launch: LaunchRecord | null
}

function processOf(value: unknown): ProcessIdentity | null {
  if (typeof value !== 'object' || value === null) return null
  const owner = value as Record<string, unknown>
  return typeof owner['pid'] === 'number' && Number.isSafeInteger(owner['pid']) && owner['pid'] > 1 && text(owner['start']) !== null
    ? { pid: owner['pid'], start: owner['start'] as string } : null
}

function stoppedOf(value: unknown): AdoptionRecord['stopped'] {
  if (typeof value !== 'object' || value === null) return null
  const stopped = value as Record<string, unknown>
  const since = stopped['since']
  const cause = stopped['cause']
  if (typeof since !== 'number' || !Number.isFinite(since) || (cause !== 'app' && cause !== 'machine')) return null
  const watch = stopped['watch']
  return { since, cause, boot: text(stopped['boot']), watch: watch === 'harness' || watch === 'host-app' ? watch : null }
}

const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : null
const absolute = (value: unknown): string | null => {
  const candidate = text(value)
  return candidate !== null && path.isAbsolute(candidate) ? candidate : null
}

/** A well-formed record from a status file, or null. */
export function parseAdoptionRecord(value: unknown): AdoptionRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const harness = record['harness']
  const owner = record['harness_process'] as Record<string, unknown> | null | undefined
  if ((harness !== 'claude-code' && harness !== 'codex') || typeof owner !== 'object' || owner === null ||
      typeof owner['pid'] !== 'number' || !Number.isSafeInteger(owner['pid']) || owner['pid'] <= 1 || text(owner['start']) === null) return null
  const ticks = text(record['harness_ticks'])
  const activity = record['last_activity_at']
  const candidate = record['end_candidate_since']
  return {
    harness,
    harness_process: { pid: owner['pid'], start: owner['start'] as string },
    harness_ticks: ticks !== null && /^\d{1,30}$/.test(ticks) ? ticks : null,
    boot: text(record['boot']),
    cwd: absolute(record['cwd']),
    transcript_path: absolute(record['transcript_path']),
    claude_config_dir: absolute(record['claude_config_dir']),
    codex_home: absolute(record['codex_home']),
    last_activity_at: typeof activity === 'number' && Number.isFinite(activity) ? activity : null,
    transcript_seen: record['transcript_seen'] === true,
    end_candidate_since: typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null,
    place: typeof record['place'] === 'string' && PLACES.has(record['place']) ? record['place'] as SessionPlace : 'unreported',
    host_app: processOf(record['host_app']),
    terminal_host: processOf(record['terminal_host']),
    stopped: stoppedOf(record['stopped']),
    launch: parseLaunchRecord(record['launch']),
  }
}

/**
 * The record for one session, from its attendance status: the one the hub
 * wrote, or, for a status an earlier hub wrote, one rebuilt from local
 * records. Null when it cannot be rebuilt: without a recorded rollout an
 * archive, and the app a thread belongs to, cannot be told.
 */
export function adoptionRecord(env: NodeJS.ProcessEnv, sessionId: string, status: Record<string, unknown>): AdoptionRecord | null {
  const written = parseAdoptionRecord(status['adoption'])
  if (written !== null) return written
  const incarnation = readSessionIncarnation(sessionId, env)
  const state = readSessionState(sessionId, env)
  if (incarnation?.harness_process === undefined || state.harness !== 'codex') return null
  const turn = state.codex_native_turn
  const transcript = turn !== undefined && turn.key === incarnation.key ? absolute(turn.transcript_path) : null
  if (transcript === null) return null
  return {
    harness: 'codex',
    harness_process: incarnation.harness_process,
    harness_ticks: null,
    boot: incarnation.boot ?? null,
    cwd: absolute(state.activation_cwd),
    transcript_path: transcript,
    claude_config_dir: null,
    codex_home: codexHomeOfRollout(transcript),
    last_activity_at: null,
    // The native turn was read from that rollout.
    transcript_seen: true,
    end_candidate_since: null,
    place: 'unreported',
    host_app: null,
    terminal_host: null,
    stopped: null,
    launch: null,
  }
}

/**
 * Whether a session child still runs for this session and harness process:
 * it writes `<pid> <harness pid>` into its locks, which it holds for life. A
 * live child has its own kernel watch, reconnects to whichever hub runs, and
 * reports the end itself.
 */
export function childWatching(env: NodeJS.ProcessEnv, sessionId: string, harnessPid: number): boolean {
  return [writerLockPath(env, sessionId, harnessPid), childLockPath(env, sessionId)].some((file) => {
    try {
      const [child, harness] = readFileSync(file, 'utf8').trim().split(' ').map(Number)
      return harness === harnessPid && child !== undefined && pidExists(child)
    } catch {
      return false
    }
  })
}

export interface AdoptionCandidate {
  sessionId: string
  status: Record<string, unknown>
  /** Null: this build cannot rebuild what the earlier hub held for it. */
  record: AdoptionRecord | null
}

/** Every attendance status on this machine, parsed. */
export function attendanceStatuses(env: NodeJS.ProcessEnv): { sessionId: string; status: Record<string, unknown> }[] {
  const directory = path.join(stateDir(env), 'sessions')
  let names: string[]
  try { names = readdirSync(directory).filter((name) => name.endsWith('.attendance.json')) } catch { return [] }
  const statuses: { sessionId: string; status: Record<string, unknown> }[] = []
  for (const name of names) {
    try {
      const status = JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as Record<string, unknown>
      if (typeof status === 'object' && status !== null && typeof status['session_id'] === 'string') statuses.push({ sessionId: status['session_id'], status })
    } catch { /* A half-written or foreign file is not a status. */ }
  }
  return statuses
}

/**
 * Codex sessions a hub attended that no child will bring back: the status
 * says a hub attended this exact incarnation and nobody holds its claim now,
 * the session has not ended, its host still runs, and no child watches it.
 * (A session whose host is gone is the sweep's: it reports the end.)
 */
export function adoptionCandidates(env: NodeJS.ProcessEnv): AdoptionCandidate[] {
  const candidates: AdoptionCandidate[] = []
  for (const { sessionId, status } of attendanceStatuses(env)) {
    if (status['phase'] === 'exited' || typeof status['incarnation'] !== 'string') continue
    const claim = readClaimFile(attendantClaimPath(sessionId, env))
    if (claim !== null && claimHolderMayRun(claim)) continue
    const incarnation = readSessionIncarnation(sessionId, env)
    if (incarnation === null || incarnation.incarnation !== status['incarnation'] || incarnation.harness_process === undefined) continue
    if (endsIncarnation(readSessionEndMarker(sessionId, env), incarnation)) continue
    const record = adoptionRecord(env, sessionId, status)
    if ((record?.harness ?? readSessionState(sessionId, env).harness) !== 'codex') continue
    if (processIdentityLiveness(incarnation.harness_process) === 'gone') continue
    if (childWatching(env, sessionId, incarnation.harness_process.pid)) continue
    candidates.push({ sessionId, status, record })
  }
  return candidates
}

/**
 * Conversations a hub stopped (their app paused, unloaded or idled them out,
 * or the machine went down) that are still owed something: the next hub keeps
 * them open until they come back in place or their windows end. The status
 * reads `exited` (`reason: stopped`) so a hub from an earlier build leaves it alone.
 */
export function stoppedCandidates(env: NodeJS.ProcessEnv): { sessionId: string; status: Record<string, unknown>; record: AdoptionRecord }[] {
  const candidates: { sessionId: string; status: Record<string, unknown>; record: AdoptionRecord }[] = []
  for (const { sessionId, status } of attendanceStatuses(env)) {
    if (status['phase'] !== 'exited' || status['reason'] !== 'stopped' || typeof status['incarnation'] !== 'string') continue
    const record = parseAdoptionRecord(status['adoption'])
    if (record === null || record.stopped === null) continue
    const claim = readClaimFile(attendantClaimPath(sessionId, env))
    if (claim !== null && claimHolderMayRun(claim)) continue
    const incarnation = readSessionIncarnation(sessionId, env)
    if (incarnation === null || incarnation.incarnation !== status['incarnation']) continue
    if (endsIncarnation(readSessionEndMarker(sessionId, env), incarnation)) continue
    candidates.push({ sessionId, status, record })
  }
  return candidates
}

/**
 * A recorded Codex rollout that existed and is gone: the conversation was
 * archived or deleted (Codex runs no SessionEnd for that).
 */
export function recordedRolloutArchived(env: NodeJS.ProcessEnv, sessionId: string, status: Record<string, unknown>): boolean {
  const record = adoptionRecord(env, sessionId, status)
  if (record === null || record.harness !== 'codex' || !record.transcript_seen) return false
  const place = locateCodexRollout(record.codex_home, sessionId, record.transcript_path).place
  return place === 'archived' || place === 'missing'
}
