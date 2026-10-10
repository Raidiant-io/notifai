import { spawnSync } from 'node:child_process'
import { openclawPluginSource } from './openclaw-plugin.js'
import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ensurePrivateDirectory } from './atomic-file.js'
import { activeBytes, Installation } from './installation.js'
import { nativeUninstallCommand } from './commands-native-uninstall.js'
import { nativeInstallCommand, nativeUpdateCommand } from './commands-native-installation.js'
import type { CommandDeps } from './commands-core.js'
import { discoverCliUpdate } from './cli-release.js'
import { Distribution, releaseSigningMessage } from './release-distribution.js'
import { RuntimeRetention } from './runtime-retention.js'
import { sessionStatePath, writeSessionState } from './hook-session-state.js'
import { sanitizeSessionId } from './config.js'
import { canonicalPath } from './local-path.js'
import { currentProcessIdentity, processStartTime } from './process-identity.js'
import { acquireClaimFile, releaseClaimFile } from './hook-question-lock.js'
import { inspectCliInstallations, cliBinReadiness } from './cli-bin.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(fetcher?: typeof fetch, target: 'bun-linux-x64' | 'bun-windows-x64' = 'bun-linux-x64') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-installation-')); roots.push(root)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const distribution = new Distribution({ fixture: publicKey.export({ format: 'pem', type: 'spki' }).toString() }, fetcher)
  const extension = target.startsWith('bun-windows-') ? '.exe' : ''
  const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const candidate = (version: string, archive?: Buffer, continuity = 'notifai-session-state-v1', schema: 1 | 2 = 2) => {
    const directory = path.join(root, version); mkdirSync(directory)
    const runtime = `runtime ${version}`, launcher = 'launcher v1'
    writeFileSync(path.join(directory, `notifai-runtime${extension}`), runtime)
    writeFileSync(path.join(directory, `notifai${extension}`), launcher)
    const payload = Buffer.from(JSON.stringify({ schema, ...(schema === 2 ? { local_continuity: { contract: continuity } } : {}), version, source_revision: 'a'.repeat(40),
      store_schema: schema, launcher_schema: 1, artifacts: [{ target, filename: `notifai-${version}-${target === 'bun-windows-x64' ? 'windows-x64.zip' : 'linux-x64.tar.gz'}`,
        bytes: archive?.length ?? 100, sha256: digest(archive ?? version), runtime_sha256: digest(runtime), materials: [], launcher_sha256: digest(launcher) }] }))
    const signedInventory = JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
      signature: sign(null, releaseSigningMessage('inventory', payload), privateKey).toString('base64') })
    return { directory, signedInventory }
  }
  const options = { root: path.join(root, 'managed'), target, distribution, access: { check() {}, directory: ensurePrivateDirectory, beforePublish() {}, protectExistingDirectory() {} }, probe: () => {} }
  const channel = (sequence: number, withdrawn: string[] = [], inventory = 'unavailable-inventory', version = '2.0.0', channel = 'stable') => {
    const payload = Buffer.from(JSON.stringify({ schema: 1, channel, sequence, version,
      inventory_sha256: digest(inventory), withdrawn_versions: withdrawn }))
    return JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
      signature: sign(null, releaseSigningMessage('channel', payload), privateKey).toString('base64') })
  }
  return { root, options, candidate, channel, installation: new Installation(options) }
}

/** Seed an already-shipped installation without asking the new installer to
 * activate code that cannot enforce its contract. These signatures are test
 * keys, not historical release acceptance evidence. */
function legacyFixture() {
  const f = fixture(), old = f.candidate('1.0.0', undefined, undefined, 1)
  const build = f.installation.stage(old), id = '55555555-5555-4555-8555-555555555555'
  const options = { ...f.options, sessionsDirectory: path.join(f.options.root, 'sessions'),
    legacyBootstrapInventories: [createHash('sha256').update(old.signedInventory).digest('hex')],
    fileUse: () => ({ status: 'clear' as const, processes: [] }) }
  ensurePrivateDirectory(path.join(options.root, 'bin'))
  copyFileSync(path.join(old.directory, 'notifai'), path.join(options.root, 'bin', 'notifai'))
  writeFileSync(path.join(options.root, 'install.json'), JSON.stringify({ schema: 1, id, owner: 'notifai', source: 'shell',
    target: options.target, channel: 'stable', previousChannel: null, launcherBuild: build, launcherUpdatePending: false }), { mode: 0o600 })
  writeFileSync(path.join(options.root, 'active.json'), activeBytes({ schema: 1, active: build, previous: null, generation: 1 }), { mode: 0o600 })
  const candidate = f.candidate('2.0.0')
  const upgrade = { ...candidate, source: 'manual' as const, upgrade: true, version: '2.0.0', channel: 'stable' as const }
  return { ...f, options, old, build, id, upgrade }
}

it('rejects unusable paired repair targets before any activation or package replacement', () => {
  const f = fixture()
  const first = f.installation.installCandidate({ ...f.candidate('2.0.0'), source: 'manual' })
  for (const candidate of [f.candidate('3.0.0', undefined, undefined, 1), f.candidate('3.0.0-beta.1'),
    f.candidate('1.0.0'), f.candidate('3.1.0', undefined, 'other-contract')]) {
    const build = f.installation.stage(candidate)
    expect(() => f.installation.assertForwardTransition(build, 1, 'stable')).toThrow()
    expect(f.installation.inspect().active).toEqual(first.active)
    expect(f.installation.inspect().pending).toBe(false)
  }
  const next = f.candidate('4.0.0'), build = f.installation.stage(next)
  expect(() => f.installation.assertForwardTransition(build, 1, 'stable')).not.toThrow()
  ensurePrivateDirectory(path.join(f.options.root, 'channels'))
  writeFileSync(path.join(f.options.root, 'channels/stable.json'), f.channel(1, ['4.0.0']), { mode: 0o600 })
  expect(() => f.installation.assertForwardTransition(build, 1, 'stable')).toThrow(/withdrawn/)
  expect(() => f.installation.assertForwardTransition(first.active.active, 1, 'stable')).not.toThrow()
})

it('keeps an interrupted host setup scoped while compatible B and C activate and retain its definition', () => {
  const f = fixture()
  let boot = '11111111-1111-4111-8111-111111111111'
  const installation = new Installation({ ...f.options, bootIdentity: () => boot })
  const first = installation.installCandidate({ ...f.candidate('1.0.0'), source: 'manual' })
  const identity = { installation_id: JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8')).id as string,
    build: first.active.active }
  const scope = path.join(f.root, 'hermes', 'plugins', 'notifai'), source = path.join(f.root, 'prepared-plugin')
  mkdirSync(source)
  const input = { scope, source, revision: 'a'.repeat(64), operation: 'install' as const }
  const token = installation.beginIntegrationOperation(1, input, identity)
  const restarted = new Installation({ ...f.options, bootIdentity: () => boot })
  expect(() => restarted.assertIntegrationScopeAvailable(scope)).toThrow(/operation remains pending/)
  expect(() => restarted.beginIntegrationOperation(1, input, identity)).toThrow(/operation remains pending/)
  expect(restarted.publishIntegration(1, () => 'unrelated repair')).toBe('unrelated repair')
  expect(() => restarted.beginUninstall(1, path.join(f.root, 'sessions'))).toThrow(/pending host plugin operation/)
  for (const version of ['2.0.0', '3.0.0']) {
    restarted.installCandidate({ ...f.candidate(version), source: 'manual', upgrade: true, version, channel: 'stable' })
  }
  boot = '22222222-2222-4222-8222-222222222222'
  expect(restarted.cleanup(3).retained).toContainEqual(expect.objectContaining({ build: first.active.active, reason: 'pending_host_plugin_operation' }))
  expect(() => restarted.installCandidate({ ...f.candidate('4.0.0', undefined, 'incompatible-definitions'), source: 'manual',
    upgrade: true, version: '4.0.0', channel: 'stable' })).toThrow(/continuity contract/)
  expect(restarted.inspect().active?.generation).toBe(3)
  expect(() => restarted.completeIntegrationOperation('wrong-operation')).toThrow(/identity changed/)
  expect(restarted.pendingIntegrationOperations()).toHaveLength(1)
  restarted.abandonPending(3)
  restarted.completeIntegrationOperation(token)
  expect(restarted.pendingIntegrationOperations()).toEqual([])
  expect(existsSync(path.join(f.options.root, 'integration-operations.json'))).toBe(false)
  expect(() => restarted.assertIntegrationScopeAvailable(scope)).not.toThrow()
  expect(restarted.cleanup(3).removed).toContain(first.active.active)
})

it('reserves host removal during native uninstall and leaves no receipt that poisons reinstall', () => {
  const f = fixture(), candidate = f.candidate('1.0.0'), sessions = path.join(f.root, 'sessions')
  const installation = new Installation({ ...f.options, fileUse: () => ({ status: 'clear', processes: [] }) })
  const first = installation.installCandidate({ ...candidate, source: 'manual' })
  const identity = { installation_id: JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8')).id as string,
    build: first.active.active }
  const scope = path.join(f.root, 'hermes', 'plugins', 'notifai')
  const enabled = installation.beginIntegrationOperation(1, { scope, operation: 'enable' }, identity)
  installation.completeIntegrationOperation(enabled)
  expect(existsSync(path.join(f.options.root, 'integration-operations.json'))).toBe(false)
  const begun = installation.beginUninstall(1, sessions)
  if (begun.status !== 'preparing') throw new Error('Fixture did not begin uninstall')
  expect(installation.enterUninstallRemoval(begun.token, sessions).status).toBe('removing')
  expect(() => installation.beginIntegrationOperation(1, { scope, operation: 'remove' }, identity, 'wrong-token')).toThrow(/authority changed/)
  const removal = installation.beginIntegrationOperation(1, { scope, operation: 'remove' }, identity, begun.token)
  expect(installation.completeUninstall(begun.token, sessions, () => ({ ok: true, conflicts: [] })).status).not.toBe('removed')
  expect(() => installation.beginIntegrationOperation(1, { scope, operation: 'enable' }, identity)).toThrow(/uninstall/)
  installation.completeIntegrationOperation(removal)
  expect(installation.completeUninstall(begun.token, sessions, () => ({ ok: true, conflicts: [] })).status).toBe('removed')
  expect(installation.installCandidate({ ...candidate, source: 'manual' }).active.generation).toBe(1)
  expect(installation.pendingIntegrationOperations()).toEqual([])
})

