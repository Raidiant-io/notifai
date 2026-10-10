import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { CommandDeps, CommandIo } from './commands-core.js'
import { hooksInstallCommand } from './commands-hook-install.js'
import { updateResumeCommand } from './commands-update-resume.js'
import { installHookAdapter, inspectHookAdapter } from './hook-adapter.js'
import { codexHookIdentityHash, codexTrustKey, findInstallations } from './install-hooks.js'
import { integrationFaultNotice, localIntegrationAssessment } from './integration-health.js'
import { nativeSkills } from './native-skills.js'
import { packageVersion } from './release.js'
import { createSkillManifest, shippedSkillBundle, verifySkillBundle } from './skill-integrity.js'
import { SkillInstallation } from './skill-installation.js'
import { markSessionEnded, readSessionState, writeSessionState } from './hook-session-state.js'
import * as attendantUpdate from './attendant-update.js'
import * as skillIntegrity from './skill-integrity.js'
import * as nativeInstallation from './native-installation.js'
import { withHookRepairIntent } from './integration-repair.js'
import { sourceIntegrationRevision } from './integration-revision.js'
import { hookRunCommand } from './commands-hook-run.js'
import { enableProject, projectBinding } from './project-enablement.js'
import { hermesPluginDir, hermesPluginSource } from './hermes-plugin.js'

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

it('leaves interrupted Hermes setup scoped while unrelated update integration succeeds', async () => {
  const f = fixture(), scope = hermesPluginDir(f.deps.env), file = path.join(scope, '__init__.py')
  mkdirSync(scope, { recursive: true })
  const source = hermesPluginSource('/older/adapter')
  writeFileSync(file, source)
  writeFileSync(path.join(scope, 'plugin.yaml'), 'name: notifai\n')
  const publish: nativeInstallation.IntegrationPublication = (action, target) => {
    if (target === scope) throw new Error('Host plugin operation remains pending')
    return action()
  }
  publish.pending = () => [{ token: '11111111-1111-4111-8111-111111111111', scope,
    operation: 'install', source: f.root, revision: 'a'.repeat(64), build: 'b'.repeat(64) }]
  vi.spyOn(nativeInstallation, 'integrationPublication').mockReturnValue(publish)
  expect(localIntegrationAssessment(f.deps).faults).toContainEqual(expect.objectContaining({ code: 'hooks-drift', file }))
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: true,
    pending_actions: [], diagnostics: expect.arrayContaining([expect.stringContaining('Plugin setup remains pending')]) })
  expect(readFileSync(file, 'utf8')).toBe(source)
})

function removeToolHook(file: string, event = 'PostToolUse') {
  const hooks = JSON.parse(readFileSync(file, 'utf8'))
  delete hooks.hooks[event]
  writeFileSync(file, JSON.stringify(hooks))
}

