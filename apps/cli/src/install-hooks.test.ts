import {
existsSync,
lstatSync,
mkdirSync,
mkdtempSync,
readFileSync,
symlinkSync,
writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { describe,expect,it } from 'vitest'
import { EXIT,type CommandDeps } from './commands-core.js'
import { hooksInstallCommand } from './commands-hook-install.js'
import {
applyPlan,
buildHookConfig,
codexLegacyProjectLayers,
codexProjectRoot,
codexRoutingTrustProblems,
codexTrustProblems,
detectedHarnesses,
handlerCommandLine,
handlerEvent,
hookCommand,
loadSettings,
mergeHooks,
removeHooks,
spliceOutNotifaiPluginTables,
type HookConfig
} from './install-hooks.js'
import {
opencodePluginSource
} from './opencode-plugin.js'

const SCRIPT = '/opt/notifai/dist/main.js'
const ADAPTER = '/Users/test/.notifai/bin/hook-adapter'

function ours(): HookConfig {
  return buildHookConfig({ adapterPath: ADAPTER })
}

describe('hook config', () => {

  it('single-quotes so a path cannot become a command', () => {
    // Double quotes still expand $() and backticks, so a checkout path with
    // shell syntax was execution on every hook event.
    const cmd = hookCommand('/tmp/$(touch /tmp/pwned)/hook-adapter', 'stop')
    expect(cmd).toBe("'/tmp/$(touch /tmp/pwned)/hook-adapter' hook stop --owner notifai")
    expect(hookCommand("/it's/here", 'stop')).toContain(`'/it'\\''s/here'`)
  })

  it('names every handler in Claude Code and Codex, and never in Grok, which rejects the field', () => {
    const names = (harness: 'claude-code' | 'codex' | 'grok', platform: NodeJS.Platform, claudeForm?: 'exec') =>
      Object.entries(buildHookConfig({ adapterPath: ADAPTER, harness, platform, ...(claudeForm ? { claudeForm } : {}) }))
        .flatMap(([event, groups]) => groups.flatMap(group => group.hooks.map(handler =>
          `${event} ${handlerEvent(handlerCommandLine(handler))}: ${handler.statusMessage}`)))
    const shared = [
      'SessionStart session-start: Loading Notifai for this session',
      'SessionStart attend: Keeping Notifai connected',
      'SubagentStart subagent-start: Loading Notifai for this subagent',
      'UserPromptSubmit user-prompt-submit: Updating Notifai session',
      'UserPromptSubmit attend: Keeping Notifai connected',
      'Stop stop: Sending questions and answers through Notifai',
      'Stop attend: Keeping Notifai connected',
      'SessionEnd session-end: Closing Notifai session',
    ]
    const codex = [...shared,
      'PreToolUse pre-tool-use: Sending this question to Notifai',
      'PostToolUse post-tool-use: Checking Notifai for notes and answers',
      'Interrupt attend: Recording the interrupt for Notifai',
    ]
    const claude = [...shared,
      'PermissionRequest permission-request: Waiting for your answer in Notifai',
      'PostToolUse post-tool-use: Recording your answer for Notifai',
    ]
    for (const platform of ['darwin', 'win32'] as const) {
      expect(names('codex', platform).sort(), platform).toEqual(codex.sort())
      expect(names('claude-code', platform).sort(), platform).toEqual(claude.sort())
    }
    expect(names('claude-code', 'darwin', 'exec').sort()).toEqual(claude.sort())
    expect(JSON.stringify(buildHookConfig({ adapterPath: ADAPTER, harness: 'grok', platform: 'darwin' }))).not.toContain('statusMessage')
  })

  it('pins the Codex definition: Codex skips every changed handler until the User approves it again', () => {
    // A deliberate Codex hook change regenerates this fixture; review it as a
    // change every Codex User must approve in /hooks.
    const golden = JSON.parse(readFileSync(new URL('./fixtures/codex-hooks-golden.json', import.meta.url), 'utf8')) as Record<string, string>
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const adapterPath = platform === 'win32' ? 'C:\\Users\\Example User\\.notifai\\bin\\notifai.exe' : '/home/example user/.notifai/bin/notifai'
      for (const scope of ['', 'codex:/home/example user/.codex']) {
        expect(JSON.stringify(buildHookConfig({ adapterPath, harness: 'codex', platform, integrationScope: scope }), null, 2), `${platform} ${scope}`)
          .toBe(golden[`${platform}|${scope}`])
      }
    }
  })
})

describe('merging into existing settings', () => {
  it('leaves unrelated settings and other people’s hooks untouched', () => {
    const existing = {
      permissions: { allow: ['Bash(git *)'] },
      hooks: {
        Stop: [{ hooks: [{ type: 'command' as const, command: 'make lint' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'guard.sh' }] }],
      },
    }
    const merged = mergeHooks(existing, ours(), SCRIPT)

    expect(merged.document['permissions']).toEqual({ allow: ['Bash(git *)'] })
    expect(merged.document.hooks?.['PreToolUse']).toEqual(existing.hooks.PreToolUse)
    const stop = merged.document.hooks?.['Stop'] ?? []
    expect(stop[0]?.hooks[0]?.command).toBe('make lint')
    expect(stop[1]?.hooks[0]?.command).toContain('hook stop')
  })
})

