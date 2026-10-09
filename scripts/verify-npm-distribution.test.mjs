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
  assert.throws(() => verifyDistribution({ ...candidate, after: { latest: '11.4.0-beta.2', beta: '11.4.0-beta.2' } }), /changed unrelated npm latest/)
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

test('a first package beta preserves the absent stable tag', async () => {
  assert.deepEqual(await registryDistTags('@raidiant/notifai-protocol', async () => new Response('', { status: 404 })), {})
  verifyDistribution({ name: '@raidiant/notifai-protocol', version: '0.1.0-beta.1', before: {}, after: { beta: '0.1.0-beta.1' } })
  assert.throws(() => verifyDistribution({ name: '@raidiant/notifai-protocol', version: '0.1.0-beta.1', before: {},
    after: { beta: '0.1.0-beta.1', latest: '0.1.0-beta.1' } }), /changed unrelated npm latest/)
})

test('candidate publication changes only its version-specific tag; beta and latest remain unchanged', () => {
  const version = '12.0.0-beta.1', distTag = `candidate-${version}`
  const before = { latest: '11.8.0', beta: '11.8.1-beta.1', other: '10.0.0' }
  const after = { ...before, [distTag]: version }
  verifyDistribution({ name: '@raidiant/notifai', version, distTag, before, after })
  for (const tag of ['latest', 'beta', 'other']) assert.throws(() => verifyDistribution({ name: '@raidiant/notifai', version, distTag, before,
    after: { ...after, [tag]: version } }), /Candidate publication changed/)
})


test('discovery promotion preserves the other audience and unrelated tags', () => {
  assert.throws(() => verifyDistribution({ name: '@raidiant/notifai', version: '12.0.0',
    before: { latest: '11.8.0', beta: '12.0.0-beta.1', retained: '11.7.0' },
    after: { latest: '12.0.0', beta: '12.0.0', retained: '11.7.0' } }), /unrelated npm beta/)
})