it('resumes owned Claude guidance beside unmanaged harnesses, preserving foreign bytes, hooks and trust', async () => {
  const f = fixture()
  const bundle = shippedSkillBundle()
  if (!bundle.ok) throw new Error(bundle.error)
  const oldBundle = path.join(f.root, 'old-bundle'), oldSkill = path.join(oldBundle, 'notifai')
  cpSync(bundle.bundle.skillRoot, oldSkill, { recursive: true })
  writeFileSync(path.join(oldSkill, 'SKILL.md'), 'old packaged guidance')
  writeFileSync(path.join(oldBundle, 'manifest.json'), JSON.stringify(createSkillManifest(oldSkill, '1.0.0')))
  const verified = verifySkillBundle(oldBundle, '1.0.0')
  if (!verified.ok) throw new Error(verified.error)
  expect(new SkillInstallation({ cwd: f.deps.cwd, env: f.deps.env }).reconcile({
    scope: 'global', agents: ['claude-code'], bundle: verified.bundle,
  }).ok).toBe(true)
  const foreign = ['.hermes', '.grok', '.openclaw'].map(harness => path.join(f.home, harness, 'skills', 'notifai'))
  for (const target of foreign) {
    cpSync(bundle.bundle.skillRoot, target, { recursive: true })
    writeFileSync(path.join(target, 'SKILL.md'), 'User-owned harness guidance')
  }
  const foreignBefore = foreign.map(target => createSkillManifest(target, '').digest)
  const add = vi.fn(nativeSkills.add)
  f.deps.nativeSkills = { ...nativeSkills, add }
  removeToolHook(f.installation.file)
  const doc = JSON.parse(readFileSync(f.installation.file, 'utf8'))
  doc.hooks.PostToolUse = [{ hooks: [{ type: 'command', command: 'foreign-tool-handler' }] }]
  writeFileSync(f.installation.file, JSON.stringify(doc))
  const trustBefore = readFileSync(f.trust, 'utf8')
  expect(localIntegrationAssessment(f.deps).faults.map(fault => fault.code)).toEqual(expect.arrayContaining(['hooks-drift', 'skill-unmanaged']))
  const result = await updateResumeCommand(f.deps, { json: true })
  expect(result, JSON.stringify(JSON.parse(f.out.at(-1)!).pending_actions)).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: false,
    pending_actions: expect.arrayContaining([expect.stringContaining('native-approval-pending')]) })
  expect(add).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global', skill: 'notifai' }))
  expect(readFileSync(f.trust, 'utf8')).toBe(trustBefore)
  expect(readFileSync(f.installation.file, 'utf8')).toContain('foreign-tool-handler')
  expect(localIntegrationAssessment(f.deps).faults.map(fault => fault.code)).toEqual(['native-approval-pending', 'skill-unmanaged'])
  expect((await nativeSkills.list('global', f.deps.cwd, f.deps.env)).skills.filter(skill => skill.owned)).toMatchObject([
    { condition: 'managed-current', agents: ['claude-code'] },
  ])
  expect(existsSync(path.join(f.home, '.agents', 'skills', 'notifai'))).toBe(false)
  expect(foreign.map(target => createSkillManifest(target, '').digest)).toEqual(foreignBefore)
  const repaired = readFileSync(f.installation.file, 'utf8')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(add).toHaveBeenCalledTimes(1)
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

it('refuses repair through a legacy application beside native without changing hooks, trust, or resident work', async () => {
  const f = fixture(), root = path.join(f.home, '.notifai'), build = 'b'.repeat(64)
  const versionDir = path.join(root, 'versions', build)
  mkdirSync(versionDir, { recursive: true }); mkdirSync(path.join(root, 'bin'), { recursive: true })
  writeFileSync(path.join(root, 'install.json'), JSON.stringify({ schema: 1, owner: 'notifai',
    id: '12345678-1234-1234-1234-123456789012', channel: 'beta', source: 'shell' }), { mode: 0o600 })
  writeFileSync(path.join(root, 'active.json'), JSON.stringify({ schema: 1, active: build, previous: null, generation: 1 }) + '\n', { mode: 0o600 })
  writeFileSync(path.join(versionDir, 'inventory.json'), JSON.stringify({ payload:
    Buffer.from(JSON.stringify({ version: packageVersion(), source_revision: 'c'.repeat(40) })).toString('base64') }), { mode: 0o600 })
  removeToolHook(f.installation.file)
  const before = [f.installation.file, f.trust, f.artifact].map(file => readFileSync(file, 'utf8'))
  const activate = vi.spyOn(attendantUpdate, 'activateInstalledAttendants')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(1)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: false, migration_complete: false, changed: [],
    pending_actions: [expect.stringContaining('legacy-native-coexistence')] })
  expect([f.installation.file, f.trust, f.artifact].map(file => readFileSync(file, 'utf8'))).toEqual(before)
  expect(activate).not.toHaveBeenCalled()
})

it.each(['darwin', 'win32', 'linux'] as const)('repairs owned %s hooks beside unmanaged-only guidance without installing skills or changing trust', async platform => {
  const f = fixture(platform)
  const skill = path.join(f.home, '.agents', 'skills', 'notifai')
  mkdirSync(skill, { recursive: true })
  writeFileSync(path.join(skill, 'SKILL.md'), 'old guidance')
  writeFileSync(path.join(f.root, 'state', 'skills', '.skill-lock.json'), JSON.stringify({ skills: { notifai: {} } }))
  const add = vi.fn(async () => 1)
  f.deps.nativeSkills = { ...nativeSkills, add }
  // Windows has no tool-boundary callback; exercise its required start hook.
  removeToolHook(f.installation.file, platform === 'win32' ? 'SessionStart' : 'PostToolUse')
  const trust = readFileSync(f.trust, 'utf8')
  const guidance = readFileSync(path.join(skill, 'SKILL.md'))
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: true,
    changed: ['codex-hooks'], pending_actions: [], diagnostics: expect.arrayContaining([expect.stringContaining('skill-unmanaged')]) })
  expect(readFileSync(f.installation.file, 'utf8')).toContain(platform === 'win32' ? 'session-start' : 'post-tool-use')
  expect(readFileSync(f.trust, 'utf8')).toBe(trust)
  expect(readFileSync(path.join(skill, 'SKILL.md'))).toEqual(guidance)
  expect(add).not.toHaveBeenCalled()
  expect(localIntegrationAssessment(f.deps).faults.map(fault => fault.code)).toContain('skill-unmanaged')
})

