import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import { parseChoices } from './send.js'
import {
  OPENCODE_PLUGIN_MARKER,
  isOurOpencodePlugin,
  opencodePluginPath,
  opencodePluginSource,
  opencodePluginTarget,
} from './opencode-plugin.js'
import { SESSION_ACTIVATION_CONTEXT } from './session-activation.js'
import { hookAdapterPath, installHookAdapter } from './hook-adapter.js'
import {
  BLOCKING_STOP_TIMEOUT_SECONDS,
  HARNESSES,
  applyPlan,
  detectHarness,
  detectedHarnesses,
  buildCursorHookConfig,
  buildHookConfig,
  codexLayerDir,
  codexProjectRoot,
  findInstallations,
  codexHookIdentityHash,
  codexCoexistenceNotes,
  codexHomeNote,
  codexRepresentationProblems,
  codexTrustKey,
  codexTrustProblems,
  handlerEvent,
  harnessAccountHome,
  hookCommand,
  quoteWindowsArg,
  loadSettings,
  mergeHooks,
  removeHooks,
  settingsFile,
  type HookConfig,
  type SettingsDocument,
} from './install-hooks.js'

const SCRIPT = '/opt/notifai/dist/main.js'
const EXEC = '/usr/local/bin/node'
const ADAPTER = '/Users/test/.notifai/bin/hook-adapter'

function ours(): HookConfig {
  return buildHookConfig({ adapterPath: ADAPTER })
}

describe('choice labels', () => {
  it('treats a comma as an ordinary character, never a delimiter', () => {
    // Observed live 2026-08-02 under the old comma-split grammar:
    // "Yes, it worked,No, something broke" passed as one value silently
    // became four choices. The delimiter form is gone; one flag, one answer.
    expect(parseChoices(['Yes, it worked', 'No, something broke'])).toEqual([
      { id: 'yes-it-worked', label: 'Yes, it worked' },
      { id: 'no-something-broke', label: 'No, something broke' },
    ])
    expect(parseChoices(['Staging,Production', 'Neither'])).toEqual([
      { id: 'staging-production', label: 'Staging,Production' },
      { id: 'neither', label: 'Neither' },
    ])
  })

  it('rejects a set that cannot become a valid closed question', () => {
    expect(parseChoices(['Only one'])).toBe('invalid')
    expect(parseChoices(['A', 'a'])).toBe('invalid')
    expect(parseChoices(['1', '2', '3', '4', '5', '6', '7'])).toBe('invalid')
  })

  it('treats an unused repeatable flag as no choices at all', () => {
    expect(parseChoices([])).toBeNull()
    expect(parseChoices(undefined)).toBeNull()
  })
})

