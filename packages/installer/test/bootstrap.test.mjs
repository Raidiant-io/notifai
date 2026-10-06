import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { pack } from 'tar-stream'
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js'
import { Distribution, releaseSigningMessage } from '../dist/shared/release-distribution.js'
import { installStandalone } from '../dist/bootstrap.mjs'
import { ownedPosixCommand } from '../dist/platform.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
async function fixture(t, extra = false, target = 'bun-linux-x64') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-npm-fixture-')), temporary = path.join(root, 'temporary')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const writer = pack(), chunks = [], reading = (async () => { for await (const chunk of writer) chunks.push(chunk) })()
  const extension = target.includes('windows') ? '.exe' : ''
  const files = { [`notifai${extension}`]: 'launcher', [`notifai-runtime${extension}`]: 'runtime', 'NOTICE.txt': 'notice', ...(extra ? { unexpected: 'not admitted' } : {}) }
  for (const [name, contents] of Object.entries(files)) await new Promise((resolve, reject) => writer.entry({ name, size: contents.length, type: 'file' }, contents, error => error ? reject(error) : resolve()))
  writer.finalize(); await reading
  let archive = gzipSync(Buffer.concat(chunks))
  if (extension) {
    const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
    for (const [name, contents] of Object.entries(files)) await zip.add(name, new Uint8ArrayReader(Buffer.from(contents)))
    archive = Buffer.from(await zip.close())
  }
  const artifact = { target, filename: `notifai-1.2.3-${target.slice(4)}.${extension ? 'zip' : 'tar.gz'}`, bytes: archive.length, sha256: hash(archive),
    launcher_sha256: hash('launcher'), runtime_sha256: hash('runtime'), materials: [{ path: 'NOTICE.txt', bytes: 6, sha256: hash('notice') }] }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const envelope = (kind, value) => {
    const payload = Buffer.from(JSON.stringify(value))
    return JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'), signature: sign(null, releaseSigningMessage(kind, payload), privateKey).toString('base64') })
  }
  const inventory = envelope('inventory', { schema: 1, version: '1.2.3', source_revision: 'a'.repeat(40), store_schema: 1, launcher_schema: 1, artifacts: [artifact] })
  const channel = envelope('channel', { schema: 1, channel: 'stable', sequence: 1, version: '1.2.3', inventory_sha256: hash(inventory), withdrawn_versions: [] })
  let changedArchive = false, changedChannel = false
  const calls = []
  const distribution = new Distribution({ fixture: publicKey.export({ type: 'spki', format: 'pem' }).toString() }, async url => {
    calls.push(String(url))
    if (String(url).endsWith('stable.json')) return new Response(changedChannel ? channel.replace('fixture', 'untrusted') : channel)
    if (String(url).endsWith('inventory.json')) return new Response(inventory)
    return new Response(changedArchive ? Buffer.from('tampered') : archive)
  })
  const executions = [], platform = {
    existingCommand: () => null, target: () => target,
    temporaryDirectory: () => { mkdirSync(temporary, { mode: 0o700 }); return temporary },
    checkPublisher: directory => { assert.equal(readFileSync(path.join(directory, `notifai${extension}`), 'utf8'), 'launcher') },
    execute: (file, args) => { assert.equal(readFileSync(path.join(path.dirname(file), 'inventory.json'), 'utf8'), inventory); executions.push({ file, args }); return 7 },
  }
  return { root, temporary, distribution: () => distribution, platform, calls, executions, tamperArchive: () => { changedArchive = true }, tamperChannel: () => { changedChannel = true } }
}

for (const target of ['bun-linux-x64', 'bun-windows-arm64']) test(`signed ${target} installation delegates exact flags and cleans temporary bytes`, async t => {
  const f = await fixture(t, false, target)
  assert.equal(await installStandalone({ json: true, version: '1.2.3', channel: 'stable', 'no-init': true, 'no-path': true, 'migrate-npm': true }, f), 7)
  assert.deepEqual(f.executions[0].args, ['install', '--source', 'npm', '--json', '--version', '1.2.3', '--channel', 'stable', '--no-init', '--no-path', '--migrate-npm'])
  assert.equal(f.calls.length, 3)
  assert.equal(existsSync(f.temporary), false)
})
test('signature, archive and extracted-member failures cannot execute a candidate', async t => {
  for (const type of ['signature', 'archive', 'member']) {
    const f = await fixture(t, type === 'member')
    if (type === 'signature') f.tamperChannel()
    if (type === 'archive') f.tamperArchive()
    await assert.rejects(installStandalone({}, f))
    assert.equal(f.executions.length, 0)
    assert.equal(existsSync(f.temporary), false)
  }
})
test('rerunning another bootstrap reuses only the fixed owned command without discovery', async () => {
  let called = false
  const unexpected = () => { throw new Error('Existing installation must not discover, stage or change runtime') }
  const platform = { existingCommand: () => '/owned/notifai', target: unexpected, temporaryDirectory: unexpected, checkPublisher: unexpected,
    execute: (file, args) => { called = true; assert.equal(file, '/owned/notifai'); assert.deepEqual(args, ['install', '--source', 'npm']); return 0 } }
  assert.equal(await installStandalone({}, { platform, distribution: unexpected }), 0)
  assert.ok(called)
  platform.existingCommand = () => { throw new Error('Unowned launcher') }
  await assert.rejects(installStandalone({}, { platform, distribution: {} }), /Unowned launcher/)
})
test('POSIX reuse rejects another writable principal or linked command', { skip: process.platform === 'win32' }, t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-npm-owner-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  assert.equal(ownedPosixCommand(home), null)
  const bin = path.join(home, '.notifai/bin'), file = path.join(bin, 'notifai')
  mkdirSync(bin, { recursive: true, mode: 0o700 }); writeFileSync(file, 'fixture', { mode: 0o700 })
  assert.equal(ownedPosixCommand(home), file)
  chmodSync(bin, 0o770)
  assert.throws(() => ownedPosixCommand(home), /not privately owned/)
  chmodSync(bin, 0o700); rmSync(file); symlinkSync('/bin/sh', file)
  assert.throws(() => ownedPosixCommand(home), /not privately owned/)
})