it('releases only an orphaned host reservation after fresh quiescence, preserving edits and pending answers', () => {
  const f = fixture(), first = f.installation.installCandidate({ ...f.candidate('1.0.0'), source: 'manual' })
  const id = JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8')).id as string
  const scope = path.join(f.root, 'hermes', 'plugins', 'notifai'), source = path.join(f.root, 'prepared-plugin')
  mkdirSync(scope, { recursive: true }); mkdirSync(source)
  const plugin = path.join(scope, '__init__.py'), prepared = path.join(source, '__init__.py')
  writeFileSync(plugin, 'later User edit'); writeFileSync(prepared, 'preserved prepared source')
  const token = f.installation.beginIntegrationOperation(1, { scope, source, revision: 'b'.repeat(64), operation: 'install' },
    { installation_id: id, build: first.active.active })
  const initial = f.installation.integrationRecoveryConfirmation(token)
  expect(() => f.installation.releaseIntegrationOperation(token, initial, 1, () => {})).toThrow(/coordinator is still running/)
  const file = path.join(f.options.root, 'integration-operations.json'), receipt = JSON.parse(readFileSync(file, 'utf8'))
  receipt.operations[0].owner = { pid: 2147483647, start: 'exited fixture owner' }
  writeFileSync(file, JSON.stringify(receipt))
  const confirmation = f.installation.integrationRecoveryConfirmation(token)
  expect(() => f.installation.releaseIntegrationOperation(token, initial, 1, () => {})).toThrow(/confirmation changed/)
  f.installation.installCandidate({ ...f.candidate('2.0.0'), source: 'manual', upgrade: true, version: '2.0.0', channel: 'stable' })
  expect(() => f.installation.releaseIntegrationOperation(token, confirmation, 1, () => {})).toThrow(/changed during recovery/)
  expect(() => f.installation.releaseIntegrationOperation(token, confirmation, 2, () => { throw new Error('child still running') })).toThrow(/child still running/)
  expect(f.installation.pendingIntegrationOperations()).toHaveLength(1)
  const env = { XDG_STATE_HOME: path.join(f.root, 'state') }
  writeSessionState('healthy-owner', env, { harness: 'hermes', acknowledgement_due: [{ request_id: 'pending-answer' }] } as Parameters<typeof writeSessionState>[2])
  const state = sessionStatePath('healthy-owner', env), before = readFileSync(state)
  expect(f.installation.releaseIntegrationOperation(token, confirmation, 2, operation => expect(operation.scope).toBe(canonicalPath(scope))).token).toBe(token)
  expect(f.installation.pendingIntegrationOperations()).toEqual([])
  expect(readFileSync(plugin, 'utf8')).toBe('later User edit')
  expect(readFileSync(prepared, 'utf8')).toBe('preserved prepared source')
  expect(readFileSync(state)).toEqual(before)
  expect(() => f.installation.releaseIntegrationOperation(token, confirmation, 2, () => {})).toThrow(/confirmation changed/)
})

it('releases an orphaned host removal without cancelling the native removing barrier', () => {
  const f = fixture(), sessions = path.join(f.root, 'sessions')
  const installation = new Installation({ ...f.options, fileUse: () => ({ status: 'clear', processes: [] }) })
  const first = installation.installCandidate({ ...f.candidate('1.0.0'), source: 'manual' })
  const id = JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8')).id as string
  const begun = installation.beginUninstall(1, sessions)
  if (begun.status !== 'preparing') throw new Error('Fixture did not begin uninstall')
  expect(installation.enterUninstallRemoval(begun.token, sessions).status).toBe('removing')
  const token = installation.beginIntegrationOperation(1, { scope: path.join(f.root, 'hermes', 'plugins', 'notifai'), operation: 'remove' },
    { installation_id: id, build: first.active.active }, begun.token)
  const file = path.join(f.options.root, 'integration-operations.json'), receipt = JSON.parse(readFileSync(file, 'utf8'))
  receipt.operations[0].owner = { pid: 2147483647, start: 'exited fixture owner' }
  writeFileSync(file, JSON.stringify(receipt))
  installation.releaseIntegrationOperation(token, installation.integrationRecoveryConfirmation(token), 1, () => {})
  expect(installation.inspect().uninstall_pending).toBe(true)
  expect(installation.uninstallState()?.phase).toBe('removing')
  expect(installation.completeUninstall(begun.token, sessions, () => ({ ok: true, conflicts: [] })).status).toBe('removed')
})

