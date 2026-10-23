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
import { describe,expect,it } from 'vitest'
import { cliBinReadiness,withoutNpxLauncherPath } from './cli-bin.js'
import { cliUpdateRecoveryCommand } from './cli-contract.js'

// The running build's version picks the channel its repair advice stays on.

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


  it.each(['darwin', 'win32'] as const)('excludes only the running npx launcher on %s', platform => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-npx-path-'))
    const modules = path.join(root, '_npx', 'hash', 'node_modules')
    const artifact = path.join(modules, '@raidiant', 'notifai', 'dist', 'main.js')
    const injected = path.join(modules, '.bin')
    const foreign = path.join(root, 'project', 'node_modules', '.bin')
    const global = path.join(root, 'global-bin')
    const key = platform === 'win32' ? 'Path' : 'PATH'
    const delimiter = platform === 'win32' ? ';' : ':'
    const env = { [key]: [injected, foreign, global].join(delimiter) }
    expect(withoutNpxLauncherPath(env, platform, artifact)[key]).toBe([foreign, global].join(delimiter))
    if (platform === 'win32') {
      const result = withoutNpxLauncherPath({ ...env, PATH: env[key] }, platform, artifact)
      expect(result.PATH).toBe(result.Path)
      expect(result.PATH).toBe([foreign, global].join(delimiter))
      expect(withoutNpxLauncherPath({ Path: result.Path, PATH: env[key] }, platform, artifact)).toEqual({
        Path: result.Path, PATH: result.Path,
      })
    }
    expect(withoutNpxLauncherPath(env, platform, path.join(root, 'other', 'main.js'))).toBe(env)
    expect(withoutNpxLauncherPath(env, platform, path.join(root, 'project', 'node_modules', '@raidiant', 'notifai', 'dist', 'main.js'))).toBe(env)
  })

  it.each(['3.0.1', '10.1.0'])('rejects a different executable PATH winner even when its version is %s', oldVersion => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-bin-stale-winner-'))
    const old = posixInstall(root, 'old', oldVersion)
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
      effective: { command_path: old.command, artifact_path: realpathSync(old.artifact), version: oldVersion },
    })
  })
})
