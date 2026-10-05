import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Installation } from './installation.js'
import { Distribution, releaseSigningMessage } from './release-distribution.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(fetcher?: typeof fetch) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-installation-')); roots.push(root)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const distribution = new Distribution({ fixture: publicKey.export({ format: 'pem', type: 'spki' }).toString() }, fetcher)
  const target = 'bun-linux-x64' as const
  const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
  const candidate = (version: string) => {
    const directory = path.join(root, version); mkdirSync(directory)
    const runtime = `runtime ${version}`, launcher = 'launcher v1'
    writeFileSync(path.join(directory, 'notifai-runtime'), runtime)
    writeFileSync(path.join(directory, 'notifai'), launcher)
    const payload = Buffer.from(JSON.stringify({ schema: 1, version, source_revision: 'a'.repeat(40),
      store_schema: 1, launcher_schema: 1, artifacts: [{ target, filename: `notifai-${version}-linux-x64.tar.gz`,
        bytes: 100, sha256: digest(version), runtime_sha256: digest(runtime), materials: [], launcher_sha256: digest(launcher) }] }))
    const signedInventory = JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
      signature: sign(null, releaseSigningMessage('inventory', payload), privateKey).toString('base64') })
    return { directory, signedInventory }
  }
  const options = { root: path.join(root, 'managed'), target, distribution, probe: () => {} }
  const channel = (sequence: number, withdrawn: string[] = [], inventory = 'unavailable-inventory', version = '2.0.0') => {
    const payload = Buffer.from(JSON.stringify({ schema: 1, channel: 'stable', sequence, version,
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
