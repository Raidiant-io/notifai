import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliBinReadiness, isExecutablePath, pathNotifaiEntries } from './cli-bin.js'

describe('PATH notifai diagnosis', () => {
  it('reports a non-executable PATH binary as a gap', () => {
    if (process.platform === 'win32') return
    const directory = mkdtempSync(path.join(os.tmpdir(), 'notifai-bin-gap-'))
    const file = path.join(directory, 'notifai')
    writeFileSync(file, '#!/usr/bin/env node\n')
    chmodSync(file, 0o644)
    expect(isExecutablePath(file, 'darwin')).toBe(false)
    const state = cliBinReadiness({ PATH: directory }, 'darwin')
    expect(state.status).toBe('gap')
    expect(state.detail).toContain(file)
    expect(state.remedy?.command).toBe('npm install -g @raidiant/notifai')
  })

  it('treats an executable PATH binary as ready', () => {
    if (process.platform === 'win32') return
    const directory = mkdtempSync(path.join(os.tmpdir(), 'notifai-bin-ok-'))
    const file = path.join(directory, 'notifai')
    writeFileSync(file, '#!/usr/bin/env node\n')
    chmodSync(file, 0o755)
    expect(pathNotifaiEntries({ PATH: directory }, 'darwin')).toEqual([file])
    expect(cliBinReadiness({ PATH: directory }, 'darwin').status).toBe('ready')
  })

  it('is ready when PATH has no notifai entry', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'notifai-bin-empty-'))
    mkdirSync(directory, { recursive: true })
    const state = cliBinReadiness({ PATH: directory }, process.platform)
    expect(state.status).toBe('ready')
    expect(state.detail).toContain('no notifai binary was on PATH')
  })
})
