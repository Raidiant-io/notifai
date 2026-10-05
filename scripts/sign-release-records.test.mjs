import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { Distribution, RELEASE_TARGETS } from '../apps/cli/dist/release-distribution.js'
import { signReleaseInventory, signReleaseChannel } from './sign-release-records.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const trustedKeys = { fixture: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
const signing = { keyId: 'fixture', privateKey, trustedKeys }
const distribution = new Distribution(trustedKeys)
const material = { path: 'licenses/NOTICE.txt', bytes: 7, sha256: hash('fixture') }
function candidates(version = '1.0.0') {
  return RELEASE_TARGETS.map(target => ({ schema: 1,
    build: { version, sourceRevision: 'a'.repeat(40), sourceDirty: false, sourceDigest: 'b'.repeat(64), target, runtime: 'bun-1.4.2' },
    artifact: { target, filename: `notifai-${version}-${target.slice(4)}.${target.includes('windows') ? 'zip' : 'tar.gz'}`,
      bytes: 100, sha256: hash(target), runtime_sha256: 'c'.repeat(64), launcher_sha256: 'd'.repeat(64), materials: [material] },
    check_sha256: 'e'.repeat(64),
  }))
}
const policy = { schema: 1, status: 'approved', runtime: 'bun-1.4.2',
  targets: Object.fromEntries(RELEASE_TARGETS.map(target => [target, [material]])) }
function inventory(version = '1.0.0', changes = {}) {
  return signReleaseInventory({ ...signing, version, sourceRevision: 'a'.repeat(40), candidates: candidates(version), materialsPolicy: policy, ...changes })
}
test('complete matching release records round-trip through the shipped verifier; publication material is mandatory', () => {
  const signed = inventory()
  assert.equal(distribution.verifyInventory(signed).artifacts.length, 6)
  assert.equal(inventory(), signed, 'Retries must produce exactly the same signed inventory')
  const missing = candidates().slice(1)
  assert.throws(() => inventory('1.0.0', { candidates: missing }), /target/)
  const mixed = candidates(); mixed[1].build.sourceRevision = 'f'.repeat(40)
  assert.throws(() => inventory('1.0.0', { candidates: mixed }), /source/)
  const differentTree = candidates(); differentTree[1].build.sourceDigest = 'f'.repeat(64)
  assert.throws(() => inventory('1.0.0', { candidates: differentTree }), /source/)
  assert.throws(() => inventory('1.0.0', { materialsPolicy: { ...policy, status: 'pending' } }), /materials/)
  const changedMaterial = candidates(); changedMaterial[0].artifact.materials[0] = { ...material, sha256: 'f'.repeat(64) }
  assert.throws(() => inventory('1.0.0', { candidates: changedMaterial }), /materials/)
  assert.throws(() => inventory('1.0.0', { privateKey: generateKeyPairSync('ed25519').privateKey }), /key/)
})
test('channel retries preserve signed bytes; promotions retain withdrawals and monotonic sequence', () => {
  const first = signReleaseChannel({ ...signing, channel: 'stable', signedInventory: inventory(), previous: null })
  assert.equal(distribution.verifyChannel(first, 'stable').sequence, 1)
  assert.equal(signReleaseChannel({ ...signing, channel: 'stable', signedInventory: inventory(), previous: first }), first)
  const withdrawn = signReleaseChannel({ ...signing, channel: 'stable', signedInventory: inventory('2.0.0'), previous: first, withdraw: ['1.0.0'] })
  assert.deepEqual(distribution.verifyChannel(withdrawn, 'stable').withdrawn_versions, ['1.0.0'])
  assert.equal(distribution.verifyChannel(withdrawn, 'stable').sequence, 2)
  const next = signReleaseChannel({ ...signing, channel: 'stable', signedInventory: inventory('3.0.0'), previous: withdrawn })
  assert.deepEqual(distribution.verifyChannel(next, 'stable').withdrawn_versions, ['1.0.0'])
  assert.throws(() => signReleaseChannel({ ...signing, channel: 'stable', signedInventory: inventory(), previous: next }), /withdrawn/)
  assert.throws(() => signReleaseChannel({ ...signing, channel: 'stable', signedInventory: inventory('2.0.0'), previous: next }), /rollback/)
  const rollback = signReleaseChannel({ ...signing, channel: 'stable', signedInventory: inventory('2.0.0'), previous: next, allowRollback: true })
  assert.equal(distribution.verifyChannel(rollback, 'stable').sequence, 4)
  assert.throws(() => signReleaseChannel({ ...signing, channel: 'stable', signedInventory: inventory('4.0.0-beta.1'), previous: next }), /Prerelease/)
  assert.throws(() => signReleaseChannel({ ...signing, channel: 'beta', signedInventory: inventory(), previous: next }), /channel/)
})
