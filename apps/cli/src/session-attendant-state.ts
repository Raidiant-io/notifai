/** Local files of the Session Attendant: its exclusive claim and its readable status. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { sanitizeSessionId, stateDir } from './config.js'
import { claimHolderMayRun, readClaimFile } from './hook-question-lock.js'
import type { AttendantPhase, AttendantStatus } from './session-attendant.js'
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
        updated_at: typeof parsed['updated_at'] === 'number' ? parsed['updated_at'] : 0,
      })
    } catch {
      // A half-written or foreign file is not an attendant.
    }
  }
  return reports.sort((a, b) => b.updated_at - a.updated_at)
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
