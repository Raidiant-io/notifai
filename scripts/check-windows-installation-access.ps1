param([Parameter(Mandatory=$true)][string]$Launcher)
$ErrorActionPreference = 'Stop'
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
function Descriptor([string]$file) {
  (Get-Acl -LiteralPath $file).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
}
try {
  Require ((Run-Launcher @('--internal-private-directory', $root)) -eq 0) 'Could not create fixture parent'
  $directory = Join-Path $root 'existing'
  [void](New-Item -ItemType Directory -Path $directory)
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
  Require ($unsafeBefore -ceq (Descriptor $directory)) 'Refused migration modified security'
  @{ ok=$true; checks=@('protect-existing-directory','preserve-child-security','reject-unsafe-writers','idempotent-protection') } | ConvertTo-Json -Compress
} finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
