import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computerKey, computerKeyOf, rawComputerId } from './computer-identity.js'
import type { ProcessRunner } from './credentials.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function runner(stdout: string, calls: string[] = []): ProcessRunner {
  return { run: (spec) => { calls.push(spec.command); return { status: 0, stdout: Buffer.from(stdout) } } }
}

describe('which computer the CLI runs on', () => {
  it('reads the operating system’s own computer identifier', () => {
    expect(rawComputerId({ platform: 'darwin', run: runner('  "IOPlatformUUID" = "ABCD-1234"\n') })).toBe('abcd-1234')
    expect(rawComputerId({ platform: 'win32', run: runner('    MachineGuid    REG_SZ    5f1e-77aa\r\n') })).toBe('5f1e-77aa')
    expect(rawComputerId({ platform: 'linux', readFile: () => 'deadbeef\n' })).toBe('deadbeef')
    expect(rawComputerId({ platform: 'darwin', run: runner('nothing useful') })).toBeNull()
  })

  it('sends only a hash, read once and kept for this OS user', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-computer-')); roots.push(root)
    const env = { XDG_STATE_HOME: path.join(root, 'state'), HOME: root }
    const calls: string[] = []
    const options = { env, platform: 'darwin' as const, run: runner('"IOPlatformUUID" = "ABCD-1234"', calls) }
    const key = computerKey(options)
    expect(key).toBe(computerKeyOf('abcd-1234'))
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(key).not.toContain('abcd')
    expect(computerKey(options)).toBe(key)
    expect(calls).toHaveLength(1)
  })
})
