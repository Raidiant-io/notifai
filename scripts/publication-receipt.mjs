#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyPackedAdapter } from './verify-packed-npm-adapter.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

// Accepted only inside this execution graph, after its npm verification and six
// installation jobs. Cross-run reuse requires separate authenticated admission.
export function validatePublicationReceipt(receipt, { version, sourceRevision, signedInventory, runId = process.env.GITHUB_RUN_ID }) {
  assert.equal(receipt.schema, 1)
  assert.equal(receipt.run_id, runId, 'Publication receipt belongs to another run')
  assert.equal(receipt.version, version)
  assert.equal(receipt.source_revision, sourceRevision)
  assert.equal(receipt.inventory_sha256, hash(signedInventory))
  assert.match(receipt.npm_tarball_sha256, /^[a-f0-9]{64}$/)
  return receipt
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [tarball, output] = process.argv.slice(2)
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.GITHUB_REPOSITORY, 'Raidiant-io/notifai')
  const { version } = JSON.parse(readFileSync('apps/cli/package.json', 'utf8'))
  const sourceRevision = process.env.GITHUB_SHA
  const { signedInventory } = verifyPackedAdapter({ tarball, sourceRevision, version })
  const receipt = { schema: 1, run_id: process.env.GITHUB_RUN_ID, version, source_revision: sourceRevision,
    inventory_sha256: hash(signedInventory), npm_tarball_sha256: hash(readFileSync(tarball)) }
  validatePublicationReceipt(receipt, { version, sourceRevision, signedInventory })
  writeFileSync(output, JSON.stringify(receipt) + '\n')
}
