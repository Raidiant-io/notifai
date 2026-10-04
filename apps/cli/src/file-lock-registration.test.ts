import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import type * as FsModule from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { withFileLock } from './file-lock.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof FsModule>()
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) }
})

const realFs = await vi.importActual<typeof FsModule>('node:fs')
const roots: string[] = []
afterEach(() => {
  vi.mocked(lstatSync).mockReset().mockImplementation(realFs.lstatSync)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-lock-registration-'))
  roots.push(root)
  return path.join(root, 'shared.lock')
}

function denied(): NodeJS.ErrnoException {
  return Object.assign(new Error('lock directory is inaccessible'), { code: 'EPERM' })
}

it('retries a directory becoming delete-pending before contender publication', () => {
  const lock = fixture()
  let reads = 0
  let actions = 0
  vi.mocked(lstatSync).mockImplementation((file, options) => {
    if (file === lock && ++reads === 2) {
      expect(readdirSync(lock)).toEqual([])
      // A cooperating releaser removed the empty directory. Native Windows
      // may expose its delete-pending transition as EPERM rather than ENOENT.
      rmSync(lock, { recursive: true })
      throw denied()
    }
    return realFs.lstatSync(file, options)
  })

  withFileLock(lock, () => { actions += 1 })

  expect(actions).toBe(1)
  expect(reads).toBeGreaterThan(2)
  expect(existsSync(lock)).toBe(false)
})

it('bounds registration retries when directory access never recovers', () => {
  const lock = fixture()
  let reads = 0
  let actions = 0
  vi.mocked(lstatSync).mockImplementation((file, options) => {
    if (file === lock) {
      reads += 1
      throw denied()
    }
    return realFs.lstatSync(file, options)
  })

  expect(() => withFileLock(lock, () => { actions += 1 }, { waitMs: 20 }))
    .toThrow(/lock directory is inaccessible/)
  expect(reads).toBeGreaterThan(1)
  expect(actions).toBe(0)
  expect(existsSync(lock)).toBe(false)
})

it.each([3, 4, 5, 6])(
  'does not register again after publication when directory read %i is denied',
  (deniedRead) => {
    const lock = fixture()
    let reads = 0
    let actions = 0
    let registrations = 0
    vi.mocked(lstatSync).mockImplementation((file, options) => {
      if (file === lock && ++reads === deniedRead) {
        expect(readdirSync(lock)).toHaveLength(1)
        throw denied()
      }
      return realFs.lstatSync(file, options)
    })

    expect(() => withFileLock(lock, () => { actions += 1 }, {
      observe(observation) {
        if (observation.phase === 'registering') registrations += 1
      },
    })).toThrow(/lock directory is inaccessible/)
    expect(registrations).toBe(1)
    expect(actions).toBe(0)
    expect(existsSync(lock)).toBe(false)
  },
)
