import assert from 'node:assert/strict'
import test from 'node:test'
import { checkPublicProviderPosture } from './check-public-provider-posture.mjs'

const commit = 'a'.repeat(40)

function providerFetch({
  pvr = true,
  immutable = true,
  tagSha = commit,
  setting = true,
  tagRuleset = true,
} = {}) {
  return async (input) => {
    const url = String(input)
    if (url.endsWith('/private-vulnerability-reporting')) {
      return Response.json({ enabled: pvr })
    }
    if (url.includes('/git/ref/tags/')) {
      return Response.json({ object: { type: 'commit', sha: tagSha } })
    }
    if (url.includes('/releases/tags/')) {
      return Response.json({ tag_name: 'v1.2.3', immutable })
    }
    if (url.endsWith('/immutable-releases')) {
      return Response.json({ enabled: setting, enforced_by_owner: false })
    }
    if (url.endsWith('/rulesets?targets=tag')) {
      return Response.json(
        tagRuleset ? [{ id: 42, target: 'tag', enforcement: 'active' }] : [],
      )
    }
    if (url.endsWith('/rulesets/42')) {
      return Response.json({
        target: 'tag',
        enforcement: 'active',
        bypass_actors: [],
        conditions: {
          ref_name: {
            include: ['refs/tags/v*', 'refs/tags/protocol-v*', 'refs/tags/android-v*'],
            exclude: [],
          },
        },
        rules: [{ type: 'update' }, { type: 'deletion' }],
      })
    }
    return new Response('', { status: 404 })
  }
}

test('accepts PVR, exact release SHA, immutable release, and repository setting', async () => {
  assert.deepEqual(
    await checkPublicProviderPosture(
      {
        releaseTag: 'v1.2.3',
        expectedSha: commit,
        requireRepositoryImmutability: true,
      },
      providerFetch(),
    ),
    {
      privateVulnerabilityReporting: true,
      releaseImmutable: true,
      repositoryImmutability: true,
      tagRuleset: true,
    },
  )
})

test('fails when private vulnerability reporting is disabled', async () => {
  await assert.rejects(
    checkPublicProviderPosture({}, providerFetch({ pvr: false })),
    /private vulnerability reporting is not enabled/,
  )
})

test('fails when the release tag moved or its release is mutable', async () => {
  await assert.rejects(
    checkPublicProviderPosture(
      { releaseTag: 'v1.2.3', expectedSha: commit },
      providerFetch({ tagSha: 'b'.repeat(40) }),
    ),
    /no longer resolves/,
  )
  await assert.rejects(
    checkPublicProviderPosture(
      { releaseTag: 'v1.2.3', expectedSha: commit },
      providerFetch({ immutable: false }),
    ),
    /GitHub Release is not immutable/,
  )
})

test('fails the admin-read posture check when repository immutability is disabled', async () => {
  await assert.rejects(
    checkPublicProviderPosture(
      { requireRepositoryImmutability: true },
      providerFetch({ setting: false }),
    ),
    /repository release immutability is not enabled/,
  )
})

test('fails the deep posture check when historic release tags are not protected', async () => {
  await assert.rejects(
    checkPublicProviderPosture(
      { requireRepositoryImmutability: true },
      providerFetch({ tagRuleset: false }),
    ),
    /no active no-bypass ruleset/,
  )
})
