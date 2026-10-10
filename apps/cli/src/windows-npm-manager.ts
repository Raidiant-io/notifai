import { execFileSync } from 'node:child_process'
import path from 'node:path'

export interface WindowsNpmManager {
  node: string
  npm: string
  version: string
  sha256: string
}

/** Deliberately one trust source: the administrator-installed Node toolchain.
 * A signed node.exe copied beside an arbitrary npm tree is not this installation.
 * Inspect before executing any JavaScript; never resolve npm through PATH. */
export const WINDOWS_NPM_MANAGER_CHECK = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
foreach ($module in @('Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility')) {
  Import-Module ([IO.Path]::Combine($PSHOME, 'Modules', $module, ($module + '.psd1'))) -ErrorAction Stop
}
$selected = [Environment]::GetEnvironmentVariable('NOTIFAI_MANAGER_NODE')
$programFiles = [Environment]::GetFolderPath('ProgramFiles')
$root = [IO.Path]::Combine($programFiles, 'nodejs')
$node = [IO.Path]::Combine($root, 'node.exe')
if (-not [IO.Path]::IsPathRooted($selected) -or [IO.Path]::GetFullPath($selected) -ine $node) {
  throw 'Automatic repair requires the administrator-installed Node toolchain in Program Files'
}
$trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
function Inspect([string]$file, [bool]$ancestor = $false) {
  $item = Get-Item -LiteralPath $file -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Manager paths cannot contain reparse points' }
  $acl = Get-Acl -LiteralPath $file
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -notin $trusted) { throw 'Manager paths must remain administrator controlled' }
  if (-not $acl.AreAccessRulesCanonical) { throw 'Uncertain manager permissions' }
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl)
  if ($null -eq $raw.DiscretionaryAcl) { throw 'Missing manager access control' }
  foreach ($rule in $raw.DiscretionaryAcl) {
    if ($rule -isnot [Security.AccessControl.CommonAce] -or $rule.IsCallback -or
        $rule.AceType -notin @([Security.AccessControl.AceType]::AccessAllowed, [Security.AccessControl.AceType]::AccessDenied)) {
      throw 'Unsupported manager permission entry'
    }
    if ([int]$rule.AceType -eq 1 -or ([int]$rule.AceFlags -band 8) -ne 0) { continue }
    # Write data, append, attributes, delete-child/delete, WRITE_DAC/OWNER,
    # GENERIC_WRITE and GENERIC_ALL. Read/execute permissions are harmless.
    $writes = if ($ancestor) { 0x500D0150L } else { 0x500D0156L }
    if (([long]$rule.AccessMask -band $writes) -ne 0 -and $rule.SecurityIdentifier.Value -notin $trusted) {
      throw 'Manager paths allow a non-administrator writer'
    }
  }
  return $item
}
$null = Inspect $root
$parent = [IO.Path]::GetDirectoryName($root)
while ($parent) {
  $null = Inspect $parent $true
  $parent = [IO.Path]::GetDirectoryName($parent)
}
$nodeItem = Inspect $node
if ($nodeItem.PSIsContainer) { throw 'Invalid Node executable' }
$signature = Get-AuthenticodeSignature -LiteralPath $node
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'OpenJS Foundation') {
  throw 'Node publisher verification failed'
}
$npmRoot = [IO.Path]::Combine($root, 'node_modules', 'npm')
$null = Inspect ([IO.Path]::Combine($root, 'node_modules'))
$npm = [IO.Path]::Combine($npmRoot, 'bin', 'npm-cli.js')
$rows = [Collections.Generic.List[string]]::new()
$rows.Add('node:' + (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant())
$pending = [Collections.Generic.Stack[string]]::new()
$pending.Push($npmRoot)
$count = 0; $bytes = 0L
while ($pending.Count) {
  $file = $pending.Pop(); $item = Inspect $file; $count++
  if ($count -gt 30000) { throw 'Manager tree exceeds its path bound' }
  $relative = $file.Substring($npmRoot.Length).Replace('\', '/')
  if ($item.PSIsContainer) {
    $rows.Add('d:' + $relative)
    foreach ($child in Get-ChildItem -LiteralPath $file -Force) { $pending.Push($child.FullName) }
  } else {
    $bytes += $item.Length
    if ($bytes -gt 134217728) { throw 'Manager tree exceeds its byte bound' }
    $rows.Add('f:' + $relative + ':' + $item.Length + ':' + (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant())
  }
}
$manifest = Get-Content -LiteralPath ([IO.Path]::Combine($npmRoot, 'package.json')) -Raw | ConvertFrom-Json
if ($manifest.name -cne 'npm' -or $manifest.version -notmatch '^11\.\d+\.\d+$' -or -not (Test-Path -LiteralPath $npm -PathType Leaf)) {
  throw 'This repair supports the installed npm 11 toolchain'
}
$rows.Sort([StringComparer]::Ordinal)
$sha = [Security.Cryptography.SHA256]::Create()
try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($rows -join "\n")))).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
@{node=$node; npm=$npm; version=$manifest.version; sha256=$digest} | ConvertTo-Json -Compress
`

/** Invoked for preparation and every GO, so a changed imported npm dependency
 * cannot inherit trust from the unchanged npm-cli.js entrypoint. */
export function inspectWindowsNpmManager(node: string): WindowsNpmManager {
  if (process.platform !== 'win32' || !path.isAbsolute(node)) throw new Error('Windows npm manager inspection requires an absolute Node path')
  const powershell = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(WINDOWS_NPM_MANAGER_CHECK, 'utf16le').toString('base64')], {
    env: { ...process.env, NOTIFAI_MANAGER_NODE: node }, windowsHide: true,
    encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const value = JSON.parse(output) as WindowsNpmManager
  if (!value || !path.isAbsolute(value.node) || !path.isAbsolute(value.npm) ||
      !/^11\.\d+\.\d+$/.test(value.version) || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Invalid npm manager inspection')
  return value
}
