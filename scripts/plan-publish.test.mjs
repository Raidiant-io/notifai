import assert from 'node:assert/strict'
import test from 'node:test'
import { planPublish } from './plan-publish.mjs'
import { publicationLane } from './publication-lane.mjs'

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

test('only stable versions use latest and only numbered beta versions use beta', () => {
  assert.equal(publicationLane('11.4.0'), 'latest')
  assert.equal(publicationLane('11.4.0-beta.1'), 'beta')
  for (const version of ['11.4.0-rc.1', '11.4.0-beta.0', '11.4.0-beta.01', '11.4.0+local']) {
    assert.throws(() => publicationLane(version), /unsupported release version/)
  }
})

test('a beta CLI may publish against an already verified stable protocol', () => {
  const beta = [packages[0], { name: '@raidiant/notifai', version: '9.1.0-beta.2', tag: 'v9.1.0-beta.2' }]
  const plan = planPublish({
    head,
    refName: 'v9.1.0-beta.2',
    packages: beta,
    tagCommits: new Map([['v9.1.0-beta.2', head]]),
    published: new Set(['@raidiant/notifai-protocol@5.0.0']),
    verified: new Set(['@raidiant/notifai-protocol@5.0.0']),
  })
  assert.deepEqual(plan.get('@raidiant/notifai'), { publish: true, verify: true })
})

test('a stable tag cannot publish a beta package, and a stable CLI cannot pin beta protocol', () => {
  const mixed = [
    { name: '@raidiant/notifai-protocol', version: '5.1.0-beta.1', tag: 'protocol-v5.1.0-beta.1' },
    packages[1],
  ]
  assert.throws(() => planPublish({
    head,
    refName: 'v9.0.0',
    packages: mixed,
    tagCommits: new Map([['v9.0.0', head], ['protocol-v5.1.0-beta.1', head]]),
    published: new Set(),
    verified: new Set(),
  }), /cannot publish a beta package from a latest release tag/)
  assert.throws(() => planPublish({
    head,
    refName: 'v9.0.0',
    packages: mixed,
    tagCommits: new Map([['v9.0.0', head]]),
    published: new Set(['@raidiant/notifai-protocol@5.1.0-beta.1']),
    verified: new Set(['@raidiant/notifai-protocol@5.1.0-beta.1']),
  }), /stable CLI cannot depend on a beta protocol/)
})
