import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT, type CommandDeps } from './commands-core.js'
import { doctorCommand } from './commands-doctor.js'
import { hooksInstallCommand, hooksUninstallCommand } from './commands-hook-install.js'
import { parseOpenclawConfig } from './openclaw-plugin.js'

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
  it('preserves foreign comments, key order and comment-like string contents through install and uninstall', () => {
    const original = `{
  // keep this line comment
  /* keep this block comment */
  "identity": "retain /*literal*/ and // literal",
  "plugins": {
    /* trust settings stay intact */
    "allow": ["sample-existing"], // keep allow note
    "entries": {
      "other": { "enabled": true }
    }
  },
  "url": "https://example.test/a//b"
}\n`.replace(/\n/g, '\r\n')
    const f = fixture(original)

    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    const installed = readFileSync(f.configFile, 'utf8')
    expect(installed).not.toMatch(/(?<!\r)\n/)
    expect(installed).toContain('// keep this line comment')
    expect(installed).toContain('/* keep this block comment */')
    expect(installed).toContain('"identity": "retain /*literal*/ and // literal"')
    expect(installed).toContain('/* trust settings stay intact */')
    expect(installed).toContain('"allow": ["sample-existing"]')
    expect(installed).toContain('// keep allow note')
    expect(installed).toContain('"url": "https://example.test/a//b"')
    expect(installed.indexOf('"allow"')).toBeLessThan(installed.indexOf('"entries"'))
    expect(parseOpenclawConfig(installed, f.configFile)).toMatchObject({
      identity: 'retain /*literal*/ and // literal',
      plugins: {
        allow: ['sample-existing'],
        entries: {
          other: { enabled: true },
          notifai: { enabled: true, hooks: { allowConversationAccess: true } },
        },
      },
    })

    expect(hooksUninstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    const uninstalled = readFileSync(f.configFile, 'utf8')
    expect(uninstalled).not.toMatch(/(?<!\r)\n/)
    expect(parseOpenclawConfig(uninstalled, f.configFile)).toEqual(
      parseOpenclawConfig(original, f.configFile),
    )
    for (const text of [
      '// keep this line comment',
      '/* keep this block comment */',
      '"identity": "retain /*literal*/ and // literal"',
      '/* trust settings stay intact */',
      '"allow": ["sample-existing"]',
      '// keep allow note',
      '"url": "https://example.test/a//b"',
    ]) {
      expect(uninstalled).toContain(text)
    }
    expect(uninstalled.indexOf('"allow"')).toBeLessThan(uninstalled.indexOf('"entries"'))
    expect(uninstalled).not.toContain('"notifai"')
  })

  it('refuses malformed JSONC before creating OpenClaw files and leaves config bytes unchanged', () => {
    const malformed = '{\n  // this comment is valid\n  "plugins": { "allow": ["sample-existing"]\n'
    const f = fixture(malformed)

    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.failed)
    expect(readFileSync(f.configFile, 'utf8')).toBe(malformed)
    expect(existsSync(f.pluginDir)).toBe(false)
    expect(f.err.join('\n')).toContain(f.configFile)
    expect(f.err.join('\n')).toContain('invalid JSONC')
  })

  it('removes an empty Notifai plugin directory after releasing its file lock', () => {
    const f = fixture('{}\n')
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(existsSync(f.pluginDir)).toBe(true)

    expect(hooksUninstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(existsSync(f.pluginDir)).toBe(false)
    expect(readdirSync(path.join(f.state, 'extensions'))).toEqual([])
  })

  it('leaves a non-empty Notifai plugin directory and its foreign files in place', () => {
    const f = fixture('{}\n')
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    const foreignFile = path.join(f.pluginDir, 'keep.txt')
    writeFileSync(foreignFile, 'foreign')

    expect(hooksUninstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(existsSync(f.pluginDir)).toBe(true)
    expect(readFileSync(foreignFile, 'utf8')).toBe('foreign')
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

  it('reports the OpenClaw plugin loadable when plugins.allow includes notifai', async () => {
    const f = fixture('{"plugins":{"allow":["sample-existing","notifai"]}}\n')
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.err).toEqual([])

    f.out.length = 0
    await doctorCommand(f.deps, { json: true })
    const doctor = JSON.parse(f.out.at(-1)!) as {
      states: {
        id: string
        status: string
        technical: { openclaw_plugin_loadable: boolean; blocking_keys: string[] }
      }[]
    }
    expect(doctor.states.find((candidate) => candidate.id === 'hooks-openclaw-plugin'))
      .toMatchObject({
        status: 'ready',
        technical: { openclaw_plugin_loadable: true, blocking_keys: [] },
      })
  })
})
