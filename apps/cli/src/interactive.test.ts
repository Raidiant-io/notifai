import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from './client.js'
import { EXIT, type CommandDeps } from './commands.js'
import { findInstallations } from './install-hooks.js'

const CANCEL = Symbol.for('notifai-clack-cancel')

type PromptCall = {
  kind: 'select' | 'text' | 'confirm' | 'multiselect'
  message: string
  options?: { value: string; label: string; hint?: string }[]
}

const promptLog: PromptCall[] = []
let answers: Array<unknown | ((call: PromptCall) => unknown)> = []

function takeAnswer(call: PromptCall): unknown {
  promptLog.push(call)
  const next = answers.shift()
  if (next === undefined) {
    throw new Error(`unexpected ${call.kind}: ${call.message}`)
  }
  return typeof next === 'function' ? next(call) : next
}

vi.mock('@clack/prompts', () => ({
  isCancel: (value: unknown) => value === CANCEL,
  select: async (args: { message: string; options: { value: string; label: string; hint?: string }[] }) =>
    takeAnswer({ kind: 'select', message: args.message, options: args.options }),
  text: async (args: { message: string }) => takeAnswer({ kind: 'text', message: args.message }),
  confirm: async (args: { message: string }) => takeAnswer({ kind: 'confirm', message: args.message }),
  multiselect: async (args: { message: string; options: { value: string; label: string; hint?: string }[] }) =>
    takeAnswer({ kind: 'multiselect', message: args.message, options: args.options }),
  note: () => {},
  outro: vi.fn(),
  log: { step: () => {}, success: () => {}, error: () => {}, warn: () => {} },
  spinner: () => ({ start: () => {}, stop: () => {} }),
}))

const { interactiveCommand, routingHookActions, uninstallScopeOptions } = await import('./interactive.js')
const clack = await import('@clack/prompts')

function isolatedEnv(cwd: string): NodeJS.ProcessEnv {
  const home = path.join(cwd, 'home')
  return {
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(cwd, 'config'),
    XDG_STATE_HOME: path.join(cwd, 'state'),
    NOTIFAI_NO_ANIMATION: '1',
  }
}

function makeClient(): ApiClient {
  return {
    health: async () => true,
    capabilities: async (platform = 'ios') => ({ schema_version: 1, platform }),
    compatibility: async () => ({
      cli: {
        state: 'current',
        reason: 'current',
        affected_operation: null,
        recovery_action: null,
        current_version: '5.0.0',
        current_build: null,
        recommended_version: '5.0.0',
        recommended_build: null,
        minimum_version: null,
        minimum_build: null,
        deprecation: null,
        sunset: null,
      },
      platforms: [],
      server_capabilities: ['answer', 'agent_acknowledgement'],
    }),
    listDevices: async () => ({ devices: [] }),
    accessStatus: async () => ({ email: 'rafael@example.test' }),
  } as unknown as ApiClient
}

function makeDeps(cwd: string, env: NodeJS.ProcessEnv = isolatedEnv(cwd)): CommandDeps {
  return {
    io: {
      out: () => {},
      err: () => {},
      confirm: async () => false,
      openUrl: () => {},
    },
    store: {
      load: () => ({
        machineId: 'mac_test',
        secret: 'test-secret',
        baseUrl: 'https://test.notifai.invalid',
        machineName: 'test-machine',
      }),
      save: () => {},
      clear: () => {},
      describe: () => 'test credential store',
    },
    env,
    cwd,
    hookAdapterHome: path.join(cwd, 'adapter-home'),
    clientFactory: () => makeClient(),
  }
}

function markClaudeProject(cwd: string): void {
  mkdirSync(path.join(cwd, '.claude'), { recursive: true })
}

