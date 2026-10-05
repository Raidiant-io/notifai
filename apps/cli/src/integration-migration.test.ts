import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-integration-'))
  roots.push(root)
  const home = path.join(root, 'home')
  const pkg = path.join(root, 'prefix', 'lib', 'node_modules', '@raidiant', 'notifai')
  const artifact = path.join(pkg, 'dist', 'main.js')
  const bin = path.join(root, 'prefix', 'bin')
  mkdirSync(path.dirname(artifact), { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: packageVersion() }))
  writeFileSync(artifact, '#!/usr/bin/env node\n', { mode: 0o755 })
  symlinkSync(artifact, path.join(bin, 'notifai'))
  const out: string[] = []
  const forbidden = () => { throw new Error('local recovery must not invoke service, credentials or User actions') }
  const io: CommandIo = { out: line => out.push(line), err: line => out.push(line), confirm: async () => false, openUrl: forbidden }
  const env = { HOME: home, PATH: bin, XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config') }
  mkdirSync(path.join(root, 'state', 'skills'), { recursive: true })
  const deps: CommandDeps = { env, cwd: root, io, hookAdapterHome: home, hookPlatform: 'darwin',
    hookInstallTarget: { execPath: process.execPath, scriptPath: artifact },
    nativeSkills, fetchImpl: forbidden, clientFactory: forbidden,
    store: { load: forbidden, save: forbidden, clear: forbidden, describe: forbidden } }
  installHookAdapter(deps.hookInstallTarget!, home)
  expect(hooksInstallCommand(deps, { harness: 'codex', narrate: false })).toBe(0)
  const installation = findInstallations(env, home).find(entry => entry.harness === 'codex')!
  const trust = path.join(home, '.codex', 'config.toml')
  writeFileSync(trust, installation.handlers.map(handler =>
    `[hooks.state.${JSON.stringify(codexTrustKey(installation, handler))}]\ntrusted_hash = ${JSON.stringify(codexHookIdentityHash(handler))}\n`,
  ).join('\n'))
  out.length = 0
  let now = 1_800_000_000_000
  deps.now = () => now
  return { root, home, artifact, deps, out, installation, trust, tick: () => { now += 60_001 } }
}

function removeToolHook(file: string) {
  const hooks = JSON.parse(readFileSync(file, 'utf8'))
  delete hooks.hooks.PostToolUse
  writeFileSync(file, JSON.stringify(hooks))
}

it('resumes stale guidance and missing handlers in the existing scope, preserving foreign hooks and trust', async () => {
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
    scope: 'global', agents: ['codex'], bundle: verified.bundle,
  }).ok).toBe(true)
  const add = vi.fn(nativeSkills.add)
  f.deps.nativeSkills = { ...nativeSkills, add }
  removeToolHook(f.installation.file)
  const doc = JSON.parse(readFileSync(f.installation.file, 'utf8'))
  doc.hooks.PostToolUse = [{ hooks: [{ type: 'command', command: 'foreign-tool-handler' }] }]
  writeFileSync(f.installation.file, JSON.stringify(doc))
  const trustBefore = readFileSync(f.trust, 'utf8')
  expect(localIntegrationAssessment(f.deps).faults.map(fault => fault.code)).toEqual(expect.arrayContaining(['hooks-drift', 'skill-drift']))
  const result = await updateResumeCommand(f.deps, { json: true })
  expect(result, JSON.stringify(JSON.parse(f.out.at(-1)!).pending_actions)).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: false,
    pending_actions: expect.arrayContaining([expect.stringContaining('native-approval-pending')]) })
  expect(add).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global', skill: 'notifai' }))
  expect(readFileSync(f.trust, 'utf8')).toBe(trustBefore)
  expect(readFileSync(f.installation.file, 'utf8')).toContain('foreign-tool-handler')
  expect(localIntegrationAssessment(f.deps).faults.map(fault => fault.code)).toEqual(['native-approval-pending'])
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

it('keeps failed installer work resumable without changing hooks, trust or skill scope', async () => {
  const f = fixture()
  const skill = path.join(f.home, '.agents', 'skills', 'notifai')
  mkdirSync(skill, { recursive: true })
  writeFileSync(path.join(skill, 'SKILL.md'), 'old guidance')
  writeFileSync(path.join(f.root, 'state', 'skills', '.skill-lock.json'), JSON.stringify({ skills: { notifai: {} } }))
  const add = vi.fn(async () => 1)
  f.deps.nativeSkills = { ...nativeSkills, add }
  removeToolHook(f.installation.file)
  const hooks = readFileSync(f.installation.file, 'utf8')
  const trust = readFileSync(f.trust, 'utf8')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(1)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: false, migration_complete: false,
    resume_command: 'notifai update --resume --json' })
  expect(readFileSync(f.installation.file, 'utf8')).toBe(hooks)
  expect(readFileSync(f.trust, 'utf8')).toBe(trust)
  expect(add).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global' }))
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
  for (const skill of [path.join(f.root, '.agents', 'skills', 'notifai'), path.join(f.home, '.agents', 'skills', 'notifai')]) {
    mkdirSync(skill, { recursive: true })
    writeFileSync(path.join(skill, 'SKILL.md'), 'old packaged skill')
  }
  writeFileSync(path.join(f.root, 'skills-lock.json'), JSON.stringify({ skills: { notifai: {} } }))
  writeFileSync(path.join(f.root, 'state', 'skills', '.skill-lock.json'), JSON.stringify({ skills: { notifai: {} } }))
  removeToolHook(f.installation.file)
  const before = readFileSync(f.installation.file, 'utf8')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(1)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: false,
    pending_actions: [expect.stringContaining('duplicate skill scopes')] })
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

it('fails open on an oversized optional skill without accessing service or changing hooks', () => {
  const f = fixture()
  const skill = path.join(f.home, '.agents', 'skills', 'notifai')
  mkdirSync(skill, { recursive: true })
  writeFileSync(path.join(skill, 'SKILL.md'), 'optional installed skill')
  writeFileSync(path.join(skill, 'oversized.md'), Buffer.alloc(2 * 1024 * 1024 + 1))
  const before = readFileSync(f.installation.file, 'utf8')
  expect(integrationFaultNotice(f.deps, 'codex')).toBeUndefined()
  expect(readFileSync(f.installation.file, 'utf8')).toBe(before)
})
