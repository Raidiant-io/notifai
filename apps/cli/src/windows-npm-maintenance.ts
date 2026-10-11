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
export interface WindowsReader extends ProcessIdentity { executable: string; reason: 'package' | 'application' | 'manager' }
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

/** A fresh observation inside an approved cooperative pause. This establishes
 * no exclusion against newly started programs, wrappers, embedded consumers or
 * shared remote storage. Those cases remain outside this direct-CLI repair.
 * A runtime name alone never establishes that a process reads this package. */
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
    if (input.liveness(producer) !== 'gone') throw new Error(`The assessed application (PID ${producer.pid}) has not finished; defer this replacement until its work settles`)
  }
  const owned = [input.coordinator, ...(input.manager ? [input.manager] : [])]
  const busy = input.census.readers.filter(reader => !owned.some(identity => identity.pid === reader.pid &&
    normalizeProcessStart(identity.start) === normalizeProcessStart(reader.start)))
  if (busy.length) {
    throw new Error(`Affected Notifai processes are still running (${busy.map(reader => `${reader.reason}: PID ${reader.pid}`).join(', ')}); defer this replacement until their work finishes. Leave unrelated applications running`)
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
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NotifaiReaderArguments {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CommandLineToArgvW(string line, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  static extern uint GetLongPathName(string input, StringBuilder output, uint size);
  public static string[] Parse(string line) {
    int count; IntPtr memory = CommandLineToArgvW(line, out count);
    if (memory == IntPtr.Zero) throw new InvalidOperationException("Cannot inspect scoped process arguments");
    try {
      var result = new string[count];
      for (int i=0; i<count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
      return result;
    } finally { LocalFree(memory); }
  }
  public static string LongPath(string value) {
    var buffer = new StringBuilder(32768);
    uint count = GetLongPathName(value, buffer, (uint)buffer.Capacity);
    return count > 0 && count < buffer.Capacity ? buffer.ToString() : value;
  }
}
'@
function Normalize-LocalPath([string]$value) {
  if ($value.StartsWith('file:', [StringComparison]::OrdinalIgnoreCase)) {
    try { $value = ([Uri]$value).LocalPath } catch { return '' }
  }
  if ($value.StartsWith('\\?\')) { $value = $value.Substring(4) }
  if ($value -notmatch '^[a-zA-Z]:[\\/]') { return '' }
  try { return [NotifaiReaderArguments]::LongPath([IO.Path]::GetFullPath($value)).TrimEnd('\').ToLowerInvariant() } catch { return '' }
}
$prefixes = @($inputScope.prefix, [IO.Path]::GetDirectoryName($inputScope.command)) | ForEach-Object { Normalize-LocalPath $_ } | Select-Object -Unique
$packages = @($prefixes | ForEach-Object { $_ + '\node_modules\@raidiant\notifai' })
$commands = @($prefixes | ForEach-Object { $_ + '\notifai'; $_ + '\notifai.cmd'; $_ + '\notifai.ps1' })
function Test-PackagePath([string]$value) {
  $candidate = Normalize-LocalPath $value
  if (-not $candidate) { return $false }
  if ($commands -contains $candidate) { return $true }
  foreach ($package in $packages) {
    if ($candidate -eq $package -or $candidate.StartsWith($package + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}
function Test-DirectReader($row) {
  if (Test-PackagePath $row.ExecutablePath) { return $true }
  if ($row.Name -notin @('node.exe', 'bun.exe', 'deno.exe')) { return $false }
  if (-not $row.CommandLine) { return $false }
  $arguments = @([NotifaiReaderArguments]::Parse($row.CommandLine))
  # The supported npm shims launch an absolute script. Inspect that entry and
  # preloads, not application data after it. Opaque embedded imports are outside
  # this direct-CLI assessment; scanning every interpreter cannot prove them safe.
  $unknownOption = $false
  for ($i = 1; $i -lt $arguments.Count; $i++) {
    $argument = $arguments[$i]
    if ($i -eq 1 -and $row.Name -in @('bun.exe', 'deno.exe') -and $argument -eq 'run') { continue }
    if ($argument -eq '--') {
      return $i + 1 -lt $arguments.Count -and (Test-PackagePath $arguments[$i + 1])
    }
    if ($argument -in @('-r', '--require', '--import', '--loader', '--experimental-loader')) {
      $i++
      if ($i -lt $arguments.Count -and (Test-PackagePath $arguments[$i])) { return $true }
      continue
    }
    if ($argument -match '^--(?:require|import|loader|experimental-loader)=(.*)$') {
      if (Test-PackagePath $Matches[1]) { return $true }
      continue
    }
    if ($argument.StartsWith('-')) { $unknownOption = $true; continue }
    if (Test-PackagePath $argument) { return $true }
    # With an unknown runtime option, its arity is unknown: retain only explicit
    # references to this package. Never widen uncertainty to unrelated runtimes.
    if (-not $unknownOption) { return $false }
  }
  return $false
}
$rows = @(Get-CimInstance -ClassName Win32_Process)
if ($rows.Count -gt 4096) { throw 'Process census exceeds its bound' }
$readers = [Collections.Generic.List[object]]::new(); $uncertain = $false
foreach ($row in $rows) {
  $named = @($inputScope.producers | Where-Object {
    ($_.pid -eq $row.ProcessId -and $row.CreationDate -and
     [Math]::Abs($row.CreationDate.ToUniversalTime().ToFileTimeUtc() - [long]$_.start.Substring(17)) -le 10) -or
    ([IO.Path]::GetFileName($_.executable) -notin @('node.exe', 'bun.exe', 'deno.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe') -and
     (Normalize-LocalPath $_.executable) -eq (Normalize-LocalPath $row.ExecutablePath))
  }).Count -gt 0
  $manager = $inputScope.manager -and $row.ProcessId -eq $inputScope.manager.pid
  if (-not $manager -and -not $named -and -not (Test-DirectReader $row)) { continue }
  try {
    # Inspect only processes tied to the assessed package/application. Inability
    # to read an unrelated program is not a reason to stop it or its workload.
    $live = [Diagnostics.Process]::GetProcessById($row.ProcessId)
    $start = $live.StartTime.ToUniversalTime()
    if ([Math]::Abs(($start - $row.CreationDate.ToUniversalTime()).Ticks) -gt 10) { $uncertain = $true; continue }
    # The supervisor owns this exact suspended process. Its module list need
    # not exist until GO, so identify it by the kernel creation time first.
    # A reused PID or any other reader still requires the full inspection.
    if ($inputScope.manager -and $row.ProcessId -eq $inputScope.manager.pid -and
        ('windows-filetime:' + $start.ToFileTimeUtc()) -ceq $inputScope.manager.start) { continue }
    $executable = $live.MainModule.FileName
    if (-not $executable -or ($live.ProcessName + '.exe') -ine $row.Name) { $uncertain = $true; continue }
    $reason = if ($manager) { 'manager' } elseif ($named) { 'application' } else { 'package' }
    $readers.Add(@{pid=[int]$row.ProcessId; start=('windows-filetime:' + $start.ToFileTimeUtc()); executable=$executable; reason=$reason})
  } catch {
    # A departed process is harmless; a still-present inaccessible process is
    # uncertainty, never an empty list that can authorize replacement.
    if (Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue) { $uncertain = $true }
  }
}
@{readers=@($readers.ToArray()); uncertain=$uncertain} | ConvertTo-Json -Depth 4 -Compress
`

export function inspectWindowsNpmReaders(scope: NpmMaintenanceScope, manager?: ProcessIdentity): WindowsReaderCensus {
  if (process.platform !== 'win32') throw new Error('Windows process observation is unavailable')
  if (manager !== undefined && !processIdentity(manager)) throw new Error('Maintenance process identity is unavailable')
  const powershell = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_NPM_READER_CENSUS, 'utf16le').toString('base64')], {
    env: { ...process.env, NOTIFAI_NPM_CENSUS: JSON.stringify({ ...scope.observation, manager }) },
    encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = JSON.parse(output) as WindowsReaderCensus
  if (!result || typeof result.uncertain !== 'boolean' || !Array.isArray(result.readers) || result.readers.length > 4096 ||
      !result.readers.every(p => processIdentity(p) && typeof p.executable === 'string' && path.win32.isAbsolute(p.executable) &&
        ['package', 'application', 'manager'].includes(p.reason))) throw new Error('Invalid Windows process census')
  return result
}
