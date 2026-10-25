import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { askCommand, EXIT, hookRunCommand, sendCommand, type CommandDeps } from './commands.js'
import { HOOK_EVENTS } from './hook-events.js'
import { enableProject, projectBinding } from './project-enablement.js'
import { workspaceExclusion } from './workspace-eligibility.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(custom = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-workspace-'))
  roots.push(root)
  const home = path.join(root, 'home')
  const codexHome = path.join(home, custom ? 'custom-codex' : '.codex')
  mkdirSync(codexHome, { recursive: true })
  const env = {
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'),
    CODEX_THREAD_ID: 'memory-session',
    ...(custom ? { CODEX_HOME: codexHome } : {}),
  }
  const out = vi.fn()
  const err = vi.fn()
  const load = vi.fn(() => null)
  const clientFactory = vi.fn((): never => { throw new Error('No service access expected') })
  const deps: CommandDeps = {
    cwd: root, env, clientFactory,
    io: { out, err, confirm: async () => false, openUrl: () => {} },
    store: { load, save: vi.fn(), clear: vi.fn(), describe: () => 'test' },
  }
  return { root, codexHome, deps, out, err, load, clientFactory }
}

const cases = ['memories', 'memories_v2', 'subdirectory', 'cwd symlink', 'root symlink', 'custom home'] as const
function memoryFixture(kind: typeof cases[number]) {
  const f = fixture(kind === 'custom home')
  const memory = path.join(f.codexHome, kind === 'memories_v2' ? 'memories_v2' : 'memories')
  let cwd = memory
  if (kind === 'root symlink') {
    cwd = path.join(f.root, 'memory-target')
    mkdirSync(cwd)
    symlinkSync(cwd, memory, 'junction')
  } else {
    mkdirSync(memory)
    if (kind === 'subdirectory') {
      cwd = path.join(memory, 'nested', 'work')
      mkdirSync(cwd, { recursive: true })
    }
    if (kind === 'cwd symlink') {
      cwd = path.join(f.root, 'alias')
      symlinkSync(memory, cwd, 'junction')
    }
  }
  return { ...f, cwd }
}

