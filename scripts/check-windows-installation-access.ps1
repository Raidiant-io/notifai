param([Parameter(Mandatory=$true)][string]$Launcher)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('notifai-acl-proof-' + [Guid]::NewGuid().ToString('N'))
function Run-Launcher([string[]]$Arguments) {
  $saved = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $diagnostic = & $Launcher @Arguments 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) { Write-Host ("Launcher exit {0}: {1}" -f $code, ($diagnostic -join [Environment]::NewLine)) }
    return $code
  }
  finally { $ErrorActionPreference = $saved }
}
function Require($condition, [string]$message) { if (-not $condition) { throw $message } }
function Require-Rejected([scriptblock]$Operation, [string]$Message) {
  $rejected = $false
  try { & $Operation } catch { $rejected = $true }
  Require $rejected $Message
}
function Descriptor([string]$file) {
  (Get-Acl -LiteralPath $file).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
}
try {
  # Inspect the actual OS profile without changing its owner or ACL. Windows
  # can create it under SYSTEM even when the process token defaults to User.
  $accountHome = Get-NotifaiAccountHome
  $profileBefore = Descriptor $accountHome
  Assert-NotifaiPathAccess $accountHome -AccountHome
  Require ($profileBefore -ceq (Descriptor $accountHome)) 'Profile inspection changed security'
  Require ((Run-Launcher @('--internal-private-directory', $root)) -eq 0) 'Could not create fixture parent'
  Require-Rejected { Assert-NotifaiPathAccess $root -AccountHome } 'Profile exception must reject a different directory'
  $directory = Join-Path $root 'existing'
  [void](New-Item -ItemType Directory -Path $directory)
  # npm leaves ordinary inherited ACLs and the creating token's default owner.
  # Inspect those objects without repairing security merely to pass validation.
  $packageFile = Join-Path $directory 'package.json'
  [IO.File]::WriteAllText($packageFile, '{}')
  $packageDirectoryBefore = Descriptor $directory
  $packageFileBefore = Descriptor $packageFile
  Require ((Run-Launcher @('--internal-check-package-directory', $directory)) -eq 0) 'Ordinary npm directory must pass'
  Require ((Run-Launcher @('--internal-check-package-file', $packageFile)) -eq 0) 'Ordinary npm file must pass'
  Assert-NotifaiPathAccess $directory -AllowDefaultOwner
  Assert-NotifaiPathAccess $packageFile -AllowDefaultOwner
  Require-Rejected { Assert-NotifaiPathAccess $directory -RequireProtected } 'Bootstrap managed directory checks must remain strict'
  Require ($packageDirectoryBefore -ceq (Descriptor $directory)) 'Package inspection changed directory security'
  Require ($packageFileBefore -ceq (Descriptor $packageFile)) 'Package inspection changed file security'
  Require ((Run-Launcher @('--internal-check-private-directory', $directory)) -ne 0) 'npm admission must not weaken managed directory checks'
  # A foreign owner must not become trusted just because its DACL is safe.
  & "$env:SystemRoot\System32\icacls.exe" $packageFile '/setowner' '*S-1-5-18' | Out-Null
  Require ($LASTEXITCODE -eq 0) 'Could not establish foreign package owner'
  $foreignBefore = Descriptor $packageFile
  Require ((Run-Launcher @('--internal-check-package-file', $packageFile)) -ne 0) 'Foreign-owned npm file must fail'
  Require-Rejected { Assert-NotifaiPathAccess $packageFile -AllowDefaultOwner } 'Bootstrap must reject foreign npm owner'
  Require ($foreignBefore -ceq (Descriptor $packageFile)) 'Refused package inspection changed owner'
  # Hosted administrator accounts can default newly created objects to the
  # Administrators owner. The fixture deliberately models current-User ownership.
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & "$env:SystemRoot\System32\icacls.exe" $directory '/setowner' "*$sid" | Out-Null
  Require ($LASTEXITCODE -eq 0) 'Could not establish fixture owner'
  $nested = Join-Path $directory 'nested'
  [void](New-Item -ItemType Directory -Path $nested)
  $file = Join-Path $nested 'preserved.txt'
  [IO.File]::WriteAllText($file, 'preserve contents and descriptor')
  $beforeRoot = Get-Acl -LiteralPath $directory
  Require (-not $beforeRoot.AreAccessRulesProtected) 'Fixture must begin with inherited access'
  $nestedBefore = Descriptor $nested
  $fileBefore = Descriptor $file
  Require ((Run-Launcher @('--internal-check-private-directory', $directory)) -ne 0) 'Unprotected directory must fail ordinary checks'
  $stateBefore = Descriptor $directory
  Require ((Run-Launcher @('--internal-check-state-directory', $directory)) -eq 0) 'Owned state with inherited safe writers must pass'
  Require ($stateBefore -ceq (Descriptor $directory)) 'State inspection changed security'
  Require ((Run-Launcher @('--internal-protect-existing-directory', $directory)) -eq 0) 'Existing safe directory must migrate'
  Require ((Run-Launcher @('--internal-check-private-directory', $directory)) -eq 0) 'Migrated directory must pass ordinary checks'
  $afterRoot = Get-Acl -LiteralPath $directory
  Require ($afterRoot.AreAccessRulesProtected) 'Root DACL must be protected'
  Require ($beforeRoot.Owner -eq $afterRoot.Owner) 'Root ownership changed'
  Require ($nestedBefore -ceq (Descriptor $nested)) 'Nested directory security changed'
  Require ($fileBefore -ceq (Descriptor $file)) 'Existing file security changed'
  Require ([IO.File]::ReadAllText($file) -ceq 'preserve contents and descriptor') 'Existing contents changed'
  $protected = Descriptor $directory
  Require ((Run-Launcher @('--internal-protect-existing-directory', $directory)) -eq 0) 'Repeated migration must converge'
  Require ($protected -ceq (Descriptor $directory)) 'Repeated migration changed security'
  & "$env:SystemRoot\System32\icacls.exe" $directory '/grant' '*S-1-1-0:(OI)(CI)F' | Out-Null
  Require ($LASTEXITCODE -eq 0) 'Could not create unsafe fixture'
  $unsafeBefore = Descriptor $directory
  Require ((Run-Launcher @('--internal-protect-existing-directory', $directory)) -ne 0) 'Unsafe writers must be refused'
  Require ((Run-Launcher @('--internal-check-state-directory', $directory)) -ne 0) 'State inspection must reject unsafe writers'
  Require ((Run-Launcher @('--internal-check-package-directory', $directory)) -ne 0) 'npm inspection must reject unsafe writers'
  Require-Rejected { Assert-NotifaiPathAccess $directory -AllowDefaultOwner } 'Bootstrap must reject unsafe npm writers'
  Require ($unsafeBefore -ceq (Descriptor $directory)) 'Refused migration modified security'
  @{ ok=$true; checks=@('protect-existing-directory','preserve-child-security','reject-unsafe-writers','idempotent-protection','npm-inherited-access','npm-default-owner','npm-foreign-owner','npm-read-only-inspection') } | ConvertTo-Json -Compress
} finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
