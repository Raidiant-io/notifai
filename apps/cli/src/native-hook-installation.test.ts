import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { hookAdapterTargetsArtifact, inspectHookAdapter, installHookAdapter } from './hook-adapter.js'
import { hookCommandPrefix } from './install-hooks.js'
import { inspectCliInstallations } from './cli-bin.js'
import { opencodePluginSource } from './opencode-plugin.js'
import { openclawPluginSource } from './openclaw-plugin.js'
import { hermesPluginSource } from './hermes-plugin.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(windows = false) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-native-hooks-')); roots.push(home)
  const root = path.join(home, '.notifai'), build = 'a'.repeat(64), extension = windows ? '.exe' : ''
  mkdirSync(path.join(root, 'bin'), { recursive: true })
  mkdirSync(path.join(root, 'versions', build), { recursive: true })
  const command = path.join(root, 'bin', `notifai${extension}`)
  const runtime = path.join(root, 'versions', build, `notifai-runtime${extension}`)
  writeFileSync(command, 'fixture native launcher', { mode: 0o700 })
  writeFileSync(runtime, 'fixture native runtime', { mode: 0o700 })
  writeFileSync(path.join(root, 'install.json'), JSON.stringify({ schema: 1, owner: 'notifai', id: '12345678-1234-1234-1234-123456789012' }), { mode: 0o600 })
  writeFileSync(path.join(root, 'active.json'), JSON.stringify({ schema: 1, active: build, previous: null, generation: 1 }) + '\n', { mode: 0o600 })
  writeFileSync(path.join(root, 'versions', build, 'inventory.json'), JSON.stringify({ payload: Buffer.from(JSON.stringify({ version: '1.2.3' })).toString('base64') }), { mode: 0o600 })
  return { home, root, command, runtime }
}

it('uses one managed native command and identifies its active payload without executing it', () => {
  const f = fixture()
  const target = { kind: 'native' as const, execPath: f.command }
  expect(installHookAdapter(target, f.home)).toEqual({ path: f.command, changed: false })
  expect(inspectHookAdapter(f.home)).toEqual({ path: f.command, target, problems: [] })
  expect(hookAdapterTargetsArtifact(target, f.runtime)).toBe(true)
  expect(hookAdapterTargetsArtifact(target, f.command)).toBe(false)
  const inspection = inspectCliInstallations({ HOME: f.home, USERPROFILE: f.home, PATH: path.dirname(f.command) }, process.platform,
    { runningArtifactPath: f.runtime, currentVersion: '1.2.3' })
  expect(inspection.effective).toMatchObject({ artifact_path: f.runtime, version: '1.2.3', install_prefix: null })
  expect(readFileSync(f.command, 'utf8')).toBe('fixture native launcher')
  expect(() => installHookAdapter({ execPath: process.execPath, scriptPath: f.runtime }, f.home)).toThrow(/managed native/)
})

it('refuses invalid native identity instead of falling back to a legacy adapter', () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'active.json'), JSON.stringify({ schema: 1, active: '../escape', generation: 1 }))
  expect(inspectHookAdapter(f.home)).toMatchObject({ target: null })
  expect(inspectHookAdapter(f.home).problems).not.toHaveLength(0)
  expect(() => installHookAdapter({ kind: 'native', execPath: f.command }, f.home)).toThrow(/generation/)
  if (process.platform !== 'win32') {
    chmodSync(path.join(f.root, 'install.json'), 0o666)
    expect(inspectHookAdapter(f.home).problems.join()).toContain('private regular')
  }
})

it('generates direct Windows commands for native harnesses without an interpreter', () => {
  const f = fixture(true)
  expect(inspectHookAdapter(f.home, 'win32').target?.kind).toBe('native')
  const prefix = hookCommandPrefix(f.command, { platform: 'win32' })
  expect(prefix).toBe(`"${f.command}" `)
  for (const source of [opencodePluginSource({ adapterPath: f.command, platform: 'win32', timeoutSeconds: 5 }),
    openclawPluginSource({ adapterPath: f.command, platform: 'win32', timeoutSeconds: 5 })]) {
    expect(source).not.toContain('const NODE =')
    expect(source).toContain('spawn(ADAPTER, ["hook"')
    expect(source).toContain('windowsHide: true')
  }
  expect(hermesPluginSource(f.command)).toContain(JSON.stringify([f.command]))
})
