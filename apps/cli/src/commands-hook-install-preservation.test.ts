import { existsSync,lstatSync,symlinkSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { EXIT,type CommandDeps } from './commands-core.js'
import { hooksInstallCommand,hooksUninstallCommand } from './commands-hook-install.js'
import { buildHookConfig,codexHookIdentityHash,codexStopDefinitionFingerprint,codexTrustFindings,codexTrustKey,codexTrustProblems,detectedHarnesses,findInstallations } from './install-hooks.js'

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

describe('Codex approval identity through actual hook repair', () => {
  it('adds missing tool wiring without moving approved hooks, empty groups or foreign groups', () => {
    const f = fixture('model = "keep-model"\n')
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    const document = JSON.parse(readFileSync(f.hooks, 'utf8'))
    const foreign = { matcher: '*', hooks: [{ type: 'command', command: 'foreign-handler', timeout: 10 }] }
    for (const groups of Object.values(document.hooks) as { hooks: unknown[] }[][]) groups.push(foreign)
    document.hooks.Stop.unshift({ matcher: 'Shell', hooks: [] })
    document.hooks.PostToolUse = [foreign]
    writeFileSync(f.hooks, JSON.stringify(document))
    const before = findInstallations(f.deps.env, f.deps.hookAdapterHome).filter(i => i.harness === 'codex')
    const installation = before[0]!
    const trust = 'model = "keep-model"\n' + installation.handlers.map(handler =>
      `[hooks.state.${JSON.stringify(codexTrustKey(installation, handler))}]\ntrusted_hash = "${codexHookIdentityHash(handler)}"\n`,
    ).join('\n')
    writeFileSync(f.toml, trust)
    expect(codexTrustProblems(before, f.deps.env)).toEqual([])
    const fingerprint = codexStopDefinitionFingerprint(before)

    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    const after = findInstallations(f.deps.env, f.deps.hookAdapterHome).filter(i => i.harness === 'codex')
    expect(codexStopDefinitionFingerprint(after)).toBe(fingerprint)
    expect(codexTrustFindings(after, f.deps.env)).toEqual([expect.objectContaining({ event: 'PostToolUse', state: 'new' })])
    expect(readFileSync(f.toml, 'utf8')).toBe(trust)
    const repaired = JSON.parse(readFileSync(f.hooks, 'utf8'))
    expect(repaired.hooks.Stop[0]).toEqual(document.hooks.Stop[0])
    for (const [event, groups] of Object.entries(document.hooks) as [string, unknown[]][]) {
      expect(repaired.hooks[event][groups.length - 1]).toEqual(foreign)
    }
    const bytes = readFileSync(f.hooks, 'utf8')
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(readFileSync(f.hooks, 'utf8')).toBe(bytes)
    expect(codexStopDefinitionFingerprint(findInstallations(f.deps.env, f.deps.hookAdapterHome))).toBe(fingerprint)
  })
})

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
})


describe('active harness homes', () => {
  it.each(['default', 'separate', 'symlinked'] as const)('discovers and repairs the %s Codex home without replacing shared links', (kind) => {
    const f = fixture('model = "keep-model"\n')
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    const sourceInstallation = findInstallations(f.deps.env, f.deps.hookAdapterHome).find(i => i.harness === 'codex')!
    writeFileSync(f.toml, readFileSync(f.toml, 'utf8') + sourceInstallation.handlers.map(handler =>
      `[hooks.state.${JSON.stringify(codexTrustKey(sourceInstallation, handler))}]\ntrusted_hash = "${codexHookIdentityHash(handler)}"\n`,
    ).join('\n'))
    const original = readFileSync(f.hooks, 'utf8')
    const originalConfig = readFileSync(f.toml, 'utf8')
    if (kind === 'default') delete f.deps.env['CODEX_HOME']
    else {
      const selected = path.join(f.deps.cwd, 'profile')
      mkdirSync(selected)
      f.deps.env['CODEX_HOME'] = selected
      for (const [name, file] of [['hooks.json', f.hooks], ['config.toml', f.toml]]) {
        if (kind === 'symlinked') symlinkSync(file!, path.join(selected, name!))
        else writeFileSync(path.join(selected, name!), readFileSync(file!))
      }
    }
    const problems: string[] = []
    const installed = findInstallations(f.deps.env, f.deps.hookAdapterHome, 'darwin', problems).filter(i => i.harness === 'codex')
    expect(installed).toHaveLength(1)
    expect(problems).toEqual([])
    expect(codexTrustFindings(installed, f.deps.env).length).toBe(kind === 'default' ? 0 : installed[0]!.handlers.length)
    expect(hooksInstallCommand(f.deps, f.flags), f.err.join('\n')).toBe(EXIT.ok)
    expect(readFileSync(f.hooks, 'utf8')).toBe(original)
    expect(readFileSync(f.toml, 'utf8')).toBe(originalConfig)
    if (kind !== 'default') expect(f.out.join('\n')).toContain('same CODEX_HOME')
    if (kind === 'symlinked') {
      expect(lstatSync(path.join(f.deps.env['CODEX_HOME']!, 'hooks.json')).isSymbolicLink()).toBe(true)
      expect(lstatSync(path.join(f.deps.env['CODEX_HOME']!, 'config.toml')).isSymbolicLink()).toBe(true)
    }
  })
})


