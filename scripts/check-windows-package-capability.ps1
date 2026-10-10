param(
  [Parameter(Mandatory=$true)][string]$Launcher,
  [Parameter(Mandatory=$true)][string]$NpmPrefix
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
  @{ ok=$true; checks=@('registered-package-capability','package-file-and-directory','unchanged-acls',
    'strict-native-and-state','different-capability','ordinary-foreign-writer','sibling-prefix','outside-scope','reparse') } | ConvertTo-Json -Compress
} finally {
  $link = Join-Path $root 'linked'
  if ([IO.Directory]::Exists($link)) { [IO.Directory]::Delete($link) }
  foreach ($owned in @($root, $sibling, $outside)) {
    if ([IO.Directory]::Exists($owned)) { Remove-Item -LiteralPath $owned -Recurse -Force }
  }
  Require ($prefixBefore -ceq (Descriptor $NpmPrefix)) 'Proof changed existing npm prefix permissions'
}
