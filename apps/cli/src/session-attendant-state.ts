/** Local files of the Session Attendant: its exclusive claim and its readable status. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { sanitizeSessionId, stateDir } from './config.js'
import { withFileLock } from './file-lock.js'
import { readSessionIncarnation, updateSessionState } from './hook-session-state.js'
import { claimHolderMayRun, readClaimFile } from './hook-question-lock.js'
import type { AttendantPhase, AttendantStatus } from './session-attendant.js'
import type { SessionActivity } from '@raidiant/notifai-protocol'
import type { DeliveryLease } from './session-delivery.js'

/** One live attendant per Agent Session: PID + process start time + incarnation. */
export function attendantClaimPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.attendant`)
}

export function attendantStatusPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.attendance.json`)
}

export function writeAttendantStatus(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  status: AttendantStatus,
): void {
  atomicWriteFileSync(
    attendantStatusPath(sessionId, env),
    `${JSON.stringify({ session_id: sessionId, pid: process.pid, ...status })}\n`,
  )
}

export interface AttendantReport {
  session_id: string
  phase: AttendantPhase
  /** Whether the recorded attendant process could still be running. */
  alive: boolean
  generation: number | null
  activity: string | null
  reason: string | null
  accepts_messages: boolean
  writer_ready: boolean
  updated_at: number
}

const PHASES: ReadonlySet<string> = new Set<AttendantPhase>([
  'dormant',
  'unsupported',
  'acquiring',
  'attending',
  'waiting-for-lease',
  'uncertain',
  'exited',
])

/**
 * Every attendant status on this machine, newest first. An attendant whose
 * process is gone without writing `exited` is reported as not alive.
 */
export function listAttendantReports(env: NodeJS.ProcessEnv): AttendantReport[] {
  const directory = path.join(stateDir(env), 'sessions')
  if (!existsSync(directory)) return []
  const reports: AttendantReport[] = []
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.attendance.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as Record<string, unknown>
      const sessionId = parsed['session_id']
      const phase = parsed['phase']
      if (typeof sessionId !== 'string' || typeof phase !== 'string' || !PHASES.has(phase)) continue
      const claim = readClaimFile(attendantClaimPath(sessionId, env))
      const alive =
        phase !== 'exited' && claim !== null && claim['pid'] === parsed['pid'] && claimHolderMayRun(claim)
      reports.push({
        session_id: sessionId,
        phase: phase as AttendantPhase,
        alive,
        generation: typeof parsed['generation'] === 'number' ? parsed['generation'] : null,
        activity: typeof parsed['activity'] === 'string' ? parsed['activity'] : null,
        reason: typeof parsed['reason'] === 'string' ? parsed['reason'] : null,
        accepts_messages: parsed['accepts_messages'] === true,
        writer_ready: parsed['writer_ready'] === true,
        updated_at: typeof parsed['updated_at'] === 'number' ? parsed['updated_at'] : 0,
      })
    } catch {
      // A half-written or foreign file is not an attendant.
    }
  }
  return reports.sort((a, b) => b.updated_at - a.updated_at)
}

/** Admission proof from the exact, live classic-CLI plugin writer. */
export function hermesQuestionRouteReady(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): boolean {
  const report = listAttendantReports(env).find((entry) => entry.session_id === sessionId)
  return report !== undefined && report.alive && report.writer_ready &&
    now >= report.updated_at && now - report.updated_at <= 5_000 &&
    (report.phase === 'dormant' || report.phase === 'acquiring' || report.phase === 'attending')
}

/**
 * The lease a writer beside the attendant (the answer waiter) may claim under:
 * the generation the live attendant of this session holds right now, or null.
 * The service still decides; a stale read is refused as `generation_fenced`.
 */
