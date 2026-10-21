import { handlerEvent } from './install-hooks.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { personalProjectConfigPath } from './config.js'
import { afterEach, expect, it, vi } from 'vitest'
import type { CommandDeps, CommandIo } from './commands-core.js'
import { hooksInstallCommand, prepareClaudeHooksForRuntime } from './commands-hook-install.js'
import { updateResumeCommand } from './commands-update-resume.js'
import { installHookAdapter, inspectHookAdapter } from './hook-adapter.js'
import { codexHookIdentityHash, codexTrustFindings, codexTrustKey, findInstallations } from './install-hooks.js'
import { cachedIntegrationFaultNotice, integrationFaultNotice, localIntegrationAssessment, pendingIntegrationFaultNotice, refreshIntegrationHealth } from './integration-health.js'
import { nativeSkills } from './native-skills.js'
import { packageVersion } from './release.js'
import { markSessionEnded, readSessionState, writeSessionState } from './hook-session-state.js'
import * as attendantUpdate from './attendant-update.js'
import * as skillIntegrity from './skill-integrity.js'
import * as nativeInstallation from './native-installation.js'
import * as distribution from './distribution.js'
import * as launchSelf from './launch-self.js'
import { withHookRepairIntent } from './integration-repair.js'
import { sourceIntegrationRevision } from './integration-revision.js'
import { hookRunCommand } from './commands-hook-run.js'
import { enableProject, projectBinding } from './project-enablement.js'
import { hermesPluginDir, hermesPluginSource } from './hermes-plugin.js'
import { readClaudeFormDeferral, recordClaudeFormDeferral } from './claude-form-readers.js'
import { attendantClaimPath } from './session-attendant-state.js'
import { acquireClaimFile, releaseClaimFile } from './hook-question-lock.js'

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

it.each(['darwin', 'win32', 'linux'] as const)('repairs %s hooks and outdated guidance without changing trust', async platform => {
  const f = fixture(platform)
  const skill = path.join(f.home, '.agents', 'skills', 'notifai')
  outdate(skill)
  // Windows has no tool-boundary callback; exercise its required start hook.
  removeToolHook(f.installation.file, platform === 'win32' ? 'SessionStart' : 'PostToolUse')
  const trust = readFileSync(f.trust, 'utf8')
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: true,
    changed: ['skill', 'codex-hooks'], pending_actions: [] })
  const installed = JSON.parse(readFileSync(f.installation.file, 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
  const events = Object.values(installed.hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => handlerEvent(hook.command))))
  expect(events).toContain(platform === 'win32' ? 'session-start' : 'post-tool-use')
  expect(sourceIntegrationRevision(readFileSync(f.installation.file, 'utf8'))).toMatch(/^[a-f0-9]{64}$/)
  expect(readFileSync(f.trust, 'utf8')).toBe(trust)
  expect(readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).not.toBe('guidance from an older release')
})

it('preserves residents beside current guidance without rewriting it', async () => {
  const f = fixture()
  expect(await nativeSkills.place({ scope: 'global', harnesses: ['claude-code', 'grok'], cwd: f.deps.cwd, env: f.deps.env })).toBe(0)
  const refresh = vi.fn(nativeSkills.refresh); f.deps.nativeSkills = { ...nativeSkills, refresh }
  const activate = vi.spyOn(attendantUpdate, 'activateInstalledAttendants').mockResolvedValue([
    { session_id: 'existing-owner', state: 'activated', native_activity: true },
  ])
  const hooks = readFileSync(f.installation.file), trust = readFileSync(f.trust)
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(activate).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: true,
    changed: [], pending_actions: [], diagnostics: [] })
  expect(readFileSync(f.installation.file)).toEqual(hooks)
  expect(readFileSync(f.trust)).toEqual(trust)
  rmSync(f.trust)
  activate.mockClear()
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(activate).not.toHaveBeenCalled()
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: true, pending_actions: [],
    diagnostics: expect.arrayContaining([expect.stringContaining('native-approval-pending')]) })
})

