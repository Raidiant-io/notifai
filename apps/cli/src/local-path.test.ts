import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalPath,
  pathContainsDirectory,
  pathDirectories,
  sameLocalPath,
} from './local-path.js'

describe('local PATH identity', () => {
  it('resolves symlinked spellings once for every caller', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-local-path-'))
    const real = path.join(root, 'real')
    const linked = path.join(root, 'linked')
    mkdirSync(real)
    symlinkSync(real, linked)

    expect(canonicalPath(linked)).toBe(canonicalPath(real))
    expect(sameLocalPath(linked, real, process.platform)).toBe(true)
  })

  it('uses Windows Path order and compares case-insensitively', () => {
    const first = path.join(os.tmpdir(), 'Notifai-Windows-First')
    const second = path.join(os.tmpdir(), 'Notifai-Windows-Second')
    expect(pathDirectories({ Path: `${first};;${second}`, PATH: 'ignored' }, 'win32')).toEqual([
      first,
      second,
    ])
    expect(pathContainsDirectory({ Path: first.toUpperCase() }, first, 'win32')).toBe(true)
  })

  it('does not fold case on POSIX', () => {
    const directory = path.join(os.tmpdir(), 'Notifai-Case-Sensitive')
    expect(pathContainsDirectory({ PATH: directory.toUpperCase() }, directory, 'linux')).toBe(
      false,
    )
  })
})
