import assert from 'node:assert/strict'
import test from 'node:test'
import { planPublish } from './plan-publish.mjs'

const head = 'release-commit'
const packages = [
  { name: '@raidiant/notifai-protocol', version: '5.0.0', tag: 'protocol-v5.0.0' },
  { name: '@raidiant/notifai', version: '9.0.0', tag: 'v9.0.0' },
]

test('a protocol tag can publish protocol while the CLI tag is still absent', () => {
  const plan = planPublish({
    head,
    refName: 'protocol-v5.0.0',
    packages,
    tagCommits: new Map([['protocol-v5.0.0', head]]),
    published: new Set(),
    verified: new Set(),
  })
  assert.deepEqual(plan.get('@raidiant/notifai-protocol'), { publish: true, verify: true })
  assert.deepEqual(plan.get('@raidiant/notifai'), { publish: false, verify: false })
})

test('a CLI tag publishes protocol first when both exact tags are ready', () => {
  const plan = planPublish({
    head,
    refName: 'v9.0.0',
    packages,
    tagCommits: new Map([
      ['protocol-v5.0.0', head],
      ['v9.0.0', head],
    ]),
    published: new Set(),
    verified: new Set(),
  })
  assert.deepEqual(plan.get('@raidiant/notifai-protocol'), { publish: true, verify: true })
  assert.deepEqual(plan.get('@raidiant/notifai'), { publish: true, verify: true })
})

test('a CLI tag refuses to publish before its protocol dependency is available', () => {
  assert.throws(
    () =>
      planPublish({
        head,
        refName: 'v9.0.0',
        packages,
        tagCommits: new Map([['v9.0.0', head]]),
        published: new Set(),
        verified: new Set(),
      }),
    /cannot publish before/,
  )
})

test('a CLI publish is refused when its published protocol failed verification', () => {
  assert.throws(
    () =>
      planPublish({
        head,
        refName: 'v9.0.0',
        packages,
        tagCommits: new Map([['v9.0.0', head]]),
        published: new Set(['@raidiant/notifai-protocol@5.0.0']),
        verified: new Set(),
      }),
    /cannot publish before .* is verified/,
  )
})

test('a verified existing protocol permits its unpublished CLI to publish', () => {
  const plan = planPublish({
    head,
    refName: 'v9.0.0',
    packages,
    tagCommits: new Map([['v9.0.0', head]]),
    published: new Set(['@raidiant/notifai-protocol@5.0.0']),
    verified: new Set(['@raidiant/notifai-protocol@5.0.0']),
  })
  assert.deepEqual(plan.get('@raidiant/notifai'), { publish: true, verify: true })
})

test('an idempotent rerun verifies the triggering package without republishing', () => {
  const plan = planPublish({
    head,
    refName: 'v9.0.0',
    packages,
    tagCommits: new Map([['v9.0.0', head]]),
    published: new Set(['@raidiant/notifai-protocol@5.0.0', '@raidiant/notifai@9.0.0']),
    verified: new Set(),
  })
  assert.deepEqual(plan.get('@raidiant/notifai-protocol'), { publish: false, verify: false })
  assert.deepEqual(plan.get('@raidiant/notifai'), { publish: false, verify: true })
})

test('a tag that does not point at the checkout is rejected', () => {
  assert.throws(
    () =>
      planPublish({
        head,
        refName: 'v9.0.0',
        packages,
        tagCommits: new Map([['v9.0.0', 'other-commit']]),
        published: new Set(),
        verified: new Set(),
      }),
    /triggering tag/,
  )
})