export function readAttendantLease(sessionId: string, env: NodeJS.ProcessEnv): DeliveryLease | null {
  try {
    const status = JSON.parse(readFileSync(attendantStatusPath(sessionId, env), 'utf8')) as Record<string, unknown>
    const generation = status['generation']
    const incarnation = status['incarnation']
    if (
      status['phase'] !== 'attending' ||
      typeof generation !== 'number' ||
      !Number.isInteger(generation) ||
      generation < 1 ||
      typeof incarnation !== 'string'
    ) {
      return null
    }
    const claim = readClaimFile(attendantClaimPath(sessionId, env))
    if (claim === null || claim['pid'] !== status['pid'] || !claimHolderMayRun(claim)) return null
    return { incarnation, generation }
  } catch {
    return null
  }
}

/**
 * Saved fencing identity for Codex SessionEnd, even if the attendant died
 * before the hook started. Ending presence is not a harness write: it must
 * survive a missing/dead claim and an exited status. The service checks the
 * exact incarnation and generation, so a saved report cannot end a newer
 * lease. Only the current local incarnation may supply that identity.
 */
export function readAttendantEndingLease(sessionId: string, env: NodeJS.ProcessEnv): DeliveryLease | null {
  try {
    const status = JSON.parse(readFileSync(attendantStatusPath(sessionId, env), 'utf8')) as Record<string, unknown>
    const generation = status['generation']
    const incarnation = status['incarnation']
    if (
      status['session_id'] !== sessionId ||
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      typeof incarnation !== 'string' ||
      readSessionIncarnation(sessionId, env)?.incarnation !== incarnation
    ) {
      return null
    }
    return { incarnation, generation }
  } catch {
    return null
  }
}

/**
 * A thread's own turn boundaries, for a harness that publishes no activity of
 * its own (Codex), scoped to one session incarnation (its stable start key).
 * Every fact here comes from a hook of that session, never from Codex's private
 * history files.
 *
 * Starts are observed by synchronous prompt and tool hooks. Automatic goal
 * continuations can omit the prompt hook; their first trusted tool callback
 * observes the turn instead, and one with no tool call appears first at its
 * Stop. Stop and Interrupt are asynchronous and may run late, so they are
 * matched by turn id. A start of a turn already seen is stale and never replaces
 * the current turn, except that a tool hook after Stop reopens that same turn: a
 * Stop hook can continue it.
 *
 * This is only a hint about when a wake is worth writing. A wake is safe at any
 * moment, because Codex stores it until the turn ends, so a wrong answer here
 * costs one blocked wake or a bounded delay and never holds input.
 */
