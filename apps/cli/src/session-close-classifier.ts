/**
 * Positive close evidence is required to discard waiting work. Process loss,
 * missing or unreadable files, and idle timing cannot prove a User close.
 * Unconfirmed stops use the existing stopped-session path; it may end only
 * after nothing waits, or after explicit archival/continuation evidence.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { codexAppSurface, type RolloutPlace } from './codex-session-end.js'
import type { ClaudePlace, CodexHostKind, SessionPlace } from './session-place.js'

/** Read at most this much of the desktop app's log, from its end. */
const DESKTOP_LOG_TAIL_BYTES = 512 * 1024
/** A pause line this much before the end signal still explains it (the log has whole seconds). */
const PAUSE_LINE_SLACK_MS = 60_000
/** The desktop app's session records are small; a larger file is not one. */
const DESKTOP_RECORD_MAX_BYTES = 1024 * 1024
const DESKTOP_RECORD_SCAN_LIMIT = 5_000

/**
 * Orca chats and T3 Code stop a conversation this long after its last
 * activity (Orca sweeps every five minutes, so its stop lands at 30–35).
 */
export const APP_IDLE_STOP_MS = 30 * 60_000

export type AppStopReason = 'desktop-paused' | 'app-unloaded' | 'ide-unloaded' | 'idle-stopped' | 'terminal-host-died' | 'unconfirmed-stop'

export type CloseVerdict = { cause: 'app'; reason: AppStopReason } | { cause: 'user'; reason: string }

/** Liveness of a process recorded at registration; null when none was recorded. */
export type Recorded = 'alive' | 'gone' | null

/**
 * The 30-minute idle stop of an Orca chat or T3 Code: the app still runs and
 * the stop came at least `APP_IDLE_STOP_MS` after the conversation's last
 * activity. Null when the place does not stop idle conversations.
 */
function appIdleStop(place: SessionPlace, hostApp: Recorded, idleMs: number | null): CloseVerdict | null {
  if (place !== 'orca-chat' && place !== 't3') return null
  if (hostApp !== 'alive') return { cause: 'app', reason: 'unconfirmed-stop' }
  if (idleMs === null || idleMs < APP_IDLE_STOP_MS) return { cause: 'app', reason: 'unconfirmed-stop' }
  return { cause: 'app', reason: 'idle-stopped' }
}

/** Losing a pane host explains a stop; a surviving host does not prove a close. */
function terminalHostVerdict(terminalHost: Recorded | undefined): CloseVerdict | null {
  if (terminalHost === 'gone') return { cause: 'app', reason: 'terminal-host-died' }
  if (terminalHost === 'alive') return { cause: 'app', reason: 'unconfirmed-stop' }
  return null
}

export type DesktopRecord = { localId: string; archived: boolean } | 'missing' | 'unreadable'

export interface ClaudeEndEvidence {
  place: ClaudePlace
  /** The conversation's transcript still exists (a deleted conversation is closed). */
  transcript: 'present' | 'missing'
  /** An Orca terminal pane's terminal host, when the conversation ran in one. */
  terminalHost?: Recorded
  /** An Orca chat: the app process that started the harness. */
  hostApp?: Recorded
  /** From the conversation's last activity the hub saw to its end; null when unknown. */
  idleMs?: number | null
  /** Only for a conversation in the Claude desktop app. */
  desktop?: {
    /** The app process that hosted the conversation still runs. */
    appAlive: boolean
    record: DesktopRecord
    /** The app's log names a pause or eviction of this conversation around the end. */
    pauseLogged: boolean
  }
}

/** The verdict for one end the confirmation did not cancel. */
export function classifyClaudeEnd(evidence: ClaudeEndEvidence): CloseVerdict {
  if (evidence.transcript === 'missing') return { cause: 'app', reason: 'unconfirmed-stop' }
  const idle = appIdleStop(evidence.place, evidence.hostApp ?? null, evidence.idleMs ?? null)
  if (idle !== null) return idle
  const pane = evidence.place === 'terminal' || evidence.place === 'unreported' ? terminalHostVerdict(evidence.terminalHost) : null
  if (pane !== null) return pane
  if (evidence.place !== 'claude-desktop') return { cause: 'app', reason: 'unconfirmed-stop' }
  const desktop = evidence.desktop
  if (desktop === undefined || !desktop.appAlive) return { cause: 'app', reason: 'unconfirmed-stop' }
  if (desktop.record === 'missing') return { cause: 'app', reason: 'unconfirmed-stop' }
  if (desktop.record === 'unreadable') return { cause: 'app', reason: 'unconfirmed-stop' }
  if (desktop.record.archived) return { cause: 'user', reason: 'archived' }
  // The Stop button and the app's own pause both leave the app running and
  // the conversation listed: only the app's log tells them apart.
  if (!desktop.pauseLogged) return { cause: 'app', reason: 'unconfirmed-stop' }
  return { cause: 'app', reason: 'desktop-paused' }
}

