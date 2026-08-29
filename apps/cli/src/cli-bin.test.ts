import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliBinReadiness, isExecutablePath, pathNotifaiEntries } from './cli-bin.js'
import { cliUpdateRecoveryCommand } from './cli-update-contract.js'

describe('PATH notifai diagnosis', () => {
  function posixInstall(root: string, name: string, version: string) {
    const prefix = path.join(root, name)
    const artifact = path.join(
      prefix,
      'lib',
      'node_modules',
      '@raidiant',
      'notifai',
      'dist',
      'main.js',
    )
    const command = path.join(prefix, 'bin', 'notifai')
    mkdirSync(path.dirname(artifact), { recursive: true })
    mkdirSync(path.dirname(command), { recursive: true })
    writeFileSync(path.join(path.dirname(path.dirname(artifact)), 'package.json'), JSON.stringify({ version }))
    writeFileSync(artifact, '#!/usr/bin/env node\n')
    chmodSync(artifact, 0o755)
    symlinkSync(path.relative(path.dirname(command), artifact), command)
    return { prefix, artifact, command }
  }

  function windowsInstall(root: string, name: string, version: string) {
    const prefix = path.join(root, name)
    const artifact = path.join(
      prefix,
      'node_modules',
      '@raidiant',
      'notifai',
      'dist',
      'main.js',
    )
    const command = path.join(prefix, 'notifai.cmd')
    mkdirSync(path.dirname(artifact), { recursive: true })
    writeFileSync(path.join(path.dirname(path.dirname(artifact)), 'package.json'), JSON.stringify({ version }))
    writeFileSync(artifact, '#!/usr/bin/env node\n')
    writeFileSync(
      command,
      '@ECHO off\r\nnode "%dp0%node_modules\\@raidiant\\notifai\\dist\\main.js" %*\r\n',
    )
    return { prefix, artifact, command }
  }

  it('reports a non-executable PATH binary as a gap', () => {
    if (process.platform === 'win32') return
    const directory = mkdtempSync(path.join(os.tmpdir(), 'notifai-bin-gap-'))
    const file = path.join(directory, 'notifai')
    writeFileSync(file, '#!/usr/bin/env node\n')
    chmodSync(file, 0o644)
    expect(isExecutablePath(file, 'darwin')).toBe(false)
    const state = cliBinReadiness({ PATH: directory }, 'darwin')
    expect(state.status).toBe('gap')
    expect(state.detail).not.toContain(file)
    expect(state.technical).toMatchObject({ entries: [{ command_path: file, executable: false }] })
    expect(state.remedy?.command).not.toBe('notifai update')
    expect(state.remedy?.command).toMatch(/ update$/)
  })

  it('treats an executable PATH binary as ready', () => {
    if (process.platform === 'win32') return
    const directory = mkdtempSync(path.join(os.tmpdir(), 'notifai-bin-ok-'))
    const file = path.join(directory, 'notifai')
    writeFileSync(file, '#!/usr/bin/env node\n')
    chmodSync(file, 0o755)
    expect(pathNotifaiEntries({ PATH: directory }, 'darwin')).toEqual([file])
    expect(
      cliBinReadiness({ PATH: directory }, 'darwin', {
        runningArtifactPath: file,
        currentVersion: null,
      }).status,
    ).toBe('ready')
  })

  it('does not call an older executable PATH winner ready when this process is the current CLI', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-bin-stale-winner-'))
    const old = posixInstall(root, 'old', '3.0.1')
    const current = posixInstall(root, 'current', '10.1.0')

    const state = cliBinReadiness(
      { PATH: `${path.dirname(old.command)}:${path.dirname(current.command)}` },
      'darwin',
      {
        runningArtifactPath: current.artifact,
        currentVersion: '10.1.0',
      },
    )

    expect(state.status).toBe('gap')
    expect(state.detail).not.toContain(old.command)
    expect(state.remedy?.command).toBe(
      cliUpdateRecoveryCommand(),
    )
    expect(state.remedy?.command).not.toContain(old.command)
    expect(state.technical).toMatchObject({
      current: { artifact_path: realpathSync(current.artifact), version: '10.1.0' },
      effective: { command_path: old.command, artifact_path: realpathSync(old.artifact), version: '3.0.1' },
    })
  })

  it('uses Windows Path order to reject an older executable winner', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-bin-windows-winner-'))
    const old = windowsInstall(root, 'old', '3.0.1')
    const current = windowsInstall(root, 'current', '10.1.0')

    const state = cliBinReadiness(
      { Path: `${old.prefix};${current.prefix}` },
      'win32',
      {
        runningArtifactPath: current.artifact,
        currentVersion: '10.1.0',
      },
    )

    expect(state.status).toBe('gap')
    expect(state.remedy?.command).toBe(
      cliUpdateRecoveryCommand(),
    )
    expect(state.technical).toMatchObject({
      effective: {
        command_path: old.command,
        artifact_path: realpathSync(old.artifact),
        version: '3.0.1',
      },
    })
  })

  it('keeps a healthy winner ready while reporting a later broken duplicate for cleanup', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-bin-later-broken-'))
    const current = posixInstall(root, 'current', '10.1.0')
    const broken = posixInstall(root, 'broken', '3.0.1')
    chmodSync(broken.artifact, 0o644)

    const state = cliBinReadiness(
      { PATH: `${path.dirname(current.command)}:${path.dirname(broken.command)}` },
      'darwin',
      { runningArtifactPath: current.artifact, currentVersion: '10.1.0' },
    )

    expect(state.status).toBe('optional-gap')
    expect(state.detail).toContain('ready')
    expect(state.detail).not.toContain(broken.command)
    expect(state.technical).toMatchObject({
      effective: { command_path: current.command, executable: true },
      entries: [
        { command_path: current.command, executable: true },
        { command_path: broken.command, executable: false },
      ],
    })
  })

  it('does not call a PATH with no notifai entry ready', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'notifai-bin-empty-'))
    mkdirSync(directory, { recursive: true })
    const state = cliBinReadiness({ PATH: directory }, process.platform)
    // The running process proves nothing about the command every printed next
    // step names — but it is running, so this cannot stand in the way either.
    expect(state.status).toBe('optional-gap')
    expect(state.detail).toContain('will not be found')
    expect(state.remedy?.command).not.toBe('notifai update')
    expect(state.remedy?.command).toMatch(/ update$/)
  })
})