/**
 * Project-scoped Codex files are no longer an install target, but a previous
 * build wrote them and they still fire. Codex resolves a project hook file
 * against the main repository, so a worktree has two directories worth
 * enumerating for removal.
 */
describe('legacy Project-scoped Codex layers', () => {

  it('rejects a forged gitfile that redirects the Codex layer outside the project', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'notifai-forged-wt-'))
    const project = path.join(base, 'project')
    const outside = path.join(base, 'outside')
    const forgedGitDir = path.join(project, 'forged-admin')
    const outsideCommonDir = path.join(outside, '.git')
    mkdirSync(forgedGitDir, { recursive: true })
    mkdirSync(path.join(outsideCommonDir, 'worktrees'), { recursive: true })
    writeFileSync(path.join(project, '.git'), `gitdir: ${forgedGitDir}\n`)
    writeFileSync(path.join(forgedGitDir, 'commondir'), `${outsideCommonDir}\n`)
    writeFileSync(path.join(forgedGitDir, 'gitdir'), `${path.join(project, '.git')}\n`)

    expect(codexProjectRoot(project)).toBe(project)
    expect(codexLegacyProjectLayers(project).map((layer) => layer.dir)).toEqual([
      path.join(project, '.codex'),
    ])
  })
})

describe('writing the settings file', () => {
  function scratch(): string {
    return mkdtempSync(path.join(os.tmpdir(), 'notifai-apply-'))
  }

  it('refuses to write through a symlink', () => {
    const dir = scratch()
    const real = path.join(dir, 'somewhere-else.json')
    const link = path.join(dir, 'settings.json')
    writeFileSync(real, '{"untouched":true}\n')
    symlinkSync(real, link)

    expect(() => applyPlan(link, { hooks: {} })).toThrow(/symlink/)
    // The point of refusing: the target must be exactly as it was.
    expect(readFileSync(real, 'utf8')).toBe('{"untouched":true}\n')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
  })
})

describe('finding what is installed', () => {

  it('keeps ordinary Question Routing available while the optional card hook awaits trust', () => {
    const installation = { harness: 'codex' as const, file: '/fixture/hooks.json', handlers: [{
      event: 'PreToolUse', groupIndex: 0, handlerIndex: 0, command: 'notifai hook pre-tool-use --harness codex',
      matcher: 'request_user_input_async', timeout: 10,
    }] }
    expect(codexTrustProblems([installation], { CODEX_HOME: '/missing-fixture-home' })).toHaveLength(1)
    expect(codexRoutingTrustProblems([installation], { CODEX_HOME: '/missing-fixture-home' })).toEqual([])
  })

})

/**
 * OpenCode's extension point is a plugin module, not a command
 * hook, so it needs a different adapter — but deliberately not different logic.
 */
describe('the OpenCode adapter', () => {
  const source = opencodePluginSource({
    adapterPath: ADAPTER,
    timeoutSeconds: 240,
  })

  it('executes the generated adapter and publishes the SDK session title', async () => {
    let requested = ''
    const generated = (await import(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    )) as {
      NotifAIPlugin(input: {
        directory: string
        client: {
          session: {
            get(input: { path: { id: string } }): Promise<{ data: { title: string } }>
          }
        }
      }): Promise<{
        'shell.env'?: (
          input: { sessionID?: string },
          output: { env: Record<string, string> },
        ) => Promise<void>
      }>
    }
    const plugin = await generated.NotifAIPlugin({
      directory: '/repo',
      client: {
        session: {
          get: async ({ path: request }) => {
            requested = request.id
            return { data: { title: 'Semantic session names' } }
          },
        },
      },
    })
    const output = { env: {} as Record<string, string> }
    await plugin['shell.env']?.({ sessionID: 'opencode-session' }, output)

    expect(requested).toBe('opencode-session')
    expect(output.env).toMatchObject({
      NOTIFAI_ACTIVE_HARNESS: 'opencode',
      NOTIFAI_ACTIVE_SESSION_ID: 'opencode-session',
      NOTIFAI_ACTIVE_SESSION_LABEL: 'Semantic session names',
      NOTIFAI_ACTIVE_SESSION_WORKER: '0',
    })
  })
})