describe('hook config', () => {
  it('activates Notifai at the session lifecycle seam for every native hook adapter', () => {
    const claude = buildHookConfig({ adapterPath: ADAPTER, harness: 'claude-code' })
    const codex = buildHookConfig({ adapterPath: ADAPTER, harness: 'codex' })
    const cursor = buildCursorHookConfig({ adapterPath: ADAPTER, harness: 'cursor' })

    expect(claude['SessionStart']?.[0]?.hooks[0]).toMatchObject({
      command: hookCommand(ADAPTER, 'session-start', 'claude-code'),
    })
    expect(codex['SessionStart']?.[0]?.hooks[0]).toMatchObject({
      command: hookCommand(ADAPTER, 'session-start', 'codex'),
    })
    expect(cursor['sessionStart']?.[0]).toMatchObject({
      command: hookCommand(ADAPTER, 'session-start', 'cursor'),
    })
    expect(claude['SubagentStart']?.[0]?.hooks[0]).toMatchObject({
      command: hookCommand(ADAPTER, 'subagent-start', 'claude-code'),
    })
    expect(codex['SubagentStart']?.[0]?.hooks[0]).toMatchObject({
      command: hookCommand(ADAPTER, 'subagent-start', 'codex'),
    })
    expect(cursor['subagentStart']).toBeUndefined()
    expect(cursor['stop']?.[0]).toMatchObject({
      command: hookCommand(ADAPTER, 'activation-stop', 'cursor'),
      loop_limit: 1,
    })
  })

  it('invokes one stable adapter so a sparse hook PATH still works', () => {
    expect(hookCommand(ADAPTER, 'stop')).toBe(`'${ADAPTER}' hook stop --owner notifai`)
  })

  it('single-quotes so a path cannot become a command', () => {
    // Double quotes still expand $() and backticks, so a checkout path with
    // shell syntax was execution on every hook event.
    const cmd = hookCommand('/tmp/$(touch /tmp/pwned)/hook-adapter', 'stop')
    expect(cmd).toBe("'/tmp/$(touch /tmp/pwned)/hook-adapter' hook stop --owner notifai")
    expect(hookCommand("/it's/here", 'stop')).toContain(`'/it'\\''s/here'`)
  })

  it('uses one fixed blocking process budget rather than accepting mutable timing inputs', () => {
    const config = buildHookConfig({ adapterPath: ADAPTER })
    expect(config['Stop']?.[0]?.hooks[0]?.timeout).toBe(540)
    expect(config['Stop']?.[0]?.hooks[0]?.async).toBeUndefined()
    // Claude Code defaults UserPromptSubmit to 30s; Codex gives SessionEnd 1-3s.
    expect(config['UserPromptSubmit']?.[0]?.hooks[0]?.timeout).toBe(15)
    expect(config['SessionEnd']?.[0]?.hooks[0]?.timeout).toBe(3)
  })

  it('stamps the exact harness on every generated command', () => {
    const config = buildHookConfig({
      adapterPath: ADAPTER,
      harness: 'claude-code',
    })
    expect(
      Object.values(config)
        .flatMap((groups) => groups)
        .flatMap((group) => group.hooks)
        .every((handler) => handler.command.includes('--harness claude-code')),
    ).toBe(true)
  })

  it('lets Codex own Stop timeout while keeping short fixed lifecycle budgets', () => {
    const codex = buildHookConfig({ adapterPath: ADAPTER, harness: 'codex' })

    expect(codex['UserPromptSubmit']?.[0]?.hooks[0]?.timeout).toBe(15)
    expect(codex['SessionEnd']?.[0]?.hooks[0]?.timeout).toBe(3)
    // Codex hashes the exact serialized definition into `trusted_hash`, so its
    // Stop handler stays a bare blocking command: declaring a timeout would
    // invalidate the user's approval and the handler would silently stop.
    expect(codex['Stop']?.[0]?.hooks[0]).toEqual({
      type: 'command',
      command: hookCommand(ADAPTER, 'stop', 'codex'),
    })
  })

  it('gives Claude Code an asynchronous Stop with an explicit waiter budget on POSIX', () => {
    const claude = buildHookConfig({ adapterPath: ADAPTER, harness: 'claude-code' })

    // `async: true` is what frees the turn: the handler returns at once and the
    // same process lives on as the waiter. The explicit timeout is what keeps
    // that process alive — Claude kills a background hook at its own 600s
    // default and reports nothing, so a wait near that boundary loses answers.
    expect(claude['Stop']?.[0]?.hooks[0]).toEqual({
      type: 'command',
      command: hookCommand(ADAPTER, 'stop', 'claude-code'),
      timeout: 3600,
      async: true,
    })
    expect(claude['UserPromptSubmit']?.[0]?.hooks[0]?.async).toBeUndefined()
    expect(claude['SessionEnd']?.[0]?.hooks[0]?.async).toBeUndefined()
  })

  it('gives Claude Code a blocking Stop continuation on Windows', () => {
    const options = {
      adapterPath: 'C:\\Users\\Ada\\.notifai\\bin\\hook-adapter',
      harness: 'claude-code' as const,
      platform: 'win32' as const,
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    }
    const claude = buildHookConfig(options)

    expect(claude['Stop']?.[0]?.hooks[0]).toEqual({
      type: 'command',
      command: hookCommand(options.adapterPath, 'stop', 'claude-code', options),
      timeout: BLOCKING_STOP_TIMEOUT_SECONDS,
    })
  })

  it('leaves exactly one handler per event when an old blocking shape is reinstalled over', () => {
    const old = mergeHooks({}, buildHookConfig({ adapterPath: ADAPTER }), SCRIPT)
    const migrated = mergeHooks(
      old.document,
      buildHookConfig({ adapterPath: ADAPTER, harness: 'claude-code' }),
      SCRIPT,
    )

    for (const event of ['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
      const groups = migrated.document.hooks?.[event] ?? []
      expect(groups.flatMap((group) => group.hooks)).toHaveLength(1)
    }
    expect(migrated.document.hooks?.['Stop']?.[0]?.hooks[0]).toMatchObject({
      timeout: 3600,
      async: true,
    })
    expect(migrated.replaced.sort()).toEqual([
      'SessionEnd',
      'SessionStart',
      'Stop',
      'SubagentStart',
      'UserPromptSubmit',
    ])
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

  it('replaces our own groups on reinstall instead of duplicating them', () => {
    const once = mergeHooks({}, ours(), SCRIPT)
    const twice = mergeHooks(
      once.document,
      buildHookConfig({ adapterPath: ADAPTER }),
      SCRIPT,
    )
    expect(twice.document.hooks?.['Stop']).toHaveLength(1)
    expect(twice.document.hooks?.['Stop']?.[0]?.hooks[0]?.timeout).toBe(540)
    expect(twice.replaced).toContain('Stop')
  })

  it('keeps a user handler that shares a matcher group with ours', () => {
    const installed = mergeHooks({}, ours(), SCRIPT)
    const mixed = installed.document.hooks!['Stop']!
    mixed[0]!.hooks.push({ type: 'command', command: 'make lint' })

    const stripped = removeHooks(installed.document, SCRIPT)
    expect(stripped.document.hooks?.['Stop']).toEqual([
      { hooks: [{ type: 'command', command: 'make lint' }] },
    ])
  })

  it('uninstall removes only our handlers', () => {
    const installed = mergeHooks(
      { hooks: { Stop: [{ hooks: [{ type: 'command' as const, command: 'make lint' }] }] } },
      ours(),
      SCRIPT,
    )
    const stripped = removeHooks(installed.document, SCRIPT)
    expect(stripped.document.hooks?.['Stop']).toEqual([
      { hooks: [{ type: 'command', command: 'make lint' }] },
    ])
    expect(stripped.document.hooks?.['UserPromptSubmit']).toBeUndefined()
  })
})

describe('settings locations', () => {
  it('writes a project install to the gitignored file, not the shared one', () => {
    expect(settingsFile('claude-code', false, '/repo', {})).toBe('/repo/.claude/settings.local.json')
    expect(settingsFile('claude-code', true, '/repo', {})).toBe(
      path.join(os.homedir(), '.claude', 'settings.json'),
    )
  })

  it('keeps ambient global settings inside the test account', () => {
    expect(os.homedir()).toBe(process.env['HOME'])
    expect(os.homedir()).toBe(process.env['NOTIFAI_TEST_HOME'])
    expect(settingsFile('claude-code', true, '/repo', {})).toBe(
      path.join(process.env['HOME']!, '.claude', 'settings.json'),
    )
  })

  it('uses inline Codex hooks for a new layer', () => {
    expect(settingsFile('codex', false, '/repo', {})).toBe('/repo/.codex/config.toml')
    expect(settingsFile('codex', true, '/repo', {})).toBe(
      path.join(os.homedir(), '.codex', 'config.toml'),
    )
  })

  it('keeps a Notifai-only hooks.json instead of rewriting config.toml', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-json-'))
    mkdirSync(path.join(repo, '.codex'), { recursive: true })
    applyPlan(path.join(repo, '.codex', 'hooks.json'), { hooks: ours() })

    expect(settingsFile('codex', false, repo, {})).toBe(path.join(repo, '.codex', 'hooks.json'))
  })

  it('joins the only populated hook representation without special-casing its owner', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-foreign-json-'))
    const layer = path.join(repo, '.codex')
    mkdirSync(layer, { recursive: true })
    writeFileSync(
      path.join(layer, 'config.toml'),
      `[hooks.state."${layer}/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:abc"\n`,
    )
    applyPlan(path.join(layer, 'hooks.json'), {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'gdh-stop' }] }],
      },
    })

    expect(settingsFile('codex', false, repo, {})).toBe(path.join(layer, 'hooks.json'))
  })

  it('keeps inline hooks when config.toml is the only populated representation', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-foreign-toml-'))
    const layer = path.join(repo, '.codex')
    mkdirSync(layer, { recursive: true })
    writeFileSync(
      path.join(layer, 'config.toml'),
      ['[[hooks.Stop]]', '', '[[hooks.Stop.hooks]]', 'type = "command"', 'command = "gdh-stop"', ''].join(
        '\n',
      ),
    )

    expect(settingsFile('codex', false, repo, {})).toBe(path.join(layer, 'config.toml'))
  })

  it('does not migrate our hooks when both representations already exist', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-both-'))
    const layer = path.join(repo, '.codex')
    mkdirSync(layer, { recursive: true })
    writeFileSync(
      path.join(layer, 'config.toml'),
      ['[[hooks.Stop]]', '', '[[hooks.Stop.hooks]]', 'type = "command"', 'command = "gdh-stop"', ''].join(
        '\n',
      ),
    )
    applyPlan(path.join(layer, 'hooks.json'), { hooks: ours() })

    expect(settingsFile('codex', false, repo, {})).toBe(path.join(layer, 'hooks.json'))
  })
})