export interface CodexEndEvidence {
  place: SessionPlace
  /** Where the thread's rollout is now, found by its id. */
  rollout: RolloutPlace
  /** The process that hosted the thread (an app-server, a terminal, the shared server). */
  host: 'alive' | 'gone'
  hostKind: CodexHostKind
  /** The rollout's recorded originator: the app the thread was born in; null when it cannot be read. */
  originator: string | null
  /** The app process that started the app-server (T3 Code's server, Orca's provider supervisor). */
  hostApp: Recorded
  /** From the conversation's last activity the hub saw to its end; null when unknown. */
  idleMs: number | null
  /** An Orca terminal pane's terminal host, when the thread ran in one. */
  terminalHost: Recorded
}

/** Archive and scripted completion are positive evidence; other losses are stops. */
export function classifyCodexEnd(evidence: CodexEndEvidence): CloseVerdict {
  if (evidence.rollout === 'archived') return { cause: 'user', reason: 'archived' }
  if (evidence.rollout === 'missing') return { cause: 'app', reason: 'unconfirmed-stop' }
  if (evidence.rollout === 'unknown') return { cause: 'app', reason: 'unconfirmed-stop' }
  if (evidence.place === 'headless') return { cause: 'user', reason: 'run-ended' }
  const idle = appIdleStop(evidence.place, evidence.hostApp, evidence.idleMs)
  if (idle !== null) return idle
  if (evidence.host === 'gone') {
    const pane = evidence.place === 'terminal' ? terminalHostVerdict(evidence.terminalHost) : null
    return pane ?? { cause: 'app', reason: 'unconfirmed-stop' }
  }
  const surface = codexAppSurface(evidence.originator)
  if (surface !== null && evidence.hostKind === 'app-server') return { cause: 'app', reason: surface === 'app' ? 'app-unloaded' : 'ide-unloaded' }
  return { cause: 'app', reason: 'unconfirmed-stop' }
}

/**
 * Whether a session that was attended in an earlier boot was stopped by the
 * machine going down. `endedAt` is when its harness was seen to exit (a
 * session child's end record), or null when nothing recorded an exit before
 * the boot ended (power loss, a crash, a hard reboot).
 */
export function machineDownEarlierBoot(input: {
  recordedBoot: string | null | undefined
  currentBoot: string | null
  endedAt: number | null
  /** The hub was still confirming its end when it was terminated. */
  endPending: boolean
  /** The machine said it was going down (`shutdownMarker`), in some boot. */
  shutdown: { boot: string; since: number } | null
}): boolean {
  const { recordedBoot, currentBoot } = input
  if (currentBoot === null || recordedBoot === null || recordedBoot === undefined || recordedBoot === currentBoot) return false
  if (input.endedAt === null || input.endPending) return true
  return input.shutdown !== null && input.shutdown.boot === recordedBoot && input.endedAt >= input.shutdown.since
}

// -- the Claude desktop app's own records (read-only) -------------------------

/** Where the desktop app keeps its Code-tab sessions and its log, under the account home. */
export function claudeDesktopPaths(home: string): { sessions: string; log: string } {
  return {
    sessions: path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
    log: path.join(home, 'Library', 'Logs', 'Claude', 'main.log'),
  }
}

/**
 * The desktop app's record of a Claude Code conversation: its own session id
 * (`local_<uuid>`) and whether it is archived. `<root>/<account>/<org>/local_*.json`
 * with `cliSessionId` naming the conversation.
 */
