import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as atomicFile from './atomic-file.js'
import { EXIT, type CommandDeps } from './commands-core.js'
import { hooksInstallCommand, hooksUninstallCommand } from './commands-hook-install.js'
import { buildHookConfig, notifaiNativePluginEnablementKeys } from './install-hooks.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(source: string) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-installer-preservation-'))
  roots.push(cwd)
  const home = path.join(cwd, 'home')
  const codex = path.join(home, '.codex')
  mkdirSync(codex, { recursive: true })
  const toml = path.join(codex, 'config.toml')
  const hooks = path.join(codex, 'hooks.json')
  writeFileSync(toml, source)
  const out: string[] = []
  const err: string[] = []
  const unexpected = () => { throw new Error('Installer must not access credentials or network') }
  const deps: CommandDeps = {
    cwd,
    env: {
      HOME: home, USERPROFILE: home, CODEX_HOME: codex,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      OPENCODE_CONFIG_DIR: path.join(home, '.config', 'opencode'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'),
    },
    hookAdapterHome: path.join(cwd, 'adapter'),
    hookPlatform: 'darwin',
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    store: { load: unexpected, save: unexpected, clear: unexpected, describe: unexpected },
    clientFactory: unexpected,
  }
  const flags = {
    harness: 'codex', execPath: process.execPath,
    scriptPath: fileURLToPath(new URL('./commands-hook-install.ts', import.meta.url)),
  }
  return { deps, flags, out, err, toml, hooks }
}

const commands = { install: hooksInstallCommand, uninstall: hooksUninstallCommand }

