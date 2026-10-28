import assert from 'node:assert/strict'
import test from 'node:test'
import { publishTarball, registryHasVersion } from './publish-npm-tarball.mjs'

// Captured from release run 40667109016 attempt 2 (npm 11.21.0, sigstore 4.1.1).
const conflict = { status: 1, stdout: '', stderr: 'npm error code TLOG_CREATE_ENTRY_ERROR\nnpm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID 108e9186\n' }
const ok = { status: 0, stdout: '+ @raidiant/notifai@1.2.3-beta.1\n', stderr: '' }
function rig(results, onRegistry = () => false) {
  const calls = [], waits = [], logs = [], lookups = []
  return { calls, waits, logs, lookups, options: { tarball: '/tmp/a.tgz', distTag: 'candidate-1.2.3-beta.1', name: '@raidiant/notifai', version: '1.2.3-beta.1',
    run: args => { calls.push(args); assert.ok(results.length); return results.shift() },
    registryHas: async (name, version) => { lookups.push(`${name}@${version}`); return onRegistry(lookups.length) },
    wait: async ms => { waits.push(ms) }, log: message => logs.push(message) } }
}

test('publishes once with OIDC provenance and the staged dist-tag', async () => {
  const r = rig([ok])
  assert.deepEqual(await publishTarball(r.options), { published: true, attempts: 1 })
  assert.deepEqual(r.calls, [['publish', '/tmp/a.tgz', '--access', 'public', '--provenance', '--tag', 'candidate-1.2.3-beta.1']])
  assert.deepEqual(r.lookups, [])
})
test('a Rekor conflict publishes again only after proving the version is absent, with a log line', async () => {
  const r = rig([conflict, ok])
  assert.deepEqual(await publishTarball(r.options), { published: true, attempts: 2 })
  assert.deepEqual(r.lookups, ['@raidiant/notifai@1.2.3-beta.1'])
  assert.equal(r.waits.length, 1)
  assert.match(r.logs[0], /Rekor 409 .* not on the registry\. Publishing again .*attempt 2 of 3/)
})
test('a Rekor conflict with the version already on the registry defers to byte verification', async () => {
  const r = rig([conflict], () => true)
  assert.deepEqual(await publishTarball(r.options), { published: true, attempts: 1 })
  assert.equal(r.calls.length, 1)
  assert.match(r.logs[0], /published-bytes check decides/)
})
test('repeated Rekor conflicts stop after the bound', async () => {
  const r = rig([conflict, conflict, conflict])
  await assert.rejects(publishTarball(r.options), /after 3 attempts; @raidiant\/notifai@1\.2\.3-beta\.1 was not published/)
  assert.equal(r.calls.length, 3)
  assert.equal(r.waits.length, 2)
})
test('every other publish failure fails at once without a retry', async () => {
  for (const result of [
    { status: 1, stderr: 'npm error code E403\nnpm error 403 You cannot publish over the previously published versions' },
    { status: 1, stderr: 'npm error code TLOG_CREATE_ENTRY_ERROR\nnpm error error creating tlog entry - (500) internal error' },
    { status: 1, stderr: 'npm error code EOTP' }, { status: null, signal: 'SIGKILL', stderr: '' }, { error: { code: 'ENOENT' } }]) {
    const r = rig([result])
    await assert.rejects(publishTarball(r.options), /npm publish failed/)
    assert.equal(r.calls.length, 1)
    assert.deepEqual(r.lookups, [])
  }
})
test('an unreadable registry fails closed instead of publishing again', async () => {
  const r = rig([conflict], () => { throw new Error('npm registry lookup failed (HTTP 503)') })
  await assert.rejects(publishTarball(r.options), /HTTP 503/)
  assert.equal(r.calls.length, 1)
})
test('registry presence reads only 200 and 404 as answers', async () => {
  const reply = status => async () => ({ status })
  assert.equal(await registryHasVersion('@raidiant/notifai', '1.0.0', reply(200)), true)
  assert.equal(await registryHasVersion('@raidiant/notifai', '1.0.0', reply(404)), false)
  await assert.rejects(registryHasVersion('@raidiant/notifai', '1.0.0', reply(502)), /HTTP 502/)
})
