import assert from 'node:assert/strict'
import test from 'node:test'
import { planPublish } from './plan-publish.mjs'

const head = 'a'.repeat(40)
const protocol = { name: '@raidiant/notifai-protocol', version: '8.2.1', tag: 'protocol-v8.2.1' }
const installer = { name: '@raidiant/notifai-install', version: '0.1.0-beta.1', tag: 'installer-v0.1.0-beta.1' }
const input = { head, packages: [protocol, installer], tagCommits: new Map([[protocol.tag, head], [installer.tag, head]]), published: new Set() }

test('each npm tag publishes only its package even when another tag names the same commit', () => {
  assert.deepEqual(planPublish({ ...input, refName: protocol.tag }), { ...protocol, npmDistTag: 'latest', publish: true })
  assert.deepEqual(planPublish({ ...input, refName: installer.tag }), { ...installer, npmDistTag: 'beta', publish: true })
})
test('retry of an existing version requires verification without republishing', () => {
  assert.equal(planPublish({ ...input, refName: installer.tag, published: new Set([`${installer.name}@${installer.version}`]) }).publish, false)
})
test('native CLI tags, unknown versions and moved package tags cannot publish npm packages', () => {
  for (const refName of ['v11.7.1', 'installer-v0.2.0', 'main']) {
    assert.throws(() => planPublish({ ...input, refName }), /triggering tag/)
  }
  assert.throws(() => planPublish({ ...input, refName: protocol.tag, tagCommits: new Map([[protocol.tag, 'b'.repeat(40)]]) }), /triggering tag/)
})