describe('Codex native plugin cleanup through actual commands', () => {
  for (const [action, command] of Object.entries(commands)) {
    it.each(['"""', "'''"])(`${action} preserves multiline strings, bracketed foreign tables and comments (%s)`, (quote) => {
      const root = `# model decision\ninstructions = ${quote}\n[plugins.notifai]\nkeep these instructions\n${quote}\nmodel = "keep-model"\n`
      const plugin = '[plugins.notifai] # plugin note\nenabled = true # enablement note\n# trailing note\n'
      const foreign = '[mcp_servers."tool[1]"]\ncommand = "keep-me"\n[[tools."item[2]"]]\nname = "keep-array"\n'
      const f = fixture(root + plugin + foreign)
      expect(command(f.deps, f.flags)).toBe(EXIT.ok)
      const after = readFileSync(f.toml, 'utf8')
      expect(parseToml(after)).toEqual(parseToml(root + foreign))
      expect(after).toContain(root)
      expect(after).toContain(foreign)
      for (const comment of ['# plugin note', '# enablement note', '# trailing note']) expect(after).toContain(comment)
      expect(existsSync(f.hooks)).toBe(action === 'install')
      expect(f.err).toEqual([])
    })

    it.each([
      'plugins.notifai.enabled = true\n',
      '"plugins"."notifai".enabled = true\n',
      'plugins = { notifai = { enabled = true }, foreign = { enabled = true } }\n',
      '[plugins]\nnotifai.enabled = true\n',
      'plugins."notifai@dotted".enabled = true\n[plugins.notifai]\nenabled = true\n',
    ])(`${action} refuses unsupported native enablement before changing either file: %s`, (source) => {
      const f = fixture(source)
      const hooks = JSON.stringify({ foreign: 'keep', hooks: buildHookConfig({ adapterPath: '/opt/test-hook-adapter', harness: 'codex' }) }) + '\n'
      writeFileSync(f.hooks, hooks)
      expect(command(f.deps, f.flags)).toBe(EXIT.failed)
      expect(readFileSync(f.toml, 'utf8')).toBe(source)
      expect(readFileSync(f.hooks, 'utf8')).toBe(hooks)
      expect(f.out).toEqual([])
      expect(f.err.join('\n')).toContain('Cannot safely remove obsolete native plugin wiring')
      if (action === 'install') expect(existsSync(f.deps.hookAdapterHome!)).toBe(false)
    })

    it(`${action} refuses malformed TOML without changing existing document hooks`, () => {
      const f = fixture('instructions = """\nunfinished\n')
      const hooks = '{"foreign": "keep"}\n'
      writeFileSync(f.hooks, hooks)
      expect(command(f.deps, f.flags)).toBe(EXIT.failed)
      expect(readFileSync(f.toml, 'utf8')).toBe('instructions = """\nunfinished\n')
      expect(readFileSync(f.hooks, 'utf8')).toBe(hooks)
      expect(f.out).toEqual([])
      expect(f.err.length).toBeGreaterThan(0)
    })
  }

  it.each([
    '[plugins.notifai]', '["plugins"."notifai"]', "['plugins'.'notifai']",
    '["plu\\u0067ins"."noti\\u0066ai"]', '[plugins."notifai@market[1]"]',
  ])('install clears decoded plugin ownership for %s', (header) => {
    const foreign = '[plugins."foreign[1]"]\nenabled = true\n'
    const f = fixture(`${header}\nenabled = true\n${foreign}`)
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(parseToml(readFileSync(f.toml, 'utf8'))).toEqual(parseToml(foreign))
    expect(existsSync(f.hooks)).toBe(true)
    expect(f.err).toEqual([])
  })

  it('validates the hook destination before disabling a working native plugin', () => {
    const source = '[plugins.notifai]\nenabled = true\n'
    const f = fixture(source)
    writeFileSync(f.hooks, '{invalid json')
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.failed)
    expect(readFileSync(f.toml, 'utf8')).toBe(source)
    expect(readFileSync(f.hooks, 'utf8')).toBe('{invalid json')
    expect(f.out).toEqual([])
  })

  it('preserves foreign inline hooks and trust data while clearing native enablement', () => {
    const root = '# keep\ninstructions = """\n[plugins.notifai]\n[hooks.Stop]\n"""\n'
    const foreign = '[mcp_servers."tool[1]"]\ncommand = "keep-me"\n'
    const hook = '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "foreign-stop"\n[hooks.state."/quoted[path]:stop:0:0"]\ntrusted_hash = "keep-hash"\n'
    const f = fixture(`${root}[plugins.notifai]\nenabled = true\n${foreign}${hook}`)
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    const after = readFileSync(f.toml, 'utf8')
    const parsed = parseToml(after)
    expect(parsed).toMatchObject(parseToml(root + foreign))
    expect(parsed['plugins']).toBeUndefined()
    expect(after).toContain(root)
    expect(after).toContain(foreign)
    expect(after).toContain('foreign-stop')
    const actualHooks = parsed['hooks'] as Record<string, unknown>
    const originalHooks = parseToml(hook)['hooks'] as Record<string, unknown>
    expect(actualHooks['state']).toEqual(originalHooks['state'])
    expect(actualHooks['Stop']).toEqual(expect.arrayContaining(originalHooks['Stop'] as unknown[]))
    expect(after).toContain('--owner notifai')
    expect(existsSync(f.hooks)).toBe(false)
    expect(f.err).toEqual([])
  })

  it.each(['before-native', 'after-native', 'before-document', 'after-document'] as const)(
    'never enables both mechanisms when a write fails %s', (boundary) => {
      const source = '[plugins.notifai]\nenabled = true\n'
      const f = fixture(source)
      const write = atomicFile.atomicWriteFileSync
      const isNative = boundary.endsWith('native')
      const target = isNative ? f.toml : f.hooks
      let reached = false
      vi.spyOn(atomicFile, 'atomicWriteFileSync').mockImplementation((file, contents, options) => {
        if (file !== target) return write(file, contents, options)
        reached = true
        // The original atomic filesystem implementation persists real bytes;
        // only the exact failure boundary is substituted.
        if (boundary.startsWith('after')) write(file, contents, options)
        throw new Error(`injected write failure ${boundary}`)
      })
      expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.failed)
      expect(reached).toBe(true)
      const native = notifaiNativePluginEnablementKeys(parseToml(readFileSync(f.toml, 'utf8'))['plugins'])
      expect(native.length > 0 && existsSync(f.hooks)).toBe(false)
      expect(native).toEqual(boundary === 'before-native' ? ['notifai'] : [])
      expect(existsSync(f.hooks)).toBe(boundary === 'after-document')
      expect(f.out).toEqual([])
      expect(f.err.join('\n')).toContain('injected write failure')
    },
  )

  it('has cleared native enablement before success narration can interrupt install', () => {
    const f = fixture('[plugins.notifai]\nenabled = true\n')
    const interruption = new Error('interrupted at first installed output')
    f.deps.io.out = (line) => { if (line.startsWith('Installed codex hooks')) throw interruption }
    expect(() => hooksInstallCommand(f.deps, f.flags)).toThrow(interruption)
    expect(existsSync(f.hooks)).toBe(true)
    expect(notifaiNativePluginEnablementKeys(parseToml(readFileSync(f.toml, 'utf8'))['plugins'])).toEqual([])
    expect(existsSync(path.join(path.dirname(f.toml), '.config.toml.notifai.lock'))).toBe(false)
  })
})
