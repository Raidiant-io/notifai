#requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/install.ps1"
function Assert-Bootstrap([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Expect-Rejection([scriptblock]$Work) {
  $rejected = $false
  try { & $Work | Out-Null } catch { $rejected = $true }
  Assert-Bootstrap $rejected 'Malformed bootstrap input was accepted'
}
$root = [IO.Path]::Combine([IO.Path]::GetTempPath(), "notifai-bootstrap-check-$([Guid]::NewGuid().ToString('N'))")
New-NotifaiPrivateDirectory $root
try {
  Assert-Bootstrap ([IO.Directory]::Exists((Get-NotifaiAccountHome))) 'Account home lookup failed'
  $script:bootstrapAccountHome = $root
  function Get-NotifaiAccountHome { return $script:bootstrapAccountHome }
  $target = Get-NotifaiWindowsTarget
  Assert-Bootstrap ($target -in @('bun-windows-x64', 'bun-windows-arm64')) 'Native target lookup failed'
  $inventory = [IO.Path]::Combine($root, 'inventory.json')
  [IO.File]::WriteAllText($inventory, 'fixture inventory bytes', [Text.UTF8Encoding]::new($false))
  $inventoryHash = Get-NotifaiHash $inventory
  $channelFile = [IO.Path]::Combine($root, 'stable.tsv')
  [IO.File]::WriteAllText($channelFile, "notifai-channel-v1`tstable`t1`t1.0.0`t$inventoryHash`nwithdrawn`t0.9.0`n")
  $parsedChannel = Read-NotifaiChannel $channelFile 'stable'
  Assert-Bootstrap ($parsedChannel.Version -ceq '1.0.0' -and $parsedChannel.Withdrawn[0] -ceq '0.9.0') 'Channel parsing changed the selected release'
  Expect-Rejection { Read-NotifaiChannel $channelFile 'beta' }
  $archive = [IO.Path]::Combine($root, 'fixture.zip')
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($name in @('notifai.exe', 'notifai-runtime.exe', 'licenses/NOTICE.txt')) {
      $entry = $zip.CreateEntry($name)
      $entry.ExternalAttributes = -2119958528
      $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
      try { $writer.Write("fixture $name") } finally { $writer.Dispose() }
    }
  } finally { $zip.Dispose() }
  $unpacked = [IO.Path]::Combine($root, 'unpacked')
  Expand-NotifaiArchive $archive $unpacked
  Assert-Bootstrap ([IO.File]::ReadAllText([IO.Path]::Combine($unpacked, 'licenses/NOTICE.txt')) -ceq 'fixture licenses/NOTICE.txt') 'Archive extraction changed material bytes'
  $artifactFile = [IO.Path]::Combine($root, 'bootstrap.tsv')
  $filename = "notifai-1.0.0-$($target.Substring(4)).zip"
  $size = (Get-Item -LiteralPath $archive).Length
  $archiveHash = Get-NotifaiHash $archive
  $launcherHash = Get-NotifaiHash ([IO.Path]::Combine($unpacked, 'notifai.exe'))
  $runtimeHash = Get-NotifaiHash ([IO.Path]::Combine($unpacked, 'notifai-runtime.exe'))
  [IO.File]::WriteAllText($artifactFile, "notifai-bootstrap-v1`t1.0.0`t$inventoryHash`nartifact`t$target`t$filename`t$size`t$archiveHash`t$launcherHash`t$runtimeHash`n")
  $artifact = Read-NotifaiArtifact $artifactFile '1.0.0' $target
  Assert-Bootstrap ($artifact.Bytes -eq $size -and $artifact.LauncherHash -ceq $launcherHash) 'Artifact identity parsing differs'
  Expect-Rejection { Read-NotifaiArtifact $artifactFile '2.0.0' $target }
  $unsafe = [IO.Path]::Combine($root, 'unsafe.zip')
  $zip = [IO.Compression.ZipFile]::Open($unsafe, [IO.Compression.ZipArchiveMode]::Create)
  try { [void]$zip.CreateEntry('../escape'); [void]$zip.CreateEntry('notifai.exe') } finally { $zip.Dispose() }
  Expect-Rejection { Expand-NotifaiArchive $unsafe ([IO.Path]::Combine($root, 'unsafe-output')) }
  Assert-Bootstrap (-not [IO.Directory]::Exists([IO.Path]::Combine($root, 'unsafe-output'))) 'Unsafe archive caused extraction before validation'
  # Exercise the complete bootstrap orchestration without network or executing
  # test file contents. Production has no URL/key/root override.
  $script:bootstrapFixtureInputs = @{ Channel = $channelFile; Artifact = $artifactFile; Inventory = $inventory; Archive = $archive }
  function Get-NotifaiDownload([string]$Url, [string]$Destination, [long]$Limit) {
    $source = switch -Regex ($Url) {
      '/stable.bootstrap.tsv$' { $script:bootstrapFixtureInputs.Channel; break }
      '/bootstrap.tsv$' { $script:bootstrapFixtureInputs.Artifact; break }
      '/inventory.json$' { $script:bootstrapFixtureInputs.Inventory; break }
      '/notifai-1.0.0-windows-(arm64|x64).zip$' { $script:bootstrapFixtureInputs.Archive; break }
      default { throw 'Unexpected download route' }
    }
    Assert-Bootstrap ((Get-Item -LiteralPath $source).Length -le $Limit) 'Download limit differs'
    [IO.File]::Copy($source, $Destination, $false)
  }
  $script:launches = 0
  function Invoke-NotifaiCandidate([string]$Launcher, [string[]]$NativeArgs) {
    $script:launches++
    Assert-Bootstrap ((Get-NotifaiHash $Launcher) -ceq $launcherHash) 'Executed launcher did not match admitted bytes'
    Assert-Bootstrap ($NativeArgs[0] -ceq 'install' -and $NativeArgs[2] -ceq 'powershell') 'Wrong native command'
    Assert-Bootstrap ($NativeArgs -ccontains '--no-init' -and $NativeArgs -ccontains '--no-path' -and $NativeArgs -ccontains '--json') 'Installer flags were lost'
    $script:NotifaiBootstrapExitCode = 0
  }
  $Json = $true; $NoInit = $true; $NoPath = $true
  Invoke-NotifaiBootstrap
  Assert-Bootstrap ($script:launches -eq 1 -and $script:NotifaiBootstrapExitCode -eq 0) 'Bootstrap did not launch exactly once'
  [IO.File]::AppendAllText($archive, 'tampered')
  Expect-Rejection { Invoke-NotifaiBootstrap }
  Assert-Bootstrap ($script:launches -eq 1) 'Tampered download reached execution'
  # Rerunning setup reuses the owned command even when transport fixtures are
  # invalid. The native Installation owns signature checks and channel policy.
  $managed = [IO.Path]::Combine($root, '.notifai')
  $bin = [IO.Path]::Combine($managed, 'bin')
  New-NotifaiPrivateDirectory $managed
  New-NotifaiPrivateDirectory $bin
  $installed = [IO.Path]::Combine($bin, 'notifai.exe')
  [IO.File]::Copy([IO.Path]::Combine($unpacked, 'notifai.exe'), $installed)
  $acl = Get-Acl -LiteralPath $installed
  $acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
  Set-Acl -LiteralPath $installed -AclObject $acl
  Assert-Bootstrap ((Get-NotifaiInstalledCommand) -ceq $installed) 'Owned command was not selected'
  Invoke-NotifaiBootstrap
  Assert-Bootstrap ($script:launches -eq 2) 'Existing installation was not resumed offline'
  $acl = Get-Acl -LiteralPath $bin
  $unsafeRule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
  [void]$acl.AddAccessRule($unsafeRule)
  Set-Acl -LiteralPath $bin -AclObject $acl
  Expect-Rejection { Invoke-NotifaiBootstrap }
  Assert-Bootstrap ($script:launches -eq 2) 'Unsafe owned-command path reached execution'

  Write-Output "PowerShell bootstrap checks passed ($target; no live downloads or installation)."
} finally { [IO.Directory]::Delete($root, $true) }
