import { existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,expect,it,vi } from 'vitest'
import type { CommandDeps,CommandIo } from './commands-core.js'
import { hooksInstallCommand } from './commands-hook-install.js'
import { updateResumeCommand } from './commands-update-resume.js'
import { installHookAdapter } from './hook-adapter.js'
import { codexHookIdentityHash,codexTrustKey,findInstallations } from './install-hooks.js'
import { localIntegrationAssessment } from './integration-health.js'
import * as nativeInstallation from './native-installation.js'
import { nativeSkills } from './native-skills.js'
import { packageVersion } from './release.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(platform: NodeJS.Platform = 'darwin') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-integration-'))
  roots.push(root)
  const home = path.join(root, 'home')
  const pkg = path.join(root, 'prefix', ...(platform === 'win32' ? [] : ['lib']), 'node_modules', '@raidiant', 'notifai')
  const artifact = path.join(pkg, 'dist', 'main.js')
  const bin = path.join(root, 'prefix', ...(platform === 'win32' ? [] : ['bin']))
  mkdirSync(path.dirname(artifact), { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: packageVersion() }))
  writeFileSync(artifact, '#!/usr/bin/env node\n', { mode: 0o755 })
  symlinkSync(artifact, path.join(bin, 'notifai'))
  const out: string[] = []
  const forbidden = () => { throw new Error('local recovery must not invoke service, credentials or User actions') }
  const io: CommandIo = { out: line => out.push(line), err: line => out.push(line), confirm: async () => false, openUrl: forbidden }
  const env = { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), PATH: bin, XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config') }
  mkdirSync(path.join(root, 'state', 'skills'), { recursive: true })
  const deps: CommandDeps = { env, cwd: root, io, hookAdapterHome: home, hookPlatform: platform,
    hookInstallTarget: { execPath: process.execPath, scriptPath: artifact },
    nativeSkills, fetchImpl: forbidden, clientFactory: forbidden,
    store: { load: forbidden, save: forbidden, clear: forbidden, describe: forbidden } }
  installHookAdapter(deps.hookInstallTarget!, home, platform, env)
  expect(hooksInstallCommand(deps, { harness: 'codex', narrate: false })).toBe(0)
  const installation = findInstallations(env, home, platform).find(entry => entry.harness === 'codex')!
  const trust = path.join(path.dirname(installation.file), 'config.toml')
  writeFileSync(trust, installation.handlers.map(handler =>
    `[hooks.state.${JSON.stringify(codexTrustKey(installation, handler))}]\ntrusted_hash = ${JSON.stringify(codexHookIdentityHash(handler))}\n`,
  ).join('\n'))
  out.length = 0
  let now = 1_800_000_000_000
  deps.now = () => now
  return { root, home, artifact, deps, out, installation, trust, tick: () => { now += 60_001 } }
}

it('fences an explicit hook installation before any adapter or definition changes', () => {
  const f = fixture(), before = readFileSync(f.installation.file)
  removeToolHook(f.installation.file)
  const damaged = readFileSync(f.installation.file)
  expect(damaged).not.toEqual(before)
  const publish = vi.fn(() => { throw new Error('Update superseded') })
  vi.spyOn(nativeInstallation, 'integrationPublication').mockReturnValue(publish)
  expect(() => hooksInstallCommand(f.deps, { harness: 'codex', narrate: false })).toThrow('Update superseded')
  expect(publish).toHaveBeenCalledOnce()
  expect(readFileSync(f.installation.file)).toEqual(damaged)
})

function removeToolHook(file: string, event = 'PostToolUse') {
  const hooks = JSON.parse(readFileSync(file, 'utf8'))
  delete hooks.hooks[event]
  writeFileSync(file, JSON.stringify(hooks))
}

function outdate(directory: string): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'SKILL.md'), 'guidance from an older release')
}

it('refreshes every outdated Notifai skill copy beside hook repair, preserving foreign hooks and trust', async () => {
  const f = fixture()
  const copies = ['.claude', '.hermes', '.grok', '.openclaw'].map(harness => path.join(f.home, harness, 'skills', 'notifai'))
  for (const copy of copies) outdate(copy)
  const refresh = vi.fn(nativeSkills.refresh)
  f.deps.nativeSkills = { ...nativeSkills, refresh }
  removeToolHook(f.installation.file)
  const doc = JSON.parse(readFileSync(f.installation.file, 'utf8'))
  doc.hooks.PostToolUse = [{ hooks: [{ type: 'command', command: 'foreign-tool-handler' }] }]
  writeFileSync(f.installation.file, JSON.stringify(doc))
  const trustBefore = readFileSync(f.trust, 'utf8')
  expect(localIntegrationAssessment(f.deps).faults.map(fault => fault.code)).toEqual(expect.arrayContaining(['hooks-drift', 'skill-drift']))
  const result = await updateResumeCommand(f.deps, { json: true })
  expect(result, JSON.stringify(JSON.parse(f.out.at(-1)!).pending_actions)).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: false,
    changed: expect.arrayContaining(['skill']),
    pending_actions: expect.arrayContaining([expect.stringContaining('native-approval-pending')]) })
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(readFileSync(f.trust, 'utf8')).toBe(trustBefore)
  expect(readFileSync(f.installation.file, 'utf8')).toContain('foreign-tool-handler')
  expect(localIntegrationAssessment(f.deps).faults.map(fault => fault.code)).toEqual(['native-approval-pending'])
  expect(nativeSkills.inspect(f.deps.cwd, f.deps.env).copies.map(copy => copy.condition)).toEqual(copies.map(() => 'current'))
  // Resume never creates a copy where none was installed.
  expect(existsSync(path.join(f.home, '.agents', 'skills', 'notifai'))).toBe(false)
  const repaired = readFileSync(f.installation.file, 'utf8')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(readFileSync(f.installation.file, 'utf8')).toBe(repaired)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: false,
    pending_actions: expect.arrayContaining([expect.stringContaining('native-approval-pending')]) })
  // Only actual approval evidence in this scope clears the requirement.
  const current = findInstallations(f.deps.env, f.home).find(entry => entry.harness === 'codex')!
  writeFileSync(f.trust, current.handlers.map(handler =>
    `[hooks.state.${JSON.stringify(codexTrustKey(current, handler))}]\ntrusted_hash = ${JSON.stringify(codexHookIdentityHash(handler))}\n`,
  ).join('\n'))
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: true, pending_actions: [] })
})

it('verifies an unchanged healthy integration without optional setup or a restart', async () => {
  const f = fixture()
  const protectedBytes = readFileSync(f.installation.file, 'utf8')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: true,
    changed: [], pending_actions: [] })
  expect(readFileSync(f.installation.file, 'utf8')).toBe(protectedBytes)
})
