import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT, type CommandDeps } from './commands-core.js'
import { doctorCommand } from './commands-doctor.js'
import { hooksInstallCommand } from './commands-hook-install.js'
import { opencodeLoadsPlugin, opencodePluginLoadWarning, probeOpencodeVersion } from './opencode-version.js'

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

  it('expects the plugin to load on OpenCode 1 and not on OpenCode 2 or later', () => {
    expect(opencodeLoadsPlugin('1.19.4')).toBe(true)
    expect(opencodeLoadsPlugin('1.0.0')).toBe(true)
    expect(opencodeLoadsPlugin('2.0.0')).toBe(false)
    expect(opencodeLoadsPlugin('2.1.3')).toBe(false)
    expect(opencodeLoadsPlugin('3.0.0')).toBe(false)
    // An unread version is no evidence of OpenCode 2.
    expect(opencodeLoadsPlugin(null)).toBe(true)
  })

  it('warns only about a version that will not load the plugin', () => {
    expect(opencodePluginLoadWarning('1.19.4')).toBeNull()
    expect(opencodePluginLoadWarning(null)).toBeNull()
    expect(opencodePluginLoadWarning('2.1.3')).toMatch(/^OpenCode 2\.1\.3 will not load Notifai's OpenCode plugin/)
  })
})

function fixture(version: string | null) {
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
    opencodeVersion: () => version,
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
  return { deps, flags, out, err }
}

interface DoctorState {
  id: string
  status: string
  detail: string
  technical: { opencode_version: string | null; opencode_loads_plugin: boolean }
  remedy?: { by: string; summary: string }
}

async function opencodeState(f: ReturnType<typeof fixture>): Promise<DoctorState | undefined> {
  f.out.length = 0
  await doctorCommand(f.deps, { json: true })
  const doctor = JSON.parse(f.out.at(-1)!) as { states: DoctorState[] }
  return doctor.states.find((candidate) => candidate.id === 'hooks-opencode-plugin')
}

describe('OpenCode plugin loadability', () => {
  it('warns at install and reports a Doctor gap when the installed OpenCode is 2 or later', async () => {
    const f = fixture('2.1.3')
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.err.join('\n')).toContain('OpenCode 2.1.3 will not load Notifai\'s OpenCode plugin')

    const state = await opencodeState(f)
    expect(state).toMatchObject({
      status: 'gap',
      technical: { opencode_version: '2.1.3', opencode_loads_plugin: false },
      remedy: { by: 'user-elsewhere' },
    })
    expect(state?.detail).toContain('OpenCode 2.1.3')
  })

  it('reports the plugin loadable on OpenCode 1 and installs without a warning', async () => {
    const f = fixture('1.19.4')
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.err).toEqual([])
    expect(await opencodeState(f)).toMatchObject({
      status: 'ready',
      technical: { opencode_version: '1.19.4', opencode_loads_plugin: true },
    })
  })

  it('does not fail Doctor when the OpenCode version cannot be read', async () => {
    const f = fixture(null)
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.err).toEqual([])
    const state = await opencodeState(f)
    expect(state).toMatchObject({ status: 'ready', technical: { opencode_version: null, opencode_loads_plugin: true } })
    expect(state?.detail).toContain('could not be read')
  })
})
