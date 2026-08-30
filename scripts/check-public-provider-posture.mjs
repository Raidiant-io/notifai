#!/usr/bin/env node
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const API_ROOT = 'https://api.github.com/repos/Raidiant-io/notifai'
const FULL_SHA = /^[0-9a-f]{40}$/

function requestHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'notifai-public-provider-posture',
    'X-GitHub-Api-Version': '2026-03-10',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function readJson(fetchImpl, endpoint, token) {
  const response = await fetchImpl(`${API_ROOT}${endpoint}`, {
    headers: requestHeaders(token),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}`)
  return await response.json()
}

async function resolveTagCommit(fetchImpl, tag, token) {
  const ref = await readJson(fetchImpl, `/git/ref/tags/${encodeURIComponent(tag)}`, token)
  let type = ref?.object?.type
  let sha = ref?.object?.sha
  for (let depth = 0; type === 'tag' && depth < 4; depth += 1) {
    if (typeof sha !== 'string' || !FULL_SHA.test(sha)) {
      throw new Error('GitHub returned an invalid annotated release tag')
    }
    const tagObject = await readJson(fetchImpl, `/git/tags/${sha}`, token)
    type = tagObject?.object?.type
    sha = tagObject?.object?.sha
  }
  if (type !== 'commit' || typeof sha !== 'string' || !FULL_SHA.test(sha)) {
    throw new Error('release tag does not resolve to one full commit SHA')
  }
  return sha
}

export async function checkPublicProviderPosture(
  {
    token,
    releaseTag,
    expectedSha,
    requireRepositoryImmutability = false,
  } = {},
  fetchImpl = fetch,
) {
  const pvr = await readJson(fetchImpl, '/private-vulnerability-reporting', token)
  if (pvr?.enabled !== true) throw new Error('private vulnerability reporting is not enabled')

  if ((releaseTag === undefined) !== (expectedSha === undefined)) {
    throw new Error('releaseTag and expectedSha must be supplied together')
  }
  if (releaseTag !== undefined) {
    if (typeof expectedSha !== 'string' || !FULL_SHA.test(expectedSha)) {
      throw new Error('expectedSha must be one full lowercase commit SHA')
    }
    const actualSha = await resolveTagCommit(fetchImpl, releaseTag, token)
    if (actualSha !== expectedSha) {
      throw new Error('release tag no longer resolves to the expected commit SHA')
    }
    const release = await readJson(
      fetchImpl,
      `/releases/tags/${encodeURIComponent(releaseTag)}`,
      token,
    )
    if (release?.tag_name !== releaseTag) throw new Error('GitHub returned a different release tag')
    if (release?.immutable !== true) throw new Error('GitHub Release is not immutable')
  }

  if (requireRepositoryImmutability) {
    const setting = await readJson(fetchImpl, '/immutable-releases', token)
    if (setting?.enabled !== true) throw new Error('repository release immutability is not enabled')
    const rulesets = await readJson(fetchImpl, '/rulesets?targets=tag', token)
    if (!Array.isArray(rulesets)) throw new Error('GitHub returned a malformed tag ruleset list')
    let protectedTags = false
    for (const summary of rulesets) {
      if (summary?.target !== 'tag' || summary?.enforcement !== 'active') continue
      if (typeof summary.id !== 'number') continue
      const ruleset = await readJson(fetchImpl, `/rulesets/${summary.id}`, token)
      const includes = ruleset?.conditions?.ref_name?.include
      const bypass = ruleset?.bypass_actors
      const ruleTypes = Array.isArray(ruleset?.rules)
        ? ruleset.rules.map((rule) => rule?.type).sort()
        : []
      if (
        Array.isArray(includes) &&
        includes.includes('refs/tags/v*') &&
        includes.includes('refs/tags/protocol-v*') &&
        includes.includes('refs/tags/android-v*') &&
        Array.isArray(bypass) &&
        bypass.length === 0 &&
        JSON.stringify(ruleTypes) === JSON.stringify(['deletion', 'update'])
      ) {
        protectedTags = true
      }
    }
    if (!protectedTags) {
      throw new Error('no active no-bypass ruleset prevents every release tag update and deletion')
    }
  }

  return {
    privateVulnerabilityReporting: true,
    releaseImmutable: releaseTag === undefined ? null : true,
    repositoryImmutability: requireRepositoryImmutability ? true : null,
    tagRuleset: requireRepositoryImmutability ? true : null,
  }
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  const result = await checkPublicProviderPosture({
    token: process.env.GH_TOKEN,
    releaseTag: argumentValue('--release-tag'),
    expectedSha: argumentValue('--expected-sha'),
    requireRepositoryImmutability: process.argv.includes('--require-repository-immutability'),
  })
  const checks = ['private vulnerability reporting']
  if (result.releaseImmutable) checks.push('release tag/SHA immutability')
  if (result.repositoryImmutability) checks.push('repository release immutability and tag ruleset')
  console.log(`Public provider posture verified: ${checks.join(', ')}.`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(`Public provider posture check failed: ${String(error)}`)
    process.exit(1)
  }
}
