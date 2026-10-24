import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { validatePublicationReceipt } from './publication-receipt.mjs'
test('publication receipt cannot cross runs, sources, versions or signed inventories', () => {
  const signedInventory = Buffer.from('signed inventory')
  const options = { version:'1.0.0-beta.1', sourceRevision:'a'.repeat(40), signedInventory, runId:'123' }
  const receipt = { schema:1, version:options.version, source_revision:options.sourceRevision, run_id:'123',
    inventory_sha256:createHash('sha256').update(signedInventory).digest('hex'), npm_tarball_sha256:'b'.repeat(64) }
  assert.equal(validatePublicationReceipt(receipt,options),receipt)
  for(const replacement of [{runId:'124'},{version:'1.0.0'},{sourceRevision:'c'.repeat(40)},{signedInventory:Buffer.from('different')}]) {
    assert.throws(()=>validatePublicationReceipt(receipt,{...options,...replacement}))
  }
})