describe('shared Machine configuration repair', () => {
  it.each(['codex', 'claude-code'] as const)('repairs %s through the selected home and preserves foreign content', (harness) => {
    const f = fixture('model = "keep-model"\n')
    const flags = { ...f.flags, harness }
    expect(hooksInstallCommand(f.deps, flags)).toBe(EXIT.ok)
    const sourceHome = harness === 'codex' ? path.dirname(f.hooks) : f.deps.env['CLAUDE_CONFIG_DIR']!
    const name = harness === 'codex' ? 'hooks.json' : 'settings.json'
    const sourceFile = path.join(sourceHome, name)
    const document = JSON.parse(readFileSync(sourceFile, 'utf8'))
    document.custom = { keep: true }
    document.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: 'foreign-command' }] }]
    writeFileSync(sourceFile, JSON.stringify(document))
    const selected = path.join(f.deps.cwd, 'shared-profile')
    mkdirSync(selected)
    symlinkSync(sourceFile, path.join(selected, name))
    if (harness === 'codex') symlinkSync(f.toml, path.join(selected, 'config.toml'))
    f.deps.env[harness === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = selected
    expect(hooksInstallCommand(f.deps, flags), f.err.join('\n')).toBe(EXIT.ok)
    const repaired = JSON.parse(readFileSync(sourceFile, 'utf8'))
    expect(repaired.custom).toEqual({ keep: true })
    expect(repaired.hooks.UserPromptSubmit[0]).toEqual(document.hooks.UserPromptSubmit[0])
    expect(repaired.hooks.UserPromptSubmit.length).toBeGreaterThan(1)
    expect(lstatSync(path.join(selected, name)).isSymbolicLink()).toBe(true)
    expect(findInstallations(f.deps.env, f.deps.hookAdapterHome).some(i => i.harness === harness)).toBe(true)
    const bytes = readFileSync(sourceFile, 'utf8')
    expect(hooksInstallCommand(f.deps, flags)).toBe(EXIT.ok)
    expect(readFileSync(sourceFile, 'utf8')).toBe(bytes)
  })

  it('refuses a dangling selected config link without replacing it', () => {
    const f = fixture('')
    rmSync(f.toml)
    symlinkSync(path.join(f.deps.cwd, 'missing.toml'), f.toml)
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.failed)
    expect(lstatSync(f.toml).isSymbolicLink()).toBe(true)
    expect(existsSync(f.hooks)).toBe(false)
  })
})


it('detects only the selected Claude home, just as it does for Codex', () => {
  const f = fixture('')
  const selected = path.join(f.deps.cwd, 'claude-profile')
  f.deps.env['CLAUDE_CONFIG_DIR'] = selected
  mkdirSync(selected)
  expect(detectedHarnesses(f.deps.env)).toContain('claude-code')
  rmSync(selected, { recursive: true })
  mkdirSync(path.join(f.deps.env['HOME']!, '.claude'))
  expect(detectedHarnesses(f.deps.env)).not.toContain('claude-code')
})