it('preserves residents beside current owned and unmanaged guidance without invoking installers', async () => {
  const f = fixture(), bundle = shippedSkillBundle()
  if (!bundle.ok) throw new Error(bundle.error)
  expect(new SkillInstallation(f.deps).reconcile({ scope: 'global', agents: ['claude-code'], bundle: bundle.bundle }).ok).toBe(true)
  const receipt = path.join(f.root, 'state', 'notifai', 'skill-installations', 'global.json')
  const receiptBefore = readFileSync(receipt)
  const add = vi.fn(nativeSkills.add); f.deps.nativeSkills = { ...nativeSkills, add }
  const skill = path.join(f.home, '.grok', 'skills', 'notifai')
  mkdirSync(skill, { recursive: true }); writeFileSync(path.join(skill, 'SKILL.md'), 'Foreign guidance')
  const activate = vi.spyOn(attendantUpdate, 'activateInstalledAttendants').mockResolvedValue([
    { session_id: 'existing-owner', state: 'activated', native_activity: true },
  ])
  const hooks = readFileSync(f.installation.file), trust = readFileSync(f.trust)
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(activate).not.toHaveBeenCalled()
  expect(add).not.toHaveBeenCalled()
  expect((await nativeSkills.list('global', f.deps.cwd, f.deps.env)).skills.filter(skill => skill.owned)).toMatchObject([
    { condition: 'managed-current', agents: ['claude-code'] },
  ])
  expect(readFileSync(receipt)).toEqual(receiptBefore)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: true,
    changed: [], pending_actions: [], diagnostics: [expect.stringContaining('skill-unmanaged')] })
  expect(readFileSync(f.installation.file)).toEqual(hooks)
  expect(readFileSync(f.trust)).toEqual(trust)
  expect(readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).toBe('Foreign guidance')
  expect(existsSync(path.join(f.home, '.agents', 'skills', 'notifai'))).toBe(false)
  rmSync(f.trust)
  activate.mockClear()
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(activate).not.toHaveBeenCalled()
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: true, pending_actions: [],
    diagnostics: expect.arrayContaining([expect.stringContaining('native-approval-pending')]) })
})

