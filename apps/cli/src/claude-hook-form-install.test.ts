import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT, type CommandDeps } from './commands-core.js'
import { hooksInstallCommand } from './commands-hook-install.js'
import { installationFaults } from './integration-health.js'
import { findInstallations, settingsFile } from './install-hooks.js'

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
