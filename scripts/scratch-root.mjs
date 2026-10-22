import { execFileSync } from 'node:child_process'
import { readdirSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REMAINING_LIMIT = 20

/**
 * Remove a scratch directory a check created, retrying briefly: on Windows a
 * process that has just exited, or a scanner reading a new executable, can
 * hold a file for a moment. Never throws. A directory that stays reports what
 * is left in it and which processes still run from it or name it, so cleanup
 * trouble neither hides the check's own result nor fails without a cause.
 */
export function removeScratchRoot(root, {
  attempts = 8,
  delayMs = 250,
  remove = directory => rmSync(directory, { recursive: true, force: true }),
  holders = scratchRootHolders,
} = {}) {
  let error
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      remove(root)
      return { removed: true, attempts: attempt }
    } catch (caught) { error = caught }
    if (attempt < attempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
  }
  return { removed: false, attempts, error, remaining: remainingEntries(root), holders: holders(root) }
}

/** One readable account of a scratch directory that could not be removed. */
export function describeScratchRoot(root, cleanup) {
  const lines = [`Could not remove ${root} after ${cleanup.attempts} attempts: ${cleanup.error?.message ?? cleanup.error}`]
  lines.push(cleanup.remaining.length === 0 ? 'Nothing is left inside it.'
    : `Still inside it: ${cleanup.remaining.join(', ')}`)
  if (cleanup.holders.error) lines.push(`Could not list the processes holding it: ${cleanup.holders.error}`)
  else if (cleanup.holders.processes.length === 0) {
    lines.push('No running process starts from it or names it; another process, such as a malware scan, may hold a handle inside it.')
  } else {
    lines.push('Processes still running from it, naming it or holding a file in it:')
    for (const holder of cleanup.holders.processes) {
      lines.push(`  pid ${holder.pid} (parent ${holder.parent}) ${holder.name}: ${holder.command ?? holder.executable ?? holder.file ?? ''}`)
    }
  }
  return lines.join('\n')
}

function remainingEntries(root) {
  const found = []
  const walk = directory => {
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (found.length >= REMAINING_LIMIT) return
      const file = path.join(directory, entry.name)
      found.push(path.relative(root, file) + (entry.isDirectory() ? path.sep : ''))
      if (entry.isDirectory()) walk(file)
    }
  }
  walk(root)
  return found
}

/**
 * Processes whose executable lies under the directory or whose command line
 * names it. Windows reports a path in whichever form started the process, so
 * both the given form (a temporary directory can use 8.3 short names) and the
 * resolved long form are matched.
 */
export function scratchRootHolders(root, platform = process.platform) {
  const forms = [...new Set([path.resolve(root), resolved(root)].filter(Boolean))]
  try {
    if (platform === 'win32') return { processes: windowsHolders(forms) }
    return { processes: posixHolders(forms) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function resolved(root) {
  try { return realpathSync.native(root) } catch { return null }
}

const WINDOWS_HOLDERS = `$ErrorActionPreference = 'Stop'
$roots = $env:NOTIFAI_SCRATCH_ROOTS -split "\`n" | Where-Object { $_ }
@(Get-CimInstance Win32_Process | Where-Object {
  $process = $_
  @($roots | Where-Object { ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($_, [StringComparison]::OrdinalIgnoreCase)) -or
    ($process.CommandLine -and $process.CommandLine.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0) }).Count -gt 0
} | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name;
  executable = $_.ExecutablePath; command = $_.CommandLine } }) | ConvertTo-Json -Compress -Depth 2`

function windowsHolders(forms) {
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_HOLDERS], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NOTIFAI_SCRATCH_ROOTS: forms.join('\n') } }).trim()
  if (output === '') return []
  const parsed = JSON.parse(output)
  // Windows PowerShell 5.1 unwraps a one-element array piped to ConvertTo-Json.
  return Array.isArray(parsed) ? parsed : [parsed]
}

function posixHolders(forms) {
  const processes = new Map()
  for (const form of forms) {
    let output
    try {
      output = execFileSync('lsof', ['-F', 'pcn', '+D', form], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (error) {
      // lsof exits 1 when nothing holds a file under the directory, and on
      // macOS also when it found holders but could not read every entry.
      if (error.status !== 1) throw error
      output = error.stdout
    }
    let current
    for (const line of output.split('\n')) {
      if (line.startsWith('p')) {
        current = processes.get(line.slice(1)) ?? { pid: Number(line.slice(1)), parent: null, name: '', executable: null, command: null, file: null }
        processes.set(line.slice(1), current)
      } else if (line.startsWith('c') && current) current.name = line.slice(1)
      else if (line.startsWith('n') && current) current.file ??= line.slice(1)
    }
  }
  return [...processes.values()]
}
