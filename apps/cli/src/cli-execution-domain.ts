/** Bounded launch-context evidence. An external shell cannot observe another
 * application's aliases, command cache, or virtual filesystem by inspecting PATH. */
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'
import { buildIdentity } from './distribution.js'
import { canonicalPath } from './local-path.js'

export interface WindowsProcessDomain {
  pid: number
  start: string
  executable: string
  package_family: string | null
  parent: number
}
export interface CliExecutionDomain {
  platform: NodeJS.Platform
  process: number
  ancestors: WindowsProcessDomain[]
  candidate_prefixes: string[]
  coverage: { path: 'invoking_process'; shell_precedence: 'unobserved'; other_applications: 'unobserved'; ancestry: 'observed' | 'partial' | 'not_applicable' }
}
export function physicalCliPath(file: string): { path: string; physical_path: string; file_id: string | null } {
  const physical = canonicalPath(file)
  try {
    const stat = statSync(file, { bigint: true })
    return { path: file, physical_path: physical, file_id: stat.ino > 0n ? `${stat.dev}:${stat.ino}` : null }
  } catch { return { path: file, physical_path: physical, file_id: null } }
}
export function windowsProcessDomain(pid: number): WindowsProcessDomain | null {
  if (process.platform !== 'win32' || buildIdentity() === null || !Number.isSafeInteger(pid) || pid < 1) return null
  try {
    const output = execFileSync(path.join(path.dirname(process.execPath), 'notifai.exe'), ['--internal-process-domain', String(pid)],
      { encoding: 'utf8', windowsHide: true, timeout: 2_000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    const [start, executable, family, parentText, extra] = output.trimEnd().split(/\r?\n/)
    const parent = Number(parentText)
    if (extra !== undefined || !start || !/^windows-filetime:\d+$/.test(start) || !executable ||
        !path.win32.isAbsolute(executable) || !family || family !== '-' && !/^[A-Za-z0-9.-]+_[A-Za-z0-9]+$/.test(family) ||
        !Number.isSafeInteger(parent) || parent < 0) return null
    return { pid, start, executable, package_family: family === '-' ? null : family, parent }
  } catch { return null }
}
/** Discover app-storage candidates only from actual process package identities.
 * Candidate location is not proof of that application's effective command. */
export function inspectExecutionDomain(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform,
  read: (pid: number) => WindowsProcessDomain | null = windowsProcessDomain, initialPid = process.pid): CliExecutionDomain {
  const result: CliExecutionDomain = { platform, process: initialPid, ancestors: [], candidate_prefixes: [],
    coverage: { path: 'invoking_process', shell_precedence: 'unobserved', other_applications: 'unobserved',
      ancestry: platform === 'win32' ? 'partial' : 'not_applicable' } }
  if (platform !== 'win32') return result
  let pid = initialPid, childStart: bigint | null = null
  for (let depth = 0; depth < 12 && pid > 0; depth++) {
    if (result.ancestors.some(item => item.pid === pid)) break
    const observed = read(pid)
    if (!observed || observed.pid !== pid || !/^windows-filetime:\d+$/.test(observed.start)) break
    const start = BigInt(observed.start.slice('windows-filetime:'.length))
    // Parent PID reuse cannot turn an unrelated application into a storage root.
    if (childStart !== null && start > childStart) break
    result.ancestors.push(observed)
    if (observed.package_family && /^[A-Za-z0-9.-]+_[A-Za-z0-9]+$/.test(observed.package_family) &&
        env['LOCALAPPDATA'] && path.win32.isAbsolute(env['LOCALAPPDATA'])) {
      const prefix = path.win32.join(env['LOCALAPPDATA'], 'Packages', observed.package_family, 'LocalCache', 'Roaming', 'npm')
      if (!result.candidate_prefixes.includes(prefix)) result.candidate_prefixes.push(prefix)
    }
    childStart = start; pid = observed.parent
    if (pid === 0) result.coverage.ancestry = 'observed'
  }
  return result
}
