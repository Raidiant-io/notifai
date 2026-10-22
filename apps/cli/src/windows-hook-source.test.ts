import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildHookConfig } from './install-hooks.js'
import { proveWindowsCodexHookSource, windowsCodexHookSource, type WindowsProcessLink } from './windows-hook-source.js'
import { windowsCodexHookShell } from './windows-codex-command.js'

const ENV = { SystemRoot: 'C:\\Windows' }
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** A process table: pid → [created, executable, parent]. */
function table(rows: Record<number, [number, string, number]>): (pid: number) => WindowsProcessLink | null {
  return (pid) => {
    const row = rows[pid]
    return row === undefined ? null : { pid, created: BigInt(row[0]), executable: row[1], parent: row[2] }
  }
}

describe('Windows Codex hook source', () => {
  it('finds Codex above the session shell and Notifai\'s PowerShell', () => {
    const read = table({
      40: [400, POWERSHELL, 30],
      30: [300, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 20],
      20: [200, 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\codex.exe', 10],
    })
    expect(windowsCodexHookSource(40, ENV, read)).toBe(20)
  })

  it('finds Codex when it starts the PowerShell itself', () => {
    const read = table({ 40: [400, POWERSHELL, 20], 20: [200, 'D:\\tools\\Codex.EXE', 10] })
    expect(windowsCodexHookSource(40, ENV, read)).toBe(20)
  })

  it('refuses a parent PID that Windows gave to a newer process', () => {
    // The real shell exited and its PID now names a Codex started after the hook's PowerShell.
    const read = table({ 40: [400, POWERSHELL, 30], 30: [500, 'C:\\tools\\codex.exe', 10] })
    expect(windowsCodexHookSource(40, ENV, read)).toBeNull()
  })

  it('accepts only the PowerShell Notifai\'s command names', () => {
    const read = table({ 40: [400, 'C:\\project\\powershell.exe', 20], 20: [200, 'C:\\tools\\codex.exe', 10] })
    expect(windowsCodexHookSource(40, ENV, read)).toBeNull()
  })

  it('refuses anything but a session shell between the PowerShell and Codex', () => {
    expect(windowsCodexHookSource(40, ENV, table({
      40: [400, POWERSHELL, 30], 30: [300, 'C:\\tools\\node.exe', 20], 20: [200, 'C:\\tools\\codex.exe', 10],
    }))).toBeNull()
    expect(windowsCodexHookSource(40, ENV, table({
      40: [400, POWERSHELL, 31], 31: [310, 'C:\\Windows\\System32\\cmd.exe', 30],
      30: [300, 'C:\\Windows\\System32\\cmd.exe', 20], 20: [200, 'C:\\tools\\codex.exe', 10],
    }))).toBeNull()
  })

  it('replaces only a proven declaration and leaves everything else as it was', () => {
    const read = table({ 40: [400, POWERSHELL, 20], 20: [200, 'C:\\tools\\codex.exe', 10] })
    const proven: NodeJS.ProcessEnv = { ...ENV, NOTIFAI_HOOK_SOURCE_PID: '40' }
    proveWindowsCodexHookSource(proven, read)
    expect(proven['NOTIFAI_HOOK_SOURCE_PID']).toBe('20')
    // A detached Notifai process inherits the proven pid: it stays.
    proveWindowsCodexHookSource(proven, read)
    expect(proven['NOTIFAI_HOOK_SOURCE_PID']).toBe('20')
    const unproven: NodeJS.ProcessEnv = { ...ENV, NOTIFAI_HOOK_SOURCE_PID: '41' }
    proveWindowsCodexHookSource(unproven, read)
    expect(unproven['NOTIFAI_HOOK_SOURCE_PID']).toBe('41')
  })
})

describe.runIf(process.platform === 'win32')('Windows Codex hook source on a real Windows host', () => {
  /**
   * A stand-in Codex (a copy of node.exe named codex.exe) runs Notifai's own
   * Windows Codex hook command through a session shell, exactly as Codex
   * does. The hook writes the parent it would declare and stays alive while
   * this test walks the real process table from there.
   */
  async function runHook(shell: 'cmd' | 'powershell' | 'none'): Promise<{ codex: number; declared: number; root: string }> {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nfhs-'))
    const codex = path.join(root, 'codex.exe')
    copyFileSync(process.execPath, codex)
    const hook = path.join(root, 'hook.cjs')
    const declared = path.join(root, 'declared')
    writeFileSync(hook, `require('node:fs').writeFileSync(${JSON.stringify(declared)}, String(process.ppid)); setTimeout(() => {}, 20000)`)
    const command = buildHookConfig({ adapterPath: hook, harness: 'codex', platform: 'win32', nodePath: process.execPath })['SessionStart']![0]!.hooks[0]!.command
    const host = path.join(root, 'host.cjs')
    const argv = shell === 'cmd' ? ['cmd.exe', ['/d', '/s', '/c', `"${command}"`], true]
      : shell === 'powershell' ? [windowsCodexHookShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], false]
        : null
    writeFileSync(host, argv === null
      ? `const [program, ...args] = ${JSON.stringify(command)}.split(' '); require('node:child_process').spawn(program, args, { stdio: 'ignore', windowsHide: true })`
      : `require('node:child_process').spawn(${JSON.stringify(argv[0])}, ${JSON.stringify(argv[1])}, { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: ${String(argv[2])} })`)
    const child = spawn(codex, [host], { stdio: 'ignore', windowsHide: true })
    const until = Date.now() + 30_000
    while (!existsSync(declared) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100))
    return { codex: child.pid!, declared: Number(readFileSync(declared, 'utf8')), root }
  }

  for (const shell of ['cmd', 'powershell', 'none'] as const) {
    it(`proves the stand-in Codex through ${shell === 'none' ? 'no session shell' : shell}`, async () => {
      const { codex, declared, root } = await runHook(shell)
      try {
        expect(declared).not.toBe(codex)
        expect(windowsCodexHookSource(declared, process.env)).toBe(codex)
      } finally {
        spawn('taskkill', ['/pid', String(codex), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        rmSync(root, { recursive: true, force: true, maxRetries: 5 })
      }
    }, 60_000)
  }

  it('proves nothing for a PowerShell no Codex started', () => {
    expect(windowsCodexHookSource(process.pid, process.env)).toBeNull()
  })
})