it('reports an unverifiable bundle without touching guidance, while repairing hooks', async () => {
  const f = fixture()
  const skill = path.join(f.home, '.grok', 'skills', 'notifai')
  outdate(skill)
  vi.spyOn(skillIntegrity, 'shippedSkillBundle').mockReturnValue({ ok: false, error: 'Mismatched bundle manifest' })
  removeToolHook(f.installation.file)
  const trust = readFileSync(f.trust)
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(1)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: false, migration_complete: false })
  expect(readFileSync(f.installation.file, 'utf8')).toContain('post-tool-use')
  expect(readFileSync(f.trust)).toEqual(trust)
  expect(readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).toBe('guidance from an older release')
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

function trustCodex(installation: { file: string }, env: NodeJS.ProcessEnv, home: string) {
  const current = findInstallations(env, home).find(entry => entry.file === installation.file)!
  writeFileSync(path.join(path.dirname(current.file), 'config.toml'), current.handlers.map(handler =>
    `[hooks.state.${JSON.stringify(codexTrustKey(current, handler))}]\ntrusted_hash = ${JSON.stringify(codexHookIdentityHash(handler))}\n`,
  ).join('\n'))
}

it('verifies the definition a host refreshed into a selected Codex copy instead of waiting for one it replaced', async () => {
  const f = fixture()
  f.deps.env['CODEX_HOME'] = path.join(f.home, 'accounts', 'selected')
  expect(hooksInstallCommand(f.deps, { harness: 'codex', narrate: false })).toBe(0)
  const selected = findInstallations(f.deps.env, f.home).find(entry => entry.harness === 'codex')!
  removeToolHook(selected.file)
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  const published = sourceIntegrationRevision(readFileSync(selected.file, 'utf8'))
  const source = sourceIntegrationRevision(readFileSync(f.installation.file, 'utf8'))
  expect(published).not.toBe(source)
  // The host replaces its account copy with the source definition, which
  // carries the source scope's revision; Notifai's own health accepts it.
  writeFileSync(selected.file, readFileSync(f.installation.file))
  expect(localIntegrationAssessment(f.deps).faults.filter(fault => fault.code === 'hooks-drift')).toEqual([])
  // A changed definition still needs approval in the home that loads it.
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  const pending = JSON.parse(f.out.at(-1)!).pending_actions as string[]
  expect(pending).toEqual([expect.stringContaining(`native-approval-pending: Codex has not approved Notifai's changed hooks in ${path.dirname(selected.file)}`)])
  expect(pending.join('\n')).not.toContain('changed before verification')
  trustCodex(selected, f.deps.env, f.home)
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: true, pending_actions: [] })
  expect(JSON.parse(readFileSync(path.join(f.root, 'state', 'notifai', 'integration-repair.json'), 'utf8')).requirements).toEqual([])
})

it('settles a selected Codex home\'s recorded repair from a shell that selects no Codex home', async () => {
  const f = fixture()
  const plain: NodeJS.ProcessEnv = { ...f.deps.env }
  delete plain['CODEX_HOME']
  f.deps.env['CODEX_HOME'] = path.join(f.home, 'accounts', 'selected')
  expect(hooksInstallCommand(f.deps, { harness: 'codex', narrate: false })).toBe(0)
  const selected = findInstallations(f.deps.env, f.home).find(entry => entry.harness === 'codex')!
  const other = path.join(f.home, 'accounts', 'other', 'hooks.json')
  mkdirSync(path.dirname(other), { recursive: true })
  writeFileSync(other, 'another account remains User-owned')
  removeToolHook(selected.file)
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  const record = path.join(f.root, 'state', 'notifai', 'integration-repair.json')
  expect(JSON.parse(readFileSync(record, 'utf8')).requirements).toEqual([expect.objectContaining({ file: selected.file })])
  // The same requirement, resumed where CODEX_HOME is unset: the recorded file
  // is inspected in its own home, not reported as out of scope.
  f.deps.env = plain
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  const pending = JSON.parse(f.out.at(-1)!).pending_actions as string[]
  expect(pending).toEqual([`native-approval-pending: Codex has not approved Notifai's changed hooks in ${path.dirname(selected.file)}. ` +
    `Open /hooks in a Codex session whose CODEX_HOME is ${path.dirname(selected.file)} and approve the Notifai handlers.`])
  trustCodex(selected, { ...plain, CODEX_HOME: path.dirname(selected.file) }, f.home)
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: true, pending_actions: [] })
  expect(JSON.parse(readFileSync(record, 'utf8')).requirements).toEqual([])
  expect(readFileSync(other, 'utf8')).toBe('another account remains User-owned')
})