export function turnActivityPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.turns.json`)
}

interface TurnRecord {
  /** The incarnation key these turns belong to. */
  key: string | null
  current: string | null
  /** Turn ids already started in this incarnation, oldest first. */
  started: string[]
  /** Turns that can never continue: interrupted, or completed under an older build. */
  ended: string[]
  /** The current turn's Stop ran. A later tool hook of that turn reopens it. */
  stopped?: string
  /** The current turn was interrupted. Codex holds its queue until the next prompt. */
  interrupted?: string
}

/** Turn ids kept to recognise a late hook; a late hook trails its turn by seconds. */
const TURNS_KEPT = 32

function readTurns(file: string): TurnRecord {
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((turn): turn is string => typeof turn === 'string') : []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    return {
      key: typeof parsed['key'] === 'string' ? parsed['key'] : null,
      current: typeof parsed['current'] === 'string' ? parsed['current'] : null,
      started: ids(parsed['started']),
      ended: ids(parsed['ended']),
      ...(typeof parsed['stopped'] === 'string' ? { stopped: parsed['stopped'] } : {}),
      ...(typeof parsed['interrupted'] === 'string' ? { interrupted: parsed['interrupted'] } : {}),
    }
  } catch {
    return { key: null, current: null, started: [], ended: [] }
  }
}

function updateTurns(sessionId: string, env: NodeJS.ProcessEnv, update: (record: TurnRecord) => TurnRecord): void {
  const file = turnActivityPath(sessionId, env)
  withFileLock(
    `${file}.lock`,
    () => {
      const next = update(readTurns(file))
      atomicWriteFileSync(file, `${JSON.stringify({ session_id: sessionId, ...next })}\n`)
    },
    // The prompt hook runs in front of the User's turn; activity is only a hint.
    { waitMs: 500 },
  )
}

const keep = (ids: string[], id: string): string[] => [...ids.filter((turn) => turn !== id), id].slice(-TURNS_KEPT)

function ownRecord(record: TurnRecord, key: string): TurnRecord {
  return record.key === key ? record : { key, current: null, started: [], ended: record.ended }
}

/** A turn of incarnation `key` started or ran a tool. A turn already seen stays as it was, except a Stop it continued past. */
export function recordTurnStart(sessionId: string, env: NodeJS.ProcessEnv, key: string, turnId: string): void {
  updateTurns(sessionId, env, (record) => {
    const same = ownRecord(record, key)
    if (same.current === turnId && same.stopped === turnId) {
      const { stopped: _stopped, ...reopened } = same
      return reopened
    }
    if (same.started.includes(turnId) || same.ended.includes(turnId)) return same
    const { stopped: _stopped, interrupted: _interrupted, ...rest } = same
    return { ...rest, current: turnId, started: keep(same.started, turnId) }
  })
}

/** A turn's Stop ran. A goal's automatic turn with no tool call is first seen here. */
export function recordTurnStop(sessionId: string, env: NodeJS.ProcessEnv, key: string, turnId: string): void {
  updateTurns(sessionId, env, (record) => {
    const same = ownRecord(record, key)
    if (same.ended.includes(turnId)) return same
    if (same.current === turnId) return { ...same, stopped: turnId }
    // Turn ids sort by start time, so a late Stop of an older turn changes nothing.
    if (same.started.includes(turnId) || (same.current !== null && turnId < same.current)) return same
    const { interrupted: _interrupted, ...rest } = same
    return { ...rest, current: turnId, started: keep(same.started, turnId), stopped: turnId }
  })
}

/** A turn was interrupted, whenever its hook got to run. */
export function recordTurnInterrupt(sessionId: string, env: NodeJS.ProcessEnv, turnId: string): void {
  updateTurns(sessionId, env, (record) => ({
    ...record, ended: keep(record.ended, turnId),
    ...(record.current === turnId ? { interrupted: turnId } : {}),
  }))
}

/** The turn this session's hooks last named, and where its history is, for the question card checks. */
export function recordCodexNativeTurn(
  sessionId: string, env: NodeJS.ProcessEnv, key: string, turnId: string, transcriptPath: unknown,
): void {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return
  updateSessionState(sessionId, env, (state) => {
    const proof = state.codex_native_turn
    if (proof?.key === key && proof.turn_id === turnId && proof.transcript_path === transcriptPath) return state
    return { ...state, codex_native_turn: { key, turn_id: turnId, transcript_path: transcriptPath, observed_at: Date.now() } }
  })
}

/** Last observed activity for this owner, never the missing-record idle default. Drives display and a bounded wake delay. */
export function observedCodexTurnActivity(sessionId: string, env: NodeJS.ProcessEnv, key: string): SessionActivity | null {
  const record = readTurns(turnActivityPath(sessionId, env))
  if (record.key !== key || record.current === null) return null
  return record.ended.includes(record.current) || record.stopped === record.current ? 'idle' : 'working'
}

/** Exact active turn, used to reject a tool hook that outlived interruption. */
export function currentCodexTurn(sessionId: string, env: NodeJS.ProcessEnv, key: string): string | null {
  const record = readTurns(turnActivityPath(sessionId, env))
  return record.key === key && record.current !== null && !record.ended.includes(record.current) &&
    record.stopped !== record.current ? record.current : null
}

/** The User interrupted the latest turn: Codex runs nothing it has queued until their next prompt. */
export function codexTurnInterrupted(sessionId: string, env: NodeJS.ProcessEnv, key: string): boolean {
  const record = readTurns(turnActivityPath(sessionId, env))
  return record.key === key && record.current !== null && record.interrupted === record.current
}

/** Whether this session's own hooks have reported a turn since it last started. */
export function codexTurnObserved(sessionId: string, env: NodeJS.ProcessEnv): boolean {
  const owner = readSessionIncarnation(sessionId, env)
  if (owner === null) return false
  const record = readTurns(turnActivityPath(sessionId, env))
  return record.key === owner.key && record.current !== null
}
