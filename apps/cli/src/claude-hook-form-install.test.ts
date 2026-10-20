import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT, type CommandDeps } from './commands-core.js'
import { hooksInstallCommand } from './commands-hook-install.js'
import { installationFaults } from './integration-health.js'
import { findInstallations, settingsFile } from './install-hooks.js'
import { olderClaudeAttendantsAlive, readClaudeFormDeferral } from './claude-form-readers.js'
import { claudeHookForm, claudeHookFormFor, describeClaudeHookForm } from './claude-hook-form.js'
import { writeSessionState } from './hook-session-state.js'
import { attendantClaimPath } from './session-attendant-state.js'
import { acquireClaimFile, releaseClaimFile } from './hook-question-lock.js'
import { Hub } from './hub.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-claude-form-'))
  roots.push(cwd)
  const home = path.join(cwd, 'home')
  mkdirSync(path.join(home, '.claude'), { recursive: true })
  const unexpected = () => { throw new Error('Installer must not access credentials or network') }
  let version: string | null = null
  const deps: CommandDeps = {
    cwd,
    env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local', 'state') },
    hookAdapterHome: path.join(cwd, 'adapter'),
    hookPlatform: 'darwin',
    io: { out: () => undefined, err: () => undefined },
    store: { load: unexpected, save: unexpected, clear: unexpected, describe: unexpected },
    clientFactory: unexpected,
    claudeCodeVersion: () => version,
  }
  const flags = { harness: 'claude-code', execPath: process.execPath,
    scriptPath: fileURLToPath(new URL('./commands-hook-install.ts', import.meta.url)) }
  const file = settingsFile('claude-code', deps.env, 'darwin')
  const handlers = () => Object.values((JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> }).hooks)
    .flatMap((groups) => groups.flatMap((group) => group.hooks))
  const form = () => handlers().every((handler) => Array.isArray(handler['args'])) ? 'exec'
    : handlers().every((handler) => !('args' in handler)) ? 'shell' : 'mixed'
  const faults = () => findInstallations(deps.env, deps.hookAdapterHome, 'darwin')
    .filter((installation) => installation.harness === 'claude-code')
    .flatMap((installation) => installationFaults(installation, 'darwin', deps))
  return { deps, flags, form, faults, setVersion: (next: string | null) => { version = next } }
}

describe('Claude Code hook form at install', () => {
  it('writes shell form while the Claude Code version is unknown', () => {
    const f = fixture()
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.form()).toBe('shell')
    expect(f.faults()).toEqual([])
  })

  it('writes shell form for a Claude Code older than the exec-form floor', () => {
    const f = fixture()
    f.setVersion('2.1.100')
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.form()).toBe('shell')
    expect(f.faults()).toEqual([])
  })

  it('moves to exec form through the repair path once Claude Code is upgraded past the floor', () => {
    const f = fixture()
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.form()).toBe('shell')
    f.setVersion('2.1.304')
    // The upgrade is a fault, which `notifai update` repairs by reinstalling.
    expect(f.faults()).toEqual(['shell-form hooks, but Claude Code 2.1.304 runs exec-form hooks'])
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.form()).toBe('exec')
    expect(f.faults()).toEqual([])
  })

  it('keeps exec form when the version cannot be read later, and leaves it for a known older Claude Code', () => {
    const f = fixture()
    f.setVersion('2.1.304')
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.form()).toBe('exec')
    f.setVersion(null)
    expect(f.faults()).toEqual([])
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.form()).toBe('exec')
    f.setVersion('2.1.100')
    expect(f.faults()).toEqual(['exec-form hooks, but Claude Code 2.1.100 predates them'])
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.form()).toBe('shell')
  })
})

describe('Claude Code hook form while an older attendant runs', () => {
  /** A Session Attendant from a runtime before the hub, holding its session's claim in this process. */
  function olderAttendant(env: NodeJS.ProcessEnv, sessionId: string, fields: Record<string, unknown> = { runtime_version: '13.1.0-beta.2' }) {
    writeSessionState(sessionId, env, { harness: 'claude-code' })
    const file = attendantClaimPath(sessionId, env)
    const token = acquireClaimFile(file, { incarnation: 'inc_olderattendant', runtime_revision: 7, ...fields })!
    return () => releaseClaimFile(file, token)
  }

  it('keeps shell form while one runs, then the hub applies exec form once it has gone', async () => {
    const f = fixture()
    f.setVersion('2.1.304')
    expect(hooksInstallCommand(f.deps, { ...f.flags })).toBe(EXIT.ok)
    expect(f.form()).toBe('exec')
    // Start over in shell form, as an installation from before the hub has it.
    rmSync(settingsFile('claude-code', f.deps.env, 'darwin'))
    f.setVersion(null)
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.form()).toBe('shell')
    f.setVersion('2.1.304')
    const release = olderAttendant(f.deps.env, 'older-session')
    expect(olderClaudeAttendantsAlive(f.deps.env, 'darwin')).toBe(1)
    // An update or install now keeps shell form, reports no drift, and records what it held back.
    expect(hooksInstallCommand(f.deps, f.flags)).toBe(EXIT.ok)
    expect(f.form()).toBe('shell')
    expect(f.faults()).toEqual([])
    expect(readClaudeFormDeferral(f.deps.env)).toMatchObject({ file: settingsFile('claude-code', f.deps.env, 'darwin') })
    expect(describeClaudeHookForm(claudeHookFormFor({ ...f.deps, hookPlatform: 'darwin' }, false))).toMatch(/^shell form, kept while an older Notifai/)

    // The hub waits while it runs.
    const hub = new Hub(f.deps, { deps: f.deps })
    hub.applyDeferredClaudeForm(Date.now())
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(f.form()).toBe('shell')
    // It hands its session over (or its session ends): the hub applies the change.
    release()
    expect(olderClaudeAttendantsAlive(f.deps.env, 'darwin')).toBe(0)
    const later = new Hub(f.deps, { deps: f.deps })
    later.applyDeferredClaudeForm(Date.now())
    for (let i = 0; i < 100 && f.form() !== 'exec'; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.form()).toBe('exec')
    expect(readClaudeFormDeferral(f.deps.env)).toBeNull()
    expect(f.faults()).toEqual([])
  })

  it('counts only live, pre-hub Claude Code attendants', () => {
    const f = fixture()
    const env = f.deps.env
    const releases = [
      olderAttendant(env, 'hub-session', { role: 'hub', runtime_version: '13.2.0' }),
      olderAttendant(env, 'current-session', { runtime_version: '13.1.0-beta.3' }),
    ]
    writeSessionState('codex-session', env, { harness: 'codex' })
    const codex = acquireClaimFile(attendantClaimPath('codex-session', env), { runtime_version: '13.0.0' })!
    expect(olderClaudeAttendantsAlive(env, 'darwin')).toBe(0)
    releases.push(olderAttendant(env, 'old-session'))
    expect(olderClaudeAttendantsAlive(env, 'darwin')).toBe(1)
    expect(olderClaudeAttendantsAlive(env, 'win32')).toBe(0)
    for (const release of releases) release()
    releaseClaimFile(attendantClaimPath('codex-session', env), codex)
    expect(olderClaudeAttendantsAlive(env, 'darwin')).toBe(0)
    // Exec form already written stays exec form.
    expect(claudeHookForm('2.1.304', true, 1)).toMatchObject({ form: 'exec', reason: 'version-supported' })
    expect(claudeHookForm('2.1.304', false, 1)).toMatchObject({ form: 'shell', reason: 'older-attendants-running' })
  })
})
