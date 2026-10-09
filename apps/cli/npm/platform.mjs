import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function powershell(operation, data = {}) {
  const script = fileURLToPath(new URL('../data/install.ps1', import.meta.url)).replaceAll("'", "''")
  // Only local pathname data crosses this boundary. Encoding it separately
  // avoids PowerShell quoting and a redirected-stdin EOF dependency on ARM.
  const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64')
  const phase = name => `[Console]::Error.WriteLine('notifai-bootstrap:${name}');`
  // Resolve only the required OS module. First-use command discovery otherwise
  // walks third-party PSModulePath entries, including slow/offline locations.
  const code = `${phase('started')} $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $PSModuleAutoLoadingPreference='None'; Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')); ${phase('modules-ready')} [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${phase('encoding-ready')} . '${script}'; ${phase('helper-ready')} $inputData=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; ${phase('operation-started')} ${operation}; ${phase('complete')}`
  const systemRoot = process.env.SystemRoot
  assert.ok(systemRoot && path.win32.isAbsolute(systemRoot), 'The OS PowerShell location is unavailable')
  const executable = path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const encoded = Buffer.from(code, 'utf16le').toString('base64')
  assert.ok(encoded.length + executable.length + 256 < 32_767, 'Installer pathname exceeds the Windows command-line limit')
  try {
    return execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true }).trim()
  } catch (error) {
    const last = [...String(error.stderr ?? '').matchAll(/notifai-bootstrap:([a-z-]+)/g)].at(-1)?.[1] ?? 'process-start'
    throw new Error(`Windows installation helper failed after ${last} (${error.code ?? error.status ?? 'unknown'}).`, { cause: error })
  }
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

export function assertAcquisitionReady(home, checkAccess, checkHomeAccess = checkAccess) {
  const root = path.join(home, '.notifai')
  for (const directory of [home, root]) {
    let stat
    try { stat = lstatSync(directory) }
    catch (error) { if (directory === root && error.code === 'ENOENT') return; throw error }
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Native installation root is not a regular directory')
    const inspect = directory === home ? checkHomeAccess : checkAccess
    inspect(directory, true)
  }
  for (const name of ['uninstall.json', 'transaction.json', 'install.json', 'active.json']) {
    try { lstatSync(path.join(root, name)) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw new Error('Native installation needs explicit recovery before acquisition; inspect the retained installation and pending owners')
  }
  for (const name of ['versions', 'runtime-retention']) {
    const directory = path.join(root, name)
    let stat
    try { stat = lstatSync(directory) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Retained native path needs explicit inspection')
    checkAccess(directory, true)
    assert.equal(readdirSync(directory).length, 0, 'Retained native versions or owners need explicit recovery before acquisition')
  }
}

/** Spawn directly, retain TTY/stdin and propagate cancellation without a shell. */
export function executeNative(executable, args, { capture = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', windowsHide: true, env })
    let stdout = '', failure = null
    if (capture) child.stdout.setEncoding('utf8').on('data', text => {
      stdout += text
      if (Buffer.byteLength(stdout) > 1024 * 1024) { failure = new Error('Native installation report exceeds its size limit'); child.kill() }
    })
    const signals = ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? [] : ['SIGHUP'])]
    const handlers = signals.map(signal => { const handler = () => child.kill(signal); process.on(signal, handler); return [signal, handler] })
    const cleanup = () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler) }
    child.once('error', error => { cleanup(); reject(error) })
    child.once('close', (code, signal) => {
      cleanup()
      if (failure) { reject(failure); return }
      const status = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1)
      resolve(capture ? { status, stdout } : status)
    })
  })
}

export function nativePlatform() {
  assert.ok(['darwin', 'linux', 'win32'].includes(process.platform), 'This operating system is not supported')
  const windows = process.platform === 'win32'
  let home
  let childEnvironment = process.env
  return {
    platform: process.platform,
    setEnvironment(env) { childEnvironment = env },
    existingCommand() {
      if (windows) {
        const result = JSON.parse(powershell("$accountHome=Get-NotifaiAccountHome; [Console]::Error.WriteLine('notifai-bootstrap:home-ready'); $command=Get-NotifaiInstalledCommand; [Console]::Error.WriteLine('notifai-bootstrap:command-ready'); [ordered]@{home=$accountHome;command=$command} | ConvertTo-Json -Compress"))
        home = result.home
        if (!result.command) this.assertAcquisitionReady()
        return result.command
      }
      home = os.userInfo().homedir
      assert.ok(path.isAbsolute(home) && (!process.env.HOME || path.resolve(process.env.HOME) === path.resolve(home)), 'HOME differs from the OS account home')
      const command = ownedPosixCommand(home)
      if (!command) this.assertAcquisitionReady()
      return command
    },
    assertAcquisitionReady() {
      assert.ok(home, 'Resolve the OS account home before acquisition')
      assertAcquisitionReady(home, windows
        ? file => powershell('Assert-NotifaiPathAccess $inputData.file', { file })
        : this.checkAccess, this.checkAccess)
    },
    checkAccess(file) {
      if (!windows) {
        const stat = lstatSync(file)
        assert.ok(stat.uid === process.getuid() && (stat.mode & 0o022) === 0, 'Npm adapter path is not owned by this User')
        return
      }
      powershell('Assert-NotifaiPathAccess $inputData.file -AllowDefaultOwner', { file })
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
    execute: (executable, args) => executeNative(executable, args, { env: childEnvironment }),
    capture: (executable, args) => executeNative(executable, args, { capture: true, env: childEnvironment }),
  }
}