export function readClaudeDesktopRecord(root: string, sessionId: string): DesktopRecord {
  let accounts: string[]
  try { accounts = readdirSync(root) } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
  }
  let scanned = 0
  for (const account of accounts) {
    let orgs: string[]
    try { orgs = readdirSync(path.join(root, account)) } catch { continue }
    for (const org of orgs) {
      let names: string[]
      try { names = readdirSync(path.join(root, account, org)).filter((name) => /^local_[A-Za-z0-9-]+\.json$/.test(name)) } catch { continue }
      for (const name of names) {
        if (++scanned > DESKTOP_RECORD_SCAN_LIMIT) return 'unreadable'
        const file = path.join(root, account, org, name)
        let record: Record<string, unknown>
        try {
          if (statSync(file).size > DESKTOP_RECORD_MAX_BYTES) continue
          record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        } catch { continue }
        if (typeof record !== 'object' || record === null || record['cliSessionId'] !== sessionId) continue
        const localId = typeof record['sessionId'] === 'string' && /^local_[A-Za-z0-9-]+$/.test(record['sessionId'])
          ? record['sessionId'] : name.slice(0, -'.json'.length)
        return { localId, archived: record['isArchived'] === true }
      }
    }
  }
  return 'missing'
}

/** A log line's local timestamp (`2026-03-26 16:17:37 [info] …`), or null. */
function logLineTime(line: string): number | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(line)
  if (matched === null) return null
  const [, y, mo, d, h, mi, s] = matched.map(Number) as [number, number, number, number, number, number, number]
  const time = new Date(y, mo - 1, d, h, mi, s).getTime()
  return Number.isFinite(time) ? time : null
}

/**
 * Whether the desktop app logged a pause (`[CCD] Pausing session local_<id> …`)
 * or a governor eviction (`[CliGovernor] … evicting local_<id>`) of this
 * conversation from `PAUSE_LINE_SLACK_MS` before `since` up to `now`.
 * Unreadable or missing: false.
 */
export function claudeDesktopPauseLogged(logFile: string, localId: string, since: number, now: number): boolean {
  let text: string
  try {
    const fd = openSync(logFile, 'r')
    try {
      const size = statSync(logFile).size
      const length = Math.min(size, DESKTOP_LOG_TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      text = buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
  for (const line of text.split('\n')) {
    if (!line.includes(localId)) continue
    const paused = line.includes(`Pausing session ${localId}`) || (line.includes('CliGovernor') && /evict/i.test(line))
    if (!paused) continue
    const at = logLineTime(line)
    if (at !== null && at >= since - PAUSE_LINE_SLACK_MS && at <= now + 5_000) return true
  }
  return false
}

/**
 * Whether a Claude Code conversation's transcript exists: the recorded path,
 * or `<config>/projects/<any>/<id>.jsonl` (a resume from another folder names
 * a path that does not exist). A projects directory that cannot be read is
 * no evidence of a delete.
 */
export function claudeTranscriptPresent(configDir: string, sessionId: string, recorded: string | null): boolean {
  if (recorded !== null) {
    try { if (statSync(recorded).isFile()) return true } catch { /* look by id */ }
  }
  let projects: string[]
  try { projects = readdirSync(path.join(configDir, 'projects')) } catch (err) { return (err as NodeJS.ErrnoException).code !== 'ENOENT' }
  for (const project of projects) {
    try { if (statSync(path.join(configDir, 'projects', project, `${sessionId}.jsonl`)).isFile()) return true } catch { /* next */ }
  }
  return false
}

/** The first lines of a forked transcript carry its parent's id; read no further than this. */
const FORK_HEAD_BYTES = 256 * 1024

/**
 * The conversation a Claude Code fork copied its history from, when the fork
 * recorded it: `/branch` writes `forkedFrom.sessionId` on every copied line.
 * A `--fork-session` fork rewrites its copied lines to its own id and records
 * no parent, so it names none here. Null when the transcript cannot be read
 * yet (Claude Code creates it at the first prompt) or names no other conversation.
 */
export function claudeForkParent(transcriptPath: string | null, sessionId: string): string | null {
  if (transcriptPath === null) return null
  let text: string
  try {
    const fd = openSync(transcriptPath, 'r')
    try {
      const buffer = Buffer.alloc(FORK_HEAD_BYTES)
      const read = readSync(fd, buffer, 0, buffer.length, 0)
      text = buffer.subarray(0, read).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  const lines = text.split('\n')
  // A last line cut by the read limit is not evidence.
  if (text.length >= FORK_HEAD_BYTES) lines.pop()
  for (const line of lines) {
    if (line.trim() === '') continue
    let record: unknown
    try { record = JSON.parse(line) } catch { continue }
    if (typeof record !== 'object' || record === null) continue
    const origin = (record as Record<string, unknown>)['forkedFrom']
    if (typeof origin !== 'object' || origin === null) continue
    const named = (origin as Record<string, unknown>)['sessionId']
    if (typeof named !== 'string' || named === '') continue
    return named !== sessionId && /^[0-9A-Za-z-]{1,128}$/.test(named) ? named : null
  }
  return null
}