it('settles a recorded requirement whose intended revision never reached its healthy, approved definition', async () => {
  const f = fixture()
  // A requirement as an earlier build left it: its file now holds another
  // healthy definition, already approved, whose revision differs.
  const record = path.join(f.root, 'state', 'notifai', 'integration-repair.json')
  mkdirSync(path.dirname(record), { recursive: true })
  writeFileSync(record, JSON.stringify({ schema: 1, requirements: [{ file: f.installation.file, harness: 'codex',
    before: 'c'.repeat(64), expected: 'd'.repeat(64) }] }) + '\n', { mode: 0o600 })
  const hooks = readFileSync(f.installation.file)
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: true, changed: [], pending_actions: [] })
  expect(JSON.parse(readFileSync(record, 'utf8')).requirements).toEqual([])
  expect(readFileSync(f.installation.file)).toEqual(hooks)
})

it('keeps activation proof bound to the definition actually present when the recorded one was replaced', async () => {
  const f = fixture()
  f.deps.env['CODEX_THREAD_ID'] = 'owner'
  writeSessionState('owner', f.deps.env, { harness: 'codex' })
  const present = sourceIntegrationRevision(readFileSync(f.installation.file, 'utf8'))!
  const record = path.join(f.root, 'state', 'notifai', 'integration-repair.json')
  mkdirSync(path.dirname(record), { recursive: true })
  writeFileSync(record, JSON.stringify({ schema: 1, requirements: [{ file: f.installation.file, harness: 'codex',
    before: 'c'.repeat(64), expected: 'd'.repeat(64), owner: { harness: 'codex', label: 'Codex', sessionId: 'owner' } }] }) + '\n', { mode: 0o600 })
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: false,
    pending_actions: expect.arrayContaining([expect.stringContaining('has not been observed in this Agent Session')]) })
  expect(JSON.parse(readFileSync(record, 'utf8')).requirements).toEqual([expect.objectContaining({ expected: present })])
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