it('bootstraps a quiet historical installation without changing retained files or session references', () => {
  const f = legacyFixture(), installation = new Installation(f.options)
  const env = { XDG_STATE_HOME: path.join(f.root, 'state') }, session = 'settled-old-session'
  writeSessionState(session, env, { harness: 'codex', runtime_builds: [{ installation_id: f.id, build: f.build }] })
  const file = sessionStatePath(session, env), before = readFileSync(file)
  const boot = new Installation({ ...f.options, sessionsDirectory: path.dirname(file) })
  const result = boot.installCandidate(f.upgrade)
  expect(result.version).toBe('2.0.0')
  expect(JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8'))).toMatchObject({ schema: 1, runtime: { target: f.options.target, contract: 'notifai-session-state-v1' } })
  expect(JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8'))).not.toHaveProperty('target')
  expect(boot.inspect()).toMatchObject({ active: { previous: f.build, generation: 2 }, pending: false, uninstall_pending: false })
  expect(readFileSync(file)).toEqual(before)
  expect(readFileSync(path.join(f.options.root, 'versions', f.build, 'notifai-runtime'), 'utf8')).toBe('runtime 1.0.0')
  expect(() => installation.rollback(2)).toThrow(/cannot enforce/)
})

it.each(['in_use', 'uncertain'] as const)('leaves the old command working when bootstrap process inspection is %s', status => {
  const f = legacyFixture(), oldMetadata = readFileSync(path.join(f.options.root, 'install.json'))
  const installation = new Installation({ ...f.options, fileUse: () => ({ status, processes: [] }) })
  expect(() => installation.installCandidate(f.upgrade)).toThrow(/old native process/)
  expect(readFileSync(path.join(f.options.root, 'install.json'))).toEqual(oldMetadata)
  expect(existsSync(path.join(f.options.root, 'uninstall.json'))).toBe(false)
  expect(installation.inspect()).toMatchObject({ active: { active: f.build, generation: 1 }, pending: true })
  expect(new Installation(f.options).installCandidate(f.upgrade).version).toBe('2.0.0')
})

it('rechecks question debt after admission closes and keeps newly observed work intact', () => {
  const f = legacyFixture(), env = { XDG_STATE_HOME: path.join(f.root, 'state') }, session = 'racing-question'
  const installation = new Installation({ ...f.options, sessionsDirectory: path.dirname(sessionStatePath(session, env)), fileUse: () => {
    writeSessionState(session, env, { runtime_builds: [{ installation_id: f.id, build: f.build }],
      acknowledgement_due: [{ request_id: 'req_raced', recorded_at: 1 }] })
    return { status: 'clear', processes: [] }
  } })
  expect(() => installation.installCandidate(f.upgrade)).toThrow(/existing questions/)
  expect(JSON.parse(readFileSync(sessionStatePath(session, env), 'utf8')).acknowledgement_due[0].request_id).toBe('req_raced')
  expect(existsSync(path.join(f.options.root, 'uninstall.json'))).toBe(false)
  expect(JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8'))).toMatchObject({ schema: 1, target: f.options.target })
  expect(JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8'))).not.toHaveProperty('runtime')
})

it.each(['bootstrap-fenced', 'launcher', 'metadata', 'activated'] as const)('recovers only the exact candidate after interruption at %s', interrupted => {
  const f = legacyFixture(), installation = new Installation({ ...f.options, observe: phase => {
    if (phase === interrupted) throw new Error('interrupted')
  } })
  expect(() => installation.installCandidate(f.upgrade)).toThrow('interrupted')
  expect(JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8'))).toMatchObject({ schema: 1, runtime: { target: f.options.target, contract: 'notifai-session-state-v1' } })
  expect(JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8'))).not.toHaveProperty('target')
  expect(installation.inspect()).toMatchObject({ pending: true, bootstrap_pending: true, uninstall_pending: false })
  expect(() => new Installation(f.options).abandonPending(1)).toThrow(/bootstrap/)
  expect(() => new Installation(f.options).installCandidate({ ...f.upgrade, ...f.candidate('3.0.0'), version: '3.0.0' })).toThrow(/exact staged/)
  const recovered = new Installation(f.options)
  expect(recovered.installCandidate(f.upgrade).version).toBe('2.0.0')
  expect(recovered.inspect()).toMatchObject({ active: { generation: 2, previous: f.build }, pending: false })
  expect(existsSync(path.join(f.options.root, 'uninstall.json'))).toBe(false)
  expect(() => recovered.rollback(2)).toThrow(/cannot enforce/)
})

it('reopens old admission if a pre-fence crash is followed by newly observed question debt', () => {
  const f = legacyFixture(), env = { XDG_STATE_HOME: path.join(f.root, 'state') }, session = 'late-owner'
  const sessionsDirectory = path.dirname(sessionStatePath(session, env))
  const interrupted = new Installation({ ...f.options, sessionsDirectory, fileUse: () => ({ status: 'in_use', processes: [] }) })
  expect(() => interrupted.installCandidate(f.upgrade)).toThrow(/old native process/)
  // Simulate abrupt process death after marker publication: JS finally did not run.
  const transaction = JSON.parse(readFileSync(path.join(f.options.root, 'transaction.json'), 'utf8'))
  const marker = path.join(f.options.root, 'uninstall.json')
  writeFileSync(marker, JSON.stringify({ schema: 2, operation: 'continuity-bootstrap', installation_id: f.id, build: transaction.to.active }), { mode: 0o600 })
  writeSessionState(session, env, { runtime_builds: [{ installation_id: f.id, build: f.build }],
    acknowledgement_due: [{ request_id: 'req_late_owner', recorded_at: 1 }] })
  const stateBefore = readFileSync(sessionStatePath(session, env))
  expect(() => new Installation({ ...f.options, sessionsDirectory }).recover()).toThrow(/existing questions/)
  expect(existsSync(marker)).toBe(false)
  expect(readFileSync(sessionStatePath(session, env))).toEqual(stateBefore)
  expect(JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8'))).toMatchObject({ schema: 1, target: f.options.target })
  expect(JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8'))).not.toHaveProperty('runtime')
})

// Real Windows access helpers run against packaged artifacts in native CI.
it.skipIf(process.platform === 'win32')('diagnoses interrupted bootstrap with authenticated exact recovery, never uninstall advice', () => {
  const f = legacyFixture(), root = path.join(f.root, '.notifai')
  renameSync(f.options.root, root)
  const options = { ...f.options, root, sessionsDirectory: path.join(root, 'sessions') }
  const installation = new Installation({ ...options, observe: phase => {
    if (phase === 'bootstrap-fenced') throw new Error('interrupted')
  } })
  expect(() => installation.installCandidate(f.upgrade)).toThrow('interrupted')
  const inspectionOptions = { nativeHome: f.root, distribution: options.distribution }
  const inspection = inspectCliInstallations({}, 'linux', inspectionOptions)
  expect(inspection.transaction).toMatchObject({ install_pending: true, bootstrap_pending: true, uninstall_pending: false,
    recovery_command: expect.stringContaining('install --upgrade --version 2.0.0 --channel stable --no-init --no-path --json') })
  expect(cliBinReadiness({}, 'linux', inspectionOptions).remedy).toMatchObject({ by: 'cli', command: inspection.transaction.recovery_command })
  // Local metadata alone is not permission to recommend a changed executable.
  const pending = installation.pendingRelease()!
  writeFileSync(pending.launcher, 'modified after staging')
  const tampered = inspectCliInstallations({}, 'linux', inspectionOptions)
  expect(tampered.transaction.bootstrap_pending).toBe(true)
  expect(tampered.transaction).not.toHaveProperty('recovery_command')
})

it('preserves an existing uninstall journal and rejects unaudited historical inventories', () => {
  const f = legacyFixture(), barrier = path.join(f.options.root, 'uninstall.json')
  writeFileSync(barrier, 'existing uninstall', { mode: 0o600 })
  expect(() => new Installation(f.options).installCandidate(f.upgrade)).toThrow()
  expect(readFileSync(barrier, 'utf8')).toBe('existing uninstall')
  rmSync(barrier)
  expect(() => new Installation({ ...f.options, legacyBootstrapInventories: [] }).installCandidate(f.upgrade)).toThrow(/no proven writer rejection/)
  expect(existsSync(barrier)).toBe(false)
  expect(JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8'))).toMatchObject({ schema: 1, target: f.options.target })
  expect(JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8'))).not.toHaveProperty('runtime')
})

it('allows later compatible updates despite authenticated old portable staging after the fence', () => {
  const f = legacyFixture(), late = f.candidate('1.5.0', undefined, undefined, 1)
  const options = { ...f.options, legacyBootstrapInventories: [...f.options.legacyBootstrapInventories,
    createHash('sha256').update(late.signedInventory).digest('hex')] }
  const installation = new Installation(options)
  installation.installCandidate(f.upgrade)
  installation.stage(late)
  expect(installation.installCandidate({ ...f.upgrade, ...f.candidate('3.0.0'), version: '3.0.0' }).version).toBe('3.0.0')
})

it.each([
  { runtime: { target: 'bun-linux-x64', contract: 'notifai-session-state-v1' } },
  { target: null },
  { target: undefined },
  { schema: 2 },
  { target: 'bun-windows-x64' },
  { target: undefined, runtime: { target: 'bun-linux-x64', contract: 'unknown' } },
  { target: undefined, runtime: { target: 'bun-windows-x64', contract: 'notifai-session-state-v1' } },
])('rejects ambiguous or unsupported writer identity %j', change => {
  const f = legacyFixture(), file = path.join(f.options.root, 'install.json')
  const prior = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...prior, ...change }))
  expect(() => new Installation(f.options).inspect()).toThrow(/Invalid installation ownership/)
})

it('never restores old writer admission through channel changes, repair or compatible rollback', () => {
  const f = legacyFixture(), installation = new Installation(f.options)
  installation.installCandidate(f.upgrade)
  const second = installation.inspect().active!.active
  installation.activate({ build: second, expectedGeneration: 2, source: 'shell', channel: 'beta' })
  installation.repairLauncher(3)
  installation.installCandidate({ ...f.upgrade, ...f.candidate('3.0.0'), version: '3.0.0' })
  installation.rollback(4)
  const record = JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8'))
  expect(record).not.toHaveProperty('target')
  expect(record.runtime).toEqual({ target: f.options.target, contract: 'notifai-session-state-v1' })
})

it('activates immutable generations, rejects stale decisions, and rolls back without losing files', () => {
  const f = fixture(), first = f.installation.stage(f.candidate('1.0.0'))
  expect(f.installation.inspect().active).toBeNull()
  expect(f.installation.activate({ build: first, expectedGeneration: 0, source: 'manual', channel: 'stable' }).changed).toBe(true)
  writeFileSync(path.join(f.options.root, 'unrelated.txt'), 'preserve')
  const second = f.installation.stage(f.candidate('2.0.0'))
  expect(() => f.installation.activate({ build: second, expectedGeneration: 0, source: 'manual', channel: 'stable' })).toThrow(/changed/)
  expect(f.installation.activate({ build: second, expectedGeneration: 1, source: 'manual', channel: 'stable' }).active.active).toBe(second)
  expect(f.installation.rollback(2).active.active).toBe(first)
  expect(readFileSync(path.join(f.options.root, 'unrelated.txt'), 'utf8')).toBe('preserve')
  for (const build of [first, second]) expect(existsSync(path.join(f.options.root, 'versions', build, 'notifai-runtime'))).toBe(true)
})

it('activates compatible updates while old questions and resident claims keep their original bytes', () => {
  const f = fixture(), env = { XDG_STATE_HOME: path.join(f.root, 'state') }, session = 'old-question'
  const sessionsDirectory = path.dirname(sessionStatePath(session, env))
  const installation = new Installation({ ...f.options, sessionsDirectory })
  installation.installCandidate({ ...f.candidate('1.0.0'), source: 'shell' })
  const first = installation.activeRelease(), id = JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8')).id
  const reference = { installation_id: id, build: first.build }
  writeSessionState(session, env, { harness: 'codex', runtime_builds: [reference],
    acknowledgement_due: [{ request_id: 'req_still_owned', recorded_at: 1 }] })
  const file = sessionStatePath(session, env), before = readFileSync(file)
  const claim = path.join(sessionsDirectory, 'unindexed.attendant')
  const token = acquireClaimFile(claim, { runtime_build: reference })!
  const claimBefore = readFileSync(claim)
  try {
    const result = installation.installCandidate({ ...f.candidate('2.0.0'), source: 'npm', upgrade: true, version: '2.0.0', channel: 'stable' })
    expect(result.version).toBe('2.0.0')
    expect(installation.inspect().source).toBe('shell')
    expect(readFileSync(file)).toEqual(before)
    expect(readFileSync(claim)).toEqual(claimBefore)
    expect(existsSync(path.join(f.options.root, 'versions', first.build, 'notifai-runtime'))).toBe(true)
  } finally { releaseClaimFile(claim, token) }
})

it('keeps an exact waiting candidate and rechecks unknown legacy work on recovery', () => {
  const f = fixture(), env = { XDG_STATE_HOME: path.join(f.root, 'state') }, session = 'legacy'
  const installation = new Installation({ ...f.options, sessionsDirectory: path.dirname(sessionStatePath(session, env)) })
  writeSessionState(session, env, { acknowledgement_due: [{ request_id: 'req_legacy', recorded_at: 1 }] })
  const candidate = f.candidate('1.0.0'), file = sessionStatePath(session, env), before = readFileSync(file)
  expect(() => installation.installCandidate({ ...candidate, source: 'manual' })).toThrow(/existing writer/)
  expect(installation.inspect()).toMatchObject({ active: null, pending: true })
  expect(() => installation.recover()).toThrow(/existing writer/)
  expect(readFileSync(file)).toEqual(before)
  // The real owner settles its debt. Bare historical state is not a writer.
  writeSessionState(session, env, {})
  expect(installation.recover().active?.generation).toBe(1)
  expect(installation.activeRelease().version).toBe('1.0.0')
})

it('blocks an unindexed live legacy claim but ignores an exactly gone owner', () => {
  const f = fixture(), sessionsDirectory = path.join(f.root, 'sessions')
  mkdirSync(sessionsDirectory)
  const installation = new Installation({ ...f.options, sessionsDirectory })
  const claim = path.join(sessionsDirectory, 'orphan.attendant'), token = acquireClaimFile(claim, {})!
  try {
    expect(() => installation.installCandidate({ ...f.candidate('1.0.0'), source: 'manual' })).toThrow(/resident/)
    const contents = JSON.parse(readFileSync(claim, 'utf8'))
    writeFileSync(claim, JSON.stringify({ ...contents, start: 'another process incarnation' }))
    expect(installation.recover().active?.generation).toBe(1)
  } finally { releaseClaimFile(claim, token) }
})

it('checks all retained generations and fences stale integration writers at publication', () => {
  const f = fixture(), first = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build: first, source: 'manual', channel: 'stable', expectedGeneration: 0 })
  const second = f.installation.stage(f.candidate('2.0.0'))
  f.installation.activate({ build: second, source: 'manual', channel: 'stable', expectedGeneration: 1 })
  let wrote = false
  expect(() => f.installation.publishIntegration(1, () => { wrote = true })).toThrow(/superseded/)
  expect(wrote).toBe(false)
  const third = f.installation.stage(f.candidate('3.0.0', undefined, 'incompatible-state-v2'))
  expect(() => f.installation.activate({ build: third, source: 'manual', channel: 'stable', expectedGeneration: 2 })).toThrow(/continuity/)
  expect(f.installation.inspect().active?.active).toBe(second)
  expect(() => f.installation.publishIntegration(2, () => { wrote = true })).toThrow(/superseded/)
  expect(wrote).toBe(false)
})

it('cleans only authenticated retired builds from an earlier boot, preserving active and previous generations', () => {
  const f = fixture()
  let boot = '11111111-1111-4111-8111-111111111111'
  const installation = new Installation({ ...f.options, bootIdentity: () => boot })
  const builds = ['1.0.0', '2.0.0', '3.0.0'].map(version => installation.stage(f.candidate(version)))
  builds.forEach((build, generation) => installation.activate({ build, expectedGeneration: generation, source: 'manual', channel: 'stable' }))
  const restage = { directory: path.join(f.root, '1.0.0'), signedInventory:
    readFileSync(path.join(f.options.root, 'versions', builds[0]!, 'inventory.json'), 'utf8') }
  expect(installation.cleanup(3).removed).toEqual([])
  boot = '22222222-2222-4222-8222-222222222222'
  expect(installation.cleanup(3).removed).toEqual([builds[0]])
  expect(installation.activeRelease().build).toBe(builds[2])
  // Re-staging an old release clears its old retirement evidence before the
  // caller can activate it. Concurrent cleanup cannot reclaim that candidate.
  expect(installation.stage(restage)).toBe(builds[0])
  expect(installation.cleanup(3).removed).toEqual([])
  expect(installation.rollback(3).active.active).toBe(builds[1])
})

it('keeps owners in other state roots and a resumed generation after its durable reference is released', () => {
  const f = fixture()
  let boot: string | null = '11111111-1111-4111-8111-111111111111'
  const installation = new Installation({ ...f.options, bootIdentity: () => boot })
  const builds = ['1.0.0', '2.0.0', '3.0.0'].map(version => installation.stage(f.candidate(version)))
  builds.forEach((build, generation) => installation.activate({ build, expectedGeneration: generation, source: 'manual', channel: 'stable' }))
  const id = JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8')).id
  const env = { XDG_STATE_HOME: path.join(f.root, 'another-state-root') }, session = 'retained-owner'
  writeSessionState(session, env, { harness: 'codex', runtime_builds: [{ installation_id: id, build: builds[0]! }] })
  const retention = new RuntimeRetention(f.options.root, id, f.options.access, () => boot)
  boot = null // Owner discovery is required even when boot identity is unavailable.
  retention.retain(builds[0]!, sessionStatePath(session, env))
  boot = '22222222-2222-4222-8222-222222222222'
  expect(installation.cleanup(3).retained).toContainEqual(expect.objectContaining({ build: builds[0], reason: 'durable_owner' }))
  retention.retain(builds[0]!, sessionStatePath(session, env))
  writeSessionState(session, env, {})
  expect(installation.cleanup(3).retained).toContainEqual(expect.objectContaining({ build: builds[0], reason: 'resumed_this_boot' }))
  boot = '33333333-3333-4333-8333-333333333333'
  expect(installation.cleanup(3).removed).toEqual([builds[0]])
})

it('finds pending work across indexed state roots before any uninstall mutation', () => {
  const f = fixture(), build = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const id = JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8')).id
  const retention = new RuntimeRetention(f.options.root, id, f.options.access, () => null)
  const env = { XDG_STATE_HOME: path.join(f.root, 'other-state') }, session = 'other-owner'
  const file = sessionStatePath(session, env), current = path.join(f.root, 'current-state', 'sessions')
  writeSessionState(session, env, { harness: 'codex', runtime_builds: [{ installation_id: id, build }] })
  retention.retain(build, file)
  expect(retention.inspectOwners(current)).toMatchObject({ status: 'clear', hosts: [], residents: [], sessions: [{ file: canonicalPath(file), sessionId: session, builds: [build] }] })
  // An unindexed sibling can have pending work from before native migration.
  writeSessionState('legacy-sibling', env, { acknowledgement_due: [{ request_id: 'req_pending', recorded_at: 1 }] })
  expect(retention.inspectOwners(current).status).toBe('waiting_for_questions')
  writeSessionState('legacy-sibling', env, {})
  expect(retention.inspectOwners(current).status).toBe('clear')
  writeFileSync(file, '{broken')
  expect(retention.inspectOwners(current).status).toBe('uncertain')
  expect(f.installation.activeRelease().build).toBe(build)
})

// Native Windows C ownership is exercised by check-standalone-runtime, not this text launcher fixture.
it.skipIf(process.platform === 'win32').each(['current', 'released-v6'])('finds %s OpenClaw pending message context in its recorded custom host root', plugin => {
  const f = fixture(), root = path.join(f.root, '.notifai')
  const installation = new Installation({ ...f.options, root })
  const build = installation.stage(f.candidate('1.0.0'))
  installation.activate({ build, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const sessions = path.join(f.root, 'cli-state', 'sessions'), hostRoot = path.join(f.root, 'custom-host', 'notifai')
  const id = JSON.parse(readFileSync(path.join(root, 'install.json'), 'utf8')).id
  const retention = new RuntimeRetention(root, id, f.options.access)
  const generation = '11111111-1111-4111-8111-111111111111', message = 'sm_pending'
  const delivery = createHash('sha256').update(generation + '\0' + message).digest('hex').slice(0, 32)
  const record = { delivery_id: delivery, message_id: message, session_key: 'agent:main:main', cwd: f.root,
    openclaw_session_id: 'native-session', generation, native_revision: 'revision', boot_id: generation,
    deadline_ns: '12345678', attempt: 1, phase: 'transcript', text: 'pending context' }
  const producer = path.join(f.root, 'host.mjs')
  const source = plugin === 'current' ? openclawPluginSource({ adapterPath: path.join(root, 'bin', 'notifai'), timeoutSeconds: 5 })
    : readFileSync(new URL('./fixtures/openclaw-v6.mjs.txt', import.meta.url), 'utf8')
      .replaceAll('/__NOTIFAI_FIXTURE__/.notifai/bin/notifai', path.join(root, 'bin', 'notifai'))
  writeFileSync(producer, source + `
JOURNAL_DIR = ${JSON.stringify(path.join(hostRoot, 'continuation-journal'))}
MESSAGE_JOURNAL_DIR = ${JSON.stringify(path.join(hostRoot, 'message-journal'))}
saveMessageJournal(${JSON.stringify(record)})
`)
  const result = spawnSync(process.execPath, [producer], { encoding: 'utf8', timeout: 10_000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(retention.inspectOwners(sessions).status).toBe('waiting_for_questions')
  expect(retention.inspectOwners(sessions).hosts).toEqual([{ pid: result.pid, start: expect.any(String) }])
  expect(installation.beginUninstall(1, sessions).status).toBe('waiting_for_questions')
  expect(existsSync(path.join(root, 'uninstall.json'))).toBe(false)
  const journal = path.join(hostRoot, 'message-journal', delivery + '.json')
  const marker = path.join(hostRoot, 'message-journal', delivery + '.context-used')
  writeFileSync(marker, 'used\n', { mode: 0o600 })
  expect(retention.inspectOwners(sessions).status).toBe('waiting_for_questions')
  const terminal: Partial<typeof record> = { ...record }
  delete terminal.text
  writeFileSync(journal, JSON.stringify(terminal), { mode: 0o600 })
  expect(retention.inspectOwners(sessions).status).toBe('clear')
  writeFileSync(journal, JSON.stringify({ ...terminal, phase: 'unconfirmed' }))
  expect(retention.inspectOwners(sessions).status).toBe('clear')
  writeFileSync(journal, JSON.stringify({ ...terminal, phase: 'submitting' }))
  expect(retention.inspectOwners(sessions).status).toBe('waiting_for_questions')
  writeFileSync(journal, JSON.stringify({ ...terminal, phase: 'future-phase' }))
  expect(retention.inspectOwners(sessions).status).toBe('uncertain')
  writeFileSync(journal, JSON.stringify(terminal))
  const temporary = journal + '.interrupted.tmp'
  writeFileSync(temporary, 'partial', { mode: 0o600 })
  expect(retention.inspectOwners(sessions).status).toBe('uncertain')
  rmSync(temporary)
  const request = 'req_host_fixture', continuation = createHash('sha256').update(generation + '\0' + request).digest('hex').slice(0, 32)
  const continuationDirectory = path.join(hostRoot, 'continuation-journal')
  mkdirSync(continuationDirectory, { mode: 0o700 })
  const continuationFile = path.join(continuationDirectory, continuation + '.json')
  const answer = { delivery_id: continuation, generation, request_ids: [request], session_key: record.session_key,
    cwd: f.root, openclaw_session_id: record.openclaw_session_id, attempt: 1, phase: 'committed' }
  writeFileSync(continuationFile, JSON.stringify(answer), { mode: 0o600 })
  expect(retention.inspectOwners(sessions).status).toBe('waiting_for_questions')
  writeFileSync(continuationFile, JSON.stringify({ ...answer, phase: 'transcript' }))
  expect(retention.inspectOwners(sessions).status).toBe('clear')
  writeFileSync(journal, '{broken')
  expect(retention.inspectOwners(sessions).status).toBe('uncertain')
  rmSync(journal)
  expect(retention.inspectOwners(sessions).status).toBe('uncertain')
})

it('inventories resident claims even when their main session record is absent', () => {
  const f = fixture(), build = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const id = JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8')).id
  const retention = new RuntimeRetention(f.options.root, id, f.options.access)
  const sessions = path.join(f.root, 'state', 'sessions')
  ensurePrivateDirectory(sessions)
  const claim = path.join(sessions, 'orphan.attendant')
  const token = acquireClaimFile(claim, { incarnation: 'fixture' })
  expect(token).not.toBeNull()
  const before = readFileSync(claim, 'utf8')
  try {
    expect(retention.inspectOwners(sessions)).toMatchObject({ status: 'clear',
      residents: [{ file: canonicalPath(claim), identity: currentProcessIdentity() }] })
    writeFileSync(claim + '.guard', '', { mode: 0o600 })
    expect(retention.inspectOwners(sessions).status).toBe('uncertain')
    rmSync(claim + '.guard')
    expect(readFileSync(claim, 'utf8')).toBe(before)
  } finally { releaseClaimFile(claim, token!) }
  expect(retention.inspectOwners(sessions)).toMatchObject({ status: 'clear', residents: [] })
  writeFileSync(claim, JSON.stringify({ pid: process.pid }), { mode: 0o600 })
  expect(retention.inspectOwners(sessions).status).toBe('uncertain')
})

it('retains unfinished native answers and input wakes before uninstall preparation', () => {
  const f = fixture(), build = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const env = { XDG_STATE_HOME: path.join(f.root, 'state') }, session = 'queued-owner'
  writeSessionState(session, env, {})
  const file = sessionStatePath(session, env), sessions = path.dirname(file)
  const initial = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...initial, native_answer_operations: [{ acknowledgement: null }] }))
  expect(f.installation.beginUninstall(1, sessions).status).toBe('uncertain')
  writeFileSync(file, JSON.stringify({ ...initial, input_wake: { queued: true } }))
  expect(f.installation.beginUninstall(1, sessions).status).toBe('waiting_for_questions')
  for (const phase of ['prepared', 'sending', 'accepted', 'unknown']) {
    writeFileSync(file, JSON.stringify({ ...initial, input_wake_attempts: [{ phase }] }))
    expect(f.installation.beginUninstall(1, sessions).status).toBe('waiting_for_questions')
  }
  expect(existsSync(path.join(f.options.root, 'uninstall.json'))).toBe(false)
  writeFileSync(file, JSON.stringify({ ...initial, input_wake_attempts: [{ phase: 'consumed' }, { phase: 'cancelled' }] }))
  const begun = f.installation.beginUninstall(1, sessions)
  expect(begun.status).toBe('preparing')
  if (begun.status === 'preparing') f.installation.cancelUninstall(begun.token)
})

it('finds orphan delivery and retirement work outside the main session records', () => {
  const f = fixture(), build = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const sessions = path.join(f.root, 'state', 'sessions')
  ensurePrivateDirectory(sessions)
  const journal = path.join(sessions, `${sanitizeSessionId('orphan')}.deliveries`)
  const entry = { attempt_id: 'attempt', subject: { type: 'session_message', message_id: 'sm_note' },
    stage: 'written', writer: { pid: 1, start: 'old' }, claimed_at: 1 }
  writeFileSync(journal, JSON.stringify({ session_id: 'orphan', entries: [entry] }))
  expect(f.installation.beginUninstall(1, sessions).status).toBe('waiting_for_questions')
  writeFileSync(journal, JSON.stringify({ session_id: 'orphan', entries: [{ ...entry, reported: null }] }))
  expect(f.installation.beginUninstall(1, sessions).status).toBe('uncertain')
  writeFileSync(journal, JSON.stringify({ session_id: 'orphan', entries: [{ ...entry, reported: 'handed_off', reported_at: 2 }] }))
  const inputs = path.join(sessions, `${sanitizeSessionId('orphan')}.inputs.json`)
  writeFileSync(inputs, JSON.stringify({ session_id: 'orphan', incarnation: 'old', generation: 1,
    messages: [{ message_id: 'sm_pending', kind: 'note', body: 'pending note', created_at: '2026-10-06T00:00:00Z', agent_acknowledgement_text_required: true }] }))
  expect(f.installation.beginUninstall(1, sessions).status).toBe('waiting_for_questions')
  rmSync(inputs)
  const retire = path.join(path.dirname(sessions), 'retire-queue.json')
  writeFileSync(retire, JSON.stringify([{ request_id: 'req_old' }]))
  expect(f.installation.beginUninstall(1, sessions).status).toBe('waiting_for_questions')
  writeFileSync(retire, '[]')
  const begun = f.installation.beginUninstall(1, sessions)
  expect(begun.status).toBe('preparing')
  if (begun.status === 'preparing') f.installation.cancelUninstall(begun.token)
})

it('closes launch admission only after work drains and fences concurrent installation mutations', () => {
  const f = fixture(), first = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build: first, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const next = f.installation.stage(f.candidate('2.0.0'))
  const env = { XDG_STATE_HOME: path.join(f.root, 'state') }, session = 'pending-owner'
  const sessions = path.dirname(sessionStatePath(session, env))
  writeSessionState(session, env, { acknowledgement_due: [{ request_id: 'req_pending', recorded_at: 1 }] })
  expect(f.installation.beginUninstall(1, sessions).status).toBe('waiting_for_questions')
  expect(existsSync(path.join(f.options.root, 'uninstall.json'))).toBe(false)
  writeSessionState(session, env, {})
  const begun = f.installation.beginUninstall(1, sessions)
  expect(begun.status).toBe('preparing')
  expect(() => f.installation.activate({ build: next, expectedGeneration: 1, source: 'manual', channel: 'stable' })).toThrow(/uninstall/)
  expect(() => f.installation.cleanup(1)).toThrow(/uninstall/)
  expect(() => f.installation.cancelUninstall('foreign-token')).toThrow(/changed/)
  if (begun.status !== 'preparing') throw new Error('Uninstall did not begin')
  const journalFile = path.join(f.options.root, 'uninstall.json')
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'))
  const parentStart = processStartTime(process.ppid)
  expect(parentStart).not.toBeNull()
  writeFileSync(journalFile, JSON.stringify({ ...journal, owner: { pid: process.ppid, start: parentStart } }))
  expect(() => f.installation.beginUninstall(1, sessions)).toThrow(/Another uninstall/)
  // A recycled PID with a different start cannot retain a crashed claim.
  writeFileSync(journalFile, JSON.stringify({ ...journal, owner: { pid: process.pid, start: 'previous-process-start' } }))
  const recovered = f.installation.beginUninstall(1, sessions)
  if (recovered.status !== 'preparing') throw new Error('Uninstall did not recover')
  expect(recovered.token).not.toBe(begun.token)
  expect(() => f.installation.cancelUninstall(begun.token)).toThrow(/changed/)
  f.installation.cancelUninstall(recovered.token)
  expect(f.installation.activate({ build: next, expectedGeneration: 1, source: 'manual', channel: 'stable' }).active.active).toBe(next)
})

it('requires drained resident and native executable owners before entering removal', () => {
  const f = fixture(), first = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build: first, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const env = { XDG_STATE_HOME: path.join(f.root, 'state') }, session = 'uninstall-owner'
  writeSessionState(session, env, {})
  const sessions = path.dirname(sessionStatePath(session, env)), claimFile = path.join(sessions, 'orphan.attendant')
  const identity = currentProcessIdentity()!
  const claim = acquireClaimFile(claimFile, identity)
  expect(claim).not.toBeNull()
  let observation: { status: 'clear' | 'in_use' | 'uncertain'; processes: Array<{ pid: number }> } = { status: 'clear', processes: [] }
  let observed = 0, lateWork = false
  const installation = new Installation({ ...f.options, fileUse: (_launcher, files) => {
    observed++
    if (lateWork) writeSessionState(session, env, { acknowledgement_due: [{ request_id: 'req_late', recorded_at: 1 }] })
    expect(files).toContain(path.join(f.options.root, 'bin', 'notifai'))
    expect(files).toContain(path.join(f.options.root, 'versions', first, 'notifai-runtime'))
    return observation
  } })
  const begun = installation.beginUninstall(1, sessions)
  if (begun.status !== 'preparing') throw new Error('Uninstall did not begin')
  expect(installation.enterUninstallRemoval(begun.token, sessions).status).toBe('residents_running')
  expect(observed).toBe(0)
  releaseClaimFile(claimFile, claim!)
  observation = { status: 'uncertain', processes: [] }
  expect(installation.enterUninstallRemoval(begun.token, sessions).status).toBe('uncertain')
  observation = { status: 'in_use', processes: [{ pid: process.pid }] }
  expect(installation.enterUninstallRemoval(begun.token, sessions).status).toBe('residents_running')
  observation = { status: 'clear', processes: [] }
  // An owner can commit its final work while native observation runs.
  lateWork = true
  expect(installation.enterUninstallRemoval(begun.token, sessions).status).toBe('waiting_for_questions')
  lateWork = false
  writeSessionState(session, env, {})
  expect(installation.enterUninstallRemoval('wrong-token', sessions).status).toBe('uncertain')
  expect(installation.enterUninstallRemoval(begun.token, sessions).status).toBe('removing')
  expect(() => installation.cancelUninstall(begun.token)).toThrow(/changed/)
  expect(existsSync(path.join(f.options.root, 'versions', first, 'notifai-runtime'))).toBe(true)
  expect(readFileSync(sessionStatePath(session, env), 'utf8')).not.toContain('ended')
})

it('releases only this installation references after teardown admission without ending Agent Sessions', () => {
  const f = fixture(), build = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const id = JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8')).id
  const env = { XDG_STATE_HOME: path.join(f.root, 'state') }, session = 'preserved-session'
  const other = { installation_id: '11111111-1111-4111-8111-111111111111', build }
  writeSessionState(session, env, { harness: 'codex', cwd: f.root, runtime_builds: [{ installation_id: id, build }, other] })
  const file = sessionStatePath(session, env), sessions = path.dirname(file)
  const original = JSON.parse(readFileSync(file, 'utf8'))
  const installation = new Installation({ ...f.options, fileUse: () => ({ status: 'clear', processes: [] }) })
  const begun = installation.beginUninstall(1, sessions)
  if (begun.status !== 'preparing') throw new Error('Uninstall did not begin')
  expect(installation.releaseUninstallReferences(begun.token, sessions).status).toBe('uncertain')
  expect(installation.enterUninstallRemoval(begun.token, sessions).status).toBe('removing')
  expect(installation.releaseUninstallReferences(begun.token, sessions).status).toBe('released')
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...original, runtime_builds: [other] })
  expect(installation.releaseUninstallReferences(begun.token, sessions).status).toBe('released')
  expect(readdirSync(sessions)).toEqual([path.basename(file)])
})

it('recovers interrupted wiring removal without reopening native launch admission', () => {
  const f = fixture(), build = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const installation = new Installation({ ...f.options, fileUse: () => ({ status: 'clear', processes: [] }) })
  const sessions = path.join(f.root, 'no-sessions')
  const begun = installation.beginUninstall(1, sessions)
  if (begun.status !== 'preparing') throw new Error('Uninstall did not begin')
  expect(installation.enterUninstallRemoval(begun.token, sessions).status).toBe('removing')
  const journalFile = path.join(f.options.root, 'uninstall.json'), journal = JSON.parse(readFileSync(journalFile, 'utf8'))
  writeFileSync(journalFile, JSON.stringify({ ...journal, owner: { pid: process.pid, start: 'previous-process-start' } }))
  const resumed = installation.beginUninstall(1, sessions)
  expect(resumed.status).toBe('removing')
  if (resumed.status !== 'removing') throw new Error('Removal did not resume')
  expect(resumed.token).not.toBe(begun.token)
  expect(() => installation.cancelUninstall(resumed.token)).toThrow(/changed/)
  expect(installation.releaseUninstallReferences(resumed.token, sessions).status).toBe('released')
  expect(JSON.parse(readFileSync(journalFile, 'utf8')).phase).toBe('removing')
})

it('removes only finite authenticated installation files and preserves User data', () => {
  const f = fixture(), build = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  writeFileSync(path.join(f.options.root, 'user-data.json'), '{"keep":true}')
  writeFileSync(path.join(f.options.root, 'bin', 'other-tool'), 'keep this tool')
  const installation = new Installation({ ...f.options, fileUse: () => ({ status: 'clear', processes: [] }) })
  const sessions = path.join(f.root, 'no-sessions')
  const begun = installation.beginUninstall(1, sessions)
  if (begun.status !== 'preparing') throw new Error('Uninstall did not begin')
  let wiringRemoved = false
  const result = installation.completeUninstall(begun.token, sessions, () => { wiringRemoved = true; return { ok: true, conflicts: [] } })
  expect(result.status).toBe('removed')
  expect(wiringRemoved).toBe(true)
  expect(installation.inspect().active).toBeNull()
  expect(existsSync(path.join(f.options.root, 'uninstall.json'))).toBe(false)
  expect(existsSync(path.join(f.options.root, 'versions', build))).toBe(false)
  expect(existsSync(path.join(f.options.root, 'bin', 'notifai'))).toBe(false)
  expect(readFileSync(path.join(f.options.root, 'bin', 'other-tool'), 'utf8')).toBe('keep this tool')
  expect(readFileSync(path.join(f.options.root, 'user-data.json'), 'utf8')).toBe('{"keep":true}')
  expect(installation.installCandidate({ ...f.candidate('2.0.0'), source: 'shell' }).changed).toBe(true)
})

it.each(['uninstall-planned', 'uninstall-file-removed', 'active-pointer-removed'])('resumes a finite uninstall after %s interruption', (interruption) => {
  const f = fixture(), build = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const options = { ...f.options, fileUse: () => ({ status: 'clear' as const, processes: [] }) }
  let interrupted = false
  const installation = new Installation({ ...options, observe(phase) {
    if (!interrupted && (phase === interruption || interruption === 'active-pointer-removed' && phase === 'uninstall-file-removed' &&
        !existsSync(path.join(f.options.root, 'active.json')))) { interrupted = true; throw new Error('interrupted removal') }
  } })
  const sessions = path.join(f.root, 'no-sessions'), begun = installation.beginUninstall(1, sessions)
  if (begun.status !== 'preparing') throw new Error('Uninstall did not begin')
  expect(installation.completeUninstall(begun.token, sessions, () => ({ ok: true, conflicts: [] })).status).toBe('incomplete')
  expect(interrupted).toBe(true)
  const journalFile = path.join(f.options.root, 'uninstall.json'), journal = JSON.parse(readFileSync(journalFile, 'utf8'))
  expect(journal.plan.files.length).toBeGreaterThan(0)
  writeFileSync(journalFile, JSON.stringify({ ...journal, owner: { pid: process.pid, start: 'previous-process-start' } }))
  const retry = new Installation(options), resumed = retry.beginUninstall(1, sessions)
  if (resumed.status !== 'removing') throw new Error('Partial removal did not resume')
  expect(retry.completeUninstall(resumed.token, sessions, () => { throw new Error('Verified wiring must not be removed again') }).status).toBe('removed')
  expect(existsSync(path.join(f.options.root, 'versions', build))).toBe(false)
  expect(existsSync(journalFile)).toBe(false)
  expect(retry.installCandidate({ ...f.candidate('2.0.0'), source: 'manual' }).changed).toBe(true)
})

it('preserves changed bytes and refuses a removal plan outside installation ownership', () => {
  const f = fixture(), build = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const options = { ...f.options, fileUse: () => ({ status: 'clear' as const, processes: [] }) }
  const interrupted = new Installation({ ...options, observe(phase) { if (phase === 'uninstall-planned') throw new Error('interrupted') } })
  const sessions = path.join(f.root, 'no-sessions'), begun = interrupted.beginUninstall(1, sessions)
  if (begun.status !== 'preparing') throw new Error('Uninstall did not begin')
  expect(interrupted.completeUninstall(begun.token, sessions, () => ({ ok: true, conflicts: [] })).status).toBe('incomplete')
  const runtime = path.join(f.options.root, 'versions', build, 'notifai-runtime')
  writeFileSync(runtime, 'preserve changed executable')
  const retry = new Installation(options)
  expect(retry.completeUninstall(begun.token, sessions, () => { throw new Error('Do not repeat wiring') }).status).toBe('incomplete')
  expect(readFileSync(runtime, 'utf8')).toBe('preserve changed executable')
  expect(existsSync(path.join(f.options.root, 'active.json'))).toBe(true)
  const outside = path.join(f.root, 'outside.txt'), journalFile = path.join(f.options.root, 'uninstall.json')
  writeFileSync(outside, 'preserve unrelated data')
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'))
  journal.plan.files[0].name = '../outside.txt'
  writeFileSync(journalFile, JSON.stringify(journal))
  expect(() => retry.beginUninstall(1, sessions)).toThrow(/removal plan/)
  expect(readFileSync(outside, 'utf8')).toBe('preserve unrelated data')
})

it('prepares a verified temporary Windows finalizer while retaining executing installation files', () => {
  const f = fixture(undefined, 'bun-windows-x64'), build = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build, expectedGeneration: 0, source: 'powershell', channel: 'stable' })
  const installation = new Installation({ ...f.options, fileUse: () => ({ status: 'clear', processes: [] }) })
  const sessions = path.join(f.root, 'no-sessions'), begun = installation.beginUninstall(1, sessions)
  if (begun.status !== 'preparing') throw new Error('Uninstall did not begin')
  const result = installation.completeUninstall(begun.token, sessions, () => ({ ok: true, conflicts: [] }))
  expect(result.status).toBe('incomplete')
  expect(result.recovery_command).toBeTruthy()
  const id = JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8')).id
  const temporary = path.join(f.options.root, 'uninstall-tools', id)
  expect(readFileSync(path.join(temporary, 'notifai.exe'), 'utf8')).toBe('launcher v1')
  expect(readFileSync(path.join(temporary, 'notifai-runtime.exe'), 'utf8')).toBe('runtime 1.0.0')
  expect(readFileSync(path.join(f.options.root, 'versions', build, 'notifai-runtime.exe'), 'utf8')).toBe('runtime 1.0.0')
  expect(installation.completeUninstall(begun.token, sessions, () => { throw new Error('Do not repeat wiring') }).recovery_command).toBe(result.recovery_command)
})

it('retains unknown boot identities and user-modified bytes rather than trusting age or directory names', () => {
  const f = fixture()
  let boot: string | null = '11111111-1111-4111-8111-111111111111'
  const installation = new Installation({ ...f.options, bootIdentity: () => boot })
  const builds = ['1.0.0', '2.0.0', '3.0.0'].map(version => installation.stage(f.candidate(version)))
  builds.forEach((build, generation) => installation.activate({ build, expectedGeneration: generation, source: 'manual', channel: 'stable' }))
  boot = null
  expect(installation.cleanup(3).retained).toContainEqual(expect.objectContaining({ build: builds[0], reason: 'boot_identity_unknown' }))
  boot = '22222222-2222-4222-8222-222222222222'
  const extra = path.join(f.options.root, 'versions', builds[0]!, 'user-note.txt')
  writeFileSync(extra, 'preserve user content')
  expect(installation.cleanup(3).retained).toContainEqual(expect.objectContaining({ build: builds[0], reason: 'cleanup_incomplete_or_unverified' }))
  expect(readFileSync(extra, 'utf8')).toBe('preserve user content')
  rmSync(extra)
  // A deletion interrupted after removing one payload resumes from the signed
  // inventory; it never accepts a remaining modified or unknown member.
  rmSync(path.join(f.options.root, 'versions', builds[0]!, 'notifai-runtime'))
  expect(installation.cleanup(3).removed).toEqual([builds[0]])
})

it.each(['prepared', 'launcher', 'metadata', 'activated'] as const)('recovers an activation interrupted after %s', phase => {
  const f = fixture(), first = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build: first, expectedGeneration: 0, source: 'shell', channel: 'stable' })
  const next = f.installation.stage(f.candidate('2.0.0'))
  const interrupted = new Installation({ ...f.options, observe(point) { if (point === phase) throw new Error('interrupted') } })
  expect(() => interrupted.activate({ build: next, expectedGeneration: 1, source: 'shell', channel: 'stable' })).toThrow('interrupted')
  expect(f.installation.inspect().pending).toBe(true)
  expect(f.installation.recover().active?.active).toBe(next)
  expect(f.installation.inspect().pending).toBe(false)
})

