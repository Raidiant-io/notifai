param(
  [Parameter(Mandatory=$true)][string]$Launcher,
  [Parameter(Mandatory=$true)][string]$NpmPrefix,
  [string]$StateRoot
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install.ps1')
function Require($condition, [string]$message) { if (-not $condition) { throw $message } }
function Descriptor([string]$file) { (Get-Acl -LiteralPath $file).Sddl }
function Native([string]$operation, [string]$file) {
  $saved = $ErrorActionPreference
  try { $ErrorActionPreference = 'Continue'; & $Launcher $operation $file 2>&1 | Out-Null; return $LASTEXITCODE }
  finally { $ErrorActionPreference = $saved }
}
function Check([string]$file, [bool]$directory, [bool]$accepted) {
  $operation = if ($directory) { '--internal-check-package-directory' } else { '--internal-check-package-file' }
  Require (((Native $operation $file) -eq 0) -eq $accepted) "Native npm access differs: $file"
  $success = $false
  try { Assert-NotifaiPathAccess $file -AllowDefaultOwner; $success = $true } catch { if ($accepted) { throw } }
  Require ($success -eq $accepted) "PowerShell npm access differs: $file"
}
function Add-Writer([string]$file, [string]$sid) {
  $acl = Get-Acl -LiteralPath $file
  [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new($sid), [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $file -AclObject $acl
}
$security = Get-NotifaiPathSecurity $NpmPrefix $true
Require ($null -ne $security.Capability) 'This proof needs an existing npm prefix of a registered current-User package'
$prefixBefore = Descriptor $NpmPrefix
$tag = 'notifai-access-proof-' + [Guid]::NewGuid().ToString('N')
$root = Join-Path $NpmPrefix $tag
$sibling = $NpmPrefix + '-' + $tag
$outside = Join-Path ([IO.Path]::GetTempPath()) $tag
$stateFixture = if ($StateRoot) { Join-Path $StateRoot $tag } else { $null }
$stateSibling = if ($StateRoot) { $StateRoot + '-' + $tag } else { $null }
$stateBefore = if ($StateRoot) { Descriptor $StateRoot } else { $null }
try {
  Check $NpmPrefix $true $true
  [void][IO.Directory]::CreateDirectory($root)
  Check $root $true $true
  $file = Join-Path $root 'package.json'
  [IO.File]::WriteAllText($file, '{}')
  Check $file $false $true
  $before = Descriptor $file
  Require ((Native '--internal-check-state-file' $file) -ne 0) 'Capability exception must not apply to state'
  Require ((Native '--internal-check-private-file' $file) -ne 0) 'Capability exception must not apply to native installation'
  Require ($before -ceq (Descriptor $file)) 'Inspection changed package permissions'
  $saved = Get-Acl -LiteralPath $file
  $parts = $security.Capability.Split('-'); $parts[-1] = ([UInt32]$parts[-1] -bxor 1).ToString()
  Add-Writer $file ($parts -join '-')
  Check $file $false $false
  Set-Acl -LiteralPath $file -AclObject $saved
  Add-Writer $file 'S-1-1-0'
  Check $file $false $false
  Set-Acl -LiteralPath $file -AclObject $saved
  Check $file $false $true
  [void][IO.Directory]::CreateDirectory($sibling)
  Add-Writer $sibling $security.Capability
  Check $sibling $true $false
  [void][IO.Directory]::CreateDirectory($outside)
  Add-Writer $outside $security.Capability
  Check $outside $true $false
  $link = Join-Path $root 'linked'
  & "$env:SystemRoot\System32\cmd.exe" /d /c mklink /J $link $outside | Out-Null
  Require ($LASTEXITCODE -eq 0) 'Could not create the owned reparse fixture'
  Check $link $true $false
  [IO.Directory]::Delete($link)
  if ($StateRoot) {
    Require ((Native '--internal-check-state-directory' $StateRoot) -eq 0) 'Registered package state root must pass'
    [void][IO.Directory]::CreateDirectory($stateFixture)
    $stateFile = Join-Path $stateFixture 'owned.json'
    [IO.File]::WriteAllText($stateFile, '{}')
    Require ((Native '--internal-check-state-directory' $stateFixture) -eq 0) 'Registered package state directory must pass'
    Require ((Native '--internal-check-state-file' $stateFile) -eq 0) 'Registered package state file must pass'
    Require ((Native '--internal-check-private-file' $stateFile) -ne 0) 'State exception must not apply to native installation'
    Check $stateFile $false $false
    $savedState = Get-Acl -LiteralPath $stateFile
    foreach ($writer in @(($parts -join '-'), 'S-1-1-0')) {
      Add-Writer $stateFile $writer
      Require ((Native '--internal-check-state-file' $stateFile) -ne 0) 'State must refuse unrelated writers'
      Set-Acl -LiteralPath $stateFile -AclObject $savedState
    }
    [void][IO.Directory]::CreateDirectory($stateSibling)
    Add-Writer $stateSibling $security.Capability
    Require ((Native '--internal-check-state-directory' $stateSibling) -ne 0) 'State must refuse sibling namespaces'
    $stateLink = Join-Path $stateFixture 'linked'
    & "$env:SystemRoot\System32\cmd.exe" /d /c mklink /J $stateLink $outside | Out-Null
    Require ($LASTEXITCODE -eq 0) 'Could not create state reparse fixture'
    Require ((Native '--internal-check-state-directory' $stateLink) -ne 0) 'State must refuse reparse objects'
    [IO.Directory]::Delete($stateLink)
  }
  @{ ok=$true; checks=@('registered-package-capability','package-file-and-directory','unchanged-acls',
    'cross-scope-rejection','different-capability','ordinary-foreign-writer','sibling-prefix','outside-scope','reparse');
    packaged_state_checked=[bool]$StateRoot } | ConvertTo-Json -Compress
} finally {
  $link = Join-Path $root 'linked'
  if ([IO.Directory]::Exists($link)) { [IO.Directory]::Delete($link) }
  if ($stateFixture) {
    $stateLink = Join-Path $stateFixture 'linked'
    if ([IO.Directory]::Exists($stateLink)) { [IO.Directory]::Delete($stateLink) }
  }
  foreach ($owned in @($root, $sibling, $outside, $stateFixture, $stateSibling)) {
    if ($owned -and [IO.Directory]::Exists($owned)) { Remove-Item -LiteralPath $owned -Recurse -Force }
  }
  Require ($prefixBefore -ceq (Descriptor $NpmPrefix)) 'Proof changed existing npm prefix permissions'
  if ($StateRoot) { Require ($stateBefore -ceq (Descriptor $StateRoot)) 'Proof changed existing state root permissions' }
}
exit 0
