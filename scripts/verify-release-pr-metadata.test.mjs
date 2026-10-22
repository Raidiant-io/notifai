import assert from 'node:assert/strict'
import test from 'node:test'
import {readGitTags, verifyReleasePullRequestMetadata} from './verify-release-pr-metadata.mjs'

const config = {
  packages: {
    'apps/cli': {
      'package-name': '@raidiant/notifai',
      component: 'notifai',
      'include-component-in-tag': false,
      'include-v-in-tag': true,
    },
    'packages/protocol': {
      'package-name': '@raidiant/notifai-protocol',
      component: 'protocol',
      'include-component-in-tag': true,
      'include-v-in-tag': true,
    },
  },
}

const beforeManifest = {
  'apps/cli': '9.2.1',
  'packages/protocol': '5.0.0',
}

const tags = [
  'v9.2.0',
  'v9.2.1-beta.1',
  'v9.2.1',
  'android-v0.1.0-45',
  'protocol-v4.9.0-beta.1',
  'protocol-v5.0.0',
]

function releaseBody(...summaries) {
  const details = summaries
    .map(summary => `<details><summary>${summary}</summary>\n\nRelease notes\n</details>`)
    .join('\n\n')
  return `:robot: I have created a release *beep* *boop*
---


${details}

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).`
}

function verify(overrides = {}) {
  return verifyReleasePullRequestMetadata({
    headRef: 'release-please--branches--main',
    baseRef: 'main',
    title: 'chore: release main',
    body: releaseBody('9.3.0', 'protocol: 5.1.0'),
    beforeManifest,
    afterManifest: {
      'apps/cli': '9.3.0',
      'packages/protocol': '5.1.0',
    },
    config,
    tags,
    ...overrides,
  })
}

function verifyProtocol(version, extraTags) {
  return verify({
    body: releaseBody(`protocol: ${version}`),
    afterManifest: {
      'apps/cli': '9.2.1',
      'packages/protocol': version,
    },
    tags: [...tags, ...extraTags],
  })
}

test('accepts combined release metadata that release-please can correlate', () => {
  assert.deepEqual(verify(), [
    {path: 'apps/cli', component: '', version: '9.3.0'},
    {path: 'packages/protocol', component: 'protocol', version: '5.1.0'},
  ])
})

test('accepts a component-named single-package release', () => {
  assert.deepEqual(
    verify({
      body: releaseBody('protocol: 5.0.1'),
      afterManifest: {
        'apps/cli': '9.2.1',
        'packages/protocol': '5.0.1',
      },
    }),
    [{path: 'packages/protocol', component: 'protocol', version: '5.0.1'}],
  )
})

test('rejects a componentless single-package release before merge', () => {
  assert.throws(
    () => verify({
      body: releaseBody('9.2.2'),
      afterManifest: {
        'apps/cli': '9.2.2',
        'packages/protocol': '5.0.0',
      },
    }),
    /componentless single-package release.*cannot correlate/i,
  )
})

test('rejects edited release title or missing release body before merge', () => {
  assert.throws(() => verify({title: 'chore: release packages'}), /title must remain/)
  assert.throws(() => verify({body: ''}), /body must remain/)
})

test('ignores ordinary feature pull requests', () => {
  assert.deepEqual(
    verify({
      headRef: 'fix/release-check',
      title: 'fix(release): validate metadata',
      body: 'Adds a focused check.',
    }),
    [],
  )
})

test('rejects a stable proposal below a beta published since the last stable', () => {
  // The generated Release PR that proposed protocol 8.6.0 after 9.0.0-beta.1.
  assert.throws(
    () => verify({
      body: releaseBody('14.0.0', 'protocol: 8.6.0'),
      beforeManifest: {'apps/cli': '13.1.0', 'packages/protocol': '8.5.0'},
      afterManifest: {'apps/cli': '14.0.0', 'packages/protocol': '8.6.0'},
      tags: [
        'protocol-v8.4.0',
        'v13.1.0-beta.7',
        'protocol-v8.5.0',
        'v13.1.0',
        'protocol-v9.0.0-beta.1',
        'v14.0.0-beta.1',
      ],
    }),
    error => {
      assert.match(error.message, /^@raidiant\/notifai-protocol 8\.6\.0 is lower than published prerelease protocol-v9\.0\.0-beta\.1\./)
      assert.match(error.message, /BREAKING CHANGE/)
      assert.match(error.message, /"release-as": "9\.0\.0" for packages\/protocol/)
      assert.match(error.message, /regenerate the Release PR/)
      return true
    },
  )
  assert.throws(
    () => verifyProtocol('5.1.0', ['protocol-v6.0.0-beta.1', 'protocol-v6.0.0-beta.2']),
    /lower than published prerelease protocol-v6\.0\.0-beta\.2\./,
  )
})

test('accepts a stable proposal equal to or above the published beta base', () => {
  assert.deepEqual(
    verifyProtocol('6.0.0', ['protocol-v6.0.0-beta.1']),
    [{path: 'packages/protocol', component: 'protocol', version: '6.0.0'}],
  )
  assert.deepEqual(
    verifyProtocol('6.1.0', ['protocol-v6.0.0-beta.1']),
    [{path: 'packages/protocol', component: 'protocol', version: '6.1.0'}],
  )
})

test('accepts a stable proposal when no beta follows the last stable', () => {
  assert.deepEqual(
    verifyProtocol('5.1.0', []),
    [{path: 'packages/protocol', component: 'protocol', version: '5.1.0'}],
  )
})

test('compares each package only with its own tags', () => {
  // A CLI beta above the protocol proposal must not block the protocol.
  assert.deepEqual(
    verifyProtocol('5.1.0', ['v10.0.0-beta.1']),
    [{path: 'packages/protocol', component: 'protocol', version: '5.1.0'}],
  )
  assert.throws(
    () => verify({tags: [...tags, 'v10.0.0-beta.1']}),
    /@raidiant\/notifai 9\.3\.0 is lower than published prerelease v10\.0\.0-beta\.1/,
  )
})

test('fails closed when tag history cannot be read', () => {
  assert.throws(() => verify({tags: undefined}), /tag history could not be read/)
  assert.throws(() => verify({tags: []}), /tag history could not be read/)
  assert.throws(
    () => verify({tags: tags.filter(tag => tag !== 'protocol-v5.0.0')}),
    /tag history is incomplete: protocol-v5\.0\.0/,
  )
  assert.throws(
    () => readGitTags(() => {
      throw new Error('not a git repository')
    }),
    /tag history could not be read: not a git repository/,
  )
  assert.deepEqual(readGitTags(() => 'v9.2.1\nprotocol-v5.0.0\n'), ['v9.2.1', 'protocol-v5.0.0'])
})
