$ErrorActionPreference = 'Stop'
$version = '7.6.7'
$arch = node -p process.arch
$hashes = @{
  arm64 = '119bd9221254ef3637523cb1990797618f5fd68848b57de40f12b561d743149e'
  x64 = 'd2f952ebdbf24386cb8923553aa58e41a846db35a6155ea04c58142a4b16dbb7'
}
if (-not $hashes.ContainsKey($arch)) { throw "Unsupported test architecture: $arch" }
$archive = Join-Path $env:RUNNER_TEMP 'test-powershell.zip'
$destination = Join-Path $env:RUNNER_TEMP 'test-powershell'
Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri "https://github.com/PowerShell/PowerShell/releases/download/v$version/PowerShell-$version-win-$arch.zip" -OutFile $archive
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hashes[$arch]) { throw 'Pinned shell hash differs' }
Expand-Archive -Path $archive -DestinationPath $destination
$executable = Join-Path $destination 'pwsh.exe'
$dumps = Join-Path $env:RUNNER_TEMP 'shell-crash-dumps'
New-Item -ItemType Directory -Force -Path $dumps | Out-Null
$key = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\pwsh.exe'
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name DumpFolder -Value $dumps -PropertyType ExpandString -Force | Out-Null
New-ItemProperty -Path $key -Name DumpType -Value 2 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $key -Name DumpCount -Value 4 -PropertyType DWord -Force | Out-Null
"NOTIFAI_TEST_PWSH=$executable" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
& $executable -NoProfile -NonInteractive -Command '$PSVersionTable; [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription'
if ($LASTEXITCODE -ne 0) { throw 'Pinned shell runtime preflight failed' }
Remove-Item -Force $archive