describe('Codex memory workspace eligibility', () => {
  it.each(cases)('silences every lifecycle hook in %s before attendance or state changes', async (kind) => {
    const f = memoryFixture(kind)
    for (const event of HOOK_EVENTS) {
      expect(await hookRunCommand(f.deps, event, async () => JSON.stringify({
        cwd: f.cwd, session_id: 'memory-session', hook_event_name: 'SessionStart',
      }), 'codex')).toBe(EXIT.ok)
    }
    expect(f.out).not.toHaveBeenCalled()
    expect(f.err).not.toHaveBeenCalled()
    expect(f.load).not.toHaveBeenCalled()
    expect(f.clientFactory).not.toHaveBeenCalled()
    expect(existsSync(f.deps.env['XDG_STATE_HOME']!)).toBe(false)
    expect(existsSync(f.deps.env['XDG_CONFIG_HOME']!)).toBe(false)
  })

  it('ignores even a previously enabled memory Project', async () => {
    const f = memoryFixture('memories')
    execFileSync('git', ['init', '-q', f.cwd])
    enableProject(projectBinding(f.cwd, f.deps.env)!)
    expect(await hookRunCommand(f.deps, 'session-start', async () => JSON.stringify({ cwd: f.cwd, session_id: 'memory-session' }), 'codex')).toBe(EXIT.ok)
    expect(f.out).not.toHaveBeenCalled()
    expect(f.load).not.toHaveBeenCalled()
    expect(existsSync(f.deps.env['XDG_STATE_HOME']!)).toBe(false)
  })

  it('uses the invocation cwd when a hook omits it', async () => {
    const f = memoryFixture('memories')
    expect(await hookRunCommand({ ...f.deps, cwd: f.cwd }, 'session-start', async () => '{}', 'codex')).toBe(EXIT.ok)
    expect(f.out).not.toHaveBeenCalled()
    expect(f.err).not.toHaveBeenCalled()
  })

  it.each(cases)('refuses send, ask and legacy send --reply from %s before credentials or submission', async (kind) => {
    const f = memoryFixture(kind)
    const deps = { ...f.deps, cwd: f.cwd }
    const refusal = { ok: false, code: 'codex_memory_workspace', message: "This is Codex's internal memory folder; Notifai doesn't send from here." }
    expect(await sendCommand(deps, { title: 'Done', summary: 'Finished.', kind: 'done', json: true })).toBe(EXIT.usage)
    expect(await askCommand(deps, 'Continue?', { title: 'Continue', json: true, projectless: true })).toBe(EXIT.usage)
    expect(await sendCommand(deps, { title: 'Continue', summary: 'Continue?', reply: true, json: true, project: 'override' })).toBe(EXIT.usage)
    expect(f.out.mock.calls.map(([line]) => JSON.parse(line as string))).toEqual([refusal, refusal, refusal])
    expect(f.err).not.toHaveBeenCalled()
    expect(f.load).not.toHaveBeenCalled()
    expect(f.clientFactory).not.toHaveBeenCalled()
    expect(existsSync(f.deps.env['XDG_STATE_HOME']!)).toBe(false)
    expect(existsSync(f.deps.env['XDG_CONFIG_HOME']!)).toBe(false)
  })

  it('gives a plain coded error to a standalone CLI invocation too', async () => {
    const f = memoryFixture('memories')
    delete (f.deps.env as NodeJS.ProcessEnv)['CODEX_THREAD_ID']
    expect(await sendCommand({ ...f.deps, cwd: f.cwd }, { kind: 'done', summary: 'Done.' })).toBe(EXIT.usage)
    expect(f.err).toHaveBeenCalledExactlyOnceWith("codex_memory_workspace: This is Codex's internal memory folder; Notifai doesn't send from here.")
  })

  it('matches only the effective Codex home and complete path components', () => {
    const f = fixture(true)
    for (const cwd of [path.join(f.root, 'memories'), path.join(f.codexHome, 'memories-backup'), path.join(f.deps.env.HOME, '.codex', 'memories'), f.codexHome]) {
      mkdirSync(cwd, { recursive: true })
      expect(workspaceExclusion(cwd, f.deps.env)).toBeNull()
    }
  })

  it.each(['codex', 'claude-code'] as const)('still injects context for a normal %s Project named memories', async (harness) => {
    const f = fixture()
    const cwd = path.join(f.root, 'memories')
    mkdirSync(cwd)
    execFileSync('git', ['init', '-q', cwd])
    enableProject(projectBinding(cwd, f.deps.env, 'memories')!)
    expect(await hookRunCommand(f.deps, 'session-start', async () => JSON.stringify({ cwd, session_id: 'normal-session' }), harness)).toBe(EXIT.ok)
    expect(f.out.mock.calls.flat().join('\n')).toContain('Notifai')
  })

  it('leaves another harness operating in this directory unchanged', async () => {
    const f = memoryFixture('memories')
    delete (f.deps.env as NodeJS.ProcessEnv)['CODEX_THREAD_ID']
    f.deps.env = { ...f.deps.env, CLAUDECODE: '1' }
    execFileSync('git', ['init', '-q', f.cwd])
    enableProject(projectBinding(f.cwd, f.deps.env, 'memories')!)
    expect(await hookRunCommand(f.deps, 'session-start', async () => JSON.stringify({ cwd: f.cwd, session_id: 'claude-session' }), 'claude-code')).toBe(EXIT.ok)
    expect(f.out.mock.calls.flat().join('\n')).toContain('Notifai')
    f.out.mockClear()
    // Existing input validation, rather than the Codex workspace refusal.
    expect(await sendCommand({ ...f.deps, cwd: f.cwd }, {})).toBe(EXIT.usage)
    expect(f.err.mock.calls.flat().join('\n')).toContain('--kind is required')
  })
})
