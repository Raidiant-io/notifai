// Release-authority operations only. These helpers never fetch a key, publish
// an asset, or advance a ref. Provider mutation must use their exact output.
import assert from 'node:assert/strict'
import { createHash, createPublicKey, sign } from 'node:crypto'
import { Distribution, RELEASE_TARGETS, releaseSigningMessage } from '../apps/cli/dist/release-distribution.js'
import { compareReleasePrecedence } from '../apps/cli/dist/version.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function signer({ keyId, privateKey, trustedKeys }) {
  assert.ok(typeof keyId === 'string' && Object.hasOwn(trustedKeys, keyId), 'Signing key is not an embedded trusted key')
  assert.equal(privateKey.asymmetricKeyType, 'ed25519', 'Signing key must be Ed25519')
  const expected = createPublicKey(trustedKeys[keyId])
  assert.deepEqual(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }), expected.export({ format: 'der', type: 'spki' }),
    'Signing key differs from the embedded public key')
  return (kind, value) => {
    const payload = Buffer.from(JSON.stringify(value))
    return JSON.stringify({ key_id: keyId, payload: payload.toString('base64'),
      signature: sign(null, releaseSigningMessage(kind, payload), privateKey).toString('base64') }) + '\n'
  }
}
function sortedMaterials(materials) {
  assert.ok(Array.isArray(materials), 'Release materials are missing')
  return [...materials].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

/** The caller must also authenticate artifact transport, verify receipts and
 * extract every archive against this inventory before any output is published. */
export function signReleaseInventory({ version, sourceRevision, candidates, materialsPolicy, ...signing }) {
  assert.ok(/^[a-f0-9]{40}$/.test(sourceRevision), 'Exact source revision is required')
  assert.ok(materialsPolicy?.schema === 1 && materialsPolicy.status === 'approved' && materialsPolicy.runtime === 'bun-1.4.2',
    'Publication materials require an approved pinned policy')
  assert.ok(Array.isArray(candidates) && candidates.length === RELEASE_TARGETS.length, 'Every native release target is required')
  assert.deepEqual(Object.keys(materialsPolicy.targets ?? {}).sort(), [...RELEASE_TARGETS].sort(), 'Publication materials must cover every target')
  const byTarget = new Map()
  let sourceDigest
  for (const candidate of candidates) {
    const { build, artifact } = candidate
    assert.ok(candidate.schema === 1 && build && artifact && RELEASE_TARGETS.includes(build.target) &&
      artifact.target === build.target && !byTarget.has(build.target), 'Invalid or repeated release target')
    assert.ok(build.version === version && build.sourceRevision === sourceRevision && build.sourceDirty === false &&
      build.runtime === materialsPolicy.runtime && /^[a-f0-9]{64}$/.test(build.sourceDigest), 'Candidate source identity differs')
    sourceDigest ??= build.sourceDigest
    assert.equal(build.sourceDigest, sourceDigest, 'Candidate source trees differ')
    assert.ok(/^[a-f0-9]{64}$/.test(candidate.check_sha256), 'Candidate executable check identity is missing')
    const materials = sortedMaterials(artifact.materials)
    assert.ok(materials.length > 0 && !materials.some(item => item.path === 'CANDIDATE-MATERIALS.txt'), 'Candidate materials cannot be published')
    assert.deepEqual(materials, sortedMaterials(materialsPolicy.targets[build.target]), 'Candidate materials differ from reviewed publication materials')
    byTarget.set(build.target, { ...artifact, materials })
  }
  const bytes = signer(signing)('inventory', { schema: 1, version, source_revision: sourceRevision,
    store_schema: 1, launcher_schema: 1, artifacts: RELEASE_TARGETS.map(target => byTarget.get(target)) })
  new Distribution(signing.trustedKeys).verifyInventory(bytes)
  return bytes
}

/** A channel's previous signed record is the sequence/withdrawal authority.
 * The provider writer must compare-and-swap the metadata ref it read. */
export function signReleaseChannel({ channel, signedInventory, previous, withdraw = [], allowRollback = false, ...signing }) {
  const distribution = new Distribution(signing.trustedKeys)
  const inventory = distribution.verifyInventory(signedInventory)
  const before = previous === null ? null : distribution.verifyChannel(previous, channel)
  assert.ok(Array.isArray(withdraw), 'Withdrawals must be explicit version data')
  const withdrawn = [...new Set([...(before?.withdrawn_versions ?? []), ...withdraw])].sort()
  assert.ok(!withdrawn.includes(inventory.version), 'Cannot recommend a withdrawn release')
  if (before && compareReleasePrecedence(inventory.version, before.version) === 'before') {
    assert.ok(allowRollback, 'A channel rollback requires explicit authorization')
  }
  const inventoryHash = hash(signedInventory)
  if (before && before.version === inventory.version && before.inventory_sha256 === inventoryHash &&
      JSON.stringify([...before.withdrawn_versions].sort()) === JSON.stringify(withdrawn)) return previous
  if (before && before.version === inventory.version) {
    assert.equal(before.inventory_sha256, inventoryHash, 'A published version cannot change its signed inventory')
  }
  const bytes = signer(signing)('channel', { schema: 1, channel, sequence: (before?.sequence ?? 0) + 1,
    version: inventory.version, inventory_sha256: inventoryHash, withdrawn_versions: withdrawn })
  distribution.verifyChannel(bytes, channel, before ? { sequence: before.sequence, digest: hash(previous) } : undefined)
  return bytes
}