it('keeps a skill loaded from both scopes current while repairing hooks', async () => {
  const f = fixture()
  for (const scope of ['project', 'global'] as const) {
    outdate(scope === 'project' ? path.join(f.deps.cwd, '.agents', 'skills', 'notifai') : path.join(f.home, '.agents', 'skills', 'notifai'))
  }
  removeToolHook(f.installation.file)
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(nativeSkills.inspect(f.deps.cwd, f.deps.env).copies.map(copy => [copy.scopes, copy.condition])).toEqual([
    [['global'], 'current'], [['project'], 'current']])
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

it('lets a prompt hook read the turn-end assessment without scanning, once per changed fault', () => {
  const f = fixture()
  removeToolHook(f.installation.file)
  const scan = vi.spyOn(nativeSkills, 'inspect')
  // Nothing recorded yet: the prompt path stays silent rather than scanning.
  expect(cachedIntegrationFaultNotice(f.deps, 'codex')).toBeUndefined()
  expect(scan).not.toHaveBeenCalled()
  // Turn end refreshes, at most once per check interval.
  refreshIntegrationHealth(f.deps, 'codex')
  refreshIntegrationHealth(f.deps, 'codex')
  expect(scan).toHaveBeenCalledTimes(1)
  scan.mockClear()
  expect(cachedIntegrationFaultNotice(f.deps, 'codex')).toContain('hooks-drift')
  expect(cachedIntegrationFaultNotice(f.deps, 'codex')).toBeUndefined()
  expect(scan).not.toHaveBeenCalled()
  // A changed fault is reported again once turn end has seen it.
  rmSync(f.installation.file)
  f.tick()
  refreshIntegrationHealth(f.deps, 'codex')
  expect(cachedIntegrationFaultNotice(f.deps, 'codex')).toContain('hooks-missing')
  // An assessment nobody has refreshed for an hour no longer speaks for the installation.
  expect(hooksInstallCommand(f.deps, { harness: 'codex', narrate: false })).toBe(0)
  removeToolHook(f.installation.file)
  f.tick()
  refreshIntegrationHealth(f.deps, 'codex')
  for (let minute = 0; minute < 61; minute += 1) f.tick()
  expect(cachedIntegrationFaultNotice(f.deps, 'codex')).toBeUndefined()
})

it('keeps a prompt-path fault notice due until a reader claims it', () => {
  const f = fixture()
  removeToolHook(f.installation.file)
  refreshIntegrationHealth(f.deps, 'codex')
  const unshown = pendingIntegrationFaultNotice(f.deps, 'codex')
  expect(unshown?.text).toContain('hooks-drift')
  // Reading spends nothing: a context without room for it leaves it due.
  const shown = pendingIntegrationFaultNotice(f.deps, 'codex')
  expect(shown?.text).toBe(unshown?.text)
  expect(shown!.claim()).toBe(true)
  expect(unshown!.claim()).toBe(false)
  expect(pendingIntegrationFaultNotice(f.deps, 'codex')).toBeUndefined()
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

it.each(['version', 'artifact', 'launcher'] as const)('does not reuse another runtime %s assessment in a current hook', change => {
  const f = fixture()
  const old = { ...f.deps, env: { ...f.deps.env } }
  if (change === 'version') old.runningVersion = '0.0.1'
  else {
    const artifact = path.join(f.root, 'older', 'dist', 'main.js')
    mkdirSync(path.dirname(artifact), { recursive: true })
    writeFileSync(artifact, '#!/usr/bin/env node\n', { mode: 0o755 })
    writeFileSync(path.join(path.dirname(path.dirname(artifact)), 'package.json'), JSON.stringify({ version: packageVersion() }))
    if (change === 'artifact') old.hookInstallTarget = { execPath: process.execPath, scriptPath: artifact }
    else {
      const bin = path.join(f.root, 'other-bin')
      mkdirSync(bin)
      symlinkSync(artifact, path.join(bin, 'notifai'))
      old.env['PATH'] = bin
    }
  }
  expect(integrationFaultNotice(old, 'codex', false)).toContain('cli-drift')
  expect(integrationFaultNotice(f.deps, 'codex')).toBeUndefined()
  removeToolHook(f.installation.file)
  f.tick()
  expect(integrationFaultNotice(f.deps, 'codex')).toContain('hooks-drift')
  expect(integrationFaultNotice(f.deps, 'codex')).toBeUndefined()
})

it('separates resolved Claude profiles and project skill roots without leaking their faults', () => {
  const f = fixture()
  expect(hooksInstallCommand(f.deps, { harness: 'claude-code', narrate: false })).toBe(0)
  const profile = path.join(f.root, 'claude-profile')
  outdate(path.join(profile, 'skills', 'notifai'))
  const other = { ...f.deps, env: { ...f.deps.env, CLAUDE_CONFIG_DIR: profile } }
  expect(integrationFaultNotice(other, 'claude-code', false)).toContain('skill-drift')
  expect(integrationFaultNotice(f.deps, 'claude-code')).toBeUndefined()

  const project = path.join(f.root, 'other-project')
  outdate(path.join(project, '.claude', 'skills', 'notifai'))
  expect(integrationFaultNotice({ ...f.deps, cwd: project }, 'claude-code', false)).toContain('skill-drift')
  expect(integrationFaultNotice(f.deps, 'claude-code')).toBeUndefined()
})

it('does not reuse faults after a profile skill link is retargeted', () => {
  const f = fixture(), profile = path.join(f.root, 'profile'), skills = path.join(profile, 'skills')
  const stale = path.join(f.root, 'stale-skills'), healthy = path.join(f.root, 'healthy-skills')
  outdate(path.join(stale, 'notifai'))
  mkdirSync(profile); mkdirSync(healthy)
  symlinkSync(stale, skills, 'dir')
  const selected = { ...f.deps, env: { ...f.deps.env, CLAUDE_CONFIG_DIR: profile } }
  expect(hooksInstallCommand(selected, { harness: 'claude-code', narrate: false })).toBe(0)
  expect(integrationFaultNotice(selected, 'claude-code', false)).toContain('skill-drift')
  rmSync(skills)
  symlinkSync(healthy, skills, 'dir')
  expect(integrationFaultNotice(selected, 'claude-code')).toBeUndefined()
})

it('silences retained native builds before inspection or cache writes, while the active build still reports faults', () => {
  const f = fixture(), root = path.join(f.home, '.notifai'), active = 'a'.repeat(64)
  const installationId = '12345678-1234-1234-1234-123456789012'
  const version = packageVersion()!
  const versionDir = path.join(root, 'versions', active)
  mkdirSync(versionDir, { recursive: true }); mkdirSync(path.join(root, 'bin'), { recursive: true })
  writeFileSync(path.join(root, 'install.json'), JSON.stringify({ schema: 1, owner: 'notifai', id: installationId }), { mode: 0o600 })
  writeFileSync(path.join(root, 'active.json'), JSON.stringify({ schema: 1, active, previous: null, generation: 1 }) + '\n', { mode: 0o600 })
  writeFileSync(path.join(versionDir, 'inventory.json'), JSON.stringify({ payload:
    Buffer.from(JSON.stringify({ version })).toString('base64') }), { mode: 0o600 })
  vi.spyOn(distribution, 'buildIdentity').mockReturnValue({ version, sourceRevision: 'c'.repeat(40), sourceDirty: false,
    sourceDigest: 'd'.repeat(64), target: 'bun-darwin-arm64', runtime: 'bun' })
  const reference = vi.spyOn(launchSelf, 'currentRuntimeBuild').mockReturnValue({ installation_id: installationId, build: 'b'.repeat(64) })
  const inspect = vi.fn(nativeSkills.inspect)
  f.deps.nativeSkills = { ...nativeSkills, inspect }
  removeToolHook(f.installation.file)
  expect(integrationFaultNotice(f.deps, 'codex', false, true)).toBeUndefined()
  expect(inspect).not.toHaveBeenCalled()
  expect(existsSync(path.join(f.root, 'state', 'notifai', 'integration-health'))).toBe(false)

  reference.mockReturnValue({ installation_id: installationId, build: active })
  expect(integrationFaultNotice(f.deps, 'codex')).toContain('hooks-drift')
  expect(integrationFaultNotice(f.deps, 'codex')).toBeUndefined()

  // A retained observer may lose active status while its scan is in flight.
  inspect.mockImplementationOnce((...args) => {
    const next = 'e'.repeat(64), directory = path.join(root, 'versions', next)
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'inventory.json'), readFileSync(path.join(versionDir, 'inventory.json')), { mode: 0o600 })
    writeFileSync(path.join(root, 'active.json'), JSON.stringify({ schema: 1, active: next, previous: active, generation: 2 }) + '\n', { mode: 0o600 })
    return nativeSkills.inspect(...args)
  })
  const health = path.join(f.root, 'state', 'notifai', 'integration-health')
  const file = path.join(health, readdirSync(health).find(name => name.endsWith('.json'))!)
  const before = JSON.parse(readFileSync(file, 'utf8'))
  outdate(path.join(f.home, '.agents', 'skills', 'notifai'))
  expect(integrationFaultNotice(f.deps, 'codex', false, true)).toBeUndefined()
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(before)
})

it('stays quiet about guidance it could not finish inspecting, without changing hooks', () => {
  const f = fixture()
  const skill = path.join(f.home, '.agents', 'skills', 'notifai')
  outdate(skill)
  writeFileSync(path.join(skill, 'oversized.md'), Buffer.alloc(2 * 1024 * 1024 + 1))
  const before = readFileSync(f.installation.file, 'utf8')
  const refresh = vi.fn(nativeSkills.refresh)
  f.deps.nativeSkills = { ...nativeSkills, refresh }
  expect(integrationFaultNotice(f.deps, 'codex')).toBeUndefined()
  expect(refresh).not.toHaveBeenCalled()
  expect(readFileSync(f.installation.file, 'utf8')).toBe(before)
})

it('finishes after an interrupted skill write without changing hooks', async () => {
  const f = fixture()
  const skills = path.join(f.home, '.claude', 'skills')
  outdate(path.join(skills, 'notifai'))
  outdate(path.join(skills, `.notifai-${'c'.repeat(24)}.new`))
  const hooks = readFileSync(f.installation.file), trust = readFileSync(f.trust)
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: true, migration_complete: true, changed: ['skill'] })
  expect(readdirSync(skills)).toEqual(['notifai'])
  expect(nativeSkills.inspect(f.deps.cwd, f.deps.env).copies).toMatchObject([{ harnesses: ['claude-code'], condition: 'current' }])
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
  f.deps.nativeSkills = { ...nativeSkills, inspect: (...args) => {
    const result = nativeSkills.inspect(...args)
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
  const settings = personalProjectConfigPath(f.root, f.deps.env)
  mkdirSync(path.dirname(settings), { recursive: true })
  writeFileSync(settings, 'project = "migration-fixture"\n')
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

it('never rewrites Codex hooks in an automatic resume, and the activation plan names them first', async () => {
  const f = fixture()
  const { activationPlan } = await import('./activation-plan.js')
  expect(activationPlan(f.deps).hook_changes).toEqual([])
  removeToolHook(f.installation.file)
  const damaged = readFileSync(f.installation.file, 'utf8')
  // The staged build reports the rewrite before it is ever activated.
  expect(activationPlan(f.deps).hook_changes).toEqual([expect.objectContaining({ harness: 'codex', file: f.installation.file,
    reasons: expect.arrayContaining([expect.stringContaining('post-tool-use')]) })])
  expect(await updateResumeCommand(f.deps, { json: true, automatic: true })).toBe(1)
  expect(readFileSync(f.installation.file, 'utf8')).toBe(damaged)
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ files_complete: false,
    pending_actions: expect.arrayContaining([expect.stringContaining('automatic updates leave them unchanged')]) })
  // The User's own resume repairs them as before.
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(readFileSync(f.installation.file, 'utf8')).not.toBe(damaged)
})

it('keeps Claude Code hooks in shell form through an update while an older attendant runs, and records the switch for the hub', async () => {
  const f = fixture()
  expect(hooksInstallCommand(f.deps, { harness: 'claude-code', narrate: false })).toBe(0)
  const claude = findInstallations(f.deps.env, f.home, 'darwin').find(entry => entry.harness === 'claude-code')!
  const before = readFileSync(claude.file, 'utf8')
  expect(before).not.toContain('"args"')
  f.deps.claudeCodeVersion = () => '2.1.304'
  writeSessionState('older-claude', f.deps.env, { harness: 'claude-code' })
  const claim = attendantClaimPath('older-claude', f.deps.env)
  const token = acquireClaimFile(claim, { incarnation: 'inc_olderattendant', runtime_version: '13.1.0-beta.2', runtime_revision: 7 })!
  try {
    expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
    expect(readFileSync(claude.file, 'utf8')).toBe(before)
    expect(readClaudeFormDeferral(f.deps.env)).toMatchObject({ file: claude.file })
    expect(JSON.parse(f.out.at(-1)!).diagnostics).toEqual(expect.arrayContaining([expect.stringContaining('stay in shell form')]))
  } finally { releaseClaimFile(claim, token) }
  // With no older attendant left, the User's update writes exec form.
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(readFileSync(claude.file, 'utf8')).toContain('"args"')
  expect(readClaudeFormDeferral(f.deps.env)).toBeNull()
})

it('asks Codex to review only a handler an update adds, and leaves an unchanged definition byte-identical', async () => {
  const f = fixture()
  const trustAll = () => {
    const installation = findInstallations(f.deps.env, f.home, 'darwin').find(entry => entry.harness === 'codex')!
    writeFileSync(f.trust, installation.handlers.map(handler =>
      `[hooks.state.${JSON.stringify(codexTrustKey(installation, handler))}]\ntrusted_hash = ${JSON.stringify(codexHookIdentityHash(handler))}\n`,
    ).join('\n'))
  }
  const codex = () => findInstallations(f.deps.env, f.home, 'darwin').filter(entry => entry.harness === 'codex')
  // An older release: the same handlers under its own revision, without the
  // question-card handler this release adds, all approved in /hooks.
  const current = sourceIntegrationRevision(readFileSync(f.installation.file, 'utf8'))!
  const older = 'b'.repeat(64)
  const document = JSON.parse(readFileSync(f.installation.file, 'utf8').replaceAll(current, older))
  delete document.hooks.PreToolUse
  writeFileSync(f.installation.file, `${JSON.stringify(document, null, 2)}\n`)
  trustAll()
  const kept = JSON.stringify(document.hooks)
  expect(await updateResumeCommand(f.deps, { json: true })).toBe(0)
  expect(JSON.parse(f.out.at(-1)!).changed).toContain('codex-hooks')
  const upgraded = JSON.parse(readFileSync(f.installation.file, 'utf8'))
  const { PreToolUse: added, ...unchanged } = upgraded.hooks
  expect(JSON.stringify(unchanged)).toBe(kept)
  expect(JSON.stringify(added)).toContain(`--integration-revision ${older}`)
  expect(sourceIntegrationRevision(readFileSync(f.installation.file, 'utf8'))).toBe(older)
  expect(codexTrustFindings(codex(), f.deps.env)).toEqual([{ file: f.installation.file, event: 'PreToolUse', state: 'new' }])
  // Once that handler is approved, a later refresh changes nothing at all.
  trustAll()
  const approved = readFileSync(f.installation.file, 'utf8')
  expect(hooksInstallCommand(f.deps, { harness: 'codex', narrate: false })).toBe(0)
  expect(readFileSync(f.installation.file, 'utf8')).toBe(approved)
  expect(codexTrustFindings(codex(), f.deps.env)).toEqual([])
})

it('rewrites exec-form Claude Code hooks to shell form before a runtime that reads only shell form becomes active', async () => {
  const f = fixture()
  f.deps.claudeCodeVersion = () => '2.1.304'
  expect(hooksInstallCommand(f.deps, { harness: 'claude-code', narrate: false })).toBe(0)
  const claude = () => findInstallations(f.deps.env, f.home, 'darwin').find(entry => entry.harness === 'claude-code')!
  const exec = readFileSync(claude().file, 'utf8')
  const slots = claude().handlers.map(handler => [handler.event, handler.groupIndex, handler.handlerIndex, handlerEvent(handler.command)])
  expect(exec).toContain('"args"')
  // A runtime that reads exec form needs nothing.
  expect(prepareClaudeHooksForRuntime(f.deps, '13.1.0-beta.3')).toBe(true)
  expect(readFileSync(claude().file, 'utf8')).toBe(exec)
  // A deferral from an earlier update must not let the hub switch them back.
  recordClaudeFormDeferral(f.deps.env, claude().file)
  expect(prepareClaudeHooksForRuntime(f.deps, '13.0.0')).toBe(true)
  const shell = claude()
  expect(readFileSync(shell.file, 'utf8')).not.toContain('"args"')
  // The same handlers in the same slots, each in the one shape such a runtime recognises.
  expect(shell.handlers.map(handler => [handler.event, handler.groupIndex, handler.handlerIndex, handlerEvent(handler.command)])).toEqual(slots)
  for (const handler of shell.handlers) {
    expect(handler.execForm).not.toBe(true)
    expect(handler.command).toMatch(/hook-adapter' hook [a-z-]+ --owner notifai --harness claude-code --integration-revision [a-f0-9]{64}$/)
  }
  expect(readClaudeFormDeferral(f.deps.env)).toBeNull()
})
