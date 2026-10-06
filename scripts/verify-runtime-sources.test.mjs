import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { verifyRuntimeSources } from './verify-runtime-sources.mjs'

test('runtime sources require immutable, complete, digest-matched publication', async () => {
  const bytes = readFileSync(new URL('../distribution/runtime-sources.json', import.meta.url))
  const manifest = JSON.parse(bytes)
  const entries = [...manifest.sources, { filename: 'sources.json', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }]
  const release = { immutable: true, draft: false, tag_name: manifest.release_tag,
    assets: entries.map(entry => ({ name: entry.filename, size: entry.bytes, digest: `sha256:${entry.sha256}`,
      state: 'uploaded', browser_download_url: `https://github.com/Raidiant-io/notifai/releases/download/${manifest.release_tag}/${entry.filename}` })) }
  const check = value => verifyRuntimeSources(bytes, { fetchImpl: async () => ({ ok: true, json: async () => value }) })
  assert.equal((await check(release)).ok, true)
  await assert.rejects(check({ ...release, immutable: false }), /immutable release/)
  await assert.rejects(check({ ...release, assets: release.assets.slice(1) }), /asset missing/)
  const changed = structuredClone(release)
  changed.assets[0].digest = `sha256:${'0'.repeat(64)}`
  await assert.rejects(check(changed), /asset differs/)
})
