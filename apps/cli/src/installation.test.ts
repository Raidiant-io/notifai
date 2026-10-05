import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ensurePrivateDirectory } from './atomic-file.js'
import { Installation } from './installation.js'
import { nativeUpdateCommand } from './commands-native-installation.js'
import type { CommandDeps } from './commands-core.js'
import { discoverCliUpdate } from './cli-release.js'
import { Distribution, releaseSigningMessage } from './release-distribution.js'

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
  const options = { root: path.join(root, 'managed'), target, distribution, access: { check() {}, directory: ensurePrivateDirectory, beforePublish() {} }, probe: () => {} }
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
