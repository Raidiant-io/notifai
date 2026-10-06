#!/usr/bin/env node
// Data-only views of the signed authority for OS shells without a JSON runtime.
// First execution trusts HTTPS; these views do not pretend to be signatures.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { Distribution } from '../apps/cli/dist/release-distribution.js'
import { RELEASE_PUBLIC_KEYS } from '../apps/cli/dist/release-trust.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function bootstrapInventoryText(distribution, signedInventory) {
  const inventory = distribution.verifyInventory(signedInventory)
  return [`notifai-bootstrap-v1\t${inventory.version}\t${hash(signedInventory)}`,
    ...inventory.artifacts.map(artifact => ['artifact', artifact.target, artifact.filename, artifact.bytes,
      artifact.sha256, artifact.launcher_sha256, artifact.runtime_sha256].join('\t')),
  ].join('\n') + '\n'
}
export function bootstrapChannelText(distribution, signedChannel, channel, signedInventory) {
  const record = distribution.verifyChannel(signedChannel, channel)
  const inventory = distribution.verifyInventory(signedInventory)
  assert.equal(inventory.version, record.version, 'Channel and inventory versions differ')
  assert.equal(hash(signedInventory), record.inventory_sha256, 'Channel and inventory bytes differ')
  assert.ok(!record.withdrawn_versions.includes(record.version), 'Cannot recommend a withdrawn release')
  return [`notifai-channel-v1\t${record.channel}\t${record.sequence}\t${record.version}\t${record.inventory_sha256}`,
    ...record.withdrawn_versions.map(version => `withdrawn\t${version}`),
  ].join('\n') + '\n'
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { inventory: { type: 'string' }, output: { type: 'string' },
    'channel-file': { type: 'string' }, channel: { type: 'string' } } })
  assert.ok(values.inventory && values.output, '--inventory and --output are required')
  assert.equal(Boolean(values['channel-file']), Boolean(values.channel), 'Channel inputs must be supplied together')
  assert.ok(Object.keys(RELEASE_PUBLIC_KEYS).length, 'Release trust root is not configured')
  const bounded = file => { const stat = lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256 * 1024, 'Metadata must be a bounded regular file'); return readFileSync(file, 'utf8') }
  const distribution = new Distribution(RELEASE_PUBLIC_KEYS), inventory = bounded(values.inventory)
  const text = values.channel ? bootstrapChannelText(distribution, bounded(values['channel-file']), values.channel, inventory)
    : bootstrapInventoryText(distribution, inventory)
  writeFileSync(values.output, text, { flag: 'wx', mode: 0o600 })
}
