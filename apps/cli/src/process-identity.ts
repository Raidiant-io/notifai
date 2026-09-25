/** A process named by PID *and* start time, so a reused PID is never mistaken for it. */
import { execFileSync } from 'node:child_process'

export interface ProcessIdentity {
  pid: number
  /** Normalised UTC `ps -o lstart` text, the same clock Claude Code's descriptor uses. */
  start: string
}

/**
 * The start time of a process, or null when it is gone or cannot be read.
 *
 * One clock source for every side of every comparison: `ps -o lstart` under
 * `TZ=UTC` and the C locale. Claude Code writes its session descriptor's
 * `procStart` the same way, so a harness start read here compares equal to it
 * as text. Whitespace is collapsed because `lstart` pads single-digit days.
 */
export function processStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const output = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '/bin:/usr/bin', TZ: 'UTC', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    })
    const start = normalizeProcessStart(output)
    return start === '' ? null : start
  } catch {
    // `ps` exits 1 for a PID that does not exist.
    return null
  }
}

/** The executable name of a process (`ps -o comm`, without its directory), or null. */
export function processExecutableName(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const output = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '/bin:/usr/bin', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim()
    return output === '' ? null : output.slice(output.lastIndexOf('/') + 1)
  } catch {
    return null
  }
}

export function normalizeProcessStart(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/** Signal 0 only asks whether the PID exists; EPERM still means it does. */
export function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type ProcessLiveness = 'alive' | 'gone' | 'unknown'

/**
 * Whether this exact process still runs. A PID that exists with a different
 * start time is a different process: the one we knew is gone.
 */
export function processIdentityLiveness(
  identity: ProcessIdentity,
  readStart: (pid: number) => string | null = processStartTime,
  exists: (pid: number) => boolean = pidExists,
): ProcessLiveness {
  if (!exists(identity.pid)) return 'gone'
  const start = readStart(identity.pid)
  if (start === null) return exists(identity.pid) ? 'unknown' : 'gone'
  return normalizeProcessStart(start) === normalizeProcessStart(identity.start) ? 'alive' : 'gone'
}

/** This process, read once: its start time never changes. */
let selfIdentity: ProcessIdentity | null | undefined
export function currentProcessIdentity(): ProcessIdentity | null {
  if (selfIdentity === undefined) {
    const start = processStartTime(process.pid)
    selfIdentity = start === null ? null : { pid: process.pid, start }
  }
  return selfIdentity
}