/**
 * Codex resolves project hooks against the main repository, so an install run
 * inside a worktree used to write a file Codex never reads — and reported
 * success. Proven against the real binary 2026-08-03.
 */
describe('a Codex install run inside a git worktree', () => {
  /** The on-disk shape `git worktree add` produces, verified against real git. */
  function repoWithWorktree(): { main: string; worktree: string } {
    const base = mkdtempSync(path.join(os.tmpdir(), 'notifai-wt-'))
    const main = path.join(base, 'main')
    const worktree = path.join(base, 'wt')
    const gitDir = path.join(main, '.git', 'worktrees', 'wt')
    mkdirSync(gitDir, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    writeFileSync(path.join(gitDir, 'commondir'), '../..\n')
    writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`)
    return { main, worktree }
  }

  it('targets the main repository, which is the file Codex actually reads', () => {
    const { main, worktree } = repoWithWorktree()

    expect(settingsFile('codex', false, worktree, {})).toBe(path.join(main, '.codex', 'config.toml'))
    expect(codexProjectRoot(worktree)).toBe(main)
  })

  it('resolves the same way from a subdirectory of the worktree', () => {
    const { main, worktree } = repoWithWorktree()
    const nested = path.join(worktree, 'apps', 'cli')
    mkdirSync(nested, { recursive: true })

    expect(codexProjectRoot(nested)).toBe(main)
  })

  it('leaves an ordinary checkout alone', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'notifai-repo-'))
    mkdirSync(path.join(base, '.git'), { recursive: true })
    const nested = path.join(base, 'packages', 'core')
    mkdirSync(nested, { recursive: true })

    expect(codexProjectRoot(base)).toBe(base)
    expect(codexProjectRoot(nested)).toBe(base)
  })

  it('falls back to the working directory outside a repository', () => {
    // Not every project is a git checkout, and an install there should still
    // land somewhere predictable rather than walking off to the filesystem root.
    const base = mkdtempSync(path.join(os.tmpdir(), 'notifai-bare-'))

    expect(codexProjectRoot(base)).toBe(base)
  })

  it('names the directory Codex needs before it will look for project hooks', () => {
    // Writing the main repository's file is not enough: Codex only loads the
    // project layer when a `.codex` directory sits at or above cwd, and in a
    // worktree there is nothing to find. An empty directory was the difference
    // between the handler running and nothing running.
    const { worktree } = repoWithWorktree()

    expect(codexLayerDir(worktree)).toBe(path.join(worktree, '.codex'))
  })

  it('anchors that directory at the worktree root so subdirectories are covered', () => {
    const { worktree } = repoWithWorktree()
    const nested = path.join(worktree, 'apps', 'cli')
    mkdirSync(nested, { recursive: true })

    // Codex walks up from cwd looking for it, so one at the root serves every
    // directory an agent might run from.
    expect(codexLayerDir(nested)).toBe(path.join(worktree, '.codex'))
  })

  it('asks for nothing extra in an ordinary checkout, where both halves agree', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'notifai-plain-'))
    mkdirSync(path.join(base, '.git'), { recursive: true })

    expect(codexLayerDir(base)).toBeNull()
  })

  it('does not redirect Claude Code, which reads the worktree it runs in', () => {
    const { worktree } = repoWithWorktree()

    expect(settingsFile('claude-code', false, worktree, {})).toBe(
      path.join(worktree, '.claude', 'settings.local.json'),
    )
  })

  it('follows the active harness home for global hook install', () => {
    expect(settingsFile('codex', true, '/repo', { HOME: '/user', CODEX_HOME: '/managed/codex' })).toBe(
      '/managed/codex/config.toml',
    )
    expect(settingsFile('claude-code', true, '/repo', { CLAUDE_CONFIG_DIR: '/managed/claude' })).toBe(
      '/managed/claude/settings.json',
    )
  })
})

describe('upgrading past a dropped event', () => {
  it('removes a handler for an event this build no longer serves', () => {
    // Found live in this repo: settings.local.json still ran
    // `main.js hook permission-request`, written by a build that had such an
    // event. The current binary exits 2 with "Unknown hook event" every time
    // the harness fires it, and reinstalling never cleaned it up because the
    // merge only touched events present in the incoming config.
    const stale = {
      hooks: {
        PermissionRequest: [
          { hooks: [{ type: 'command' as const, command: hookCommand(ADAPTER, 'permission-request') }] },
        ],
        Stop: [{ hooks: [{ type: 'command' as const, command: hookCommand(ADAPTER, 'stop') }] }],
      },
    }

    const merged = mergeHooks(stale, ours(), SCRIPT)

    expect(merged.document.hooks?.['PermissionRequest']).toBeUndefined()
    expect(merged.removed).toEqual(['PermissionRequest'])
    expect(merged.replaced).toContain('Stop')
  })

  it('keeps someone else’s handler for that same dropped event', () => {
    const mixed = {
      hooks: {
        PermissionRequest: [
          {
            hooks: [
              { type: 'command' as const, command: hookCommand(ADAPTER, 'permission-request') },
              { type: 'command' as const, command: 'their-own-tool --check' },
            ],
          },
        ],
      },
    }

    const merged = mergeHooks(mixed, ours(), SCRIPT)

    expect(merged.document.hooks?.['PermissionRequest']?.[0]?.hooks).toEqual([
      { type: 'command', command: 'their-own-tool --check' },
    ])
  })

  it('does not accumulate duplicates when run twice', () => {
    const once = mergeHooks({}, ours(), SCRIPT)
    const twice = mergeHooks(once.document, ours(), SCRIPT)
    expect(twice.document.hooks?.['Stop']?.[0]?.hooks).toHaveLength(1)
    expect(twice.removed).toEqual([])
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

  it('preserves an existing file’s mode and leaves no temp file behind', () => {
    const dir = scratch()
    const file = path.join(dir, 'settings.json')
    writeFileSync(file, '{}\n', { mode: 0o644 })

    applyPlan(file, { hooks: ours() })

    expect(statSync(file).mode & 0o777).toBe(0o644)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveProperty('hooks.Stop')
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('keeps a file it creates private, since settings can carry tokens', () => {
    const dir = scratch()
    const file = path.join(dir, 'nested', 'settings.json')
    applyPlan(file, { hooks: {} })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('merges into Codex config.toml without dropping trust state or foreign hooks', () => {
    const dir = scratch()
    const file = path.join(dir, 'config.toml')
    writeFileSync(
      file,
      [
        'model = "gpt-5.6"',
        '',
        '[features]',
        'hooks = true',
        '',
        `[hooks.state."${file}:stop:0:0"]`,
        'trusted_hash = "sha256:abc"',
        '',
        '[[hooks.Stop]]',
        '',
        '[[hooks.Stop.hooks]]',
        'type = "command"',
        'command = "gdh-stop"',
        '',
      ].join('\n'),
    )

    const merged = mergeHooks(loadSettings(file), ours(), SCRIPT)
    applyPlan(file, merged.document)

    const text = readFileSync(file, 'utf8')
    expect(text).toContain('model = "gpt-5.6"')
    expect(text).toContain('trusted_hash = "sha256:abc"')
    expect(text).toContain('gdh-stop')
    expect(text).toContain('hook stop')
    expect(text).toContain('[[hooks.UserPromptSubmit]]')
    expect(text).toContain('[[hooks.SessionEnd]]')
    expect(merged.document.hooks?.['Stop']?.flatMap((group) => group.hooks)).toHaveLength(2)
  })
})

describe('finding what is installed', () => {
  it('reports Notifai handlers written as inline Codex [hooks]', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-find-toml-'))
    const file = path.join(cwd, '.codex', 'config.toml')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      [
        '[[hooks.Stop]]',
        '',
        '[[hooks.Stop.hooks]]',
        'type = "command"',
        'command = "gdh-stop"',
        '',
        '[[hooks.Stop]]',
        '',
        '[[hooks.Stop.hooks]]',
        'type = "command"',
        `command = "${hookCommand(ADAPTER, 'stop', 'codex')}"`,
        '',
      ].join('\n'),
    )

    const found = findInstallations(cwd, { HOME: path.join(cwd, 'isolated-home') })
    const codex = found.find((installation) => installation.harness === 'codex' && !installation.global)
    expect(codex?.file).toBe(file)
    expect(codex?.handlers.map((handler) => handler.event)).toEqual(['Stop'])
    expect(codex?.handlers[0]?.handlerIndex).toBe(0)
    expect(codex?.handlers[0]?.groupIndex).toBe(1)
  })

  /**
   * The shape a session manager leaves behind: it owns `hooks.json` for its own
   * agent lifecycle, Notifai sits in `config.toml`, and every handler fires
   * exactly once. Reported as a Notifai failure for a whole release, it sent
   * users to hand-edit a file another program regenerates — for nothing.
   */
  it('says nothing when the other representation holds only foreign hooks', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-foreign-rep-'))
    const layer = path.join(cwd, '.codex')
    mkdirSync(layer, { recursive: true })
    applyPlan(path.join(layer, 'hooks.json'), {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '/bin/sh /opt/other-tool/hook.sh' }] }],
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: '/bin/sh /opt/other-tool/hook.sh' }] },
        ],
      },
    })
    writeFileSync(
      path.join(layer, 'config.toml'),
      stringifyToml({ hooks: ours() as unknown as Record<string, unknown> }),
    )

    expect(codexRepresentationProblems(cwd, { HOME: path.join(cwd, 'isolated-home') })).toEqual([])
  })

  it('names the foreign file and says Notifai will not touch it', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-coexist-'))
    const layer = path.join(cwd, '.codex')
    mkdirSync(layer, { recursive: true })
    applyPlan(path.join(layer, 'hooks.json'), {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '/bin/sh /opt/other-tool/hook.sh' }] }],
      },
    })
    writeFileSync(
      path.join(layer, 'config.toml'),
      stringifyToml({ hooks: ours() as unknown as Record<string, unknown> }),
    )

    const notes = codexCoexistenceNotes(cwd, { HOME: path.join(cwd, 'isolated-home') })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(path.join(layer, 'hooks.json'))
    expect(notes[0]).toContain('Notifai will not modify it')
    expect(notes[0]).toContain('not a Notifai fault')
    expect(notes[0]).toContain("can end a turn before Notifai's answer arrives")
  })

  it('says nothing when Notifai is the only thing in the layer', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-coexist-alone-'))
    const layer = path.join(cwd, '.codex')
    mkdirSync(layer, { recursive: true })
    writeFileSync(
      path.join(layer, 'config.toml'),
      stringifyToml({ hooks: ours() as unknown as Record<string, unknown> }),
    )

    expect(codexCoexistenceNotes(cwd, { HOME: path.join(cwd, 'isolated-home') })).toEqual([])
  })

  it('names the events a Notifai copy in each file would notify twice for', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-dual-rep-'))
    const layer = path.join(cwd, '.codex')
    mkdirSync(layer, { recursive: true })
    applyPlan(path.join(layer, 'hooks.json'), { hooks: ours() })
    writeFileSync(
      path.join(layer, 'config.toml'),
      stringifyToml({ hooks: ours() as unknown as Record<string, unknown> }),
    )

    const problems = codexRepresentationProblems(cwd, { HOME: path.join(cwd, 'isolated-home') })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(path.join(layer, 'hooks.json'))
    expect(problems[0]).toContain(path.join(layer, 'config.toml'))
    expect(problems[0]).toMatch(/Stop/)
    expect(problems[0]).toMatch(
      /notifies twice per turn for SessionStart, SubagentStart, UserPromptSubmit, Stop, SessionEnd/,
    )
    expect(problems[0]).toMatch(/notifai hooks uninstall --harness codex/)
    expect(problems[0]).not.toMatch(/--global/)
  })

  it('reports Notifai split across both files, where only one copy stays current', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-split-rep-'))
    const layer = path.join(cwd, '.codex')
    mkdirSync(layer, { recursive: true })
    const { Stop, ...rest } = ours()
    applyPlan(path.join(layer, 'hooks.json'), { hooks: { Stop: Stop! } })
    writeFileSync(
      path.join(layer, 'config.toml'),
      stringifyToml({ hooks: rest as unknown as Record<string, unknown> }),
    )

    const problems = codexRepresentationProblems(cwd, { HOME: path.join(cwd, 'isolated-home') })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/split between them/)
    expect(problems[0]).toMatch(/Stop/)
    expect(problems[0]).toMatch(/UserPromptSubmit/)
    expect(problems[0]).not.toMatch(/twice per turn/)
  })

  it('scopes the remedy to the global layer it found the duplicate in', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-global-rep-'))
    const home = path.join(cwd, 'isolated-home')
    const layer = path.join(home, '.codex')
    mkdirSync(layer, { recursive: true })
    applyPlan(path.join(layer, 'hooks.json'), { hooks: ours() })
    writeFileSync(
      path.join(layer, 'config.toml'),
      stringifyToml({ hooks: ours() as unknown as Record<string, unknown> }),
    )

    const problems = codexRepresentationProblems(cwd, { HOME: home })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/notifai hooks uninstall --harness codex --global/)
    expect(problems[0]).toMatch(/notifai hooks install --harness codex --global/)
  })

  it('reports handlers from either harness with their positions', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-find-'))
    mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    applyPlan(path.join(cwd, '.claude', 'settings.local.json'), { hooks: ours() })

    const found = findInstallations(cwd, { HOME: path.join(cwd, 'isolated-home') })
    const claude = found.find((i) => i.harness === 'claude-code' && !i.global)

    expect(claude).toBeDefined()
    expect(claude?.handlers.map((h) => h.event).sort()).toEqual([
      'SessionEnd',
      'SessionStart',
      'Stop',
      'SubagentStart',
      'UserPromptSubmit',
    ])
    expect(claude?.handlers.every((h) => h.groupIndex === 0 && h.handlerIndex === 0)).toBe(true)
  })

  it('reads the event a handler actually invokes, not the key it sits under', () => {
    // These diverge exactly when an upgrade drops an event, which is the case
    // worth detecting.
    expect(handlerEvent(hookCommand(ADAPTER, 'permission-request'))).toBe('permission-request')
    expect(handlerEvent('unrelated --tool')).toBeNull()
  })

  it('detects when Codex still trusts an older definition of an installed hook', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-trust-'))
    const home = path.join(cwd, 'home')
    const env = { HOME: home }
    const hookFile = path.join(cwd, '.codex', 'hooks.json')
    mkdirSync(path.dirname(hookFile), { recursive: true })
    applyPlan(hookFile, { hooks: ours() })
    const installations = findInstallations(cwd, env)
    const codex = installations.find((installation) => installation.harness === 'codex')
    const stop = codex?.handlers.find((handler) => handler.event === 'Stop')
    expect(stop).toBeDefined()

    const trustFile = path.join(home, '.codex', 'config.toml')
    mkdirSync(path.dirname(trustFile), { recursive: true })
    writeFileSync(
      trustFile,
      `[hooks.state.${JSON.stringify(codexTrustKey(codex!, stop!))}]\ntrusted_hash = "sha256:obsolete"\n`,
    )

    const stale = codexTrustProblems(installations, env)
    expect(stale).toHaveLength(5)
    expect(stale).toEqual(expect.arrayContaining([expect.stringMatching(/Stop.*changed.*\/hooks/i)]))

    writeFileSync(
      trustFile,
      `[hooks.state.${JSON.stringify(codexTrustKey(codex!, stop!))}]\ntrusted_hash = "${codexHookIdentityHash(stop!)}"\n`,
    )
    const untrusted = codexTrustProblems(installations, env)
    expect(untrusted).toHaveLength(4)
    expect(untrusted).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/SessionStart.*not trusted.*\/hooks/i),
        expect.stringMatching(/SubagentStart.*not trusted.*\/hooks/i),
        expect.stringMatching(/UserPromptSubmit.*not trusted.*\/hooks/i),
        expect.stringMatching(/SessionEnd.*not trusted.*\/hooks/i),
      ]),
    )

    writeFileSync(
      trustFile,
      `[hooks.state.${JSON.stringify(codexTrustKey(codex!, stop!))}]\ntrusted_hash = "${codexHookIdentityHash(stop!)}"\nenabled = false\n`,
    )
    expect(codexTrustProblems(installations, env)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Stop.*disabled.*\/hooks/i)]),
    )
  })

})

/**
 * Ownership was matched on the absolute script path, so a second
 * checkout did not recognise the first one's handlers as ours: both stayed,
 * the harness ran both, and one question produced two notifications.
 */
describe('two checkouts', () => {
  const OTHER = '/Users/rafael/notifai-public/apps/cli/dist/main.js'

  function documentWith(command: string): SettingsDocument {
    return { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 300 }] }] } }
  }

  function stopCommands(document: SettingsDocument): string[] {
    return (document.hooks?.['Stop'] ?? []).flatMap((group) => group.hooks.map((h) => h.command))
  }

  it('replaces a handler another checkout installed instead of running beside it', () => {
    const existing = documentWith(hookCommand('/other/notifai/hook-adapter', 'stop'))
    const merged = mergeHooks(
      existing,
      buildHookConfig({ adapterPath: ADAPTER }),
      SCRIPT,
    )
    const commands = stopCommands(merged.document)
    expect(commands.filter((c) => c.includes('hook stop'))).toHaveLength(1)
    expect(commands[0]).toContain(ADAPTER)
    expect(commands.join(' ')).not.toContain('/other/notifai/hook-adapter')
  })

  it('uninstalls a handler another checkout installed', () => {
    const removed = removeHooks(documentWith(hookCommand('/other/notifai/hook-adapter', 'stop')), SCRIPT)
    expect(stopCommands(removed.document)).toHaveLength(0)
  })

  it('still recognises an install that predates the marker', () => {
    // Different checkout, no marker: the form written by an older build.
    const legacy = documentWith(`'${EXEC}' '${OTHER}' hook stop`)
    expect(stopCommands(removeHooks(legacy, SCRIPT).document)).toHaveLength(0)
  })

  it("leaves someone else's hook alone", () => {
    const foreign = documentWith('/usr/local/bin/my-own-thing --stop')
    expect(stopCommands(removeHooks(foreign, SCRIPT).document)).toHaveLength(1)
  })

  it("preserves a foreign project's generic dist/main.js hook", () => {
    const foreign = documentWith("'/usr/local/bin/node' '/opt/foreign/dist/main.js' hook stop")
    expect(stopCommands(removeHooks(foreign, SCRIPT).document)).toHaveLength(1)
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

  it('shells out to the same hook commands the other harnesses run', () => {
    // The whole point: presence, escalation and retirement stay in the CLI.
    expect(source).toContain('"hook", event')
    expect(source).toContain('"--harness", "opencode"')
    expect(source).toContain(JSON.stringify(ADAPTER))
    expect(source).not.toContain(JSON.stringify(SCRIPT))
    expect(source).not.toContain(JSON.stringify(EXEC))
  })

  it('wires the three question lifecycle joints and leaves permissions alone', () => {
    expect(source).toContain('"chat.message"')
    expect(source).toContain('event: async ({ event })')
    expect(source).toContain('event?.type === "session.idle"')
    expect(source).toContain('event?.properties?.sessionID')
    expect(source).toContain('event?.type === "session.deleted"')
    expect(source).toContain('event?.properties?.info?.id')
    expect(source).not.toContain('"permission.ask"')
  })

  it('adds session activation through OpenCode system context without setup or network', async () => {
    expect(source).toContain('"experimental.chat.system.transform"')
    const generated = (await import(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    )) as {
      NotifAIPlugin(input: { directory: string; client: object }): Promise<{
        'experimental.chat.system.transform'?: (
          input: object,
          output: { system: string[] },
        ) => Promise<void>
      }>
    }
    const plugin = await generated.NotifAIPlugin({ directory: '/repo', client: {} })
    const output = { system: ['existing context'] }

    await plugin['experimental.chat.system.transform']?.({ sessionID: 'ses_1' }, output)

    expect(output.system).toEqual([`existing context\n\n${SESSION_ACTIVATION_CONTEXT}`])

    const internal = { system: ['internal agent-generation context'] }
    await plugin['experimental.chat.system.transform']?.({}, internal)
    expect(internal.system).toEqual(['internal agent-generation context'])

    const empty = { system: [] as string[] }
    await plugin['experimental.chat.system.transform']?.({ sessionID: 'ses_2' }, empty)
    expect(empty.system).toEqual([SESSION_ACTIVATION_CONTEXT])
  })

  it('publishes the session pointer on a user message without injecting content', () => {
    // The CLI has never emitted `hookSpecificOutput.additionalContext`, so the
    // injection this used to assert could not fire. The handler earns its place
    // by publishing the pointer that lets `notifai ask` find this session.
    expect(source).toContain('"chat.message"')
    expect(source).toContain('hook_event_name: "UserPromptSubmit"')
    expect(source).not.toContain('additionalContext')
    expect(source).not.toContain('synthetic: true')
  })

  it('injects exact identity and the first-party OpenCode title into agent shells', () => {
    expect(source).toContain('"shell.env"')
    expect(source).toContain('NOTIFAI_ACTIVE_HARNESS')
    expect(source).toContain('NOTIFAI_ACTIVE_SESSION_ID')
    expect(source).toContain('NOTIFAI_ACTIVE_SESSION_LABEL')
    expect(source).toContain('NOTIFAI_ACTIVE_SESSION_LABEL_PENDING')
    expect(source).toContain('input?.sessionID')
    expect(source).toContain('client.session.get({ path: { id: sessionID } })')
    expect(source).toContain('response?.data?.title')
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
    })
  })

  it('marks OpenCode placeholder titles as pending instead of publishing them', async () => {
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
          get: async () => ({
            data: { title: 'New session - 2026-08-20T13:05:00.000Z' },
          }),
        },
      },
    })
    const output = { env: {} as Record<string, string> }
    await plugin['shell.env']?.({ sessionID: 'opencode-session' }, output)

    expect(output.env).toEqual({
      NOTIFAI_ACTIVE_HARNESS: 'opencode',
      NOTIFAI_ACTIVE_SESSION_ID: 'opencode-session',
      NOTIFAI_ACTIVE_SESSION_LABEL_PENDING: '1',
    })
  })

  it('carries the ownership marker so a second checkout replaces it', () => {
    expect(source).toContain(OPENCODE_PLUGIN_MARKER)
    expect(isOurOpencodePlugin(source)).toBe(true)
    expect(isOurOpencodePlugin('export const SomeoneElse = () => ({})')).toBe(false)
  })

  it('installs beside the config rather than into it', () => {
    const local = opencodePluginPath(false, '/repo', {})
    expect(local).toBe(path.join('/repo', '.opencode', 'plugins', 'notifai.js'))
    const global = opencodePluginPath(true, '/repo', { OPENCODE_CONFIG_DIR: '/cfg/opencode' })
    expect(global).toBe(path.join('/cfg/opencode', 'plugins', 'notifai.js'))
  })

  it('is a harness `hooks install` knows about', () => {
    expect(HARNESSES).toContain('opencode')
    expect(settingsFile('opencode', false, '/repo', {})).toContain('notifai.js')
  })

  it('reports the same stable adapter identity as command-hook harnesses', () => {
    expect(opencodePluginTarget(source)).toEqual({
      adapter: ADAPTER,
      current: true,
      timeoutSeconds: 240,
    })
    expect(opencodePluginTarget(source.replace(/^const ADAPTER_VERSION = .*\n/m, ''))).toEqual({
      adapter: ADAPTER,
      current: false,
      timeoutSeconds: 240,
    })
    expect(opencodePluginTarget('export const SomeoneElse = () => ({})')).toBeNull()
    // Ours, but with the constants edited beyond recognition: no answer beats
    // a wrong one, since the caller compares these for equality.
    expect(opencodePluginTarget(`${OPENCODE_PLUGIN_MARKER}\nconst ADAPTER = whatever\n`)).toBeNull()
  })
})

describe('detectHarness', () => {
  function project(...entries: string[]): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'notifai-detect-'))
    for (const entry of entries) {
      if (entry.endsWith('.md')) writeFileSync(path.join(dir, entry), '# project\n')
      else mkdirSync(path.join(dir, entry), { recursive: true })
    }
    return dir
  }

  it('detects Claude Code from a project .claude directory', () => {
    expect(detectHarness(project('.claude'))).toBe('claude-code')
  })

  it('detects Claude Code from CLAUDE.md alone', () => {
    // A repository worked in daily through Claude Code may never accumulate a
    // .claude/ directory; its project file is the only marker there is.
    expect(detectHarness(project('CLAUDE.md'))).toBe('claude-code')
  })

  it('detects Claude Code from .claude and CLAUDE.md together without double-counting', () => {
    expect(detectHarness(project('.claude', 'CLAUDE.md'))).toBe('claude-code')
  })

  it('does not infer a harness from AGENTS.md', () => {
    // AGENTS.md began as a Codex convention and is now read by most agent
    // tooling, Claude Code included. Naming a harness from it would be a guess
    // wearing detection's clothes. With no other project evidence this falls
    // through to machine evidence, which on a multi-tool machine is ambiguous.
    const dir = project('AGENTS.md')
    const answer = detectHarness(dir)
    expect(answer).not.toBe('codex')
    expect(HARNESSES.includes(answer as never) || answer === null).toBe(true)
  })

  it('pairs AGENTS.md with CLAUDE.md as Claude Code, not Codex', () => {
    // The shape this very repository has, and four of the five projects the
    // release was verified in.
    expect(detectHarness(project('CLAUDE.md', 'AGENTS.md'))).toBe('claude-code')
  })

  it('detects each harness from its own project directory', () => {
    expect(detectHarness(project('.codex'))).toBe('codex')
    expect(detectHarness(project('.cursor'))).toBe('cursor')
    expect(detectHarness(project('.opencode'))).toBe('opencode')
  })

  it('returns null when the project itself names two harnesses', () => {
    // Genuine ambiguity for a single-harness caller. detectedHarnesses lists
    // both so install can wire them together.
    expect(detectHarness(project('.claude', '.codex'))).toBeNull()
  })

  it('lists every project-named harness in declared order', () => {
    const isolated = { HOME: mkdtempSync(path.join(os.tmpdir(), 'notifai-detect-home-')) }
    expect(detectedHarnesses(project('.codex', '.claude'), isolated)).toEqual([
      'claude-code',
      'codex',
    ])
  })

  it('detects Codex from the active custom CODEX_HOME', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-detect-home-'))
    const codexHome = path.join(home, 'managed', 'codex')
    mkdirSync(codexHome, { recursive: true })

    expect(detectedHarnesses(project(), { HOME: home, CODEX_HOME: codexHome })).toEqual(['codex'])
  })

  it('prefers project evidence over anything installed on the machine', () => {
    // The regression. Machine-global markers used to be OR-ed in per harness,
    // so a developer with several agent tools installed got a candidate for
    // every one of them, the "exactly one" test never passed, and detection
    // returned null in every repository on that machine — including ones whose
    // own contents named a single harness unambiguously.
    //
    // This asserts the ordering rather than the machine state, so it holds on
    // a CI box with a bare home directory and on a developer laptop carrying
    // all four.
    expect(detectHarness(project('.cursor'))).toBe('cursor')
    expect(detectHarness(project('CLAUDE.md'))).toBe('claude-code')
  })

  it('falls back to machine evidence only when the project offers none', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'notifai-detect-empty-'))
    // Whatever this machine has, an empty project must never crash and must
    // return either a single harness or null — never an arbitrary pick.
    const answer = detectHarness(empty)
    expect(answer === null || HARNESSES.includes(answer)).toBe(true)
  })
})

describe('Windows hook commands and discovery', () => {
  const winNode = 'C:\\Program Files\\nodejs\\node.exe'
  const winAdapter = 'C:\\Users\\Ada Lovelace\\.notifai\\bin\\hook-adapter'
  const winOpts = { platform: 'win32' as const, nodePath: winNode }

  it('keeps POSIX command bytes unchanged', () => {
    expect(hookCommand(ADAPTER, 'stop', undefined, { platform: 'posix' })).toBe(
      `'${ADAPTER}' hook stop --owner notifai`,
    )
    expect(hookCommand(ADAPTER, 'stop', 'codex', { platform: 'posix' })).toBe(
      `'${ADAPTER}' hook stop --owner notifai --harness codex`,
    )
  })

  it('emits a Windows-safe command with no POSIX single quotes', () => {
    const command = hookCommand(winAdapter, 'stop', 'codex', winOpts)
    expect(command).toBe(
      `"${winNode}" "${winAdapter}" hook stop --owner notifai --harness codex`,
    )
    expect(command).not.toContain("'")
    expect(quoteWindowsArg('C:\\ends\\with\\')).toBe('"C:\\ends\\with\\\\"')
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('round-trips the Windows command through JSON and TOML documents', () => {
    const command = hookCommand(winAdapter, 'stop', 'cursor', winOpts)
    expect(JSON.parse(JSON.stringify({ command }))).toEqual({ command })
    expect(parseToml(stringifyToml({ command }))).toEqual({ command })
  })

  it('discovers a Windows-quoted installation as the stable adapter', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-win-discover-'))
    const homeDir = path.join(cwd, 'home')
    const script = path.join(cwd, 'cli.js')
    writeFileSync(script, '')
    installHookAdapter({ execPath: process.execPath, scriptPath: script }, homeDir, 'win32')
    const adapter = hookAdapterPath(homeDir)
    mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    applyPlan(path.join(cwd, '.claude', 'settings.local.json'), {
      hooks: buildHookConfig({
        adapterPath: adapter,
        harness: 'claude-code',
        platform: 'win32',
        nodePath: process.execPath,
      }),
    })

    const found = findInstallations(
      cwd,
      { HOME: homeDir, USERPROFILE: 'C:\\Users\\Ada' },
      homeDir,
      'win32',
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.harness).toBe('claude-code')
    expect(found[0]?.problems ?? []).toEqual([])
    expect(found[0]?.handlers[0]?.command.startsWith(`${quoteWindowsArg(process.execPath)} `)).toBe(
      true,
    )
  })

  it('prefers a Windows-absolute USERPROFILE over an MSYS HOME', () => {
    const env = { HOME: '/c/Users/msys', USERPROFILE: 'C:\\Users\\Ada' }
    expect(harnessAccountHome(env, 'win32')).toBe('C:\\Users\\Ada')
    expect(settingsFile('cursor', true, '/repo', env, 'win32')).toBe(
      path.join('C:\\Users\\Ada', '.cursor', 'hooks.json'),
    )
    expect(settingsFile('claude-code', true, '/repo', env, 'win32')).toBe(
      path.join('C:\\Users\\Ada', '.claude', 'settings.json'),
    )
    expect(opencodePluginPath(true, '/repo', env, 'win32')).toBe(
      path.join('C:\\Users\\Ada', '.config', 'opencode', 'plugins', 'notifai.js'),
    )
  })

  it('makes OpenCode spawn the adapter through Node on Windows with shell:false', () => {
    const source = opencodePluginSource({
      adapterPath: winAdapter,
      timeoutSeconds: 240,
      platform: 'win32',
      nodePath: winNode,
    })
    expect(source).toContain(`const NODE = ${JSON.stringify(winNode)}`)
    expect(source).toContain('spawn(NODE, [ADAPTER, "hook", event, "--owner", "notifai", "--harness", "opencode"]')
    expect(source).toContain('shell: false')
    expect(source).toContain('windowsHide: true')
    expect(source).not.toContain('spawn(ADAPTER,')
    expect(opencodePluginTarget(source)).toEqual({
      adapter: winAdapter,
      current: true,
      timeoutSeconds: 240,
      nodePath: winNode,
    })
  })
})

/**
 * `CODEX_HOME` replaces the Codex home rather than shadowing it: `codex doctor`
 * with the variable set resolves every path inside it and never reads
 * `~/.codex`. Installing to the account default anyway would write hooks the
 * running agent cannot see, so Notifai follows the variable — and says so,
 * because the same divergence is what makes a correct install look absent.
 */
describe('codex home note', () => {
  it('is silent when CODEX_HOME is unset', () => {
    expect(codexHomeNote({ HOME: '/home/someone' }, 'linux')).toBeNull()
  })

  it('is silent when CODEX_HOME names the account default', () => {
    expect(
      codexHomeNote({ HOME: '/home/someone', CODEX_HOME: '/home/someone/.codex' }, 'linux'),
    ).toBeNull()
  })

  it('names both homes and why the other one is not read', () => {
    const note = codexHomeNote({ HOME: '/home/someone', CODEX_HOME: '/runtime/home' }, 'linux')
    expect(note).toContain('/runtime/home')
    expect(note).toContain('/home/someone/.codex')
    expect(note).toContain('not read by Codex in this shell')
    expect(note).toContain('trust by absolute file path')
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

  it('replaces the hooks tables rather than appending a second copy', () => {
    const layer = layerFor('notifai-toml-replace-')
    const file = path.join(layer, 'config.toml')
    writeFileSync(file, '# keep me\nmodel = "gpt-5.6"\n')

    applyPlan(file, { ...loadSettings(file), hooks: ours() })
    const once = readFileSync(file, 'utf8')
    applyPlan(file, { ...loadSettings(file), hooks: ours() })
    const twice = readFileSync(file, 'utf8')

    expect(twice).toBe(once)
    expect(twice).toContain('# keep me')
    expect(twice.match(/\[\[hooks\.Stop\]\]/g) ?? []).toHaveLength(1)
  })

  it('carries the Codex trust store across a write', () => {
    const layer = layerFor('notifai-toml-trust-')
    const file = path.join(layer, 'config.toml')
    writeFileSync(
      file,
      `model = "gpt-5.6"\n\n[hooks.state."${layer}/config.toml:stop:0:0"]\ntrusted_hash = "sha256:abc"\n`,
    )

    const existing = loadSettings(file)
    applyPlan(file, { ...existing, hooks: { ...existing.hooks, ...ours() } })

    const after = parseToml(readFileSync(file, 'utf8')) as {
      hooks: { state: Record<string, { trusted_hash: string }> }
    }
    expect(after.hooks.state[`${layer}/config.toml:stop:0:0`]?.trusted_hash).toBe('sha256:abc')
  })

  it('falls back to a whole-file write when the splice cannot be trusted', () => {
    const layer = layerFor('notifai-toml-inline-')
    const file = path.join(layer, 'config.toml')
    // An inline top-level `hooks` key cannot be spliced around, only rewritten.
    writeFileSync(file, '# this comment is lost, and that is the safe outcome\nhooks = {}\n')

    applyPlan(file, { hooks: ours() })

    const after = readFileSync(file, 'utf8')
    expect(after).toContain('[[hooks.Stop]]')
    expect(after).not.toContain('hooks = {}')
  })
})
