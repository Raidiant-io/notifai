#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from './cross-platform.mjs'

// Source availability is required before binary finalization, independently of
// the signed runtime inventory. These assets never participate in installation.
export async function verifyRuntimeSources(bytes, { token, fetchImpl = fetch } = {}) {
  const manifest = JSON.parse(bytes)
  assert.equal(manifest.schema, 1)
  assert.equal(manifest.runtime, 'bun-1.4.2')
  assert.match(manifest.release_tag, /^runtime-sources-bun-[0-9.]+$/)
  const base = 'https://github.com/Raidiant-io/notifai/releases'
  assert.equal(manifest.release_url, `${base}/tag/${manifest.release_tag}`)
  assert.ok(Array.isArray(manifest.sources) && manifest.sources.length > 0 && manifest.sources.length < 50)
  const response = await fetchImpl(`https://api.github.com/repos/Raidiant-io/notifai/releases/tags/${manifest.release_tag}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'notifai-runtime-source-verifier',
      'X-GitHub-Api-Version': '2026-03-10', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  })
  assert.ok(response.ok, `Runtime source release unavailable: HTTP ${response.status}`)
  const release = await response.json()
  assert.ok(release.immutable === true && release.draft === false && release.tag_name === manifest.release_tag,
    'Runtime sources must already be published as an immutable release')
  const expected = [...manifest.sources, { filename: 'sources.json', bytes: Buffer.byteLength(bytes),
    sha256: createHash('sha256').update(bytes).digest('hex') }]
  const names = new Set()
  for (const entry of expected) {
    assert.match(entry.filename, /^[a-z0-9][a-z0-9.-]+$/)
    assert.ok(!names.has(entry.filename), 'Duplicate runtime source asset')
    names.add(entry.filename)
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0)
    assert.match(entry.sha256, /^[a-f0-9]{64}$/)
    const matches = release.assets?.filter(asset => asset.name === entry.filename) ?? []
    assert.equal(matches.length, 1, `Runtime source asset missing: ${entry.filename}`)
    const asset = matches[0]
    assert.ok(asset.state === 'uploaded' && asset.size === entry.bytes && asset.digest === `sha256:${entry.sha256}` &&
      asset.browser_download_url === `${base}/download/${manifest.release_tag}/${entry.filename}`,
    `Runtime source asset differs: ${entry.filename}`)
  }
  return { ok: true, runtime: manifest.runtime, release: manifest.release_tag, assets: expected.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const bytes = readFileSync(path.join(repositoryRoot, 'distribution/runtime-sources.json'))
  console.log(JSON.stringify(await verifyRuntimeSources(bytes, { token: process.env.GH_TOKEN })))
}
