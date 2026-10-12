#!/usr/bin/env node
// Read-only admission before either discovery pointer changes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from './cross-platform.mjs'
import { verifyPackedAdapter } from './verify-packed-npm-adapter.mjs'
import { verifyNativePublication } from './verify-native-publication.mjs'
import { registryDistTags } from './verify-npm-distribution.mjs'
import { publicationLane } from './publication-lane.mjs'

export function requireReleasePair({ version, sourceRevision, native, adapter }) {
  assert.equal(native.version, version, 'Native publication version differs')
  assert.equal(native.source_revision, sourceRevision, 'Native publication source differs')
  assert.equal(adapter.manifest.adapter_version, version, 'npm adapter version differs')
  assert.equal(adapter.manifest.native.source_revision, sourceRevision, 'npm adapter source differs')
  assert.equal(createHash('sha256').update(adapter.signedInventory).digest('hex'), native.inventory_sha256,
    'npm and native distribution authenticate different inventories')
}
export async function requireUnifiedPublication({ version, sourceRevision, requireNpmPointer = false }) {
  const runCommand = (file, args) => execFileSync(file, args, { cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000 })
  const native = verifyNativePublication({ version, tagSha: sourceRevision, requireChannel: false, runCommand })
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-unified-admission-'))
  try {
    const tarball = path.join(root, 'registry.tgz')
    runCommand(process.execPath, ['scripts/verify-published.mjs', '@raidiant/notifai', '--expected-sha', sourceRevision,
      '--artifact-output', tarball])
    const adapter = verifyPackedAdapter({ tarball, sourceRevision, version })
    requireReleasePair({ version, sourceRevision, native, adapter })
    if (requireNpmPointer) assert.equal((await registryDistTags('@raidiant/notifai'))[publicationLane(version)], version,
      'Promote npm discovery before native discovery')
    return { version, source_revision: sourceRevision, inventory_sha256: native.inventory_sha256,
      npm_tarball_sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') }
  } finally { rmSync(root, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [version, sourceRevision, pointer] = process.argv.slice(2)
  console.log(JSON.stringify(await requireUnifiedPublication({ version, sourceRevision, requireNpmPointer: pointer === '--require-npm-pointer' })))
}
