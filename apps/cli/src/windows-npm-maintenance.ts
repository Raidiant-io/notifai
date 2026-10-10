import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { sameLocalPath } from './local-path.js'
import { normalizeProcessStart, type ProcessIdentity } from './process-identity.js'
import type { RuntimeOwnerInspection } from './runtime-retention.js'

export interface NpmAppObservation {
  schema: 1
  /** Supplied by the agent after observing the affected shell, not discovered
   * from an external shell's PATH or guessed from a credential directory. */
  source: 'affected-shell'
  command: string
  /** Present when the affected packaged app reports a logical command path.
   * Its actual-shell observation must establish this physical mapping. */
  physical_command?: string
  prefix: string
  state_roots: string[]
  producers: Array<ProcessIdentity & { executable: string }>
  consumer: 'windows-direct-cli'
}
export interface ObservedDirectory { path: string; identity: string }
export interface NpmMaintenanceScope {
  observation: NpmAppObservation
  prefix: ObservedDirectory
  states: ObservedDirectory[]
}
export interface WindowsReader extends ProcessIdentity { executable: string }
export interface WindowsReaderCensus { readers: WindowsReader[]; uncertain: boolean }

const processIdentity = (value: ProcessIdentity) => value && Number.isSafeInteger(value.pid) && value.pid > 0 &&
  typeof value.start === 'string' && /^windows-filetime:\d+$/.test(value.start)

export function parseNpmAppObservation(value: unknown): NpmAppObservation {
  const v = value as NpmAppObservation
  if (!v || v.schema !== 1 || v.source !== 'affected-shell' || v.consumer !== 'windows-direct-cli' ||
      typeof v.command !== 'string' || !path.win32.isAbsolute(v.command) ||
      v.physical_command !== undefined && (typeof v.physical_command !== 'string' || !path.win32.isAbsolute(v.physical_command)) ||
      typeof v.prefix !== 'string' || !path.win32.isAbsolute(v.prefix) ||
      !Array.isArray(v.state_roots) || v.state_roots.length < 1 || v.state_roots.length > 8 ||
      !v.state_roots.every(p => typeof p === 'string' && path.win32.isAbsolute(p) && !p.startsWith('\\\\')) ||
      !Array.isArray(v.producers) || v.producers.length < 1 || v.producers.length > 16 ||
      !v.producers.every(p => processIdentity(p) && typeof p.executable === 'string' && path.win32.isAbsolute(p.executable)) ||
      v.prefix.startsWith('\\\\') || Buffer.byteLength(JSON.stringify(v)) > 8192) {
    throw new Error('Repair needs a bounded actual-shell observation of the local npm prefix, state roots and named producers')
  }
  if (!['notifai', 'notifai.cmd', 'notifai.ps1'].some(name =>
    path.win32.basename(v.command).toLowerCase() === name && sameLocalPath(v.physical_command ?? v.command, path.win32.join(v.prefix, name), 'win32'))) {
    throw new Error('The observed command must be a direct command at the assessed npm prefix; wrappers and aliases need separate assessment')
  }
  return { schema: 1, source: v.source, command: v.command, prefix: v.prefix,
    ...(v.physical_command ? { physical_command: v.physical_command } : {}),
    state_roots: [...new Set(v.state_roots)], producers: v.producers.map(p => ({ pid: p.pid, start: p.start, executable: p.executable })), consumer: v.consumer }
}

export function observeNpmDirectory(file: string): ObservedDirectory {
  const resolved = realpathSync(file), stat = lstatSync(resolved, { bigint: true })
  if (!stat.isDirectory() || stat.ino <= 0n || resolved.startsWith('\\\\')) throw new Error('Npm maintenance requires identified local directories')
  return { path: resolved, identity: `${stat.dev}:${stat.ino}` }
}

export function captureNpmMaintenanceScope(value: unknown): NpmMaintenanceScope {
  const observation = parseNpmAppObservation(value)
  return { observation, prefix: observeNpmDirectory(observation.prefix), states: observation.state_roots.map(observeNpmDirectory) }
}

export function assertNpmScopeDirectories(scope: NpmMaintenanceScope): void {
  parseNpmAppObservation(scope.observation)
  if (!scope.prefix || !Array.isArray(scope.states) || scope.states.length !== scope.observation.state_roots.length) throw new Error('Invalid prepared maintenance scope')
  for (const [observed, source] of [[scope.prefix, scope.observation.prefix], ...scope.states.map((state, i) => [state, scope.observation.state_roots[i]!] as const)] as const) {
    const actual = observeNpmDirectory(source)
    if (actual.identity !== observed.identity || !sameLocalPath(actual.path, observed.path, 'win32')) throw new Error('The assessed application directory changed')
  }
}

export const npmMaintenanceDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** A fresh observation inside an approved cooperative pause. This establishes
 * no exclusion against newly started programs, wrappers, embedded consumers or
 * shared remote storage. Those cases remain outside this direct-CLI repair. */
