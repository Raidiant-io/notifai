import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function powershell(operation, data = {}) {
  const script = fileURLToPath(new URL('./data/install.ps1', import.meta.url)).replaceAll("'", "''")
  const code = `$ErrorActionPreference='Stop'; . '${script}'; $inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json; ${operation}`
  const systemRoot = process.env.SystemRoot
  assert.ok(systemRoot && path.win32.isAbsolute(systemRoot), 'The OS PowerShell location is unavailable')
  const executable = path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  return execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
    { input: JSON.stringify(data), encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true }).trim()
}

export function ownedPosixCommand(home, uid = process.getuid()) {
  const command = path.join(home, '.notifai/bin/notifai')
  try { lstatSync(command) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  for (const file of [home, path.join(home, '.notifai'), path.dirname(command), command]) {
    const stat = lstatSync(file)
    assert.ok(!stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o022) === 0 &&
      (file === command ? stat.isFile() && (stat.mode & 0o100) !== 0 : stat.isDirectory()),
    'Existing installation is not privately owned; inspect it before repair')
  }
  return command
}

export function nativePlatform() {
  assert.ok(['darwin', 'linux', 'win32'].includes(process.platform), 'This operating system is not supported')
  const windows = process.platform === 'win32'
  let home
  return {
    existingCommand() {
      if (windows) {
        const result = JSON.parse(powershell('[ordered]@{home=(Get-NotifaiAccountHome);command=(Get-NotifaiInstalledCommand)} | ConvertTo-Json -Compress'))
        home = result.home
        return result.command
      }
      home = os.userInfo().homedir
      assert.ok(path.isAbsolute(home) && (!process.env.HOME || path.resolve(process.env.HOME) === path.resolve(home)), 'HOME differs from the OS account home')
      return ownedPosixCommand(home)
    },
    target() {
      if (windows) return powershell('Get-NotifaiWindowsTarget')
      let arch = process.arch
      if (process.platform === 'darwin') {
        const result = spawnSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8', timeout: 5_000 })
        if (result.status === 0 && result.stdout.trim() === '1') arch = 'arm64'
      } else {
        const report = process.report.getReport()
        assert.ok(report.header.glibcVersionRuntime, 'This release requires glibc Linux; musl is not supported')
      }
      assert.ok(arch === 'x64' || arch === 'arm64', 'This native CPU architecture is not supported')
      if (arch === 'x64') {
        const features = process.platform === 'linux' ? readFileSync('/proc/cpuinfo', 'utf8') :
          execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.features'], { encoding: 'utf8', timeout: 5_000 })
        assert.match(features, /\bsse4[._]2\b/i, 'This x64 release requires SSE4.2 support')
      }
      return `bun-${process.platform}-${arch}`
    },
    temporaryDirectory() {
      assert.ok(home, 'Resolve the OS account home before staging')
      if (!windows) return mkdtempSync(path.join(os.tmpdir(), 'notifai-npm-install-'))
      const directory = path.join(os.tmpdir(), `notifai-npm-install-${randomUUID()}`)
      powershell('New-NotifaiPrivateDirectory $inputData.directory', { directory })
      return directory
    },
    checkPublisher(directory) {
      if (process.platform !== 'darwin') return
      for (const name of ['notifai', 'notifai-runtime']) {
        const executable = path.join(directory, name)
        execFileSync('/usr/bin/codesign', ['--verify', '--strict', executable], { timeout: 30_000, stdio: ['ignore', 'ignore', 'pipe'] })
        execFileSync('/usr/bin/codesign', ['-vvvv', '-R=notarized', '--check-notarization', executable], { timeout: 60_000, stdio: ['ignore', 'ignore', 'pipe'] })
      }
    },
    execute(executable, args) {
      const result = spawnSync(executable, args, { stdio: 'inherit', windowsHide: true })
      if (result.error || result.signal || result.status === null) throw new Error('Native installation was interrupted; rerun this installer to inspect and resume setup')
      return result.status
    },
  }
}
