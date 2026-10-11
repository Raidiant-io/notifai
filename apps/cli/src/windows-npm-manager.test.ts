import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { inspectWindowsNpmManager } from './windows-npm-manager.js'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.resetAllMocks() })

it('allows the observed full-tree verification time without dropping trust checks', () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  const manager = { node: path.resolve('node.exe'), npm: path.resolve('npm-cli.js'), version: '11.17.0', sha256: 'a'.repeat(64) }
  vi.mocked(execFileSync).mockImplementation((_file, args, options) => {
    const timeout = (options as { timeout: number }).timeout
    if (timeout <= 57_745) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
    expect(timeout).toBeLessThanOrEqual(120_000)
    const script = Buffer.from((args as string[]).at(-1)!, 'base64').toString('utf16le')
    expect(script).toContain('Get-AuthenticodeSignature')
    expect(script).toContain('Get-Acl')
    expect(script).toContain('Get-FileHash')
    return JSON.stringify(manager)
  })
  expect(inspectWindowsNpmManager(manager.node)).toEqual(manager)
})

it('still refuses an inspection that times out or fails instead of trusting its partial output', () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  const failure = Object.assign(new Error('inspection exceeded deadline'), { code: 'ETIMEDOUT' })
  vi.mocked(execFileSync).mockImplementation(() => { throw failure })
  expect(() => inspectWindowsNpmManager(path.resolve('node.exe'))).toThrow(failure)
})