it('refuses tampered payloads and foreign stable commands without replacing either', () => {
  const f = fixture(), first = f.installation.stage(f.candidate('1.0.0'))
  const file = path.join(f.options.root, 'versions', first, 'notifai-runtime')
  writeFileSync(file, 'tampered')
  expect(() => f.installation.activate({ build: first, expectedGeneration: 0, source: 'manual', channel: 'stable' })).toThrow(/integrity/)
  expect(f.installation.inspect().active).toBeNull()
  const second = f.installation.stage(f.candidate('2.0.0'))
  mkdirSync(path.join(f.options.root, 'bin')); writeFileSync(path.join(f.options.root, 'bin', 'notifai'), 'foreign command')
  expect(() => f.installation.activate({ build: second, expectedGeneration: 0, source: 'manual', channel: 'stable' })).toThrow(/Unowned/)
  expect(readFileSync(path.join(f.options.root, 'bin', 'notifai'), 'utf8')).toBe('foreign command')
})

it('restores the recorded channel on rollback and never installs a prerelease on stable', () => {
  const f = fixture(), beta = f.installation.stage(f.candidate('1.0.0-beta.1'))
  expect(() => f.installation.activate({ build: beta, expectedGeneration: 0, source: 'manual', channel: 'stable' })).toThrow(/Prerelease/)
  f.installation.activate({ build: beta, expectedGeneration: 0, source: 'manual', channel: 'beta' })
  const stable = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build: stable, expectedGeneration: 1, source: 'manual', channel: 'stable' })
  expect(f.installation.inspect().channel).toBe('stable')
  f.installation.rollback(2)
  expect(f.installation.inspect().channel).toBe('beta')
})

