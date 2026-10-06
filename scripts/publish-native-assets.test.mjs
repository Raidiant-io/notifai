import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publishNativeAssets } from './publish-native-assets.mjs'
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
test('an ambiguous or absent release for the admitted tag stops before any mutation', async () => {
  const twice = fixture()
  twice.state.otherReleases.push({ ...twice.state.release, id: 3 })
  await assert.rejects(publishNativeAssets(twice.args), /Exactly one GitHub release/)
  const none = fixture()
  none.state.release.tag_name = 'v2.0.0'
  await assert.rejects(publishNativeAssets(none.args), /Exactly one GitHub release/)
  for (const { state } of [twice, none]) assert.ok(state.calls.every(call => call.method === 'GET'))
})
