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

  it('does not call a PATH with no notifai entry ready', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'notifai-bin-empty-'))
    mkdirSync(directory, { recursive: true })
    const state = cliBinReadiness({ PATH: directory }, process.platform)
    // The running process proves nothing about the command every printed next
    // step names — but it is running, so this cannot stand in the way either.
    expect(state.status).toBe('optional-gap')
    expect(state.detail).toContain('will not be found')
    expect(state.remedy?.command).toBe('npm install -g @raidiant/notifai')
  })
})
