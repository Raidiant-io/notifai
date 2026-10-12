#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { parseNpmAdapterManifest, NPM_ADAPTER_MANIFEST } from '../apps/cli/dist/npm-adapter-contract.js'
import { RELEASE_TARGETS } from '../apps/cli/dist/release-distribution.js'
import { releaseMaterialPath } from '../apps/cli/dist/release-path.js'
import { repositoryRoot } from './cross-platform.mjs'

export function prepareReviewedMaterials({ target, output, sourceRoot = path.join(repositoryRoot, 'distribution'), adapterManifest, adapterNotice }) {
  const policy = JSON.parse(readFileSync(path.join(sourceRoot, 'release-materials.json'), 'utf8'))
  assert.ok(policy.schema === 1 && policy.status === 'approved' && policy.runtime === 'bun-1.4.2', 'Reviewed publication materials are not ready')
  assert.ok(RELEASE_TARGETS.includes(target), 'Unknown material target')
  const entries = policy.targets?.[target]
  assert.ok(Array.isArray(entries) && entries.length > 0 && entries.length <= 128, 'Reviewed target material inventory is missing')
  const names = new Set(), files = []
  for (const entry of entries) {
    assert.ok(releaseMaterialPath(entry.path) && entry.path !== 'CANDIDATE-MATERIALS.txt' && !names.has(entry.path.toLowerCase()), 'Invalid publication material path')
    names.add(entry.path.toLowerCase())
    let file = sourceRoot
    for (const segment of ['materials', target, ...entry.path.split('/')]) {
      file = path.join(file, segment)
      assert.ok(!lstatSync(file).isSymbolicLink(), 'Publication material cannot be linked')
    }
    const stat = lstatSync(file)
    assert.ok(stat.isFile() && stat.size === entry.bytes && stat.size <= 256 * 1024 * 1024, 'Publication material size differs')
    const bytes = readFileSync(file)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, 'Publication material hash differs')
    files.push([entry.path, bytes])
  }
  if (adapterManifest !== undefined) {
    parseNpmAdapterManifest(adapterManifest)
    assert.ok(!names.has(NPM_ADAPTER_MANIFEST), 'Reviewed material collides with adapter manifest')
    files.push([NPM_ADAPTER_MANIFEST, adapterManifest])
    assert.ok(adapterNotice, 'npm shim redistribution notice is required')
    assert.ok(!names.has('licenses/npm-cmd-shim.txt'), 'Reviewed material collides with npm notice')
    files.push(['licenses/npm-cmd-shim.txt', adapterNotice])
  }
  mkdirSync(output, { mode: 0o700 })
  try {
    for (const [name, bytes] of files) {
      const file = path.join(output, name)
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
    }
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { target: { type: 'string' }, output: { type: 'string' }, 'adapter-manifest': { type: 'string' } } })
  assert.ok(values.output, 'An exclusive material output directory is required')
  assert.ok(values['adapter-manifest'], 'The release-bound npm adapter manifest is required')
  prepareReviewedMaterials({ ...values, adapterManifest: readFileSync(values['adapter-manifest'], 'utf8'),
    adapterNotice: readFileSync(path.join(repositoryRoot, 'apps/cli/npm/SHIM-NOTICE'), 'utf8') })
}