describe('detectHarness', () => {
  function home(...entries: string[]): NodeJS.ProcessEnv {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'notifai-detect-home-'))
    for (const entry of entries) mkdirSync(path.join(dir, entry), { recursive: true })
    return { HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config') }
  }

  it('never lets a repository decide the machine-wide install', () => {
    // A cloned repository carries every harness marker there is. Lifecycle
    // wiring lands for the whole machine, so those folders count for nothing:
    // with no harness at home, install names none and asks for --harness.
    const repo = mkdtempSync(path.join(os.tmpdir(), 'notifai-detect-repo-'))
    for (const marker of ['.claude', '.codex', '.cursor', '.opencode', '.openclaw', '.grok']) {
      mkdirSync(path.join(repo, marker))
    }
    writeFileSync(path.join(repo, 'CLAUDE.md'), '# project\n')
    const env = home()
    expect(detectedHarnesses(env)).toEqual([])
    const err: string[] = []
    const deps = {
      cwd: repo,
      env,
      io: { out: () => undefined, err: (line: string) => err.push(line), confirm: async () => false, openUrl: () => undefined },
    } as unknown as CommandDeps
    expect(hooksInstallCommand(deps, {})).toBe(EXIT.usage)
    expect(err.join('\n')).toContain('pass --harness')
    for (const marker of ['.claude', '.codex', '.cursor']) expect(existsSync(path.join(env['HOME']!, marker))).toBe(false)
  })
})

describe('Windows hook commands and discovery', () => {
  const winNode = 'C:\\Program Files\\nodejs\\node.exe'
  const winAdapter = 'C:\\Users\\Ada Lovelace\\.notifai\\bin\\hook-adapter'
  const winOpts = { platform: 'win32' as const, nodePath: winNode }

  it('replaces old Windows Codex hooks once and preserves foreign encoded scripts', () => {
    const foreign = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' +
      Buffer.from("Write-Output 'hook stop --owner notifai'", 'utf16le').toString('base64')
    const old = { hooks: { Stop: [{ hooks: [
      { type: 'command' as const, command: `"${winAdapter}" hook stop --owner notifai --harness codex` },
      { type: 'command' as const, command: foreign },
    ] }] } }
    const desired = buildHookConfig({ adapterPath: winAdapter, harness: 'codex', ...winOpts })
    const merged = mergeHooks(old, desired, winAdapter).document
    expect(mergeHooks(merged, desired, winAdapter).document).toEqual(merged)
    const commands = Object.values(merged.hooks ?? {}).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command)))
    expect(commands).toContain(foreign)
    expect(commands).not.toContain(old.hooks.Stop[0]!.hooks[0]!.command)
    expect(commands.filter(command => handlerEvent(command) === 'stop')).toHaveLength(1)
    expect(handlerEvent(foreign)).toBeNull()
    expect(removeHooks(merged, winAdapter).document.hooks?.Stop?.[0]?.hooks).toEqual([{ type: 'command', command: foreign }])
  })
})

/**
 * `config.toml` is the user's file and usually hand-written. Notifai adds three
 * handlers to it and must hand back everything else exactly as it arrived —
 * comments, ordering, and spacing included.
 */
describe('writing config.toml around what is already there', () => {
  const layerFor = (name: string): string => {
    const repo = mkdtempSync(path.join(os.tmpdir(), name))
    const layer = path.join(repo, '.codex')
    mkdirSync(layer, { recursive: true })
    return layer
  }

  it('leaves every byte outside the hooks tables untouched', () => {
    const layer = layerFor('notifai-toml-comments-')
    const file = path.join(layer, 'config.toml')
    const original = [
      '# why this model, in the user\'s own words',
      'model = "gpt-5.6"   # trailing note',
      '',
      '[mcp_servers.linear]',
      '# a comment nobody but the user cares about',
      'command = "npx"',
      'args = ["-y", "linear-mcp"]',
      '',
    ].join('\n')
    writeFileSync(file, original)

    applyPlan(file, { ...loadSettings(file), hooks: ours() })

    const after = readFileSync(file, 'utf8')
    expect(after).toContain(original.trimEnd())
    expect(after).toContain("# why this model, in the user's own words")
    expect(after).toContain('# trailing note')
    expect(after).toContain('# a comment nobody but the user cares about')
    expect(parseToml(after)).toMatchObject({ model: 'gpt-5.6' })
    expect(after).toContain('[[hooks.Stop]]')
  })
})

describe('obsolete native plugin enablement', () => {

  it('preserves strings in arrays, escaped quotes, disabled plugins and all comment text', () => {
    const foreign = [
      '# root note',
      'unrelated_nan = nan',
      'examples = ["""',
      '[plugins.notifai]',
      'keep \\"quoted\\" text',
      '"""]',
      '[plugins.notifai]',
      'enabled = false',
      'options = { text = "[plugins.notifai]" }',
      '',
    ].join('\n')
    const owned = [
      '[plugins."notifai@local"] # owned header note',
      'enabled = true',
      'values = [',
      '  "remove", # keep array note',
      ']',
      '# final note',
      '',
    ].join('\n')
    const { next, removed } = spliceOutNotifaiPluginTables(foreign + owned)
    expect(removed).toEqual(['notifai@local'])
    expect(parseToml(next)).toEqual(parseToml(foreign))
    expect(next).toContain(foreign)
    for (const comment of ['# owned header note', '# keep array note', '# final note']) expect(next).toContain(comment)
    expect(spliceOutNotifaiPluginTables(next)).toEqual({ next, removed: [] })
  })
})
