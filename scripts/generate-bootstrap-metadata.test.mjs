import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { test } from 'node:test'
import { Distribution, releaseSigningMessage } from '../apps/cli/dist/release-distribution.js'
import { bootstrapChannelText, bootstrapInventoryText } from './generate-bootstrap-metadata.mjs'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const distribution = new Distribution({ fixture: publicKey.export({ type: 'spki', format: 'pem' }).toString() })
const hash = data => createHash('sha256').update(data).digest('hex')
const signed = (kind, value) => {
  const payload = Buffer.from(JSON.stringify(value))
  return JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'), signature: sign(null, releaseSigningMessage(kind, payload), privateKey).toString('base64') })
}
const inventory = signed('inventory', { schema: 1, version: '1.0.0', source_revision: 'a'.repeat(40), store_schema: 1, launcher_schema: 1,
  artifacts: [{ target: 'bun-linux-x64', filename: 'notifai-1.0.0-linux-x64.tar.gz', bytes: 123, sha256: 'b'.repeat(64),
    launcher_sha256: 'c'.repeat(64), runtime_sha256: 'd'.repeat(64), materials: [] }] })
const channel = overrides => signed('channel', { schema: 1, channel: 'stable', sequence: 1, version: '1.0.0',
  inventory_sha256: hash(inventory), withdrawn_versions: ['0.9.0'], ...overrides })
test('OS bootstrap data is derived only from authenticated matching release records', () => {
  assert.equal(bootstrapInventoryText(distribution, inventory), `notifai-bootstrap-v1\t1.0.0\t${hash(inventory)}\nartifact\tbun-linux-x64\tnotifai-1.0.0-linux-x64.tar.gz\t123\t${'b'.repeat(64)}\t${'c'.repeat(64)}\t${'d'.repeat(64)}\n`)
  assert.equal(bootstrapChannelText(distribution, channel(), 'stable', inventory), `notifai-channel-v1\tstable\t1\t1.0.0\t${hash(inventory)}\nwithdrawn\t0.9.0\n`)
  assert.throws(() => bootstrapChannelText(distribution, channel({ version: '2.0.0' }), 'stable', inventory), /versions differ/)
  assert.throws(() => bootstrapChannelText(distribution, channel({ inventory_sha256: '0'.repeat(64) }), 'stable', inventory), /bytes differ/)
  assert.throws(() => bootstrapChannelText(distribution, channel({ withdrawn_versions: ['1.0.0'] }), 'stable', inventory), /withdrawn/)
  const changed = JSON.parse(inventory); changed.signature = Buffer.alloc(64).toString('base64')
  assert.throws(() => bootstrapInventoryText(distribution, JSON.stringify(changed)), /signature/)
})
