import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runNpmManager } from './npm-conversion-process.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let elapsed: number
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }
beforeEach(() => {
  vi.useFakeTimers()
  elapsed = 0
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: vi.fn() })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); Object.defineProperty(process, 'platform', platform) })
const begin = (admit: () => undefined) => runNpmManager({ launcher: path.resolve('notifai.exe'), executable: path.resolve('node.exe'), args: [], cwd: path.resolve('.'), env: {}, admit })
const announce = () => child.stdout.write('{"pid":42,"start":"windows-filetime:123"}\n')

it('leaves execution time after bounded toolchain and package admission', async () => {
  const result = begin(() => { elapsed = 135_000; return undefined })
  announce()
  expect(child.stdin.read()?.toString()).toBe('G')
  child.emit('close', 0)
  expect(await result).toMatchObject({ started: true, exit_code: 0 })
  expect(child.kill).not.toHaveBeenCalled()
})

it('never sends GO after admission consumes the entire finite operation budget', async () => {
  const result = begin(() => { elapsed = 300_000; return undefined })
  announce()
  expect(child.stdin.read()).toBeNull()
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  child.emit('close', 1)
  expect(await result).toMatchObject({ started: false, failure: 'Npm admission exceeded its deadline' })
})

it('terminates a manager that does not complete within the operation budget', async () => {
  const result = begin(() => undefined)
  announce()
  await vi.advanceTimersByTimeAsync(300_000)
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  child.emit('close', 1)
  expect(await result).toMatchObject({ started: true, failure: expect.stringContaining('exceeded its deadline') })
})
