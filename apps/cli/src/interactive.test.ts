import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from './client.js'
import { EXIT, type CommandDeps } from './commands.js'
import {
  setupProofProject,
  writeSetupProof,
} from './commands-setup-proof.js'
import { findInstallations, findLegacyProjectInstallations } from './install-hooks.js'

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

const { interactiveCommand, routingHookActions } = await import('./interactive.js')
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

function makeDeps(
  cwd: string,
  env: NodeJS.ProcessEnv = isolatedEnv(cwd),
  client: ApiClient = makeClient(),
): CommandDeps {
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
    clientFactory: () => client,
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
      installations: [],
      hooksReady: false,
    })
    expect(options.map((option) => option.value)).toEqual(['settings', 'back'])
  })

  it('offers install labeled as hooks, without uninstall, when nothing is wired', () => {
    const options = routingHookActions({
      canInstall: true,
      installations: [],
      hooksReady: false,
    })
    expect(options.find((option) => option.value === 'install')).toMatchObject({
      label: 'Install hooks',
      hint: 'this machine; enable or disable Notifai per project separately',
    })
    expect(options.some((option) => option.value === 'uninstall')).toBe(false)
  })

  it('names the one machine installation it would remove', () => {
    const options = routingHookActions({
      canInstall: true,
      installations: [{ harness: 'claude-code' }, { harness: 'codex' }],
      hooksReady: true,
    })
    expect(options.find((option) => option.value === 'install')?.label).toBe('Re-install hooks')
    expect(options.find((option) => option.value === 'uninstall')).toMatchObject({
      label: 'Uninstall hooks on this machine',
      hint: 'claude-code, codex',
    })
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

  it('offers a test notification when completed proof has a transient evidence-read failure', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-durable-proof-'))
    const readyIphone = {
      device_id: 'dev_iphone',
      display_name: 'iPhone',
      platform: 'ios' as const,
      permission_status: 'authorized',
      registration_healthy: true,
      app_version: '1.0.0',
      app_build: '1',
      os_version: '19.0',
      capabilities: ['answer'] as const,
      support_state: 'current' as const,
      derived_status: 'working' as const,
      status_message: null,
      last_seen_at: '2026-09-05T12:00:00.000Z',
    }
    const client = {
      ...makeClient(),
      listDevices: async () => ({ devices: [readyIphone] }),
      accessStatus: async () => ({
        status: 'active',
        reason: 'alpha_grant',
        expires_at: null,
        email: 'rafael@example.test',
      }),
      evidence: async () => {
        throw new Error('transient evidence failure')
      },
    } as unknown as ApiClient
    const deps = makeDeps(cwd, isolatedEnv(cwd), client)
    writeSetupProof(deps, {
      request_id: 'req_durable_proof',
      device_id: readyIphone.device_id,
      project: setupProofProject(deps, null),
      started_at: '2026-09-05T12:00:00.000Z',
      companion_receipt: { state: 'observed', observed_at: '2026-09-05T12:00:02.000Z' },
    })
    answers = [CANCEL]

    expect(await interactiveCommand(deps, '0.0.0-test')).toBe(EXIT.ok)
    const menu = promptLog.find((entry) => entry.message === 'What would you like to do?')
    expect(menu?.options?.[0]).toMatchObject({
      value: 'test',
      label: 'Send a test notification',
    })
    expect(optionLabels(menu!)).not.toContain('Finish setup')
  })

  it('still offers Finish setup when no Companion Receipt has been observed', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-unobserved-proof-'))
    const client = {
      ...makeClient(),
      listDevices: async () => ({
        devices: [{
          device_id: 'dev_iphone',
          display_name: 'iPhone',
          platform: 'ios',
          permission_status: 'authorized',
          registration_healthy: true,
          capabilities: ['answer'],
        }],
      }),
    } as unknown as ApiClient
    answers = [CANCEL]

    expect(await interactiveCommand(makeDeps(cwd, isolatedEnv(cwd), client), '0.0.0-test')).toBe(EXIT.ok)
    const menu = promptLog.find((entry) => entry.message === 'What would you like to do?')
    expect(menu?.options?.[0]).toMatchObject({
      value: 'setup',
      label: 'Finish setup',
      hint: 'delivery proof',
    })
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

  it('never asks where hooks should go — there is one place they can go', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-install-scope-'))
    markClaudeProject(cwd)
    const env = isolatedEnv(cwd)
    const deps = makeDeps(cwd, env)
    answers = ['routing', 'install', 'quit']

    expect(await interactiveCommand(deps, '0.0.0-test')).toBe(EXIT.ok)
    expect(promptLog.some((entry) => entry.message === 'Install hooks for')).toBe(false)
    const installed = findInstallations(env, deps.hookAdapterHome)
    expect(installed.map((item) => item.file)).toEqual([
      path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'),
    ])
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
    expect(findInstallations(env, deps.hookAdapterHome)).toHaveLength(1)

    answers = ['routing', CANCEL, 'quit']
    expect(await interactiveCommand(deps, '0.0.0-test')).toBe(EXIT.ok)
    expect(optionLabels(routingCall())).toContain('Uninstall hooks on this machine')
    expect(findInstallations(env, deps.hookAdapterHome)).toHaveLength(1)
  })

  it('clears a leftover Project-scoped copy along with the Machine one', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-legacy-'))
    markClaudeProject(cwd)
    const env = isolatedEnv(cwd)
    const deps = makeDeps(cwd, env)
    writeClaudeHooks(path.join(cwd, '.claude', 'settings.local.json'))
    writeClaudeHooks(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'))

    answers = ['routing', 'uninstall', 'quit']
    expect(await interactiveCommand(deps, '0.0.0-test')).toBe(EXIT.ok)

    expect(findInstallations(env, deps.hookAdapterHome)).toEqual([])
    expect(findLegacyProjectInstallations(cwd, env, deps.hookAdapterHome)).toEqual([])
    expect(promptLog.some((entry) => entry.message === 'Uninstall hooks from')).toBe(false)
  })

  it('goes back from a test notification prompt instead of quitting', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-test-esc-'))
    answers = ['test', CANCEL, 'quit']

    expect(await interactiveCommand(makeDeps(cwd), '0.0.0-test')).toBe(EXIT.ok)
    expect(promptLog.filter((entry) => entry.message === 'What would you like to do?')).toHaveLength(2)
    expect(promptLog.some((entry) => entry.message === 'Title')).toBe(true)
    expect(clack.outro).toHaveBeenCalledOnce()
  })

  it('uninstalls machine hooks from the one named action', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-machine-remove-'))
    const env = isolatedEnv(cwd)
    const deps = makeDeps(cwd, env)
    writeClaudeHooks(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'))

    answers = ['routing', 'uninstall', 'quit']
    expect(await interactiveCommand(deps, '0.0.0-test')).toBe(EXIT.ok)
    expect(optionLabels(routingCall())).toContain('Uninstall hooks on this machine')
    expect(findInstallations(env, deps.hookAdapterHome)).toEqual([])
  })
})
