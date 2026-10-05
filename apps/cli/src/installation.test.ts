import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ensurePrivateDirectory } from './atomic-file.js'
import { Installation } from './installation.js'
import { nativeInstallCommand, nativeUpdateCommand } from './commands-native-installation.js'
import type { CommandDeps } from './commands-core.js'
import { discoverCliUpdate } from './cli-release.js'
import { Distribution, releaseSigningMessage } from './release-distribution.js'
import { RuntimeRetention } from './runtime-retention.js'
import { sessionStatePath, writeSessionState } from './hook-session-state.js'
import { canonicalPath } from './local-path.js'
import { processStartTime } from './process-identity.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(fetcher?: typeof fetch) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-installation-')); roots.push(root)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const distribution = new Distribution({ fixture: publicKey.export({ format: 'pem', type: 'spki' }).toString() }, fetcher)
  const target = 'bun-linux-x64' as const
  const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const candidate = (version: string, archive?: Buffer) => {
    const directory = path.join(root, version); mkdirSync(directory)
    const runtime = `runtime ${version}`, launcher = 'launcher v1'
    writeFileSync(path.join(directory, 'notifai-runtime'), runtime)
    writeFileSync(path.join(directory, 'notifai'), launcher)
    const payload = Buffer.from(JSON.stringify({ schema: 1, version, source_revision: 'a'.repeat(40),
      store_schema: 1, launcher_schema: 1, artifacts: [{ target, filename: `notifai-${version}-linux-x64.tar.gz`,
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
  expect(retention.inspectOwners(current)).toEqual({ status: 'clear', sessions: [{ file: canonicalPath(file), sessionId: session, builds: [build] }] })
  // An unindexed sibling can have pending work from before native migration.
  writeSessionState('legacy-sibling', env, { acknowledgement_due: [{ request_id: 'req_pending', recorded_at: 1 }] })
  expect(retention.inspectOwners(current).status).toBe('waiting_for_questions')
  writeSessionState('legacy-sibling', env, {})
  expect(retention.inspectOwners(current).status).toBe('clear')
  writeFileSync(file, '{broken')
  expect(retention.inspectOwners(current).status).toBe('uncertain')
  expect(f.installation.activeRelease().build).toBe(build)
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
    pendingWork: () => null,
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
  const discovery = await discoverCliUpdate({ env: {}, installation: f.installation })
  expect(discovery).toMatchObject({ channel: 'beta', target: '1.0.0-beta.2', newer: '1.0.0-beta.2', available: true, error: null })
  expect(f.installation.inspect().active?.generation).toBe(1)
  const out: string[] = []
  const deps: CommandDeps = { env: { HOME: f.root }, cwd: f.root,
    store: { load: () => null, save() {}, clear() {}, describe: () => 'fixture' },
    io: { out: line => out.push(line), err: line => out.push(line), confirm: async () => false, openUrl() {} } }
  expect(await nativeUpdateCommand(deps, { json: true }, { installation: f.installation, pendingWork: () => null,
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
  const seams = { installation: f.installation, pendingWork: () => null,
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

it('native installer refuses pending work before installation and preserves an activated runtime when setup fails', async () => {
  const f = fixture(), candidate = f.candidate('1.0.0')
  const inventory = path.join(candidate.directory, 'inventory.json'); writeFileSync(inventory, candidate.signedInventory)
  const out: string[] = []
  const deps: CommandDeps = { env: {}, cwd: f.root,
    store: { load: () => null, save() {}, clear() {}, describe: () => 'fixture' },
    io: { out: line => out.push(line), err: line => out.push(line), confirm: async () => false, openUrl() {} } }
  const flags = { directory: candidate.directory, inventory, path: false, json: true }
  expect(await nativeInstallCommand(deps, flags, { installation: f.installation, pendingWork: () => 'A question is pending' })).toBe(1)
  expect(f.installation.inspect().active).toBeNull()
  out.length = 0
  expect(await nativeInstallCommand(deps, flags, { installation: f.installation, pendingWork: () => null,
    init: () => { throw new Error('interrupted setup') } })).toBe(1)
  expect(JSON.parse(out[0]!)).toMatchObject({ runtime_installed: true, setup_complete: false })
  expect(f.installation.activeRelease().version).toBe('1.0.0')
})
