/** A process named by PID *and* start time, so a reused PID is never mistaken for it. */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { buildIdentity } from './distribution.js'

export interface ProcessIdentity {
  pid: number
  /** UTC ps text on POSIX; kernel FILETIME on Windows. Never a PID alone. */
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
export function processStartTime(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (platform === 'win32') return buildIdentity() !== null ? windowsProcessInfo(pid)?.start ?? null : windowsProcessStart(pid)
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
export function processExecutableName(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (platform === 'win32') return buildIdentity() !== null ? windowsProcessInfo(pid)?.name ?? null : windowsProcessProperty(pid, 'ProcessName')
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

/** Native identity reads use the sibling C launcher, never PowerShell or a
 * cached PID start. The tagged FILETIME shares the source/harness kernel clock. */
function windowsProcessInfo(pid: number): { start: string; name: string } | null {
  try {
    const output = execFileSync(path.join(path.dirname(process.execPath), 'notifai.exe'), ['--internal-process-info', String(pid)],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 })
    const [start, name] = output.trim().split(/\r?\n/)
    if (!start || !/^windows-filetime:\d+$/.test(start) || !name) return null
    return { start, name: name.replace(/\.exe$/i, '') }
  } catch { return null }
}

/**
 * One property of a Windows process, or null when it is gone or unreadable.
 *
 * Windows has no `ps`; PowerShell is the one tool every supported Windows has.
 * A process's start is read as its FILETIME in UTC, a plain integer, because
 * that is exactly what Claude Code writes as `procStart` in its session
 * descriptor on Windows: the two compare equal as text, as `lstart` does
 * elsewhere. Each read starts PowerShell, about a fifth of a second.
 */
function windowsProcessProperty(pid: number, property: string): string | null {
  try {
    return execFileSync(
      path.win32.join(process.env['SystemRoot'] || process.env['SYSTEMROOT'] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).${property}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true },
    ).trim()
  } catch {
    // Get-Process fails for a PID that does not exist.
    return null
  }
}

/** How long one Windows start read answers for the same PID in this process. */
const WINDOWS_START_CACHE_MS = 5_000

let windowsStarts = new Map<number, { start: string; at: number }>()

/**
 * A Windows process's start, as its FILETIME in UTC.
 *
 * One hook asks about the same few processes several times within a moment,
 * and each fresh answer costs a PowerShell start. A start never changes while
 * its PID lives, so a recent answer is reused for a PID that still exists;
 * the window is short because Windows hands a freed PID out again quickly.
 */
export function windowsProcessStart(
  pid: number,
  read: (pid: number, property: string) => string | null = windowsProcessProperty,
  now: () => number = Date.now,
  exists: (pid: number) => boolean = pidExists,
): string | null {
  const at = now()
  const known = windowsStarts.get(pid)
  if (known !== undefined && at - known.at < WINDOWS_START_CACHE_MS && exists(pid)) return known.start
  windowsStarts.delete(pid)
  const start = read(pid, 'StartTime.ToFileTimeUtc()')
  if (start === null || !/^\d+$/.test(start)) return null
  if (windowsStarts.size > 64) windowsStarts = new Map()
  windowsStarts.set(pid, { start, at })
  return start
}

export function normalizeProcessStart(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  // Claude Code descriptors use bare FILETIME; the native helper tags its
  // clock. Compare the same kernel value across those two explicit producers.
  return /^windows-filetime:\d+$/.test(normalized) ? normalized.slice('windows-filetime:'.length) : normalized
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