it.each(['edited', 'linked', 'invalid-receipt', 'invalid-bundle', 'oversized-foreign'] as const)(
  'preserves %s skill custody or inspection gaps while repairing independent owned hooks', async kind => {
    const f = fixture(), bundle = shippedSkillBundle()
    if (!bundle.ok) throw new Error(bundle.error)
    expect(new SkillInstallation(f.deps).reconcile({ scope: 'global', agents: ['claude-code'], bundle: bundle.bundle }).ok).toBe(true)
    const selected = path.join(f.home, '.claude', 'skills', 'notifai')
    const foreign = path.join(f.home, '.grok', 'skills', 'notifai')
    mkdirSync(foreign, { recursive: true }); writeFileSync(path.join(foreign, 'SKILL.md'), 'Unmanaged guidance')
    if (kind === 'edited') writeFileSync(path.join(selected, 'SKILL.md'), 'User edited owned guidance')
    if (kind === 'linked') { rmSync(selected, { recursive: true }); symlinkSync(bundle.bundle.skillRoot, selected, 'dir') }
    if (kind === 'invalid-receipt') writeFileSync(path.join(f.root, 'state', 'notifai', 'skill-installations', 'global.json'), '{}')
    if (kind === 'invalid-bundle') vi.spyOn(skillIntegrity, 'shippedSkillBundle').mockReturnValue({ ok: false, error: 'Mismatched bundle manifest' })
    if (kind === 'oversized-foreign') writeFileSync(path.join(foreign, 'oversized.md'), Buffer.alloc(2 * 1024 * 1024 + 1))
    removeToolHook(f.installation.file)
    const hooks = readFileSync(f.installation.file), trust = readFileSync(f.trust)
    const add = vi.fn(nativeSkills.add); f.deps.nativeSkills = { ...nativeSkills, add }
    const activate = vi.spyOn(attendantUpdate, 'activateInstalledAttendants').mockResolvedValue([])
    expect(await updateResumeCommand(f.deps, { json: true })).toBe(1)
    expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: false, migration_complete: false })
    expect(add).not.toHaveBeenCalled(); expect(activate).not.toHaveBeenCalled()
    expect(readFileSync(f.installation.file).equals(hooks)).toBe(false)
    expect(readFileSync(f.installation.file, 'utf8')).toContain('post-tool-use')
    expect(readFileSync(f.trust)).toEqual(trust)
    expect(readFileSync(path.join(foreign, 'SKILL.md'), 'utf8')).toBe('Unmanaged guidance')
  },
)

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('preserves an unreadable selected owned placement before hook or resident repair', async () => {
  const f = fixture(), bundle = shippedSkillBundle()
  if (!bundle.ok) throw new Error(bundle.error)
  expect(new SkillInstallation(f.deps).reconcile({ scope: 'global', agents: ['claude-code'], bundle: bundle.bundle }).ok).toBe(true)
  const selected = path.join(f.home, '.claude', 'skills', 'notifai')
  chmodSync(selected, 0)
  removeToolHook(f.installation.file)
  const hooks = readFileSync(f.installation.file)
  try {
    expect(await updateResumeCommand(f.deps, { json: true })).toBe(1)
    expect(readFileSync(f.installation.file).equals(hooks)).toBe(false)
    expect(readFileSync(f.installation.file, 'utf8')).toContain('post-tool-use')
  } finally { chmodSync(selected, 0o700) }
  expect(createSkillManifest(selected, '').digest).toBe(bundle.bundle.manifest.digest)
})

it('repairs both installed source and selected Codex definitions without touching another account', async () => {
  const f = fixture()
  removeToolHook(f.installation.file)
  f.deps.env['CODEX_HOME'] = path.join(f.home, 'accounts', 'selected')
  expect(hooksInstallCommand(f.deps, { harness: 'codex', narrate: false })).toBe(0)
  const selected = findInstallations(f.deps.env, f.home).find(entry => entry.harness === 'codex')!
  removeToolHook(selected.file)
  const other = path.join(f.home, 'accounts', 'other', 'hooks.json')
  mkdirSync(path.dirname(other), { recursive: true })
  writeFileSync(other, 'another account remains User-owned')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: false,
    pending_actions: expect.arrayContaining([expect.stringContaining('native-approval-pending')]) })
  expect(readFileSync(f.installation.file, 'utf8')).toContain('post-tool-use')
  expect(readFileSync(selected.file, 'utf8')).toContain('post-tool-use')
  expect(readFileSync(other, 'utf8')).toBe('another account remains User-owned')
})

it('refuses shared migration from a competing executable, even at the same version', async () => {
  const f = fixture()
  const competing = path.join(f.root, 'competing', 'dist', 'main.js')
  mkdirSync(path.dirname(competing), { recursive: true })
  writeFileSync(competing, '')
  f.deps.hookInstallTarget = { execPath: process.execPath, scriptPath: competing }
  const adapter = readFileSync(inspectHookAdapter(f.home).path, 'utf8')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(1)
  expect(readFileSync(inspectHookAdapter(f.home).path, 'utf8')).toBe(adapter)
  expect(localIntegrationAssessment(f.deps).faults.map(fault => fault.code)).toContain('cli-drift')
})

it('preserves pending exact-owner work before any integration change', async () => {
  const f = fixture()
  f.deps.env['CODEX_THREAD_ID'] = 'exact-owner'
  writeSessionState('exact-owner', f.deps.env, { message_acknowledgement_due: [{ message_id: 'sm_pending', recorded_at: 1_800_000_000_000 }] })
  removeToolHook(f.installation.file)
  const before = readFileSync(f.installation.file, 'utf8')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(1)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: false,
    pending_actions: [expect.stringContaining('outstanding')] })
  expect(readFileSync(f.installation.file, 'utf8')).toBe(before)
  expect(readSessionState('exact-owner', f.deps.env).message_acknowledgement_due).toEqual([{ message_id: 'sm_pending', recorded_at: 1_800_000_000_000 }])
})

