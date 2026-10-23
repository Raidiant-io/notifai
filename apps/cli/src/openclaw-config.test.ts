import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach,describe,expect,it } from 'vitest'
import { EXIT,type CommandDeps } from './commands-core.js'
import { doctorCommand } from './commands-doctor.js'
import { hooksInstallCommand,hooksUninstallCommand } from './commands-hook-install.js'
import {
parseOpenclawConfig,
removeOpenclawNotifaiConfigText
} from './openclaw-plugin.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(config: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-openclaw-config-'))
  roots.push(root)
  const home = path.join(root, 'home')
  const state = path.join(root, 'openclaw')
  mkdirSync(state, { recursive: true })
  const configFile = path.join(state, 'openclaw.json')
  writeFileSync(configFile, config)
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
      OPENCLAW_STATE_DIR: state,
    },
    hookAdapterHome: path.join(root, 'adapter'),
    hookPlatform: 'darwin',
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
  const flags = {
    harness: 'openclaw',
    execPath: process.execPath,
    scriptPath: fileURLToPath(import.meta.url),
  }
  return {
    root,
    state,
    configFile,
    pluginDir: path.join(state, 'extensions', 'notifai'),
    deps,
    flags,
    out,
    err,
  }
}

describe('OpenClaw JSONC config edits', () => {
  it('keeps the comment immediately before a following foreign plugin', () => {
    const source = `{
  "plugins": {
    "entries": {
      "notifai": { "enabled": true },
      // Keep this: settings for my other plugin
      "other": { "enabled": true }
    }
  }
}\n`
    const result = removeOpenclawNotifaiConfigText(source, 'probe', '/fake/notifai')
    expect(result).toContain('      // Keep this: settings for my other plugin\n      "other": { "enabled": true }')
    expect(result).not.toContain('"notifai"')
    expect(parseOpenclawConfig(result)).toEqual({ plugins: { entries: { other: { enabled: true } } } })
  })

  it('preserves a pre-existing commented-empty entries container byte-for-byte after install and uninstall', () => {
    const original = `{
  "plugins": {
    "entries": {
      // Keep this even while there are no plugin entries.
    }
  }
}\n`
    const f = fixture(original)
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(hooksUninstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(readFileSync(f.configFile, 'utf8')).toBe(original)
  })
})

describe('OpenClaw plugin trust readiness', () => {
  it.each([
    {
      name: 'a restrictive allow-list',
      config: '{"plugins":{"allow":["sample-existing"]}}\n',
      key: 'plugins.allow',
      remedy: 'add "notifai" to plugins.allow',
    },
    {
      name: 'a deny-list entry',
      config: '{"plugins":{"deny":["notifai"]}}\n',
      key: 'plugins.deny',
      remedy: 'remove "notifai" from plugins.deny',
    },
  ])('warns and reports a not-ready Doctor gap for $name', async ({ config, key, remedy }) => {
    const f = fixture(config)
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.err.join('\n')).toContain('OpenClaw will not load Notifai')
    expect(f.err.join('\n')).toContain(key)
    expect(f.err.join('\n')).toContain(remedy)

    f.out.length = 0
    expect(await doctorCommand(f.deps, { json: true })).toBe(EXIT.failed)
    const doctor = JSON.parse(f.out.at(-1)!) as {
      states: {
        id: string
        status: string
        detail: string
        technical: { openclaw_plugin_loadable: boolean; blocking_keys: string[] }
        remedy: { by: string; summary: string } | null
      }[]
    }
    const state = doctor.states.find((candidate) => candidate.id === 'hooks-openclaw-plugin')
    expect(state).toMatchObject({
      status: 'gap',
      technical: { openclaw_plugin_loadable: false, blocking_keys: [key] },
      remedy: { by: 'user-elsewhere', summary: remedy },
    })
    expect(state?.detail).toContain(key)
  })
})