it.each(['prepared', 'launcher', 'metadata', 'activated'] as const)('repairs a pending launcher after %s interruption without changing rollback history', phase => {
  const f = fixture(), first = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build: first, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const next = f.installation.stage(f.candidate('2.0.0'))
  f.installation.activate({ build: next, expectedGeneration: 1, source: 'manual', channel: 'stable' })
  const metadata = path.join(f.options.root, 'install.json')
  const record = JSON.parse(readFileSync(metadata, 'utf8'))
  writeFileSync(metadata, JSON.stringify({ ...record, launcherBuild: first, launcherUpdatePending: true }))
  const before = f.installation.inspect().active
  expect(() => f.installation.repairLauncher(1)).toThrow(/changed/)
  const interrupted = new Installation({ ...f.options, observe(point) { if (point === phase) throw new Error('interrupted') } })
  expect(() => interrupted.repairLauncher(2)).toThrow('interrupted')
  expect(f.installation.recover().active).toEqual(before)
  expect(JSON.parse(readFileSync(metadata, 'utf8')).launcherUpdatePending).toBe(false)
  expect(f.installation.rollback(2).active.active).toBe(first)
})

it('commits a verified same-build channel change while retaining the previous release channel', () => {
  const f = fixture(), first = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build: first, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const next = f.installation.stage(f.candidate('2.0.0'))
  f.installation.activate({ build: next, expectedGeneration: 1, source: 'manual', channel: 'stable' })
  const switched = f.installation.activate({ build: next, expectedGeneration: 2, source: 'manual', channel: 'beta' })
  expect(f.installation.inspect().channel).toBe('beta')
  expect(switched.active.previous).toBe(first)
  expect(switched.active.generation).toBe(3)
  f.installation.rollback(3)
  expect(f.installation.inspect().channel).toBe('stable')
})


