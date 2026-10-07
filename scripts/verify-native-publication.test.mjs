import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { test } from 'node:test'
import { RELEASE_TARGETS, releaseSigningMessage } from '../apps/cli/dist/release-distribution.js'
import { verifyNativePublication } from './verify-native-publication.mjs'

const version = '11.8.0-beta.4'
const tagSha = 'a'.repeat(40)
const hash = value => createHash('sha256').update(value).digest('hex')

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const keys = { fixture: publicKey.export({ type: 'spki', format: 'pem' }) }
  const signed = (kind, value) => {
    const payload = Buffer.from(JSON.stringify(value))
    return JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
      signature: sign(null, releaseSigningMessage(kind, payload), privateKey).toString('base64') }) + '\n'
  }
  const inventory = { schema: 1, version, source_revision: tagSha, store_schema: 1, launcher_schema: 1,
    artifacts: RELEASE_TARGETS.map(target => ({ target,
      filename: `notifai-${version}-${target.slice(4)}.${target.includes('windows') ? 'zip' : 'tar.gz'}`,
      bytes: 10, sha256: 'b'.repeat(64), runtime_sha256: 'c'.repeat(64), launcher_sha256: 'd'.repeat(64), materials: [] })) }
  let inventoryBytes = signed('inventory', inventory)
  const channel = { schema: 1, channel: 'beta', sequence: 3, version,
    inventory_sha256: hash(inventoryBytes), withdrawn_versions: [] }
  const release = { tag_name: `v${version}`, immutable: true, draft: false, prerelease: true,
    assets: [{ name: 'inventory.json', state: 'uploaded', digest: `sha256:${hash(inventoryBytes)}`, size: Buffer.byteLength(inventoryBytes) },
      ...inventory.artifacts.map(artifact => ({ name: artifact.filename, state: 'uploaded', digest: `sha256:${artifact.sha256}`, size: artifact.bytes }))] }
  const state = { channelBytes: null, stable: null, remoteSha: tagSha }
  const runCommand = (binary, args) => {
    assert.equal(binary, 'gh')
    if (args[0] === 'release') return inventoryBytes
    const endpoint = args[1].replace('repos/Raidiant-io/notifai/', '')
    if (endpoint.startsWith('releases/')) return JSON.stringify(release)
    if (endpoint.startsWith('git/ref/')) return JSON.stringify({ object: { type: 'commit', sha: state.remoteSha } })
    if (endpoint === 'contents?ref=release-metadata') return JSON.stringify(state.stable ? [{ name: 'stable.json' }] : [])
    if (endpoint === 'contents/beta.json?ref=release-metadata') return JSON.stringify({ content: Buffer.from(state.channelBytes ?? signed('channel', channel)).toString('base64') })
    if (endpoint === 'contents/stable.json?ref=release-metadata') return JSON.stringify({ content: Buffer.from(signed('channel', state.stable)).toString('base64') })
    throw new Error(`Unexpected endpoint ${endpoint}`)
  }
  return { release, channel, state, inventory, signed,
    setInventory: bytes => { inventoryBytes = bytes },
    verify: (options = {}) => verifyNativePublication({ version, tagSha, runCommand, keys, ...options }) }
}

test('native publication admits all signed targets and exact asset bytes without npm', () => {
  const f = fixture()
  assert.equal(f.verify().distribution, 'native')
  assert.equal(f.verify().inventory_sha256, f.channel.inventory_sha256)
})

test('native publication refuses unpublished, mutable or wrong-channel releases', () => {
  for (const change of [{ draft: true }, { immutable: false }, { prerelease: false }]) {
    const f = fixture(); Object.assign(f.release, change)
    assert.throws(f.verify, /immutable, published/u)
  }
})

test('native publication binds remote tag, channel signature and inventory bytes', () => {
  const tag = fixture(); tag.state.remoteSha = 'f'.repeat(40)
  assert.throws(tag.verify, /remote tag/u)
  const signature = fixture(); const envelope = JSON.parse(signature.signed('channel', signature.channel))
  envelope.signature = Buffer.alloc(64).toString('base64'); signature.state.channelBytes = JSON.stringify(envelope)
  assert.throws(signature.verify, /signature/u)
  const inventory = fixture(); inventory.setInventory(inventory.signed('inventory', inventory.inventory).trim())
  assert.throws(inventory.verify, /inventory does not match/u)
})

test('native publication refuses missing, duplicate and changed archives', () => {
  for (const mutate of [assets => assets.pop(), assets => assets.push(assets[1]),
    assets => { assets[1].digest = `sha256:${'e'.repeat(64)}` }, assets => { assets[1].size++ }]) {
    const f = fixture(); mutate(f.release.assets)
    assert.throws(f.verify, /asset does not match/u)
  }
})

test('native publication refuses withdrawn and superseded betas', () => {
  const newer = fixture(); newer.channel.version = '11.8.0-beta.5'
  assert.throws(newer.verify, /superseded or withdrawn/u)
  const withdrawn = fixture(); withdrawn.channel.withdrawn_versions.push(version)
  assert.throws(withdrawn.verify, /superseded or withdrawn/u)
  const stable = fixture(); stable.state.stable = { ...stable.channel, channel: 'stable', version: '11.8.0' }
  assert.throws(stable.verify, /superseded by the signed stable/u)
})

test('historical native entries may be superseded but still require signatures and assets', () => {
  const f = fixture(); f.channel.version = '11.8.0-beta.5'
  assert.equal(f.verify({ requireCurrent: false }).distribution, 'native')
  f.release.assets.pop()
  assert.throws(() => f.verify({ requireCurrent: false }), /asset does not match/u)
  const withdrawn = fixture(); withdrawn.channel.withdrawn_versions.push(version)
  assert.throws(() => withdrawn.verify({ requireCurrent: false }), /withdrawn/u)
})
