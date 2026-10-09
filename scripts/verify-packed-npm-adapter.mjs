#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertPackedTarballs } from './check-packed-boundary.mjs'
import { Distribution } from '../apps/cli/dist/release-distribution.js'
import { RELEASE_PUBLIC_KEYS } from '../apps/cli/dist/release-trust.js'
import { installationAccess } from '../apps/cli/dist/installation-access.js'
import { repositoryRoot } from './cross-platform.mjs'
import { verifyNpmAdapterArtifact, npmAdapterPosixAccess } from '../apps/cli/dist/npm-adapter-verification.js'

export function releaseAdapterAccess(scratch) {
  if (process.platform !== 'win32') return npmAdapterPosixAccess
  // Build the existing OS ownership helper from the reviewed candidate source;
  // never treat POSIX stat bits as Windows ACL evidence.
  const output = path.join(scratch, 'access-helper')
  execFileSync(process.execPath, ['scripts/build-launcher.mjs', output], { cwd: repositoryRoot, timeout: 120_000 })
  return installationAccess(path.join(output, 'notifai.exe')).check
}
export function verifyPackedAdapter({ tarball, sourceRevision, version, keys = RELEASE_PUBLIC_KEYS, checkAccess }) {
  assert.ok(tarball && /^[a-f0-9]{40}$/.test(sourceRevision), 'Exact tarball and source SHA are required')
  assertPackedTarballs({ tarballs: [path.resolve(tarball)] })
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'notifai-packed-adapter-'))
  try {
    execFileSync('tar', ['xzf', path.resolve(tarball)], { cwd: scratch, timeout: 30_000 })
    const verified = verifyNpmAdapterArtifact(path.join(scratch, 'package'), new Distribution(keys), checkAccess ?? releaseAdapterAccess(scratch))
    assert.equal(verified.manifest.native.source_revision, sourceRevision, 'Packed native source identity differs')
    assert.equal(verified.manifest.adapter_version, version, 'Packed native version differs')
    return { version, source_revision: sourceRevision, inventory: verified.inventory, manifest: verified.manifest, signedInventory: verified.signedInventory }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [tarball, sourceRevision, version] = process.argv.slice(2)
  const result = verifyPackedAdapter({ tarball, sourceRevision, version })
  console.log(JSON.stringify({ ok: true, version: result.version, source_revision: result.source_revision }))
}