it('keeps the accepted channel sequence after a failed inventory fetch and refuses a withdrawn rollback', async () => {
  let channel = ''
  const f = fixture(async input => String(input).endsWith('/stable.json') ? new Response(channel) : new Response(null, { status: 503 }))
  const first = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build: first, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const second = f.installation.stage(f.candidate('2.0.0'))
  f.installation.activate({ build: second, expectedGeneration: 1, source: 'manual', channel: 'stable' })
  channel = f.channel(4, ['1.0.0'])
  await expect(f.installation.resolveRelease('stable')).rejects.toThrow(/503/)
  channel = f.channel(3)
  await expect(f.installation.resolveRelease('stable')).rejects.toThrow(/sequence/)
  expect(() => f.installation.rollback(2)).toThrow(/withdrawn/)
  expect(f.installation.inspect().active?.active).toBe(second)
})


it('requires explicit stable return and admits only the signed stable target for downgrade', async () => {
  let channel = '', inventory = ''
  const f = fixture(async input => new Response(String(input).endsWith('/stable.json') ? channel : inventory))
  const beta = f.installation.stage(f.candidate('2.0.0-beta.1'))
  f.installation.activate({ build: beta, expectedGeneration: 0, source: 'manual', channel: 'beta' })
  const candidate = f.candidate('1.0.0'), stable = f.installation.stage(candidate)
  inventory = candidate.signedInventory; channel = f.channel(2, [], inventory, '1.0.0')
  await f.installation.resolveRelease('stable')
  expect(() => f.installation.activate({ build: stable, expectedGeneration: 1, source: 'manual', channel: 'stable' })).toThrow(/rollback/)
  expect(f.installation.activate({ build: stable, expectedGeneration: 1, source: 'manual', channel: 'stable', allowStableDowngrade: true }).active.active).toBe(stable)
  expect(f.installation.inspect().channel).toBe('stable')
  f.installation.rollback(2)
  expect(f.installation.inspect().channel).toBe('beta')
})

it.each(['prepared', 'launcher', 'metadata'] as const)('does not recover a newly withdrawn candidate after %s and can abandon it safely', async phase => {
  let channel = ''
  const f = fixture(async input => String(input).endsWith('/stable.json') ? new Response(channel) : new Response(null, { status: 503 }))
  const first = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build: first, expectedGeneration: 0, source: 'shell', channel: 'stable' })
  const next = f.installation.stage(f.candidate('2.0.0'))
  const interrupted = new Installation({ ...f.options, observe(point) { if (point === phase) throw new Error('interrupted') } })
  expect(() => interrupted.activate({ build: next, expectedGeneration: 1, source: 'shell', channel: 'stable' })).toThrow('interrupted')
  channel = f.channel(4, ['2.0.0'])
  await expect(f.installation.resolveRelease('stable')).rejects.toThrow(/withdrawn/)
  expect(() => f.installation.recover()).toThrow(/withdrawn/)
  expect(f.installation.inspect().active?.active).toBe(first)
  expect(() => f.installation.abandonPending(0)).toThrow(/changed/)
  expect(f.installation.abandonPending(1)).toMatchObject({ pending: false, channel: 'stable', active: { active: first, generation: 1 } })
  expect(existsSync(path.join(f.options.root, 'versions', next))).toBe(true)
})