function writeClaudeHooks(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'notifai hook user-prompt-submit --owner notifai' }] },
          ],
          Stop: [{ hooks: [{ type: 'command', command: 'notifai hook stop --owner notifai' }] }],
        },
      },
      null,
      2,
    )}\n`,
  )
}

function routingCall(): PromptCall {
  const call = promptLog.find((entry) => entry.kind === 'select' && entry.message === 'Question routing')
  if (call === undefined) throw new Error('Question routing was not shown')
  return call
}

function optionValues(call: PromptCall): string[] {
  return (call.options ?? []).map((option) => option.value)
}

function optionLabels(call: PromptCall): string[] {
  return (call.options ?? []).map((option) => option.label)
}

describe('routingHookActions', () => {
  it('hides install and uninstall when this directory cannot apply hooks', () => {
    const options = routingHookActions({
      canInstall: false,
      projectInstallations: [],
      machineInstallations: [],
      hooksReady: false,
    })
    expect(options.map((option) => option.value)).toEqual(['settings', 'back'])
  })

  it('offers install labeled as hooks, without uninstall, when nothing is wired', () => {
    const options = routingHookActions({
      canInstall: true,
      projectInstallations: [],
      machineInstallations: [],
      hooksReady: false,
    })
    expect(options.find((option) => option.value === 'install')).toMatchObject({
      label: 'Install hooks',
      hint: 'this project or this machine',
    })
    expect(options.some((option) => option.value === 'uninstall')).toBe(false)
  })

  it('names the project scope when only project hooks exist', () => {
    const options = routingHookActions({
      canInstall: true,
      projectInstallations: [{ harness: 'claude-code' }],
      machineInstallations: [],
      hooksReady: true,
    })
    expect(options.find((option) => option.value === 'install')?.label).toBe('Re-install hooks')
    expect(options.find((option) => option.value === 'uninstall')).toMatchObject({
      label: 'Uninstall hooks for this project',
      hint: 'claude-code',
    })
  })

  it('names the machine scope when only machine hooks exist', () => {
    const options = routingHookActions({
      canInstall: false,
      projectInstallations: [],
      machineInstallations: [{ harness: 'claude-code' }],
      hooksReady: true,
    })
    expect(options.some((option) => option.value === 'install')).toBe(false)
    expect(options.find((option) => option.value === 'uninstall')).toMatchObject({
      label: 'Uninstall hooks on this machine',
    })
  })

  it('asks which scope to remove when both are present', () => {
    const options = routingHookActions({
      canInstall: true,
      projectInstallations: [{ harness: 'claude-code' }],
      machineInstallations: [{ harness: 'claude-code' }],
      hooksReady: true,
    })
    expect(options.find((option) => option.value === 'uninstall')).toMatchObject({
      label: 'Uninstall hooks',
      hint: 'this project or this machine',
    })
    expect(uninstallScopeOptions([{ harness: 'claude-code' }], [{ harness: 'codex' }])).toEqual([
      { value: 'project', label: 'This project', hint: 'remove hooks from this directory' },
      { value: 'machine', label: 'This machine', hint: 'remove hooks for every project here' },
    ])
  })
})

describe('interactiveCommand', () => {
  beforeEach(() => {
    promptLog.length = 0
    answers = []
    vi.mocked(clack.outro).mockClear()
  })

  afterEach(() => {
    answers = []
  })

  it('enters init on first-run instead of a parallel Sign in path', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-first-run-'))
    const out: string[] = []
    const deps = makeDeps(cwd)
    deps.store.load = () => null
    deps.io.out = (line: string) => {
      out.push(line)
    }
    answers = [CANCEL]

    expect(await interactiveCommand(deps, '0.0.0-test')).toBe(EXIT.ok)
    expect(out.join('\n')).toContain('Next: This machine')
    expect(out.join('\n')).toContain('notifai init')
    expect(out.join('\n')).not.toContain('notifai login')
    const menu = promptLog.find((entry) => entry.message === 'What would you like to do?')
    expect(menu?.options?.[0]).toMatchObject({ value: 'setup', label: 'Finish setup' })
    expect(optionLabels(menu!)).not.toContain('Sign in')
    expect(optionLabels(menu!)).not.toContain('Add a device')
  })

  it('offers Finish setup instead of a parallel Add a device path', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-finish-setup-'))
    answers = [CANCEL]

    expect(await interactiveCommand(makeDeps(cwd), '0.0.0-test')).toBe(EXIT.ok)
    const menu = promptLog.find((entry) => entry.message === 'What would you like to do?')
    expect(menu?.options?.[0]).toMatchObject({ value: 'setup', label: 'Finish setup' })
    expect(optionLabels(menu!)).not.toContain('Add a device')
    expect(optionLabels(menu!)).not.toContain('Sign in')
  })

  it('quits from the root menu on Escape', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-root-esc-'))
    answers = [CANCEL]

    expect(await interactiveCommand(makeDeps(cwd), '0.0.0-test')).toBe(EXIT.ok)
    expect(promptLog.map((entry) => entry.message)).toEqual(['What would you like to do?'])
    expect(clack.outro).toHaveBeenCalledOnce()
  })

  it('goes back to the root menu when Escape is pressed on question routing', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-routing-esc-'))
    markClaudeProject(cwd)
    answers = ['routing', CANCEL, CANCEL]

    expect(await interactiveCommand(makeDeps(cwd), '0.0.0-test')).toBe(EXIT.ok)
    expect(promptLog.filter((entry) => entry.message === 'What would you like to do?')).toHaveLength(2)
    expect(clack.outro).toHaveBeenCalledOnce()
  })

  it('goes back from settings and account instead of quitting', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-nested-esc-'))
    answers = ['settings', CANCEL, 'account', CANCEL, 'quit']

    expect(await interactiveCommand(makeDeps(cwd), '0.0.0-test')).toBe(EXIT.ok)
    expect(promptLog.filter((entry) => entry.message === 'What would you like to do?')).toHaveLength(3)
    expect(clack.outro).toHaveBeenCalledOnce()
  })

  it('does not install hooks when Escape is pressed on the install scope picker', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-install-esc-'))
    markClaudeProject(cwd)
    const deps = makeDeps(cwd)
    answers = ['routing', 'install', CANCEL, 'quit']

    expect(await interactiveCommand(deps, '0.0.0-test')).toBe(EXIT.ok)
    expect(findInstallations(cwd, deps.env, deps.hookAdapterHome)).toEqual([])
    expect(promptLog.some((entry) => entry.message === 'Install hooks for')).toBe(true)
    expect(promptLog.filter((entry) => entry.message === 'What would you like to do?')).toHaveLength(2)
  })

  it('offers install hooks when a harness applies here and omits uninstall when none are wired', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-install-offer-'))
    markClaudeProject(cwd)
    answers = ['routing', 'back', 'quit']

    expect(await interactiveCommand(makeDeps(cwd), '0.0.0-test')).toBe(EXIT.ok)
    expect(optionLabels(routingCall())).toContain('Install hooks')
    expect(optionValues(routingCall())).not.toContain('uninstall')
  })

  it('hides install when no harness applies in this directory', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-no-harness-'))
    answers = ['routing', 'back', 'quit']

    expect(await interactiveCommand(makeDeps(cwd), '0.0.0-test')).toBe(EXIT.ok)
    expect(optionValues(routingCall())).toEqual(['settings', 'back'])
  })

  it('names machine uninstall and does not strip it on Escape', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-machine-esc-'))
    const env = isolatedEnv(cwd)
    const deps = makeDeps(cwd, env)
    writeClaudeHooks(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'))
    expect(findInstallations(cwd, env, deps.hookAdapterHome).some((item) => item.global)).toBe(true)

    answers = ['routing', CANCEL, 'quit']
    expect(await interactiveCommand(deps, '0.0.0-test')).toBe(EXIT.ok)
    expect(optionLabels(routingCall())).toContain('Uninstall hooks on this machine')
    expect(findInstallations(cwd, env, deps.hookAdapterHome).some((item) => item.global)).toBe(true)
  })

  it('uninstalls only the named project scope and leaves machine hooks', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-scope-'))
    markClaudeProject(cwd)
    const env = isolatedEnv(cwd)
    const deps = makeDeps(cwd, env)
    writeClaudeHooks(path.join(cwd, '.claude', 'settings.local.json'))
    writeClaudeHooks(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'))

    answers = ['routing', 'uninstall', 'project', 'quit']
    expect(await interactiveCommand(deps, '0.0.0-test')).toBe(EXIT.ok)

    const remaining = findInstallations(cwd, env, deps.hookAdapterHome)
    expect(remaining.some((item) => !item.global && item.harness === 'claude-code')).toBe(false)
    expect(remaining.some((item) => item.global && item.harness === 'claude-code')).toBe(true)
    const scopeCall = promptLog.find((entry) => entry.message === 'Uninstall hooks from')
    expect(scopeCall).toBeDefined()
    expect(optionLabels(scopeCall!)).toEqual(['This project', 'This machine', '← Back'])
  })

  it('does not strip either scope when Escape is pressed on the uninstall picker', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-uninstall-esc-'))
    markClaudeProject(cwd)
    const env = isolatedEnv(cwd)
    const deps = makeDeps(cwd, env)
    writeClaudeHooks(path.join(cwd, '.claude', 'settings.local.json'))
    writeClaudeHooks(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'))

    answers = ['routing', 'uninstall', CANCEL, 'quit']
    expect(await interactiveCommand(deps, '0.0.0-test')).toBe(EXIT.ok)

    const remaining = findInstallations(cwd, env, deps.hookAdapterHome)
    expect(remaining.some((item) => !item.global && item.harness === 'claude-code')).toBe(true)
    expect(remaining.some((item) => item.global && item.harness === 'claude-code')).toBe(true)
  })

  it('goes back from a test notification prompt instead of quitting', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-test-esc-'))
    answers = ['test', CANCEL, 'quit']

    expect(await interactiveCommand(makeDeps(cwd), '0.0.0-test')).toBe(EXIT.ok)
    expect(promptLog.filter((entry) => entry.message === 'What would you like to do?')).toHaveLength(2)
    expect(promptLog.some((entry) => entry.message === 'Title')).toBe(true)
    expect(clack.outro).toHaveBeenCalledOnce()
  })

  it('uninstalls machine hooks only after that scope is chosen by name', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-machine-remove-'))
    const env = isolatedEnv(cwd)
    const deps = makeDeps(cwd, env)
    writeClaudeHooks(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'))

    answers = ['routing', 'uninstall', 'quit']
    expect(await interactiveCommand(deps, '0.0.0-test')).toBe(EXIT.ok)
    expect(optionLabels(routingCall())).toContain('Uninstall hooks on this machine')
    expect(findInstallations(cwd, env, deps.hookAdapterHome)).toEqual([])
  })
})
