import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type * as FsModule from 'node:fs'
import os from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { atomicWriteFileSync } from './atomic-file.js'
import { enableProject, projectEnabled } from './project-enablement.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof FsModule>()
  return { ...actual, chmodSync: vi.fn(actual.chmodSync) }
})

const realFs = await vi.importActual<typeof FsModule>('node:fs')
const roots: string[] = []
afterEach(() => {
  vi.mocked(chmodSync).mockClear()
  vi.mocked(chmodSync).mockImplementation(realFs.chmodSync)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(mode: number) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-private-write-'))
  roots.push(root)
  const directory = path.join(root, 'project-enablement')
  mkdirSync(directory, { mode })
  realFs.chmodSync(directory, mode)
  const binding = { project: 'permissions-fixture', markerPath: path.join(directory, 'marker.json') }
  return { directory, binding }
}

function denyChmod() {
  vi.mocked(chmodSync).mockImplementation(file => {
    throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${String(file)}'`), {
      code: 'EPERM', syscall: 'chmod', path: String(file),
    })
  })
}

it.skipIf(process.platform === 'win32')('enables a Project in an already-private directory when chmod is denied', () => {
  const { directory, binding } = fixture(0o700)
  denyChmod()

  expect(() => enableProject(binding)).not.toThrow()
  expect(projectEnabled(binding)).toBe(true)
  expect(statSync(directory).mode & 0o7777).toBe(0o700)
  expect(statSync(binding.markerPath).mode & 0o7777).toBe(0o600)
  expect(chmodSync).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('refuses an insecure directory when the required chmod is denied', () => {
  const { directory, binding } = fixture(0o755)
  denyChmod()

  expect(() => enableProject(binding)).toThrow(/EPERM/)
  expect(existsSync(binding.markerPath)).toBe(false)
  expect(statSync(directory).mode & 0o7777).toBe(0o755)
})

it.skipIf(process.platform === 'win32')('repairs a permissive directory and a file mode restricted by umask', () => {
  const { directory, binding } = fixture(0o755)
  const priorUmask = process.umask(0o777)
  try {
    enableProject(binding)
    expect(projectEnabled(binding)).toBe(true)
    expect(statSync(directory).mode & 0o7777).toBe(0o700)
    expect(statSync(binding.markerPath).mode & 0o7777).toBe(0o600)
  } finally {
    process.umask(priorUmask)
  }
})

it.skipIf(process.platform === 'win32')('keeps the prior file when its replacement requires a denied mode change', () => {
  const { directory, binding } = fixture(0o700)
  writeFileSync(binding.markerPath, 'prior', { mode: 0o640 })
  realFs.chmodSync(binding.markerPath, 0o640)
  const priorUmask = process.umask(0o077)
  try {
    denyChmod()
    expect(() => atomicWriteFileSync(binding.markerPath, 'replacement', {
      requireCurrentUserOwner: true,
    })).toThrow(/EPERM/)
    expect(readFileSync(binding.markerPath, 'utf8')).toBe('prior')
    expect(statSync(binding.markerPath).mode & 0o7777).toBe(0o640)
    expect(readdirSync(directory)).toEqual(['marker.json'])
  } finally {
    process.umask(priorUmask)
  }
})

it('preserves the prior file when platform ownership cannot be established before publication', () => {
  const { directory, binding } = fixture(0o700)
  writeFileSync(binding.markerPath, 'prior')
  expect(() => atomicWriteFileSync(binding.markerPath, 'replacement', {
    prepareTemporary(temporary) {
      expect(temporary).not.toBe(binding.markerPath)
      expect(readFileSync(binding.markerPath, 'utf8')).toBe('prior')
      throw new Error('ownership unavailable')
    },
  })).toThrow('ownership unavailable')
  expect(readFileSync(binding.markerPath, 'utf8')).toBe('prior')
  expect(readdirSync(directory)).toEqual(['marker.json'])
})


it('preserves concurrent User edits when an owned profile edit no longer matches its read snapshot', () => {
  const { directory } = fixture(0o700)
  const file = path.join(directory, 'profile')
  writeFileSync(file, 'original profile')
  const expectedContentsSha256 = createHash('sha256').update('original profile').digest('hex')
  expect(() => atomicWriteFileSync(file, 'installer replacement', { expectedContentsSha256,
    prepareTemporary() { writeFileSync(file, 'concurrent User edit') },
  })).toThrow(/changed/)
  expect(readFileSync(file, 'utf8')).toBe('concurrent User edit')
  expect(readdirSync(directory)).toEqual(['profile'])
  expect(() => atomicWriteFileSync(file, 'installer replacement', { expectedContentsSha256 })).toThrow(/changed/)
  expect(readFileSync(file, 'utf8')).toBe('concurrent User edit')
})
