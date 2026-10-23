import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT, type CommandDeps } from './commands-core.js'
import { doctorCommand } from './commands-doctor.js'
import { hooksInstallCommand } from './commands-hook-install.js'
import { findInstallations } from './install-hooks.js'
import { installationFaults } from './integration-health.js'
import { opencodePluginPath, opencodePluginTarget } from './opencode-plugin.js'
import { opencodePluginLine, opencodeSupport, probeOpencodeVersion } from './opencode-version.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OpenCode version', () => {
  it('reads the version from either major line\'s `opencode --version`, and nothing from no answer', () => {
    // OpenCode 1 prints the bare version; OpenCode 2 prints its CLI banner.
    expect(probeOpencodeVersion({}, () => '1.19.4\n')).toBe('1.19.4')
    expect(probeOpencodeVersion({}, () => 'opencode v2.1.3\n')).toBe('2.1.3')
    expect(probeOpencodeVersion({}, () => null)).toBeNull()
    expect(probeOpencodeVersion({}, () => 'opencode: command not found')).toBeNull()
  })

  it('writes the OpenCode 2 plugin for OpenCode 2 or later, and the OpenCode 1 plugin otherwise', () => {
    expect(opencodePluginLine('1.19.4')).toBe(1)
    expect(opencodePluginLine('2.0.4')).toBe(2)
    expect(opencodePluginLine('2.1.3')).toBe(2)
    expect(opencodePluginLine('3.0.0')).toBe(2)
    // An unread version keeps today's OpenCode 1 plugin.
    expect(opencodePluginLine(null)).toBe(1)
  })

  it('supports OpenCode 1 and OpenCode 2.1 or later, and says what to do about anything else', () => {
    for (const version of ['1.19.4', '1.0.0', '2.1.0', '2.1.3', '2.7.12', null]) {
      expect(opencodeSupport(version)).toEqual({ supported: true, problem: null, remedy: null })
    }
    const early = opencodeSupport('2.0.9')
    expect(early.supported).toBe(false)
    expect(early.problem).toMatch(/^OpenCode 2\.0\.9 predates/)
    expect(early.remedy).toMatch(/upgrade OpenCode to 2\.1 or later/)
    const future = opencodeSupport('3.0.0')
    expect(future.supported).toBe(false)
    expect(future.problem).toMatch(/^OpenCode 3\.0\.0 is newer/)
  })
})

function fixture(version: () => string | null) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode-version-'))
  roots.push(root)
  const home = path.join(root, 'home')
  const out: string[] = []
  const err: string[] = []
  const offlineClient = {
    health: async () => false,
    capabilities: async () => ({ schema_version: 1, platform: 'ios' }),
    listDevices: async () => ({ devices: [] }),
  }
  const deps: CommandDeps = {
    cwd: root,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
    },
    hookAdapterHome: path.join(root, 'adapter'),
    hookPlatform: 'darwin',
    opencodeVersion: version,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      interactive: false,
    },
    store: {
      load: () => null,
      save: () => { throw new Error('doctor must not save credentials') },
      clear: () => { throw new Error('doctor must not clear credentials') },
      describe: () => 'not paired',
    },
    clientFactory: (() => offlineClient) as unknown as CommandDeps['clientFactory'],
  }
  const flags = { harness: 'opencode', execPath: process.execPath, scriptPath: fileURLToPath(import.meta.url) }
  const installedLine = () => opencodePluginTarget(readFileSync(opencodePluginPath(deps.env, 'darwin'), 'utf8'))?.line
  const opencode = () => findInstallations(deps.env, deps.hookAdapterHome, 'darwin').find((item) => item.harness === 'opencode')!
  return { deps, flags, out, err, installedLine, opencode }
}

interface DoctorState {
  id: string
  status: string
  detail: string
  technical: { opencode_version: string | null; opencode_plugin_line: number | null; opencode_expected_line: number }
  remedy?: { by: string; summary: string; command?: string }
}

async function opencodeState(f: ReturnType<typeof fixture>): Promise<DoctorState | undefined> {
  f.out.length = 0
  await doctorCommand(f.deps, { json: true })
  const doctor = JSON.parse(f.out.at(-1)!) as { states: DoctorState[] }
  return doctor.states.find((candidate) => candidate.id === 'hooks-opencode-plugin')
}

describe('OpenCode plugin line', () => {
  it('installs the OpenCode 2 plugin on OpenCode 2.1 and reports it ready', async () => {
    const f = fixture(() => '2.1.3')
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.err).toEqual([])
    expect(f.installedLine()).toBe(2)
    const state = await opencodeState(f)
    expect(state).toMatchObject({
      status: 'ready',
      technical: { opencode_version: '2.1.3', opencode_plugin_line: 2, opencode_expected_line: 2 },
    })
    expect(state?.detail).toContain('OpenCode 2.1.3')
  })

  it('installs the OpenCode 1 plugin on OpenCode 1, and when the version cannot be read', async () => {
    for (const version of ['1.19.4', null]) {
      const f = fixture(() => version)
      expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
      expect(f.err).toEqual([])
      expect(f.installedLine()).toBe(1)
      expect(await opencodeState(f)).toMatchObject({ status: 'ready', technical: { opencode_version: version, opencode_plugin_line: 1 } })
    }
  })

  it('reports OpenCode 2.0 as unsupported with an upgrade remedy, and warns at install', async () => {
    const f = fixture(() => '2.0.9')
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.err.join('\n')).toContain('OpenCode 2.0.9 predates')
    expect(f.installedLine()).toBe(2)
    const state = await opencodeState(f)
    expect(state).toMatchObject({ status: 'gap', remedy: { by: 'user-elsewhere' } })
    expect(state?.remedy?.summary).toContain('upgrade OpenCode to 2.1 or later')
  })

  it('reports a plugin written for the other major as a fault that reinstalling repairs', async () => {
    let version: string | null = '1.19.4'
    const f = fixture(() => version)
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(installationFaults(f.opencode(), 'darwin', f.deps)).toEqual([])

    // The User installs OpenCode 2 over OpenCode 1.
    version = '2.1.3'
    expect(installationFaults(f.opencode(), 'darwin', f.deps)).toEqual([
      'OpenCode 2.1.3 loads only OpenCode 2 plugins, but the installed Notifai plugin is for OpenCode 1; rerun `notifai hooks install --harness opencode`',
    ])
    const state = await opencodeState(f)
    expect(state).toMatchObject({
      status: 'gap',
      technical: { opencode_version: '2.1.3', opencode_plugin_line: 1, opencode_expected_line: 2 },
      remedy: { command: 'notifai hooks install --harness opencode' },
    })

    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.installedLine()).toBe(2)
    expect(installationFaults(f.opencode(), 'darwin', f.deps)).toEqual([])
    expect(await opencodeState(f)).toMatchObject({ status: 'ready' })

    // And back again.
    version = '1.19.4'
    expect(installationFaults(f.opencode(), 'darwin', f.deps)).toEqual([
      'OpenCode 1.19.4 loads only OpenCode 1 plugins, but the installed Notifai plugin is for OpenCode 2; rerun `notifai hooks install --harness opencode`',
    ])
  })

  it('never reports a mismatch when the version cannot be read, and a reinstall then keeps the installed line', () => {
    let version: string | null = '2.1.3'
    const f = fixture(() => version)
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    version = null
    expect(installationFaults(f.opencode(), 'darwin', f.deps)).toEqual([])
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.installedLine()).toBe(2)
  })
})
