import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { requireReleasePair } from './require-unified-publication.mjs'
const signedInventory = 'exact authenticated envelope bytes'
const version = '12.0.0-beta.1', sourceRevision = 'a'.repeat(40)
const native = { version, source_revision: sourceRevision, inventory_sha256: createHash('sha256').update(signedInventory).digest('hex') }
const adapter = { signedInventory, manifest: { adapter_version: version, native: { source_revision: sourceRevision } } }
test('release promotion binds both sources and the exact signed inventory, not just version strings', () => {
  requireReleasePair({ version, sourceRevision, native, adapter })
  for (const changed of [{ ...adapter, signedInventory: signedInventory + '\n' },
    { ...adapter, manifest: { ...adapter.manifest, native: { source_revision: 'b'.repeat(40) } } }]) {
    assert.throws(() => requireReleasePair({ version, sourceRevision, native, adapter: changed }))
  }
  assert.throws(() => requireReleasePair({ version, sourceRevision, native: { ...native, source_revision: 'b'.repeat(40) }, adapter }))
})
