import assert from 'node:assert/strict'
import test from 'node:test'
import { planPublish } from './plan-publish.mjs'
const head = 'a'.repeat(40)
const protocol = { name: '@raidiant/notifai-protocol', version: '8.2.1', tag: 'protocol-v8.2.1' }
const cli = { name: '@raidiant/notifai', version: '12.0.0-beta.1', tag: 'v12.0.0-beta.1' }
const input = { head, packages: [protocol, cli], tagCommits: new Map([[protocol.tag, head], [cli.tag, head]]), published: new Set() }
test('CLI candidate publication avoids beta/latest while protocol retains its independent lane', () => {
  assert.deepEqual(planPublish({ ...input, refName: cli.tag }), { ...cli, npmDistTag: 'candidate-12.0.0-beta.1', publish: true })
  assert.deepEqual(planPublish({ ...input, refName: protocol.tag }), { ...protocol, npmDistTag: 'latest', publish: true })
})
test('retries verify immutable existing bytes and promotion never republishes', () => {
  const published = new Set([`${cli.name}@${cli.version}`])
  assert.equal(planPublish({ ...input, refName: cli.tag, published }).publish, false)
  assert.deepEqual(planPublish({ ...input, refName: cli.tag, published, mode: 'promote' }), { ...cli, npmDistTag: 'beta', publish: false })
  assert.throws(() => planPublish({ ...input, refName: cli.tag, mode: 'promote' }), /already verified published/)
})
test('retired components, unknown versions and moved source tags cannot publish', () => {
  for (const refName of ['installer-v0.1.0', 'v12.0.0-beta.2', 'main']) assert.throws(() => planPublish({ ...input, refName }), /triggering tag/)
  assert.throws(() => planPublish({ ...input, refName: cli.tag, tagCommits: new Map([[cli.tag, 'b'.repeat(40)]]) }), /triggering tag/)
})
