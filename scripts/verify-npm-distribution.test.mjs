import assert from 'node:assert/strict'
import test from 'node:test'
import { registryDistTags, verifyDistribution, waitForDistribution, promoteDistribution } from './verify-npm-distribution.mjs'
import { requireCurrentNpmChannels } from './publication-lane.mjs'

test('stable publication makes the exact version latest', () => {
  verifyDistribution({ name: '@raidiant/notifai', version: '11.4.0', before: { latest: '11.3.2' }, after: { latest: '11.4.0' } })
  assert.throws(() => verifyDistribution({ name: '@raidiant/notifai', version: '11.4.0', before: { latest: '11.3.2' }, after: { latest: '11.3.2' } }), /did not become npm latest/)
})

test('protocol stable promotion advances beta, preserving a genuinely newer beta', () => {
  const candidate = { name: '@raidiant/notifai-protocol', version: '8.4.0',
    before: { latest: '8.3.3', beta: '8.2.1-beta.2' } }
  verifyDistribution({ ...candidate, after: { latest: '8.4.0', beta: '8.4.0' } })
  assert.throws(() => verifyDistribution({ ...candidate, after: { ...candidate.before, latest: '8.4.0' } }), /beta/)
  verifyDistribution({ ...candidate, before: { latest: '8.3.3', beta: '8.5.0-beta.1' },
    after: { latest: '8.4.0', beta: '8.5.0-beta.1' } })
})

test('CLI stable promotion retires a stale beta tag so old clients still parse discovery', () => {
  const before = { latest: '12.0.0', beta: '13.0.0-beta.1' }
  const after = { latest: '13.0.0' }
  verifyDistribution({ name: '@raidiant/notifai', version: '13.0.0', before, after })
  assert.throws(() => verifyDistribution({ name: '@raidiant/notifai', version: '13.0.0', before,
    after: { ...before, latest: '13.0.0' } }), /beta/)
  // The shipped pre-fix parser accepts an absent beta and rejects stable beta.
  assert.equal(after.beta, undefined)
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
    if (tag === 'latest') delete published.beta
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

test('stable promotion writes protocol beta first, retires stale CLI beta, and never downgrades newer beta', async () => {
  for (const [name, before, expected] of [
    ['@raidiant/notifai-protocol', { latest: '12.0.0', beta: '13.0.0-beta.1' }, [{ tag: 'beta', version: '13.0.0' }, { tag: 'latest', version: '13.0.0' }]],
    ['@raidiant/notifai', { latest: '12.0.0', beta: '13.0.0-beta.1' }, [{ tag: 'beta', version: null }, { tag: 'latest', version: '13.0.0' }]],
    ['@raidiant/notifai', { latest: '12.0.0', beta: '14.0.0-beta.1' }, [{ tag: 'latest', version: '13.0.0' }]],
  ]) {
    const writes = [], after = { ...before }
    await promoteDistribution({ name, version: '13.0.0', before }, {
      lookup: async () => before,
      writeTag: async (pkg, write) => {
        assert.equal(pkg, name); writes.push(write)
        if (write.version === null) delete after[write.tag]
        else after[write.tag] = write.version
      },
    })
    assert.deepEqual(writes, expected)
    verifyDistribution({ name, version: '13.0.0', before, after })
    if (name === '@raidiant/notifai') {
      // Freeze the shipped parser's restriction, independently of new clients.
      assert.ok(after.beta === undefined || /^\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(after.beta))
    }
    assert.equal((await promoteDistribution({ name, version: '13.0.0', before: after }, {
      lookup: async () => after, writeTag: async () => assert.fail('retry must not write'),
    })), undefined)
  }
})

test('admission refuses lagging tags but accepts the CLI fallback when beta is absent', async () => {
  for (const name of ['@raidiant/notifai', '@raidiant/notifai-protocol']) {
    assert.throws(() => requireCurrentNpmChannels(name, { latest: '13.0.0', beta: '13.0.0-beta.1' }), /beta is behind/)
  }
  requireCurrentNpmChannels('@raidiant/notifai', { latest: '13.0.0' })
  assert.throws(() => requireCurrentNpmChannels('@raidiant/notifai', { latest: '13.0.0', beta: '13.0.0' }), /prerelease-only/)
  requireCurrentNpmChannels('@raidiant/notifai-protocol', { latest: '13.0.0', beta: '13.0.0' })
  await assert.rejects(promoteDistribution({ name: '@raidiant/notifai', version: '13.0.0', before: { latest: '12.0.0' } }, {
    lookup: async () => ({ latest: '12.0.0', other: '11.0.0' }), writeTag: async () => assert.fail('changed snapshot must not write'),
  }), /changed since/)
})

test('forbidden trusted-publisher tag management names the package setting and stops before latest', async () => {
  const name = '@raidiant/notifai-protocol', before = { latest: '8.3.3', beta: '8.2.1-beta.2' }, writes = []
  const providerError = Object.assign(new Error('npm dist-tag command failed'), {
    stderr: Buffer.from('npm error code E403\nThis trusted publisher cannot manage dist-tags. Ask a package maintainer to enable Allow npm dist-tag.'),
  })
  await assert.rejects(promoteDistribution({ name, version: '8.4.0', before }, {
    lookup: async () => before,
    writeTag: async (_pkg, write) => { writes.push(write); throw providerError },
  }), error => {
    assert.match(error.message, /@raidiant\/notifai-protocol/)
    assert.match(error.message, /Allow npm dist-tag/)
    assert.match(error.message, /8\.4\.0/)
    return true
  })
  assert.deepEqual(writes, [{ tag: 'beta', version: '8.4.0' }])
  const otherForbidden = Object.assign(new Error('different registry refusal'), { stderr: 'npm error E403 another policy' })
  await assert.rejects(promoteDistribution({ name, version: '8.4.0', before }, {
    lookup: async () => before, writeTag: async () => { throw otherForbidden },
  }), error => error === otherForbidden)
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
