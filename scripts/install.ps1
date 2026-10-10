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
  [switch]$MigrateNpm,
  [switch]$Upgrade
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
function Add-NotifaiBootstrapType([string]$Source) {
  if ($PSVersionTable.PSEdition -ne 'Desktop') { Add-Type -TypeDefinition $Source -ErrorAction Stop; return }
  # Framework CodeDom passes csc an ANSI environment block. Keep its temporary
  # paths relative even when the User's profile/TEMP contains non-ANSI text.
  # Only this synchronous compiler invocation changes process-local cwd/env.
  $scratch = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'notifai-compiler-' + [Guid]::NewGuid().ToString('N'))
  New-NotifaiPrivateDirectory $scratch
  $previousDirectory = [Environment]::CurrentDirectory
  $previousTemp = $env:TEMP
  $previousTmp = $env:TMP
  $parameters = [CodeDom.Compiler.CompilerParameters]::new()
  $parameters.GenerateInMemory = $true
  [void]$parameters.ReferencedAssemblies.Add([ComponentModel.Win32Exception].Assembly.Location)
  $parameters.TempFiles = [CodeDom.Compiler.TempFileCollection]::new('.', $false)
  try {
    [Environment]::CurrentDirectory = $scratch
    $env:TEMP = '.'
    $env:TMP = '.'
    Add-Type -TypeDefinition $Source -CompilerParameters $parameters -ErrorAction Stop
  } finally {
    try { $parameters.TempFiles.Dispose() }
    finally {
      [Environment]::CurrentDirectory = $previousDirectory
      $env:TEMP = $previousTemp
      $env:TMP = $previousTmp
      [IO.Directory]::Delete($scratch, $true)
    }
  }
}
function Get-NotifaiWindowsTarget {
  if (-not ('NotifaiBootstrap.Native' -as [type])) {
    Add-NotifaiBootstrapType @'
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
# Read the descriptor and physical location through one non-following handle.
# Package capabilities restrict a User's access; they do not replace it.
# Only the registered package owning this current-User npm location is admitted.
function Get-NotifaiPathSecurity([string]$File, [bool]$Package) {
  if (-not ('NotifaiBootstrap.PathSecurity' -as [type])) {
    Add-NotifaiBootstrapType @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
namespace NotifaiBootstrap {
  public sealed class PathSecurity {
    public RawSecurityDescriptor Descriptor;
    public uint Attributes;
    public string Capability;
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, out TagInfo info, uint size);
    [DllImport("kernel32.dll")]
    static extern uint GetFileType(SafeFileHandle file);
    [StructLayout(LayoutKind.Sequential)] struct TagInfo { public uint Attributes; public uint Tag; }
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(SafeFileHandle file, int kind, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll")]
    static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)]
    static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
    static extern int GetPackagesByPackageFamily(string family, ref uint count, IntPtr names, ref uint size, IntPtr buffer);
    static SafeFileHandle Open(string file, uint access) {
      var handle = CreateFile(file, access, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
      if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(); }
      return handle;
    }
    static string Physical(SafeFileHandle handle) {
      var path = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandle(handle, path, 32768, 0);
      if (length == 0 || length >= 32768) throw new Win32Exception();
      return path.ToString();
    }
    static string PackageCapability(string physical) {
      string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      string prefix;
      using (var handle = Open(home, 0x80)) { prefix = Physical(handle).TrimEnd('\\') + @"\AppData\Local\Packages\"; }
      if (!physical.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
      string relative = physical.Substring(prefix.Length);
      int end = relative.IndexOf('\\');
      if (end <= 0 || end > 255) return null;
      string family = relative.Substring(0, end), tail = relative.Substring(end);
      const string npm = @"\LocalCache\Roaming\npm";
      if (!tail.Equals(npm, StringComparison.OrdinalIgnoreCase) && !tail.StartsWith(npm + @"\", StringComparison.OrdinalIgnoreCase)) return null;
      uint count = 0, size = 0;
      if (GetPackagesByPackageFamily(family, ref count, IntPtr.Zero, ref size, IntPtr.Zero) != 122 || count == 0 || size == 0) return null;
      IntPtr pointer;
      if (DeriveAppContainerSidFromAppContainerName(family, out pointer) != 0) return null;
      try {
        var sid = new SecurityIdentifier(pointer);
        byte[] bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
        if (bytes.Length != 40 || bytes[1] != 8 || BitConverter.ToUInt32(bytes, 8) != 2) return null;
        bytes[8] = 3;
        return new SecurityIdentifier(bytes, 0).Value;
      } finally { FreeSid(pointer); }
    }
    public static PathSecurity Read(string file, bool package) {
      using (var handle = Open(file, 0x20080)) {
        TagInfo info;
        if (GetFileType(handle) != 1 || !GetFileInformationByHandleEx(handle, 9, out info, 8) || (info.Attributes & 0x400) != 0) throw new IOException("Existing path is linked or not a disk object");
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try {
          uint length = GetSecurityDescriptorLength(descriptor);
          if (length == 0 || length > 1024 * 1024) throw new IOException("Invalid path security descriptor");
          byte[] bytes = new byte[length]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
          return new PathSecurity { Descriptor = new RawSecurityDescriptor(bytes, 0), Attributes = info.Attributes,
            Capability = package ? PackageCapability(Physical(handle)) : null };
        } finally { LocalFree(descriptor); }
      }
    }
  }
}
'@
  }
  return [NotifaiBootstrap.PathSecurity]::Read($File, $Package)
}
# Read-only inspection of an existing path. npm can inherit a token's default
# owner. The OS-confirmed profile can belong to Windows itself; this exception
# must never admit a system-owned npm package or managed installation path.
function Assert-NotifaiPathAccess([string]$File, [switch]$AllowDefaultOwner, [switch]$RequireProtected, [switch]$AccountHome) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $user = $identity.User.Value
  $security = Get-NotifaiPathSecurity $File $AllowDefaultOwner
  $attributes = [IO.FileAttributes]$security.Attributes
  $acl = $security.Descriptor
  if ($null -eq $acl.Owner -or $null -eq $acl.DiscretionaryAcl) { throw 'Existing path has no owner or discretionary access control' }
  $owner = $acl.Owner.Value
  $defaultOwner = $AllowDefaultOwner -and $identity.Owner.Value -eq 'S-1-5-32-544' -and $owner -eq $identity.Owner.Value
  $profileOwner = $false
  if ($AccountHome) {
    $expectedHome = Get-NotifaiAccountHome
    if (-not [String]::Equals([IO.Path]::GetFullPath($File).TrimEnd('\', '/'), $expectedHome.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase) -or
        ($attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'Account home access check requires the exact OS profile directory' }
    $profileOwner = $owner -in @('S-1-5-18', 'S-1-5-32-544')
  }
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      ($owner -ne $user -and -not $defaultOwner -and -not $profileOwner) -or
      ($RequireProtected -and ($acl.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0)) { throw 'Existing path is not privately owned; inspect it before repair' }
  $writes = [int64][Security.AccessControl.FileSystemRights]'Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership' -bor 0x50000000
  foreach ($rule in $acl.DiscretionaryAcl) {
    if ($rule.AceType -eq [Security.AccessControl.AceType]::AccessDenied) { continue }
    if ($rule.AceType -ne [Security.AccessControl.AceType]::AccessAllowed) { throw 'Existing path has unsupported access rules' }
    if (([int64]$rule.AccessMask -band $writes) -ne 0 -and
        $rule.SecurityIdentifier.Value -notin @($user, 'S-1-5-18', 'S-1-5-32-544', $security.Capability)) { throw 'Existing path permits another writer; inspect it before repair' }
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
    Assert-NotifaiPathAccess $file -AccountHome:($file -eq $accountHome) -RequireProtected:($file -eq $managed -or $file -eq $bin)
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
  if ($Upgrade) { $nativeArgs += '--upgrade' }
  return $nativeArgs
}
function Invoke-NotifaiBootstrap {
  $selectedChannel = if ($Channel) { $Channel } else { 'stable' }
  if ($Version -and -not (Test-NotifaiVersion $Version)) { throw 'Version must be an exact semantic version' }
  if ($Upgrade -and (-not $Version -or -not $Channel -or -not $NoInit -or -not $NoPath)) { throw 'Upgrade requires exact version, channel, no-init and no-path' }
  $existing = Get-NotifaiInstalledCommand
  if ($existing -and -not $Upgrade) {
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