it('preserves duplicate skill scopes while repairing independently owned hooks', async () => {
  const f = fixture()
  const bundle = shippedSkillBundle()
  if (!bundle.ok) throw new Error(bundle.error)
  for (const scope of ['project', 'global'] as const) {
    expect(new SkillInstallation(f.deps).reconcile({ scope, agents: ['codex'], bundle: bundle.bundle }).ok).toBe(true)
  }
  removeToolHook(f.installation.file)
  const before = readFileSync(f.installation.file, 'utf8')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(1)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: false,
    pending_actions: [expect.stringContaining('Multiple receipt-backed')] })
  expect(readFileSync(f.installation.file, 'utf8')).not.toBe(before)
  expect(readFileSync(f.installation.file, 'utf8')).toContain('post-tool-use')
})

it('keeps healthy callbacks silent and deduplicates later faults across callbacks and Projects', () => {
  const f = fixture()
  expect(integrationFaultNotice(f.deps, 'codex')).toBeUndefined()
  removeToolHook(f.installation.file)
  expect(integrationFaultNotice(f.deps, 'codex')).toBeUndefined()
  f.tick()
  expect(integrationFaultNotice(f.deps, 'codex')).toContain('hooks-drift')
  expect(integrationFaultNotice(f.deps, 'codex')).toBeUndefined()
  f.tick()
  expect(integrationFaultNotice({ ...f.deps, cwd: path.join(f.root, 'another-project') }, 'codex')).toBeUndefined()
  expect(hooksInstallCommand(f.deps, { harness: 'codex', narrate: false })).toBe(0)
  f.tick()
  expect(integrationFaultNotice(f.deps, 'codex')).toBeUndefined()
  removeToolHook(f.installation.file)
  f.tick()
  expect(integrationFaultNotice(f.deps, 'codex')).toContain('hooks-drift')
})

it('lets a resident observer detect missing wiring without consuming the agent notice or changing trust', () => {
  const f = fixture()
  const trust = readFileSync(f.trust, 'utf8')
  expect(integrationFaultNotice(f.deps, 'codex')).toBeUndefined()
  rmSync(f.installation.file)
  // An explicit contract loss records the fault before withdrawal even when
  // the regular minute cache still holds the preceding healthy assessment.
  expect(integrationFaultNotice(f.deps, 'codex', false, true)).toContain('hooks-missing')
  expect(integrationFaultNotice(f.deps, 'codex', false)).toBeUndefined()
  expect(integrationFaultNotice(f.deps, 'codex')).toContain('hooks-missing')
  expect(integrationFaultNotice(f.deps, 'codex')).toBeUndefined()
  expect(readFileSync(f.trust, 'utf8')).toBe(trust)
})

it('reports incomplete inspection for oversized guidance without accessing service or changing hooks', () => {
  const f = fixture()
  const skill = path.join(f.home, '.agents', 'skills', 'notifai')
  mkdirSync(skill, { recursive: true })
  writeFileSync(path.join(skill, 'SKILL.md'), 'optional installed skill')
  writeFileSync(path.join(skill, 'oversized.md'), Buffer.alloc(2 * 1024 * 1024 + 1))
  const before = readFileSync(f.installation.file, 'utf8')
  const add = vi.fn(nativeSkills.add)
  f.deps.nativeSkills = { ...nativeSkills, add }
  expect(integrationFaultNotice(f.deps, 'codex')).toContain('skill-inspection-incomplete')
  expect(integrationFaultNotice(f.deps, 'codex')).toBeUndefined()
  expect(add).not.toHaveBeenCalled()
  expect(readFileSync(f.installation.file, 'utf8')).toBe(before)
})


