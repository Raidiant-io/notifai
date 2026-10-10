#!/usr/bin/env node
// Read-only admission for a retained production-signed release bundle.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Distribution } from '../apps/cli/dist/release-distribution.js'
import { RELEASE_PUBLIC_KEYS } from '../apps/cli/dist/release-trust.js'
import { nativeReleaseBundle } from './publish-native-assets.mjs'

const [directory, sourceRevision] = process.argv.slice(2)
assert.ok(directory && /^[a-f0-9]{40}$/.test(sourceRevision ?? ''), 'Supply the retained bundle and exact source SHA')
const bundle = nativeReleaseBundle(directory, new Distribution(RELEASE_PUBLIC_KEYS), sourceRevision)
const source = JSON.parse(readFileSync(new URL('../apps/cli/package.json', import.meta.url), 'utf8'))
assert.equal(bundle.inventory.version, source.version, 'Retained bundle version differs from current source')
console.log(JSON.stringify({ ok: true, version: bundle.inventory.version, source_revision: sourceRevision,
  inventory_sha256: createHash('sha256').update(bundle.signedInventory).digest('hex') }))
