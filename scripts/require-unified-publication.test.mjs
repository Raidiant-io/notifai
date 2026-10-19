import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { requireReleasePair, requireNpmDiscovery } from './require-unified-publication.mjs'
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

test('native promotion admission requires current npm beta discovery for both packages', () => {
  const candidate = { version: '13.0.0', cliTags: { latest: '13.0.0' }, protocolTags: { latest: '8.4.0', beta: '8.4.0' } }
  requireNpmDiscovery(candidate)
  assert.throws(() => requireNpmDiscovery({ ...candidate, cliTags: { latest: '13.0.0', beta: '13.0.0-beta.1' } }), /beta is behind latest/)
  assert.throws(() => requireNpmDiscovery({ ...candidate, protocolTags: { latest: '8.4.0', beta: '8.2.1-beta.2' } }), /beta is behind latest/)
  assert.throws(() => requireNpmDiscovery({ ...candidate, cliTags: { latest: '12.0.0' } }), /Promote npm discovery/)
})