it('resumes an interrupted owned skill replacement without changing recorded harnesses or hooks', async () => {
  const f = fixture(), bundle = shippedSkillBundle()
  if (!bundle.ok) throw new Error(bundle.error)
  const source = path.join(f.root, 'previous-bundle'), tree = path.join(source, 'notifai')
  cpSync(bundle.bundle.skillRoot, tree, { recursive: true })
  writeFileSync(path.join(tree, 'SKILL.md'), 'Previous verified release guidance')
  writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(createSkillManifest(tree, '1.0.0')))
  const previous = verifySkillBundle(source)
  if (!previous.ok) throw new Error(previous.error)
  expect(new SkillInstallation(f.deps).reconcile({ scope: 'global', agents: ['claude-code'], bundle: previous.bundle }).ok).toBe(true)
  const interrupted = new SkillInstallation({ cwd: f.deps.cwd, env: f.deps.env, observe(phase) {
    if (phase === 'old-retained') throw new Error('simulated replacement interruption')
  } })
  expect(interrupted.reconcile({ scope: 'global', bundle: bundle.bundle }).ok).toBe(false)
  const hooks = readFileSync(f.installation.file), trust = readFileSync(f.trust)
  const add = vi.fn(nativeSkills.add); f.deps.nativeSkills = { ...nativeSkills, add }
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: true, changed: ['skill'] })
  expect(add).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global' }))
  expect(await nativeSkills.list('global', f.deps.cwd, f.deps.env)).toMatchObject({ skills: [
    { owned: true, pending: false, condition: 'managed-current', agents: ['claude-code'] },
  ] })
  expect(readFileSync(f.installation.file)).toEqual(hooks)
  expect(readFileSync(f.trust)).toEqual(trust)
})

it('retains required approval after interruption immediately following hook publication', async () => {
  const f = fixture()
  removeToolHook(f.installation.file)
  const doc = JSON.parse(readFileSync(f.installation.file, 'utf8'))
  doc.hooks.PostToolUse = [{ hooks: [{ type: 'command', command: 'foreign-tool-handler' }] }]
  writeFileSync(f.installation.file, JSON.stringify(doc))
  expect(() => withHookRepairIntent(f.deps, f.installation, null, () => {
    expect(hooksInstallCommand(f.deps, { harness: 'codex', narrate: false, refreshOnly: true })).toBe(0)
    throw new Error('interrupted after publication')
  })).toThrow('interrupted after publication')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ changed: [], migration_complete: false,
    pending_actions: expect.arrayContaining([expect.stringContaining('native-approval-pending')]) })
})

it('rejects a no-write resume superseded during final asynchronous discovery', async () => {
  const f = fixture()
  let superseded = false, calls = 0
  vi.spyOn(nativeInstallation, 'integrationPublication').mockReturnValue(action => {
    if (superseded) throw new Error('Update superseded')
    return action()
  })
  f.deps.nativeSkills = { ...nativeSkills, list: async (...args) => {
    const result = await nativeSkills.list(...args)
    if (++calls >= 4) superseded = true
    return result
  } }
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(1)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ changed: [], migration_complete: false })
})

it('requires the loaded revision and accepts a same-scope replacement after the original owner ends', async () => {
  const f = fixture()
  f.deps.env.CLAUDECODE = '1'
  f.deps.env.CLAUDE_CODE_SESSION_ID = 'original'
  mkdirSync(path.join(f.root, '.notifai'), { recursive: true })
  writeFileSync(path.join(f.root, '.notifai', 'config.toml'), 'project = "migration-fixture"\n')
  enableProject(projectBinding(f.root, f.deps.env, 'migration-fixture')!)
  expect(hooksInstallCommand(f.deps, { harness: 'claude-code', narrate: false })).toBe(0)
  const hooks = findInstallations(f.deps.env, f.home).find(entry => entry.harness === 'claude-code')!
  const callback = async (session: string, revision: string, event = 'session-start', child = false) =>
    hookRunCommand(f.deps, event, async () => JSON.stringify({ session_id: session, cwd: f.root,
      ...(child ? { agent_id: 'worker' } : {}) }), 'claude-code', revision)
  const oldRevision = 'a'.repeat(64)
  await callback('original', oldRevision)
  removeToolHook(hooks.file, 'UserPromptSubmit')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: false })
  const expected = sourceIntegrationRevision(readFileSync(hooks.file, 'utf8'))!
  // An old loaded command can invoke this very runtime, but cannot prove reload.
  await callback('original', oldRevision, 'user-prompt-submit')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: false })
  await callback('original', expected, 'subagent-start', true)
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: false })
  writeSessionState('original', f.deps.env, { ...readSessionState('original', f.deps.env),
    acknowledgement_due: [{ request_id: 'original-debt', recorded_at: 1 }] })
  markSessionEnded('original', f.deps.env, Date.now())
  f.deps.env.CLAUDE_CODE_SESSION_ID = 'replacement'
  await callback('replacement', oldRevision)
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: false })
  await callback('replacement', expected)
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: true })
  expect(readSessionState('original', f.deps.env).acknowledgement_due?.[0]?.request_id).toBe('original-debt')
  expect(readSessionState('replacement', f.deps.env).acknowledgement_due).toBeUndefined()
})
