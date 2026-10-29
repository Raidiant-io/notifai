import { existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,expect,it,vi } from 'vitest'
import type { CommandDeps,CommandIo } from './commands-core.js'
import { hooksInstallCommand } from './commands-hook-install.js'
import { updateResumeCommand } from './commands-update-resume.js'
import { installHookAdapter } from './hook-adapter.js'
import * as codexToolMessages from './codex-tool-messages.js'
import { doctorCommand } from './commands-doctor.js'
import { hookRunCommand } from './commands-hook-run.js'
import { buildHookConfig,codexHookIdentityHash,codexTrustFindings,codexTrustKey,findInstallations,installedHookRevision } from './install-hooks.js'
import { readSessionState,writeSessionState } from './hook-session-state.js'
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

function approveCodex(f: ReturnType<typeof fixture>) {
  const current = findInstallations(f.deps.env, f.home, f.deps.hookPlatform).find(entry => entry.harness === 'codex')!
  writeFileSync(f.trust, current.handlers.map(handler =>
    `[hooks.state.${JSON.stringify(codexTrustKey(current, handler))}]\ntrusted_hash = ${JSON.stringify(codexHookIdentityHash(handler))}\n`,
  ).join('\n'))
}

/** Doctor's hook findings, read the way an agent reads them. */
async function doctorHooks(f: ReturnType<typeof fixture>) {
  const out: string[] = []
  await doctorCommand({ ...f.deps, io: { ...f.deps.io, out: line => out.push(line) },
    store: { ...f.deps.store, load: () => null },
    // Offline: only the local hook findings matter here.
    clientFactory: () => ({ health: async () => false }) as unknown as ReturnType<NonNullable<CommandDeps['clientFactory']>> },
  { json: true }, { updatesRunHere: false })
  return (JSON.parse(out.at(-1)!).states as Array<{ id: string; status: string; detail: string }>)
    .filter(state => state.id.startsWith('hooks') && state.status !== 'ready')
    .map(({ id, status, detail }) => ({ id, status, detail }))
}

/** What a Codex SessionStart runs: the command its loaded handler carries. */
async function startCodexSession(f: ReturnType<typeof fixture>, sessionId: string) {
  const installation = findInstallations(f.deps.env, f.home, f.deps.hookPlatform).find(entry => entry.harness === 'codex')!
  const revision = installedHookRevision(installation.handlers)
  expect(await hookRunCommand(f.deps, 'session-start',
    async () => JSON.stringify({ cwd: f.root, session_id: sessionId, hook_event_name: 'SessionStart', source: 'startup' }),
    'codex', revision)).toBe(0)
}

/** A session an earlier release started records no per-handler fingerprints. */
function asStartedByEarlierRelease(f: ReturnType<typeof fixture>, sessionId: string) {
  const earlier = readSessionState(sessionId, f.deps.env)
  delete earlier.codex_handler_fingerprints
  writeSessionState(sessionId, f.deps.env, earlier)
}