it('finishes already-activated recovery without silently downgrading and refuses to abandon committed activation', async () => {
  let channel = ''
  const f = fixture(async input => String(input).endsWith('/stable.json') ? new Response(channel) : new Response(null, { status: 503 }))
  const first = f.installation.stage(f.candidate('1.0.0'))
  const interrupted = new Installation({ ...f.options, observe(point) { if (point === 'activated') throw new Error('interrupted') } })
  expect(() => interrupted.activate({ build: first, expectedGeneration: 0, source: 'manual', channel: 'stable' })).toThrow('interrupted')
  channel = f.channel(4, ['1.0.0'])
  await expect(f.installation.resolveRelease('stable')).rejects.toThrow(/503/)
  expect(() => f.installation.abandonPending(1)).toThrow(/committed/)
  expect(f.installation.recover()).toMatchObject({ pending: false, active: { active: first } })
})

it('abandons a partially prepared first install while preserving data and staged content', () => {
  const f = fixture(), first = f.installation.stage(f.candidate('1.0.0'))
  const interrupted = new Installation({ ...f.options, observe(point) { if (point === 'metadata') throw new Error('interrupted') } })
  expect(() => interrupted.activate({ build: first, expectedGeneration: 0, source: 'manual', channel: 'stable' })).toThrow('interrupted')
  writeFileSync(path.join(f.options.root, 'user-data'), 'keep')
  expect(f.installation.abandonPending(0)).toMatchObject({ pending: false, active: null, source: null })
  expect(readFileSync(path.join(f.options.root, 'user-data'), 'utf8')).toBe('keep')
  expect(existsSync(path.join(f.options.root, 'versions', first))).toBe(true)
  expect(f.installation.activate({ build: first, expectedGeneration: 0, source: 'manual', channel: 'stable' }).active.active).toBe(first)
})


it('downloads a signed release through archive admission into one reusable immutable activation', async () => {
  const writer = pack(), chunks: Buffer[] = []
  const consumed = (async () => { for await (const chunk of writer) chunks.push(chunk) })()
  writer.entry({ name: 'notifai' }, 'launcher v1')
  writer.entry({ name: 'notifai-runtime' }, 'runtime 1.0.0')
  writer.finalize(); await consumed
  const archive = gzipSync(Buffer.concat(chunks))
  let channel = '', inventory = '', downloads = 0
  const f = fixture(async input => {
    if (String(input).endsWith('/stable.json')) return new Response(channel)
    if (String(input).endsWith('/inventory.json')) return new Response(inventory)
    downloads++
    return new Response(archive)
  })
  inventory = f.candidate('1.0.0', archive).signedInventory
  channel = f.channel(1, [], inventory, '1.0.0')
  const first = await f.installation.installRelease({ channel: 'stable', source: 'shell', expectedGeneration: 0 })
  expect(first).toMatchObject({ changed: true, version: '1.0.0', active: { generation: 1 } })
  expect(readdirSync(path.join(f.options.root, 'downloads'))).toEqual([])
  expect(await f.installation.installRelease({ channel: 'stable', source: 'npm', expectedGeneration: 1 })).toMatchObject({ changed: false, active: first.active })
  expect(f.installation.inspect().source).toBe('shell')
  expect(downloads).toBe(1)
})


it('native rollback runs integration through the restored immutable executable and preserves runtime history', async () => {
  const f = fixture(), first = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build: first, expectedGeneration: 0, source: 'shell', channel: 'stable' })
  const second = f.installation.stage(f.candidate('2.0.0'))
  f.installation.activate({ build: second, expectedGeneration: 1, source: 'shell', channel: 'stable' })
  const out: string[] = [], launches: string[] = []
  const deps: CommandDeps = { env: { HOME: f.root }, cwd: f.root,
    store: { load: () => null, save() {}, clear() {}, describe: () => 'fixture' },
    io: { out: line => out.push(line), err: line => out.push(line), confirm: async () => false, openUrl() {} } }
  const result = await nativeUpdateCommand(deps, { rollback: true, json: true }, {
    installation: f.installation,
    resume: executable => { launches.push(executable); return { ok: true, files_complete: true, migration_complete: true, pending_actions: [] } },
  })
  expect(result).toBe(0)
  expect(launches).toEqual([path.join(f.options.root, 'versions', first, 'notifai')])
  expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, version: '1.0.0', channel: 'stable', integration_complete: true })
  expect(f.installation.inspect().active).toMatchObject({ active: first, previous: second, generation: 3 })
  expect(existsSync(path.join(f.options.root, 'versions', second, 'notifai-runtime'))).toBe(true)
})


it('native update keeps the saved beta channel and reports incomplete integration after activation', async () => {
  const requested: string[] = []
  let record = '', inventory = ''
  const f = fixture((async (url: string) => {
    requested.push(url)
    return new Response(url.endsWith('inventory.json') ? inventory : record)
  }) as typeof fetch)
  const first = f.installation.stage(f.candidate('1.0.0-beta.1'))
  f.installation.activate({ build: first, expectedGeneration: 0, source: 'npm', channel: 'beta' })
  const candidate = f.candidate('1.0.0-beta.2')
  f.installation.stage(candidate)
  inventory = candidate.signedInventory
  record = f.channel(1, [], inventory, '1.0.0-beta.2', 'beta')
  const discovery = await discoverCliUpdate({ env: {}, installation: f.installation, readOnly: true })
  expect(discovery).toMatchObject({ channel: 'beta', target: '1.0.0-beta.2', newer: '1.0.0-beta.2', available: true, error: null })
  expect(f.installation.inspect().active?.generation).toBe(1)
  expect(existsSync(path.join(f.options.root, 'channels', 'beta.json'))).toBe(false)
  const out: string[] = []
  const deps: CommandDeps = { env: { HOME: f.root }, cwd: f.root,
    store: { load: () => null, save() {}, clear() {}, describe: () => 'fixture' },
    io: { out: line => out.push(line), err: line => out.push(line), confirm: async () => false, openUrl() {} } }
  expect(await nativeUpdateCommand(deps, { json: true }, { installation: f.installation,
    resume: () => { throw new Error('interrupted integration') } })).toBe(1)
  expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, version: '1.0.0-beta.2', channel: 'beta',
    integration_complete: false, recovery_command: 'notifai update --resume --json' })
  expect(requested.some(url => url.endsWith('beta.json'))).toBe(true)
  expect(requested.some(url => url.includes('registry.npmjs.org'))).toBe(false)
  expect(f.installation.inspect()).toMatchObject({ source: 'npm', channel: 'beta', active: { generation: 2 } })
})


it('candidate installation reuses the healthy owned runtime without silently upgrading or changing source', () => {
  const f = fixture()
  const first = f.installation.installCandidate({ ...f.candidate('1.0.0'), source: 'shell' })
  expect(first).toMatchObject({ version: '1.0.0', reused: false, changed: true })
  const newer = f.candidate('2.0.0')
  expect(f.installation.installCandidate({ ...newer, source: 'npm' })).toMatchObject({ version: '1.0.0', reused: true, changed: false })
  expect(f.installation.inspect()).toMatchObject({ source: 'shell', channel: 'stable', active: { generation: 1 } })
  expect(() => f.installation.installCandidate({ ...newer, source: 'manual', version: '2.0.0' })).toThrow(/update/)
  expect(() => f.installation.installCandidate({ ...newer, source: 'manual', channel: 'beta' })).toThrow(/update/)
})


it('native installation activates authenticated local bytes and reports setup separately through the installed launcher', async () => {
  const f = fixture(), candidate = f.candidate('1.0.0')
  const inventory = path.join(candidate.directory, 'inventory.json'); writeFileSync(inventory, candidate.signedInventory)
  const out: string[] = [], launches: string[] = []
  const deps: CommandDeps = { env: {}, cwd: f.root,
    store: { load: () => null, save() {}, clear() {}, describe: () => 'fixture' },
    io: { out: line => out.push(line), err: line => out.push(line), confirm: async () => false, openUrl() {} } }
  const flags = { directory: candidate.directory, inventory, source: 'manual', json: true, path: false }
  const seams = { installation: f.installation,
    init: (executable: string, env: NodeJS.ProcessEnv) => {
      launches.push(executable)
      expect(env['PATH']).toBe(path.join(f.options.root, 'bin'))
      expect(deps.env['PATH']).toBeUndefined()
      return { ok: false, code: 'approval_required' }
    } }
  expect(await nativeInstallCommand(deps, flags, seams)).toBe(1)
  const active = f.installation.activeRelease()
  expect(launches).toEqual([active.launcher])
  expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, runtime_installed: true, setup_complete: false, setup: { code: 'approval_required' } })
  out.length = 0; launches.length = 0
  expect(await nativeInstallCommand(deps, { ...flags, source: 'npm', init: false }, seams)).toBe(0)
  expect(launches).toEqual([])
  expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, reused: true, setup_complete: false, setup_skipped: true })
  expect(f.installation.inspect()).toMatchObject({ source: 'manual', active: { generation: 1 } })
})

it('native installer preserves an activated runtime when setup fails', async () => {
  const f = fixture(), candidate = f.candidate('1.0.0')
  const inventory = path.join(candidate.directory, 'inventory.json'); writeFileSync(inventory, candidate.signedInventory)
  const out: string[] = []
  const deps: CommandDeps = { env: {}, cwd: f.root,
    store: { load: () => null, save() {}, clear() {}, describe: () => 'fixture' },
    io: { out: line => out.push(line), err: line => out.push(line), confirm: async () => false, openUrl() {} } }
  const flags = { directory: candidate.directory, inventory, path: false, json: true }
  expect(await nativeInstallCommand(deps, flags, { installation: f.installation,
    init: () => { throw new Error('interrupted setup') } })).toBe(1)
  expect(JSON.parse(out[0]!)).toMatchObject({ runtime_installed: true, setup_complete: false })
  expect(f.installation.activeRelease().version).toBe('1.0.0')
})

it('uninstalls through the public command and reports wiring conflicts without removing runtime files', async () => {
  const f = fixture(), build = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const installation = new Installation({ ...f.options, fileUse: () => ({ status: 'clear', processes: [] }) })
  const out: string[] = []
  const deps: CommandDeps = { env: { HOME: f.root }, cwd: f.root,
    store: { load: () => null, save() {}, clear() {}, describe: () => 'fixture' },
    io: { out: line => out.push(line), err: line => out.push(line), confirm: async () => false, openUrl() {} } }
  const seams = { installation, sessions: path.join(f.root, 'no-sessions') }
  expect(await nativeUninstallCommand(deps, { json: true }, { ...seams, removeWiring: () => ({ ok: false, conflicts: ['modified skill'] }) })).toBe(1)
  expect(JSON.parse(out.pop()!)).toMatchObject({ ok: false, status: 'incomplete', conflicts: ['modified skill'] })
  expect(existsSync(path.join(f.options.root, 'versions', build, 'notifai-runtime'))).toBe(true)
  expect(await nativeUninstallCommand(deps, { json: true }, { ...seams, removeWiring: () => ({ ok: true, conflicts: [] }) })).toBe(0)
  expect(JSON.parse(out.pop()!)).toMatchObject({ ok: true, status: 'removed' })
  expect(existsSync(path.join(f.options.root, 'active.json'))).toBe(false)
})

