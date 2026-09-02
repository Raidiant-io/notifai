import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { activeNpmCli, npmInvocation } from './npm-invocation.js'

describe('npm invocation', () => {
  it('uses the active npm JavaScript entry when the caller owns one', () => {
    const npmCli = '/opt/npm/bin/npm-cli.js'
    expect(activeNpmCli({ npm_execpath: npmCli })).toBe(npmCli)
    expect(
      npmInvocation(['prefix', '--global'], {
        platform: 'linux',
        env: { npm_execpath: npmCli },
        nodeExecutable: '/opt/node/bin/node',
      }),
    ).toEqual({
      file: '/opt/node/bin/node',
      args: [npmCli, 'prefix', '--global'],
      options: { windowsHide: true },
    })
  })

  it('uses Node bundled npm on Windows without spawning a cmd shim', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-npm-invocation-'))
    const node = path.join(home, 'node.exe')
    const npmCli = path.join(home, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    mkdirSync(path.dirname(npmCli), { recursive: true })
    writeFileSync(npmCli, '// fixture')

    expect(
      npmInvocation(['install', 'fixture'], {
        platform: 'win32',
        env: {},
        nodeExecutable: node,
        useActiveNpm: false,
      }),
    ).toEqual({
      file: node,
      args: [npmCli, 'install', 'fixture'],
      options: { windowsHide: true },
    })
  })

  it('keeps ordinary POSIX npm execution direct when no active entry is selected', () => {
    expect(
      npmInvocation(['view', 'fixture'], {
        platform: 'linux',
        env: { npm_execpath: '/opt/pnpm/pnpm.cjs' },
        useActiveNpm: false,
      }),
    ).toEqual({
      file: 'npm',
      args: ['view', 'fixture'],
      options: { windowsHide: true },
    })
  })
})