export function assertNpmMaintenanceQuiet(input: {
  scope: NpmMaintenanceScope
  census: WindowsReaderCensus
  coordinator: ProcessIdentity
  manager?: ProcessIdentity
  owners: RuntimeOwnerInspection[]
  liveness: (identity: ProcessIdentity) => 'alive' | 'gone' | 'unknown'
}): void {
  if (!processIdentity(input.coordinator) || input.manager !== undefined && !processIdentity(input.manager)) throw new Error('Maintenance process identity is unavailable')
  if (input.census.uncertain || !Array.isArray(input.census.readers) || input.census.readers.some(p => !processIdentity(p))) throw new Error('Relevant process inspection is incomplete')
  for (const producer of input.scope.observation.producers) {
    if (input.liveness(producer) !== 'gone') throw new Error('An assessed producer has not been proved stopped')
  }
  const owned = [input.coordinator, ...(input.manager ? [input.manager] : [])]
  if (input.census.readers.some(reader => !owned.some(identity => identity.pid === reader.pid &&
      normalizeProcessStart(identity.start) === normalizeProcessStart(reader.start)))) {
    throw new Error('A possible legacy reader or named producer is still running; maintain the approved pause before resuming')
  }
  if (input.owners.length !== input.scope.states.length || input.owners.some(owner => owner.status !== 'clear' || owner.unattributedPending ||
      owner.sessions.some(session => session.pending) || [...owner.hosts, ...owner.residents.map(item => item.identity)].some(p => input.liveness(p) !== 'gone'))) {
    throw new Error('Pending or uncertain session work must settle before npm replacement')
  }
}

export const WINDOWS_NPM_READER_CENSUS = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
foreach ($module in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'CimCmdlets')) {
  Import-Module ([IO.Path]::Combine($PSHOME, 'Modules', $module, ($module + '.psd1'))) -ErrorAction Stop
}
$inputScope = [Environment]::GetEnvironmentVariable('NOTIFAI_NPM_CENSUS') | ConvertFrom-Json
foreach ($directory in @($inputScope.prefix) + @($inputScope.state_roots)) {
  if (-not $directory -or [IO.DriveInfo]::new([IO.Path]::GetPathRoot($directory)).DriveType -ne [IO.DriveType]::Fixed) {
    throw 'Repair supports fixed local storage; shared or unestablished storage remains pending'
  }
}
$names = @('node.exe', 'bun.exe', 'deno.exe', 'notifai-runtime.exe') + @($inputScope.producers | ForEach-Object { [IO.Path]::GetFileName($_.executable) })
$rows = @(Get-CimInstance -ClassName Win32_Process)
if ($rows.Count -gt 4096) { throw 'Process census exceeds its bound' }
$readers = [Collections.Generic.List[object]]::new(); $uncertain = $false
foreach ($row in $rows) {
  if ($row.Name -notin $names) { continue }
  try {
    # Include possible readers across account boundaries. Codex sandbox users
    # can cache this package without permission to write the User's state.
    # A foreign or inaccessible possible reader defers this narrow repair.
    $live = [Diagnostics.Process]::GetProcessById($row.ProcessId)
    $start = $live.StartTime.ToUniversalTime()
    if ([Math]::Abs(($start - $row.CreationDate.ToUniversalTime()).Ticks) -gt 10) { $uncertain = $true; continue }
    $executable = $live.MainModule.FileName
    if (-not $executable -or ($live.ProcessName + '.exe') -ine $row.Name) { $uncertain = $true; continue }
    $readers.Add(@{pid=[int]$row.ProcessId; start=('windows-filetime:' + $start.ToFileTimeUtc()); executable=$executable})
  } catch {
    # A departed process is harmless; a still-present inaccessible process is
    # uncertainty, never an empty list that can authorize replacement.
    if (Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue) { $uncertain = $true }
  }
}
@{readers=@($readers.ToArray()); uncertain=$uncertain} | ConvertTo-Json -Depth 4 -Compress
`

export function inspectWindowsNpmReaders(scope: NpmMaintenanceScope): WindowsReaderCensus {
  if (process.platform !== 'win32') throw new Error('Windows process observation is unavailable')
  const powershell = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_NPM_READER_CENSUS, 'utf16le').toString('base64')], {
    env: { ...process.env, NOTIFAI_NPM_CENSUS: JSON.stringify(scope.observation) },
    encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = JSON.parse(output) as WindowsReaderCensus
  if (!result || typeof result.uncertain !== 'boolean' || !Array.isArray(result.readers) || result.readers.length > 4096 ||
      !result.readers.every(p => processIdentity(p) && typeof p.executable === 'string' && path.win32.isAbsolute(p.executable))) throw new Error('Invalid Windows process census')
  return result
}
