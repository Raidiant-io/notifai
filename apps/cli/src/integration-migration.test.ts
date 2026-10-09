import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
import { readSessionState, writeSessionState } from './hook-session-state.js'
import * as attendantUpdate from './attendant-update.js'
import * as skillIntegrity from './skill-integrity.js'

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
})

it('verifies an unchanged healthy integration without optional setup or a restart', async () => {
  const f = fixture()
  const protectedBytes = readFileSync(f.installation.file, 'utf8')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: true,
    changed: [], pending_actions: [] })
  expect(readFileSync(f.installation.file, 'utf8')).toBe(protectedBytes)
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
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: false,
    changed: ['codex-hooks'], pending_actions: expect.arrayContaining([expect.stringContaining('skill-unmanaged')]) })
  expect(readFileSync(f.installation.file, 'utf8')).toContain(platform === 'win32' ? 'session-start' : 'post-tool-use')
  expect(readFileSync(f.trust, 'utf8')).toBe(trust)
  expect(readFileSync(path.join(skill, 'SKILL.md'))).toEqual(guidance)
  expect(add).not.toHaveBeenCalled()
  expect(localIntegrationAssessment(f.deps).faults.map(fault => fault.code)).toContain('skill-unmanaged')
})

it('recovers residents beside current owned and unmanaged guidance without invoking the skill installer', async () => {
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
  expect(activate).toHaveBeenCalledWith(f.deps, realpathSync(f.artifact))
  expect(add).not.toHaveBeenCalled()
  expect((await nativeSkills.list('global', f.deps.cwd, f.deps.env)).skills.filter(skill => skill.owned)).toMatchObject([
    { condition: 'managed-current', agents: ['claude-code'] },
  ])
  expect(readFileSync(receipt)).toEqual(receiptBefore)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: false,
    changed: ['resident-attendants'], pending_actions: [expect.stringContaining('skill-unmanaged')] })
  expect(readFileSync(f.installation.file)).toEqual(hooks)
  expect(readFileSync(f.trust)).toEqual(trust)
  expect(readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).toBe('Foreign guidance')
  expect(existsSync(path.join(f.home, '.agents', 'skills', 'notifai'))).toBe(false)
  rmSync(f.trust)
  activate.mockClear()
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(activate).not.toHaveBeenCalled()
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: false,
    pending_actions: expect.arrayContaining([expect.stringContaining('native-approval-pending')]) })
})

it.each(['edited', 'linked', 'invalid-receipt', 'invalid-bundle', 'oversized-foreign'] as const)(
  'keeps %s custody or inspection gaps blocking owned migration beside unmanaged guidance', async kind => {
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
    expect(readFileSync(f.installation.file)).toEqual(hooks)
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
    expect(readFileSync(f.installation.file)).toEqual(hooks)
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

it('does not choose between duplicate native skill scopes or mutate hooks', async () => {
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
  expect(readFileSync(f.installation.file, 'utf8')).toBe(before)
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
