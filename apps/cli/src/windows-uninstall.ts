import path from 'node:path'

/** PowerShell waits outside the native runtime, so Windows can release both
 * executing images before removing the verified temporary copy. No scheduled
 * task, background service, execution-policy change or recursive deletion. */
export function windowsUninstallCommand(root: string, id: string, receiptHash: string): string {
  const encoded = Buffer.from(JSON.stringify({ directory: path.join(root, 'uninstall-tools', id), receiptHash })).toString('base64')
  return `& {
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Import-Module ([IO.Path]::Combine($PSHOME, 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'))
$c = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
function AssertFile($file, $expected) {
  $attrs = [IO.File]::GetAttributes($file)
  if (($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($attrs -band [IO.FileAttributes]::Directory) -ne 0) { throw 'Cleanup file is not a regular file' }
  $stream = [IO.File]::OpenRead($file); $sha = [Security.Cryptography.SHA256]::Create()
  try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose(); $stream.Dispose() }
  if ($actual -cne $expected) { throw 'Cleanup file changed; retain it for inspection' }
}
$directory = $c.directory
$parent = $directory
while ($parent) {
  if (([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Cleanup path is redirected' }
  $parent = [IO.Path]::GetDirectoryName($parent)
}
$receipt = [IO.Path]::Combine($directory, 'cleanup.json')
AssertFile $receipt $c.receiptHash
$s = [IO.File]::ReadAllText($receipt) | ConvertFrom-Json
$launcher = [IO.Path]::Combine($directory, 'notifai.exe')
$runtime = [IO.Path]::Combine($directory, 'notifai-runtime.exe')
$lockFile = [IO.Path]::Combine($directory, 'cleanup.lock')
if ([IO.File]::Exists($lockFile)) { AssertFile $lockFile 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }
$lock = [IO.File]::Open($lockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $journal = [IO.Path]::Combine($s.root, 'uninstall.json')
  if ([IO.File]::Exists($journal)) {
    AssertFile $launcher $s.launcherHash
    AssertFile $runtime $s.runtimeHash
    & $launcher uninstall --finish --installation-id $s.id --installation-root $s.root --json
    if ($LASTEXITCODE -ne 0) { throw 'Uninstall is incomplete; retry this command after other Notifai commands exit' }
  }
  if ([IO.File]::Exists($journal)) { throw 'Uninstall journal remains; retain recovery tools' }
  foreach ($name in $s.files) {
    $file = [IO.Path]::Combine($s.root, $name)
    if ([IO.File]::Exists($file) -or [IO.Directory]::Exists($file)) { throw 'Installation files remain; retain recovery tools' }
  }
  AssertFile $receipt $c.receiptHash
  foreach ($item in @(@{file=$runtime; hash=$s.runtimeHash}, @{file=$launcher; hash=$s.launcherHash})) {
    if ([IO.File]::Exists($item.file)) { AssertFile $item.file $item.hash; [IO.File]::Delete($item.file) }
  }
  [IO.File]::Delete($receipt)
} finally { $lock.Dispose() }
[IO.File]::Delete($lockFile)
if ([IO.Directory]::GetFileSystemEntries($directory).Length -eq 0) { [IO.Directory]::Delete($directory) }
Write-Output 'Notifai was uninstalled. Your configuration and session history were preserved.'
}`
}
