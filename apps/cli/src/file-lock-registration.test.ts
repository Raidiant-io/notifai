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
  // The lock's own clock, not the machine's: each denied read takes 10 ms of
  // it, so the 20 ms budget always allows a retry and always runs out.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.mocked(lstatSync).mockImplementation((file, options) => {
    if (file === lock) {
      reads += 1
      vi.setSystemTime(Date.now() + 10)
      throw denied()
    }
    return realFs.lstatSync(file, options)
  })

  try {
    expect(() => withFileLock(lock, () => { actions += 1 }, { waitMs: 20 }))
      .toThrow(/lock directory is inaccessible/)
  } finally {
    vi.useRealTimers()
  }
  expect(reads).toBe(2)
  expect(actions).toBe(0)
  expect(existsSync(lock)).toBe(false)
})

it.each([1, 2, 3, 4])(
  'does not register again when directory read %i after publication is denied',
  (deniedRead) => {
    const lock = fixture()
    // Counted from publication, so a pre-publication check added later does not
    // move a denial in front of the entry it is meant to follow.
    let reads = 0
    let published = false
    let actions = 0
    let registrations = 0
    vi.mocked(lstatSync).mockImplementation((file, options) => {
      if (published && file === lock && ++reads === deniedRead) {
        expect(readdirSync(lock)).toHaveLength(1)
        throw denied()
      }
      return realFs.lstatSync(file, options)
    })

    // A real permission failure after publication reaches the caller.
    expect(() => withFileLock(lock, () => { actions += 1 }, {
      observe(observation) {
        if (observation.phase === 'registering') {
          registrations += 1
          published = true
        }
      },
    })).toThrow(/lock directory is inaccessible/)
    expect(reads).toBeGreaterThanOrEqual(deniedRead)
    expect(registrations).toBe(1)
    expect(actions).toBe(0)
    expect(existsSync(lock)).toBe(false)
  },
)
