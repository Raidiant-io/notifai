import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { processStartTime } from './process-identity.js'

export interface NativeFileUse {
  status: 'clear' | 'in_use' | 'uncertain'
  processes: Array<{ pid: number; start?: string }>
}

/** Explicit uninstall only. C checks exact executable identity. Exclude only
 * this foreground command and its completed read-only probe. On Windows the
 * foreground C parent waits for this payload; its locked image is retained for
 * external cleanup. No process is signalled and no arbitrary PID is exempted. */
export function inspectNativeFileUse(launcher: string, files: readonly string[]): NativeFileUse {
  const processes: NativeFileUse['processes'] = []
  try {
    if (!path.isAbsolute(launcher) || files.length === 0 || files.some(file => !path.isAbsolute(file))) throw new Error('Invalid file-use request')
    // Windows command lines have a finite UTF-16 limit. Keep each bounded probe
    // well below it, including quoting and the helper executable itself.
    const groups: string[][] = []
    let group: string[] = [], size = launcher.length + 64
    for (const file of new Set(files)) {
      const length = file.length * 2 + 4
      if (length + launcher.length + 64 > 24_000) throw new Error('File-use path is too long')
      if (size + length > 24_000 || group.length === 256) { groups.push(group); group = []; size = launcher.length + 64 }
      group.push(file); size += length
    }
    if (group.length) groups.push(group)
    const parentStart = process.platform === 'win32' ? processStartTime(process.ppid) : null
    for (const files of groups) {
      const result = spawnSync(launcher, ['--internal-file-users', ...files], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (result.error || result.status !== 0 || !Number.isSafeInteger(result.pid) || result.pid <= 0) throw new Error('Native process observation failed')
      const record = JSON.parse(result.stdout) as { reboot_reasons?: unknown; processes?: unknown }
      if (record.reboot_reasons !== 0 || !Array.isArray(record.processes)) throw new Error('Native process observation is incomplete')
      for (const item of record.processes) {
        if (!item || !Number.isSafeInteger(item.pid) || item.pid <= 0 ||
            (process.platform === 'win32' && (typeof item.start !== 'string' || !/^windows-filetime:[0-9]+$/.test(item.start)))) {
          throw new Error('Invalid native process identity')
        }
        // The synchronous child has exited. This process cannot have had its
        // PID recycled while running this code. The Windows parent is exempt
        // only with the same kernel creation time observed before the scan.
        if (item.pid === result.pid || item.pid === process.pid || (process.platform === 'win32' &&
            item.pid === process.ppid && parentStart !== null && item.start === parentStart)) continue
        if (!processes.some(known => known.pid === item.pid && known.start === item.start)) processes.push({ pid: item.pid, ...(item.start ? { start: item.start } : {}) })
      }
    }
    return { status: processes.length ? 'in_use' : 'clear', processes }
  } catch { return { status: 'uncertain', processes } }
}