for (const startedBy of ['this release', 'an earlier release'] as const) {
  it(`never reports done for a Codex session that started before a handler was added (started by ${startedBy})`, async () => {
    const f = fixture()
    // An older release's definition: everything but the SubagentStart handler, approved.
    removeToolHook(f.installation.file, 'SubagentStart')
    approveCodex(f)
    const session = 'codex-thread-started-before-update'
    f.deps.env['CODEX_THREAD_ID'] = session
    await startCodexSession(f, session)
    if (startedBy === 'an earlier release') asStartedByEarlierRelease(f, session)
    // The tool and card proofs are not what this is about.
    vi.spyOn(codexToolMessages, 'codexToolHookReady').mockReturnValue(true)

    // The update adds the handler, and the User approves it from another process.
    await updateResumeCommand(f.deps, { json: true })
    approveCodex(f)
    expect(findInstallations(f.deps.env, f.home).find(entry => entry.harness === 'codex')!.handlers
      .some(handler => handler.event === 'SubagentStart')).toBe(true)
    await updateResumeCommand(f.deps, { json: true })
    const stale = JSON.parse(f.out.at(-1)!)
    expect(stale.migration_complete).toBe(false)
    expect(stale.pending_actions).toEqual([
      "This Codex session is not running Notifai's SubagentStart handler: it was added or changed after the session started. A new Codex session picks it up; this one keeps working without it."])
    if (startedBy === 'this release') {
      // Doctor says the same, and does not block: no feature needs that handler.
      expect((await doctorHooks(f)).find(state => state.id === 'hooks-session-handlers')).toEqual({
        id: 'hooks-session-handlers', status: 'optional-gap', detail: stale.pending_actions[0] })
    }

    // The User ends it and works in a new Codex session, which loads the current definition.
    expect(await hookRunCommand(f.deps, 'session-end',
      async () => JSON.stringify({ cwd: f.root, session_id: session, hook_event_name: 'SessionEnd' }), 'codex')).toBe(0)
    const fresh = 'codex-thread-started-after-update'
    f.deps.env['CODEX_THREAD_ID'] = fresh
    await startCodexSession(f, fresh)
    await updateResumeCommand(f.deps, { json: true })
    expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ migration_complete: true, pending_actions: [] })
    expect((await doctorHooks(f)).find(state => state.id === 'hooks-session-handlers')).toBeUndefined()
  })
}

it('blocks in doctor only when a feature needs the handler a Codex session lacks', async () => {
  const f = fixture()
  removeToolHook(f.installation.file, 'PreToolUse')
  approveCodex(f)
  const session = 'codex-thread-without-cards'
  f.deps.env['CODEX_THREAD_ID'] = session
  await startCodexSession(f, session)
  // The current definition adds the card handler; the session keeps the one it loaded.
  expect(hooksInstallCommand(f.deps, { harness: 'codex', narrate: false })).toBe(0)
  approveCodex(f)
  expect((await doctorHooks(f)).find(state => state.id === 'hooks-session-handlers')).toEqual({
    id: 'hooks-session-handlers', status: 'gap',
    detail: "This Codex session is not running Notifai's PreToolUse (request_user_input_async) handler: it was added or changed after the session started. A new Codex session picks it up; until then this session has no Codex question cards." })
})

it('keeps the exact bytes of every Codex handler an existing install carries, so nothing needs approval again', async () => {
  const f = fixture()
  // An install from a release that stamped a revision into every Codex command.
  const revision = 'a'.repeat(64)
  const document = JSON.parse(readFileSync(f.installation.file, 'utf8'))
  delete document.hooks.SubagentStart
  // Those releases wrote no handler names.
  for (const groups of Object.values(document.hooks) as Array<Array<{ hooks: Array<{ command: string; statusMessage?: string }> }>>) {
    for (const group of groups) for (const handler of group.hooks) {
      handler.command += ` --integration-revision ${revision}`
      delete handler.statusMessage
    }
  }
  writeFileSync(f.installation.file, JSON.stringify(document, null, 2))
  approveCodex(f)
  const commands = () => findInstallations(f.deps.env, f.home).find(entry => entry.harness === 'codex')!.handlers
    .map(handler => [`${handler.event}:${handler.groupIndex}:${handler.handlerIndex}`, handler.command] as const)
  const before = commands()

  await updateResumeCommand(f.deps, { json: true })
  const after = new Map(commands())
  for (const [key, command] of before) expect(after.get(key)).toBe(command)
  // Only the handler the update added waits for approval.
  const installation = findInstallations(f.deps.env, f.home).find(entry => entry.harness === 'codex')!
  expect(codexTrustFindings([installation], f.deps.env)).toEqual([
    { file: installation.file, event: 'SubagentStart', state: 'new' }])
})

it('stamps no revision into a new Codex install, and keeps it for every other harness', () => {
  const options = { adapterPath: '/x/notifai', integrationScope: '/x/hooks.json', platform: 'darwin' as const }
  expect(JSON.stringify(buildHookConfig({ ...options, harness: 'codex' }))).not.toContain('--integration-revision')
  expect(JSON.stringify(buildHookConfig({ ...options, harness: 'claude-code', claudeForm: 'shell' }))).toContain('--integration-revision')
})
