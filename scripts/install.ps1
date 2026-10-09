#requires -Version 5.1
<# First execution trusts the HTTPS release channel. Hash checks detect changed
   downloads; the installed verifier authenticates subsequent updates. This
   script never changes execution policy or requires an installed Node runtime. #>
[CmdletBinding()]
param(
  [string]$Version,
  [ValidateSet('stable', 'beta')][string]$Channel,
  [switch]$Json,
  [switch]$NoInit,
  [switch]$NoPath,
  [switch]$MigrateNpm
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-NotifaiVersion([string]$Value) {
  return $Value.Length -le 100 -and $Value -cmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
}
function Get-NotifaiHash([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}
function Get-NotifaiDownload([string]$Url, [string]$Destination, [long]$Limit) {
  $uri = [Uri]$Url
  for ($redirect = 0; $redirect -le 5; $redirect++) {
    if ($uri.Scheme -cne 'https' -or -not $uri.IsDefaultPort -or $uri.UserInfo -or
        $uri.Host -notin @('github.com', 'raw.githubusercontent.com', 'release-assets.githubusercontent.com')) {
      throw 'Release download left its trusted HTTPS origins'
    }
    $request = [Net.HttpWebRequest]::Create($uri)
    $request.AllowAutoRedirect = $false
    $request.Timeout = 30000
    $request.ReadWriteTimeout = 30000
    $request.UserAgent = 'notifai-installer'
    $response = $request.GetResponse()
    try {
      $status = [int]$response.StatusCode
      if ($status -in @(301, 302, 303, 307, 308)) {
        if ($redirect -eq 5 -or -not $response.Headers['Location']) { throw 'Release download has too many redirects' }
        $uri = [Uri]::new($uri, $response.Headers['Location'])
        continue
      }
      if ($status -ne 200 -or $response.ContentLength -gt $Limit) { throw 'Release download was unavailable or too large' }
      $inputStream = $response.GetResponseStream()
      $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        $buffer = New-Object byte[] 65536
        [long]$total = 0
        while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $total += $count
          if ($total -gt $Limit) { throw 'Release download exceeded its size limit' }
          $outputStream.Write($buffer, 0, $count)
        }
        $outputStream.Flush($true)
      } finally { $outputStream.Dispose(); $inputStream.Dispose() }
      return
    } finally { $response.Dispose() }
  }
}
function Read-NotifaiChannel([string]$File, [string]$SelectedChannel) {
  $lines = [IO.File]::ReadAllLines($File)
  if ($lines.Length -lt 1 -or $lines.Length -gt 1001) { throw 'Invalid channel metadata' }
  $header = $lines[0].Split([char]9)
  if ($header.Length -ne 5 -or $header[0] -cne 'notifai-channel-v1' -or $header[1] -cne $SelectedChannel -or
      $header[2] -cnotmatch '^[1-9][0-9]{0,15}$' -or -not (Test-NotifaiVersion $header[3]) -or $header[4] -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Invalid channel metadata'
  }
  $withdrawn = @()
  for ($i = 1; $i -lt $lines.Length; $i++) {
    $fields = $lines[$i].Split([char]9)
    if ($fields.Length -ne 2 -or $fields[0] -cne 'withdrawn' -or -not (Test-NotifaiVersion $fields[1])) { throw 'Invalid channel withdrawal' }
    $withdrawn += $fields[1]
  }
  if ($header[3] -cin $withdrawn -or ($SelectedChannel -eq 'stable' -and $header[3].Split('+')[0].Contains('-'))) { throw 'Channel recommends an ineligible release' }
  return @{ Version = $header[3]; InventoryHash = $header[4]; Withdrawn = $withdrawn }
}
function Read-NotifaiArtifact([string]$File, [string]$SelectedVersion, [string]$Target) {
  $lines = [IO.File]::ReadAllLines($File)
  if ($lines.Length -lt 2 -or $lines.Length -gt 7) { throw 'Invalid release metadata' }
  $header = $lines[0].Split([char]9)
  if ($header.Length -ne 3 -or $header[0] -cne 'notifai-bootstrap-v1' -or $header[1] -cne $SelectedVersion -or $header[2] -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Release metadata identity differs'
  }
  $found = $null
  $seen = @{}
  for ($i = 1; $i -lt $lines.Length; $i++) {
    $fields = $lines[$i].Split([char]9)
    if ($fields.Length -ne 7 -or $fields[0] -cne 'artifact' -or
        $fields[1] -cnotmatch '^bun-(darwin|linux|windows)-(arm64|x64)$' -or $seen.ContainsKey($fields[1]) -or
        $fields[3] -cnotmatch '^[1-9][0-9]{0,8}$' -or [long]$fields[3] -gt 268435456 -or
        $fields[4] -cnotmatch '^[a-f0-9]{64}$' -or $fields[5] -cnotmatch '^[a-f0-9]{64}$' -or $fields[6] -cnotmatch '^[a-f0-9]{64}$') {
      throw 'Invalid release artifact metadata'
    }
    $suffix = if ($fields[1].StartsWith('bun-windows-')) { 'zip' } else { 'tar.gz' }
    if ($fields[2] -cne "notifai-$SelectedVersion-$($fields[1].Substring(4)).$suffix") { throw 'Invalid release artifact filename' }
    $seen[$fields[1]] = $true
    if ($fields[1] -ceq $Target) {
      $found = @{ Filename = $fields[2]; Bytes = [long]$fields[3]; Hash = $fields[4]; LauncherHash = $fields[5]; RuntimeHash = $fields[6]; InventoryHash = $header[2] }
    }
  }
  if ($null -eq $found) { throw 'This release does not support the native Windows architecture' }
  return $found
}
function Expand-NotifaiArchive([string]$Archive, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    if ($zip.Entries.Count -lt 2 -or $zip.Entries.Count -gt 130) { throw 'Invalid release archive entry count' }
    $seen = @{}
    [long]$expanded = 0
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName
      if ($name.Length -gt 240 -or $name.Split('/').Length -gt 8) { throw 'Invalid release archive path' }
      foreach ($part in $name.Split('/')) {
        if ($part -cnotmatch '^[A-Za-z0-9_-][A-Za-z0-9._-]*$' -or $part.EndsWith('.') -or $part -imatch '^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)') { throw 'Unsafe release archive path' }
      }
      $type = ($entry.ExternalAttributes -shr 16) -band 61440
      if ($type -notin @(0, 32768) -or $seen.ContainsKey($name) -or $entry.Length -gt 536870912) { throw 'Unsafe release archive member' }
      foreach ($prior in $seen.Keys) {
        if ($name.StartsWith("$prior/", [StringComparison]::OrdinalIgnoreCase) -or $prior.StartsWith("$name/", [StringComparison]::OrdinalIgnoreCase)) { throw 'Conflicting release archive paths' }
      }
      $seen[$name] = $true
      $expanded += $entry.Length
      if ($expanded -gt 805306368) { throw 'Expanded release archive exceeds its size limit' }
    }
    if (-not $seen.ContainsKey('notifai.exe') -or -not $seen.ContainsKey('notifai-runtime.exe')) { throw 'Release executables are missing' }
    [void][IO.Directory]::CreateDirectory($Destination)
    foreach ($entry in $zip.Entries) {
      $file = [IO.Path]::Combine($Destination, $entry.FullName.Replace('/', [IO.Path]::DirectorySeparatorChar))
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))
      $inputStream = $entry.Open()
      $outputStream = [IO.File]::Open($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        $buffer = New-Object byte[] 65536
        [long]$total = 0
        while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $total += $count
          if ($total -gt $entry.Length) { throw 'Release archive member exceeded its declared size' }
          $outputStream.Write($buffer, 0, $count)
        }
        if ($total -ne $entry.Length) { throw 'Release archive member is truncated' }
        $outputStream.Flush($true)
      } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
  } finally { $zip.Dispose() }
}
function Get-NotifaiWindowsTarget {
  if (-not ('NotifaiBootstrap.Native' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace NotifaiBootstrap {
  public static class Native {
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);
  }
}
'@
  }
  [UInt16]$processMachine = 0
  [UInt16]$nativeMachine = 0
  if (-not [NotifaiBootstrap.Native]::IsWow64Process2([IntPtr](-1), [ref]$processMachine, [ref]$nativeMachine)) { throw 'Cannot establish native Windows architecture' }
  switch ($nativeMachine) {
    34404 { return 'bun-windows-x64' }
    43620 { return 'bun-windows-arm64' }
    default { throw 'This native Windows architecture is not supported' }
  }
}
function Get-NotifaiAccessControl([string]$File, [IO.FileAttributes]$Attributes) {
  $info = if (($Attributes -band [IO.FileAttributes]::Directory) -ne 0) { [IO.DirectoryInfo]::new($File) } else { [IO.FileInfo]::new($File) }
  # Keep this bootstrap lookup independent of filesystem/security cmdlet
  # module discovery. Windows PowerShell and PowerShell use different .NET APIs.
  if ($PSVersionTable.PSEdition -eq 'Desktop') { return $info.GetAccessControl() }
  return [IO.FileSystemAclExtensions]::GetAccessControl($info)
}
function New-NotifaiPrivateDirectory([string]$Directory) {
  if ([IO.Directory]::Exists($Directory) -or [IO.File]::Exists($Directory)) { throw 'Installer temporary directory already exists' }
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $security = New-Object Security.AccessControl.DirectorySecurity
  $security.SetOwner($user)
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($user, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow)
    [void]$security.AddAccessRule($rule)
  }
  $overload = [IO.Directory].GetMethods() | Where-Object { $_.Name -eq 'CreateDirectory' -and $_.GetParameters().Length -eq 2 -and $_.GetParameters()[1].ParameterType -eq [Security.AccessControl.DirectorySecurity] }
  if ($overload) { [void][IO.Directory]::CreateDirectory($Directory, $security) }
  else { [IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($Directory), $security) }
  $attributes = [IO.File]::GetAttributes($Directory)
  $actual = Get-NotifaiAccessControl $Directory $attributes
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $actual.AreAccessRulesProtected -or
      $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Installer temporary directory is not privately owned' }
  foreach ($rule in $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) { throw 'Installer temporary directory permits another account' }
  }
}
function Invoke-NotifaiCandidate([string]$Launcher, [string[]]$NativeArgs) {
  & $Launcher @NativeArgs
  $script:NotifaiBootstrapExitCode = $LASTEXITCODE
}
function Get-NotifaiAccountHome {
  $accountHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  if (-not $accountHome -or -not [IO.Path]::IsPathRooted($accountHome)) { throw 'Cannot resolve this account home' }
  foreach ($value in @($env:USERPROFILE, $env:HOME)) {
    # Git Bash's POSIX HOME is not a Windows account relocation.
    if ($value -and $value -match '^(?:[A-Za-z]:[\\/]|\\\\)') {
      if (-not [String]::Equals([IO.Path]::GetFullPath($value).TrimEnd('\', '/'), $accountHome.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) { throw 'HOME or USERPROFILE differs from the OS account home' }
    }
  }
  return $accountHome
}
# Read-only inspection of an existing path. npm and the OS profile may use
# inherited ACLs and an elevated token's default owner; managed paths retain
# exact User ownership and, when requested, protected inheritance.
function Assert-NotifaiPathAccess([string]$File, [switch]$AllowDefaultOwner, [switch]$RequireProtected) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $user = $identity.User.Value
  $attributes = [IO.File]::GetAttributes($File)
  $acl = Get-NotifaiAccessControl $File $attributes
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $defaultOwner = $AllowDefaultOwner -and $identity.Owner.Value -eq 'S-1-5-32-544' -and $owner -eq $identity.Owner.Value
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      ($owner -ne $user -and -not $defaultOwner) -or
      ($RequireProtected -and -not $acl.AreAccessRulesProtected)) { throw 'Existing path is not privately owned; inspect it before repair' }
  $writes = [int64][Security.AccessControl.FileSystemRights]'Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership' -bor 0x50000000
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        ([int64]$rule.FileSystemRights -band $writes) -ne 0 -and
        $rule.IdentityReference.Value -notin @($user, 'S-1-5-18', 'S-1-5-32-544')) { throw 'Existing path permits another writer; inspect it before repair' }
  }
}
function Get-NotifaiInstalledCommand {
  $accountHome = Get-NotifaiAccountHome
  $managed = [IO.Path]::Combine($accountHome, '.notifai')
  $bin = [IO.Path]::Combine($managed, 'bin')
  $command = [IO.Path]::Combine($bin, 'notifai.exe')
  try { [void][IO.File]::GetAttributes($command) }
  catch [IO.FileNotFoundException] { return $null }
  catch [IO.DirectoryNotFoundException] { return $null }
  foreach ($file in @($accountHome, $managed, $bin, $command)) {
    Assert-NotifaiPathAccess $file -AllowDefaultOwner:($file -eq $accountHome) -RequireProtected:($file -eq $managed -or $file -eq $bin)
  }
  if (-not [IO.File]::Exists($command)) { throw 'Existing launcher is not a regular file; repair it explicitly' }
  return $command
}
function Get-NotifaiInstallArguments {
  $nativeArgs = @('install', '--source', 'powershell')
  if ($Channel) { $nativeArgs += @('--channel', $Channel) }
  if ($Version) { $nativeArgs += @('--version', $Version) }
  if ($Json) { $nativeArgs += '--json' }
  if ($NoInit) { $nativeArgs += '--no-init' }
  if ($NoPath) { $nativeArgs += '--no-path' }
  if ($MigrateNpm) { $nativeArgs += '--migrate-npm' }
  return $nativeArgs
}
function Invoke-NotifaiBootstrap {
  $selectedChannel = if ($Channel) { $Channel } else { 'stable' }
  if ($Version -and -not (Test-NotifaiVersion $Version)) { throw 'Version must be an exact semantic version' }
  $existing = Get-NotifaiInstalledCommand
  if ($existing) {
    Invoke-NotifaiCandidate $existing (Get-NotifaiInstallArguments)
    return
  }
  if ($selectedChannel -eq 'stable' -and $Version -and $Version.Split('+')[0].Contains('-')) { throw 'A prerelease requires -Channel beta' }
  $target = Get-NotifaiWindowsTarget
  $temporary = [IO.Path]::Combine([IO.Path]::GetTempPath(), "notifai-install-$([Guid]::NewGuid().ToString('N'))")
  New-NotifaiPrivateDirectory $temporary
  try {
    $channelFile = [IO.Path]::Combine($temporary, 'channel.tsv')
    Get-NotifaiDownload "https://raw.githubusercontent.com/Raidiant-io/notifai/release-metadata/$selectedChannel.bootstrap.tsv" $channelFile 262144
    $release = Read-NotifaiChannel $channelFile $selectedChannel
    $selectedVersion = if ($Version) { $Version } else { $release.Version }
    if ($selectedVersion -cin $release.Withdrawn) { throw 'The requested release has been withdrawn' }
    $base = "https://github.com/Raidiant-io/notifai/releases/download/v$selectedVersion"
    $artifactFile = [IO.Path]::Combine($temporary, 'bootstrap.tsv')
    Get-NotifaiDownload "$base/bootstrap.tsv" $artifactFile 262144
    $artifact = Read-NotifaiArtifact $artifactFile $selectedVersion $target
    if ($selectedVersion -ceq $release.Version -and $artifact.InventoryHash -cne $release.InventoryHash) { throw 'Channel and release inventory differ' }
    $inventory = [IO.Path]::Combine($temporary, 'inventory.json')
    Get-NotifaiDownload "$base/inventory.json" $inventory 262144
    if ((Get-NotifaiHash $inventory) -cne $artifact.InventoryHash) { throw 'Release inventory digest differs' }
    $archive = [IO.Path]::Combine($temporary, $artifact.Filename)
    Get-NotifaiDownload "$base/$($artifact.Filename)" $archive $artifact.Bytes
    if ((Get-Item -LiteralPath $archive).Length -ne $artifact.Bytes -or (Get-NotifaiHash $archive) -cne $artifact.Hash) { throw 'Release archive digest or size differs' }
    $extracted = [IO.Path]::Combine($temporary, 'release')
    Expand-NotifaiArchive $archive $extracted
    $launcher = [IO.Path]::Combine($extracted, 'notifai.exe')
    if ((Get-NotifaiHash $launcher) -cne $artifact.LauncherHash -or (Get-NotifaiHash ([IO.Path]::Combine($extracted, 'notifai-runtime.exe'))) -cne $artifact.RuntimeHash) { throw 'Release executable digests differ' }
    $nativeArgs = @(Get-NotifaiInstallArguments) + @('--directory', $extracted, '--inventory', $inventory)
    Invoke-NotifaiCandidate $launcher $nativeArgs
  } finally {
    if ([IO.Directory]::Exists($temporary)) {
      try { [IO.Directory]::Delete($temporary, $true) }
      catch { [Console]::Error.WriteLine("Temporary installer files remain at $temporary; remove them after running commands finish.") }
    }
  }
}
if ($MyInvocation.InvocationName -ne '.') {
  try { Invoke-NotifaiBootstrap; exit $script:NotifaiBootstrapExitCode }
  catch {
    if ($Json) { @{ ok = $false; code = 'bootstrap_failed'; message = $_.Exception.Message } | ConvertTo-Json -Compress }
    else { [Console]::Error.WriteLine("Notifai installation failed: $($_.Exception.Message)") }
    exit 1
  }
}
