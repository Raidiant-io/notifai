import assert from 'node:assert/strict'
import test from 'node:test'
import { registryDistTags, verifyDistribution } from './verify-npm-distribution.mjs'

test('stable publication makes the exact version latest', () => {
  verifyDistribution({ name: '@raidiant/notifai', version: '11.4.0', before: { latest: '11.3.2' }, after: { latest: '11.4.0' } })
  assert.throws(() => verifyDistribution({ name: '@raidiant/notifai', version: '11.4.0', before: { latest: '11.3.2' }, after: { latest: '11.3.2' } }), /did not become npm latest/)
})

test('beta publication moves beta and preserves latest', () => {
  const candidate = { name: '@raidiant/notifai', version: '11.4.0-beta.2', before: { latest: '11.3.2', beta: '11.4.0-beta.1' } }
  verifyDistribution({ ...candidate, after: { latest: '11.3.2', beta: '11.4.0-beta.2' } })
  assert.throws(() => verifyDistribution({ ...candidate, after: { latest: '11.4.0-beta.2', beta: '11.4.0-beta.2' } }), /changed npm latest/)
  assert.throws(() => verifyDistribution({ ...candidate, after: { latest: '11.3.2', beta: '11.4.0-beta.1' } }), /did not become npm beta/)
  assert.throws(() => verifyDistribution({ ...candidate, before: { latest: '11.4.0' }, after: { latest: '11.4.0', beta: '11.4.0-beta.2' } }), /must target a version newer/)
})

test('npm distribution lookup uses the public registry and fails closed', async () => {
  const tags = await registryDistTags('@raidiant/notifai', async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/%40raidiant%2Fnotifai')
    assert.equal(options.redirect, 'error')
    return Response.json({ 'dist-tags': { latest: '11.3.2', beta: '11.4.0-beta.1' } })
  })
  assert.equal(tags.latest, '11.3.2')
  await assert.rejects(registryDistTags('@raidiant/notifai', async () => new Response('', { status: 503 })), /HTTP 503/)
})
