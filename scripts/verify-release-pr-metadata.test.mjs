import assert from 'node:assert/strict'
import test from 'node:test'
import {verifyReleasePullRequestMetadata} from './verify-release-pr-metadata.mjs'

const config = {
  packages: {
    'apps/cli': {
      component: 'notifai',
      'include-component-in-tag': false,
    },
    'packages/protocol': {
      component: 'protocol',
      'include-component-in-tag': true,
    },
  },
}

const beforeManifest = {
  'apps/cli': '9.2.1',
  'packages/protocol': '5.0.0',
}

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
    ...overrides,
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
