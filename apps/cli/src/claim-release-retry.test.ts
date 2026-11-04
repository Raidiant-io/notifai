import type * as Fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireClaimFile, releaseClaimFile } from './hook-question-lock.js'

const fault = vi.hoisted(() => ({ file: '', code: '', reads: 0 }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof Fs>()
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === fault.file) {
      fault.reads++
      if (fault.code) throw Object.assign(new Error('Temporary claim read failure'), { code: fault.code })
    }
    return fs.readFileSync(...args)
  } }
})

const roots: string[] = []
afterEach(async () => {
  fault.code = ''; fault.file = ''; fault.reads = 0
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  // Let pending releases observe deletion before restoring the real clock.
  await vi.advanceTimersByTimeAsync(30_000)
  vi.useRealTimers()
})

function claim() {
  vi.useFakeTimers()
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-release-')); roots.push(root)
  const file = path.join(root, 'claim')
  const token = acquireClaimFile(file, {})!
  expect(token).not.toBeNull()
  const saved = readFileSync(file, 'utf8')
  fault.file = file
  return { file, token, saved }
}

it.each(['EIO', 'EACCES'])('keeps retrying an owned release after a %s read failure, without a new caller', async code => {
  const { file, token } = claim()
  fault.code = code
  releaseClaimFile(file, token)
  expect(existsSync(file)).toBe(true)
  // Prolonged trouble must back off, rather than spin or quietly abandon work.
  const before = fault.reads
  await vi.advanceTimersByTimeAsync(91_000)
  expect(fault.reads - before).toBe(7) // 1, 3, 7, 15, 31, 61, 91 seconds
  fault.code = ''
  await vi.advanceTimersByTimeAsync(30_000)
  expect(existsSync(file)).toBe(false)
  const settled = fault.reads
  await vi.advanceTimersByTimeAsync(120_000)
  expect(fault.reads).toBe(settled)
})

it.each(['{', 'null', '{}', '[]'])('does not forget a release while the holder is unreadable (%s)', async contents => {
  const { file, token, saved } = claim()
  writeFileSync(file, contents)
  releaseClaimFile(file, token)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(readFileSync(file, 'utf8')).toBe(contents)
  writeFileSync(file, saved)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(existsSync(file)).toBe(false)
})

it('leaves a replacement owner intact when the pending release becomes readable', async () => {
  const { file, token, saved } = claim()
  fault.code = 'EIO'
  releaseClaimFile(file, token)
  const replacement = JSON.stringify({ ...JSON.parse(saved), token: 'replacement-owner' })
  writeFileSync(file, replacement)
  fault.code = ''
  await vi.advanceTimersByTimeAsync(1_000)
  expect(readFileSync(file, 'utf8')).toBe(replacement)
  const settled = fault.reads
  await vi.advanceTimersByTimeAsync(120_000)
  expect(fault.reads).toBe(settled)
})

it('stops retrying when the claim and its directory have been removed', async () => {
  const { file, token } = claim()
  fault.code = 'EIO'
  releaseClaimFile(file, token)
  fault.code = ''
  rmSync(path.dirname(file), { recursive: true })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(vi.getTimerCount()).toBe(0)
})
