/**
 * Who ended a Claude Code conversation: the User, its app, or the machine.
 *
 * A close by the User expires the conversation's questions. A stop the User
 * did not make keeps them open for their own window, and what is answered
 * meanwhile reaches the conversation when it comes back in place:
 *
 * - **the app**: the Claude desktop app pauses or evicts a conversation it
 *   still lists (an idle pause, its process cap, memory pressure). Its own
 *   log names the pause; without that line, or with the log unreadable, the
 *   stop is taken for the User's.
 * - **the machine**: a shutdown, restart, crash or power loss. Recognised by a
 *   different boot at the next start, with the end still pending, never
 *   reported, or recorded after the machine said it was going down.
 *
 * Anything not positively attributed to the app or the machine is the User's
 * close: a missed keep can be asked again, a missed expiry leaves a stale
 * question on the phone.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ClaudePlace } from './session-place.js'

/** Read at most this much of the desktop app's log, from its end. */
const DESKTOP_LOG_TAIL_BYTES = 512 * 1024
/** A pause line this much before the end signal still explains it (the log has whole seconds). */
const PAUSE_LINE_SLACK_MS = 60_000
/** The desktop app's session records are small; a larger file is not one. */
const DESKTOP_RECORD_MAX_BYTES = 1024 * 1024
const DESKTOP_RECORD_SCAN_LIMIT = 5_000

export type CloseVerdict = { cause: 'app'; reason: 'desktop-paused' } | { cause: 'user'; reason: string }

export type DesktopRecord = { localId: string; archived: boolean } | 'missing' | 'unreadable'

export interface ClaudeEndEvidence {
  place: ClaudePlace
  /** The conversation's transcript still exists (a deleted conversation is closed). */
  transcript: 'present' | 'missing'
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
  if (evidence.place !== 'claude-desktop') return { cause: 'user', reason: 'closed' }
  if (evidence.transcript === 'missing') return { cause: 'user', reason: 'transcript-missing' }
  const desktop = evidence.desktop
  if (desktop === undefined || !desktop.appAlive) return { cause: 'user', reason: 'app-quit' }
  if (desktop.record === 'missing') return { cause: 'user', reason: 'deleted' }
  if (desktop.record === 'unreadable') return { cause: 'user', reason: 'record-unreadable' }
  if (desktop.record.archived) return { cause: 'user', reason: 'archived' }
  // The Stop button and the app's own pause both leave the app running and
  // the conversation listed: only the app's log tells them apart.
  if (!desktop.pauseLogged) return { cause: 'user', reason: 'stopped-in-app' }
  return { cause: 'app', reason: 'desktop-paused' }
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
