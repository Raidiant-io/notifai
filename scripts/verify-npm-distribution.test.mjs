import assert from 'node:assert/strict'
import test from 'node:test'
import { registryDistTags, verifyDistribution, waitForDistribution } from './verify-npm-distribution.mjs'

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

test('npm distribution lookup reads the dedicated tag endpoint and fails closed', async () => {
  const tags = await registryDistTags('@raidiant/notifai', async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/-/package/%40raidiant%2Fnotifai/dist-tags')
    assert.equal(options.redirect, 'error')
    return Response.json({ latest: '11.3.2', beta: '11.4.0-beta.1' })
  })
  assert.equal(tags.latest, '11.3.2')
  await assert.rejects(registryDistTags('@raidiant/notifai', async () => new Response('', { status: 503 })), /HTTP 503/)
  for (const malformed of [null, [], { 'dist-tags': { beta: '11.4.0-beta.1' } }, { beta: '' }]) {
    await assert.rejects(registryDistTags('@raidiant/notifai', async () => Response.json(malformed)), /distribution tags missing|invalid npm distribution tag/)
  }
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


const delayedBeta = {
  name: '@raidiant/notifai', version: '12.0.0-beta.2',
  before: { latest: '11.8.0', beta: '12.0.0-beta.1' },
}

test('publication waits for unchanged registry metadata to expose the exact target', async () => {
  for (const candidate of [
    delayedBeta,
    { ...delayedBeta, version: '12.0.0' },
    { ...delayedBeta, distTag: 'candidate-12.0.0-beta.2' },
  ]) {
    const tag = candidate.distTag ?? (candidate.version.includes('-') ? 'beta' : 'latest')
    const published = { ...candidate.before, [tag]: candidate.version }
    let lookups = 0
    const sleeps = []
    const result = await waitForDistribution(candidate, {
      lookup: async () => ++lookups < 3 ? candidate.before : published,
      sleep: async (ms) => { sleeps.push(ms) },
    })
    assert.deepEqual(result, published)
    assert.equal(lookups, 3)
    assert.deepEqual(sleeps, [2_000, 2_000])
  }
})

test('unchanged stale tags fail after six lookups without republishing', async () => {
  let lookups = 0, sleeps = 0
  await assert.rejects(waitForDistribution(delayedBeta, {
    lookup: async () => { lookups += 1; return delayedBeta.before },
    sleep: async () => { sleeps += 1 },
  }), /did not become npm beta/)
  assert.equal(lookups, 6)
  assert.equal(sleeps, 5)
})

test('unexpected target or unrelated tag mutations never receive a propagation retry', async () => {
  for (const [after, message] of [
    [{ ...delayedBeta.before, beta: '12.0.0-beta.3' }, /unexpected version/],
    [{ ...delayedBeta.before, latest: '12.0.0' }, /unrelated npm latest/],
    [{ ...delayedBeta.before, other: '1.0.0' }, /unrelated npm other/],
    [{ ...delayedBeta.before, beta: delayedBeta.version, latest: '12.0.0' }, /unrelated npm latest/],
  ]) {
    let lookups = 0
    await assert.rejects(waitForDistribution(delayedBeta, {
      lookup: async () => { lookups += 1; return after },
      sleep: async () => assert.fail('unsafe state must not retry'),
    }), message)
    assert.equal(lookups, 1)
  }
})

test('registry errors remain failures and current tags return immediately', async () => {
  await assert.rejects(waitForDistribution(delayedBeta, {
    lookup: async () => { throw new Error('registry unavailable') },
    sleep: async () => assert.fail('lookup failure must not retry'),
  }), /registry unavailable/)
  const after = { ...delayedBeta.before, beta: delayedBeta.version }
  assert.deepEqual(await waitForDistribution(delayedBeta, {
    lookup: async () => after,
    sleep: async () => assert.fail('current state must not wait'),
  }), after)
})
