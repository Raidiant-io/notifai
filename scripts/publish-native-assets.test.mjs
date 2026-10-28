import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changelogSection, publishNativeAssets } from './publish-native-assets.mjs'
import { fixture } from './native-publication.test-support.mjs'
test('native release uploads every exact asset before publication; immutable retries perform no mutation', async () => {
  const { state, args } = fixture()
  assert.equal((await publishNativeAssets(args)).immutable, true)
  assert.equal(state.calls.filter(call => call.method === 'POST').length, 8)
  state.calls = []
  await publishNativeAssets(args)
  assert.ok(state.calls.every(call => call.method === 'GET'))
})
test('lost upload/publish responses resume from provider state without replacing complete assets', async () => {
  const { state, args } = fixture()
  state.failUploadResponse = true
  await assert.rejects(publishNativeAssets(args), /502/)
  assert.equal(state.release.assets.length, 1)
  state.failPublishResponse = true
  await assert.rejects(publishNativeAssets(args), /502/)
  assert.equal(state.release.immutable, true)
  const priorWrites = state.calls.filter(call => call.method !== 'GET').length
  await publishNativeAssets(args)
  assert.equal(state.calls.filter(call => call.method !== 'GET').length, priorWrites)
  assert.equal(state.calls.filter(call => call.method === 'POST').length, 8)
})
test('completed mismatches stop before mutation; only an expected empty draft starter is removable', async () => {
  const bad = fixture()
  bad.state.release.assets.push({ id: 5, name: 'inventory.json', size: 99, digest: `sha256:${'f'.repeat(64)}`, state: 'uploaded' })
  await assert.rejects(publishNativeAssets(bad.args), /never replace/)
  assert.ok(bad.state.calls.every(call => call.method === 'GET'))
  const retry = fixture()
  retry.state.release.assets.push({ id: 5, name: 'inventory.json', size: 0, state: 'starter' })
  await publishNativeAssets(retry.args)
  assert.equal(retry.state.calls.filter(call => call.method === 'DELETE').length, 1)
})
test('a missing draft is created from the CHANGELOG notes, then published as usual', async () => {
  const { state, args } = fixture()
  state.release = null
  assert.equal((await publishNativeAssets(args)).immutable, true)
  assert.deepEqual(state.created, { tag_name: 'v1.0.0', name: '1.0.0', body: '### Bug Fixes\n\n* Fixture notes.\n', draft: true, prerelease: false })
  assert.equal(state.release.assets.length, 8)
  const bare = fixture()
  bare.state.release = null
  await assert.rejects(publishNativeAssets({ ...bare.args, notes: undefined }), /no release notes were supplied/)
  const existing = fixture()
  await publishNativeAssets({ ...existing.args, notes: () => { throw new Error('notes are read only to create a draft') } })
  assert.ok(bare.state.calls.every(call => call.method === 'GET'))
})
test('identical empty duplicate drafts collapse to the oldest; any other ambiguity stops before mutation', async () => {
  const twice = fixture()
  twice.state.otherReleases.push({ ...twice.state.release, id: 3, assets: [] })
  assert.equal((await publishNativeAssets(twice.args)).release_id, 1)
  assert.deepEqual(twice.state.calls.filter(call => call.method === 'DELETE').map(call => call.route), ['/releases/3'])
  for (const change of [{ body: 'different notes' }, { draft: false, immutable: true }, { assets: [{ id: 9, name: 'inventory.json', size: 1, state: 'uploaded' }] }]) {
    const other = fixture()
    other.state.otherReleases.push({ ...other.state.release, id: 3, assets: [], ...change })
    await assert.rejects(publishNativeAssets(other.args), /Exactly one GitHub release must exist for the admitted tag; found 2/)
    assert.ok(other.state.calls.every(call => call.method === 'GET'))
  }
})
test('notes are the exact CHANGELOG section for the version', () => {
  const text = '# Changelog\n\n## [1.1.0-beta.1](https://x/compare) (2026-10-28)\n\n### Bug Fixes\n\n* New.\n\n## [1.0.0](https://x) (2026-10-27)\n\n* Old.\n'
  assert.equal(changelogSection(text, '1.1.0-beta.1'), '### Bug Fixes\n\n* New.\n')
  assert.equal(changelogSection(text, '1.0.0'), '* Old.\n')
  assert.throws(() => changelogSection(text, '1.1.0'), /no section for 1\.1\.0/)
  assert.throws(() => changelogSection(text, '1.0.0-beta.1'), /no section/)
})
