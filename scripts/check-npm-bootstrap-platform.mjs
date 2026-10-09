#!/usr/bin/env node
// Read the hosted runner's OS identity; create only a unique temporary folder.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from './cross-platform.mjs'

// The source helper is staged with its canonical PowerShell data file. This
// is source-platform evidence; the generated bundled entrypoint has its own gate.
const staged = mkdtempSync(path.join(os.tmpdir(), 'notifai-npm-platform-source-'))
mkdirSync(path.join(staged, 'lib'))
mkdirSync(path.join(staged, 'data'))
copyFileSync(path.join(repositoryRoot, 'apps/cli/npm/platform.mjs'), path.join(staged, 'lib/platform.mjs'))
copyFileSync(path.join(repositoryRoot, 'scripts/install.ps1'), path.join(staged, 'data/install.ps1'))
const { nativePlatform } = await import(pathToFileURL(path.join(staged, 'lib/platform.mjs')).href)
if (process.platform === 'win32') {
  // Classify only the disposable runner's profile security, without emitting
  // account identifiers or changing the profile to make installation pass.
  const diagnostic = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $PSModuleAutoLoadingPreference='None'; Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')); $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $profile=[Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile); $acl=([IO.DirectoryInfo]::new($profile)).GetAccessControl(); $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; [ordered]@{profileOwnerIsUser=($owner -eq $identity.User.Value); profileOwnerIsTokenDefault=($owner -eq $identity.Owner.Value); profileOwnerIsSystem=($owner -eq 'S-1-5-18'); profileOwnerIsAdministrators=($owner -eq 'S-1-5-32-544'); tokenDefaultIsAdministrators=($identity.Owner.Value -eq 'S-1-5-32-544'); profileIsReparsePoint=(([IO.File]::GetAttributes($profile) -band [IO.FileAttributes]::ReparsePoint) -ne 0); profileRulesProtected=$acl.AreAccessRulesProtected} | ConvertTo-Json -Compress`
  console.log(execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(diagnostic, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 30_000 }).trim())
}
const platform = nativePlatform()
assert.equal(platform.existingCommand(), null, 'Hosted bootstrap proof requires a clean runner with no existing native installation')
assert.equal(platform.target(), process.argv[2], 'npm bootstrap must select the native runner target')
const fixture = mkdtempSync(path.join(os.tmpdir(), "notifai npm δ🚀 ' & "))
const originalTemp = process.env.TEMP, originalTmp = process.env.TMP
let temporary
try {
  if (process.platform === 'win32') { process.env.TEMP = fixture; process.env.TMP = fixture }
  temporary = platform.temporaryDirectory()
  const stat = lstatSync(temporary)
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink())
  if (process.platform !== 'win32') assert.ok(stat.uid === process.getuid() && (stat.mode & 0o077) === 0)
  // The Windows helper verifies its private owner/DACL before returning.
  console.log(JSON.stringify({ ok: true, target: process.argv[2], checks: ['os-account-home', 'native-target', 'private-temporary-directory'] }))
} finally {
  if (originalTemp === undefined) delete process.env.TEMP; else process.env.TEMP = originalTemp
  if (originalTmp === undefined) delete process.env.TMP; else process.env.TMP = originalTmp
  if (temporary) rmSync(temporary, { recursive: true, force: true })
  rmSync(fixture, { recursive: true, force: true })
  rmSync(staged, { recursive: true, force: true })
}