it('refuses finishing from an original executable and preserves modified temporary cleanup bytes', () => {
  const f = fixture(undefined, 'bun-windows-x64'), build = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build, expectedGeneration: 0, source: 'powershell', channel: 'stable' })
  const installation = new Installation({ ...f.options, fileUse: () => ({ status: 'clear', processes: [] }) })
  const sessions = path.join(f.root, 'no-sessions'), begun = installation.beginUninstall(1, sessions)
  if (begun.status !== 'preparing') throw new Error('Uninstall did not begin')
  expect(installation.completeUninstall(begun.token, sessions, () => ({ ok: true, conflicts: [] })).recovery_command).toBeTruthy()
  const id = installation.uninstallState()!.installationId
  expect(() => installation.finishUninstall(id, sessions)).toThrow(/temporary uninstall command/)
  const copy = path.join(f.options.root, 'uninstall-tools', id, 'notifai-runtime.exe')
  writeFileSync(copy, 'preserve modified copy')
  const result = installation.completeUninstall(begun.token, sessions, () => { throw new Error('Do not repeat wiring') })
  expect(result.status).toBe('incomplete')
  expect(result.recovery_command).toBeUndefined()
  expect(readFileSync(copy, 'utf8')).toBe('preserve modified copy')
  expect(existsSync(path.join(f.options.root, 'active.json'))).toBe(true)
})

it('keeps runtime and launch admission unchanged when harness wiring cannot be inspected', async () => {
  const f = fixture(), build = f.installation.stage(f.candidate('1.0.0'))
  f.installation.activate({ build, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const claude = path.join(f.root, '.claude'); mkdirSync(claude)
  writeFileSync(path.join(claude, 'settings.json'), '{ malformed')
  const out: string[] = []
  const deps: CommandDeps = { env: { HOME: f.root, CLAUDE_CONFIG_DIR: claude }, cwd: f.root, hookAdapterHome: f.root,
    store: { load: () => null, save() {}, clear() {}, describe: () => 'fixture' },
    io: { out: line => out.push(line), err: line => out.push(line), confirm: async () => false, openUrl() {} } }
  expect(await nativeUninstallCommand(deps, { json: true }, { installation: f.installation, sessions: path.join(f.root, 'no-sessions') })).toBe(1)
  expect(JSON.parse(out.pop()!)).toMatchObject({ status: 'uncertain', conflicts: expect.arrayContaining([expect.stringContaining('Cannot inspect harness wiring')]) })
  expect(existsSync(path.join(f.options.root, 'uninstall.json'))).toBe(false)
  expect(existsSync(path.join(f.options.root, 'active.json'))).toBe(true)
})

it('repeated portable installation preserves pending uninstall until an explicit lifecycle action', () => {
  const f = fixture(), candidate = f.candidate('1.0.0'), build = f.installation.stage(candidate)
  f.installation.activate({ build, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  const options = { ...f.options, fileUse: () => ({ status: 'clear' as const, processes: [] }) }
  const installation = new Installation(options), sessions = path.join(f.root, 'no-sessions')
  const preparing = installation.beginUninstall(1, sessions)
  if (preparing.status !== 'preparing') throw new Error('Uninstall did not begin')
  const pendingBytes = readFileSync(path.join(f.options.root, 'uninstall.json'), 'utf8')
  expect(() => installation.installCandidate({ ...candidate, source: 'manual' })).toThrow(/pending uninstall/)
  expect(readFileSync(path.join(f.options.root, 'uninstall.json'), 'utf8')).toBe(pendingBytes)
  installation.cancelUninstall(preparing.token)
  expect(installation.installCandidate({ ...candidate, source: 'manual' }).reused).toBe(true)
  const interrupted = new Installation({ ...options, observe(phase) {
    if (phase === 'uninstall-file-removed') throw new Error('interrupted')
  } })
  const begun = interrupted.beginUninstall(1, sessions)
  if (begun.status !== 'preparing') throw new Error('Uninstall did not begin')
  expect(interrupted.completeUninstall(begun.token, sessions, () => ({ ok: true, conflicts: [] })).status).toBe('incomplete')
  expect(() => installation.installCandidate({ ...candidate, source: 'manual' })).toThrow(/pending uninstall/)
  expect(existsSync(path.join(f.options.root, 'uninstall.json'))).toBe(true)
  expect(installation.completeUninstall(begun.token, sessions, () => ({ ok: true, conflicts: [] })).status).toBe('removed')
  expect(installation.installCandidate({ ...candidate, source: 'manual' }).reused).toBe(false)
})

it('native install reports pending uninstall before reading a candidate or starting setup', async () => {
  const f = fixture(), candidate = f.candidate('1.0.0'), build = f.installation.stage(candidate)
  f.installation.activate({ build, expectedGeneration: 0, source: 'manual', channel: 'stable' })
  f.installation.beginUninstall(1, path.join(f.root, 'no-sessions'))
  const file = path.join(f.options.root, 'uninstall.json'), before = readFileSync(file, 'utf8'), out: string[] = []
  const deps: CommandDeps = { env: { HOME: f.root }, cwd: f.root, hookAdapterHome: f.root,
    store: { load: () => null, save() {}, clear() {}, describe: () => 'fixture' },
    io: { out: line => out.push(line), err() {}, confirm: async () => false, openUrl() {} } }
  expect(await nativeInstallCommand(deps, { json: true, directory: path.join(f.root, 'missing'), inventory: path.join(f.root, 'missing.json') }, {
    installation: f.installation,
    init: () => { throw new Error('Must not initialize during uninstall') },
  })).toBe(1)
  expect(JSON.parse(out[0]!)).toMatchObject({ code: 'uninstall_pending', runtime_installed: false })
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(f.installation.inspect().active?.generation).toBe(1)
})

it('stages an explicitly requested npm migration without deleting the legacy package or claiming setup complete', async () => {
  const f = fixture(), candidate = f.candidate('1.0.0'), prefix = path.join(f.root, 'npm-prefix')
  const packageRoot = path.join(prefix, 'lib', 'node_modules', '@raidiant', 'notifai')
  const artifact = path.join(packageRoot, 'dist', 'main.js'), bin = path.join(prefix, 'bin')
  mkdirSync(path.dirname(artifact), { recursive: true }); mkdirSync(bin)
  writeFileSync(artifact, 'preserve the legacy executable')
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@raidiant/notifai', version: '0.9.0', bin: { notifai: 'dist/main.js' } }))
  symlinkSync(artifact, path.join(bin, 'notifai'))
  const inventory = path.join(candidate.directory, 'inventory.json'); writeFileSync(inventory, candidate.signedInventory)
  const out: string[] = []
  const deps: CommandDeps = { env: { HOME: f.root, PATH: bin }, cwd: f.root, hookAdapterHome: f.root, hookPlatform: 'linux',
    store: { load: () => null, save() {}, clear() {}, describe: () => 'fixture' },
    io: { out: line => out.push(line), err: line => out.push(line), confirm: async () => false, openUrl() {} } }
  const flags = { json: true, directory: candidate.directory, inventory, path: false, init: false }
  const seams = { installation: f.installation }
  expect(await nativeInstallCommand(deps, flags, seams)).toBe(1)
  expect(JSON.parse(out.pop()!)).toMatchObject({ code: 'installation_collision', runtime_installed: false })
  expect(f.installation.inspect().active).toBeNull()
  expect(await nativeInstallCommand(deps, { ...flags, migrateNpm: true }, seams)).toBe(1)
  expect(JSON.parse(out.pop()!)).toMatchObject({ code: 'migration_pending_legacy_owners', runtime_installed: true, setup_complete: false,
    migration: { prefix: canonicalPath(prefix), repair: { package_manager: 'npm', status: 'assessment_required', owner: 'agent' } } })
  expect(readFileSync(artifact, 'utf8')).toBe('preserve the legacy executable')
  // Model resolution of the separately assessed collision. This fixture does
  // not establish package replacement or authorize removing a live package.
  rmSync(path.join(bin, 'notifai')); rmSync(packageRoot, { recursive: true })
  expect(await nativeInstallCommand(deps, flags, seams)).toBe(0)
  expect(JSON.parse(out.pop()!)).toMatchObject({ code: 'installed', reused: true, setup_skipped: true })
})

it('installs over a folder an older CLI left behind, protecting it only after authenticating the candidate', () => {
  // Windows refuses an installation directory until its permissions are
  // protected. A folder from an earlier non-native CLI is not protected yet,
  // so nothing may require that before the authenticated migration step.
  const f = fixture(undefined, 'bun-windows-x64')
  mkdirSync(path.join(f.options.root, 'bin'), { recursive: true })
  writeFileSync(path.join(f.options.root, 'bin', 'hook-adapter'), 'older CLI file')
  const protectedDirectories = new Set<string>(), order: string[] = []
  const installation = new Installation({ ...f.options, access: { ...f.options.access,
    check(file: string, directory: boolean) {
      // New children inherit a protected parent's permissions, as on Windows.
      const covered = [...protectedDirectories].some(parent => file === parent || file.startsWith(parent + path.sep))
      if (directory && !covered) throw new Error(`unprotected directory checked: ${file}`)
    },
    protectExistingDirectory(file: string) { order.push(file); protectedDirectories.add(file) },
    directory(file: string) { ensurePrivateDirectory(file); protectedDirectories.add(file) },
  } })
  const candidate = f.candidate('1.0.0')
  expect(installation.inspect().uninstall_pending).toBe(false)
  expect(order).toEqual([])
  expect(installation.installCandidate({ ...candidate, source: 'powershell' })).toMatchObject({ changed: true, reused: false })
  expect(order).toEqual([f.options.root, path.join(f.options.root, 'bin')])
  expect(readFileSync(path.join(f.options.root, 'bin', 'hook-adapter'), 'utf8')).toBe('older CLI file')
})

it.each(['unknown', 'reboot'] as const)('does not let a never-admitted candidate poison later updates (%s boot)', mode => {
  const f = fixture()
  let boot: string | null = mode === 'unknown' ? null : '11111111-1111-1111-1111-111111111111'
  const installation = new Installation({ ...f.options, bootIdentity: () => boot })
  const original = f.candidate('1.0.0')
  installation.installCandidate({ ...original, source: 'shell' })
  const rejected = installation.stage(f.candidate('2.0.0', undefined, 'incompatible-state-v2'))
  expect(() => installation.activate({ build: rejected, expectedGeneration: 1, source: 'shell', channel: 'stable' })).toThrow(/continuity/)
  installation.abandonPending(1)
  if (mode === 'reboot') boot = '22222222-2222-2222-2222-222222222222'
  const compatible = installation.stage(f.candidate('3.0.0'))
  expect(installation.activate({ build: compatible, expectedGeneration: 1, source: 'shell', channel: 'stable' }).changed).toBe(true)
  expect(existsSync(path.join(f.options.root, 'versions', rejected, 'inventory.json'))).toBe(true)
  // Restaging a previously active build must never recreate the exemption.
  const old = installation.inspect().active!.previous!
  expect(installation.stage(original)).toBe(old)
  expect(existsSync(path.join(f.options.root, 'staged-runtimes', `${old}.json`))).toBe(false)
})
