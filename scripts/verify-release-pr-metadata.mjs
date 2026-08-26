#!/usr/bin/env node
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import process from 'node:process'

const RELEASE_BRANCH_PREFIX = 'release-please--branches--'
const RELEASE_HEADER = ':robot: I have created a release *beep* *boop*'
const RELEASE_FOOTER =
  'This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).'
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`
const SUMMARY = new RegExp(`^(?:(?<component>.*[^:]): )?(?<version>${SEMVER})$`)

function changedManifestVersions(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...paths]
    .sort()
    .filter(path => before[path] !== after[path])
    .map(path => {
      if (typeof after[path] !== 'string') {
        throw new Error(`release manifest removed ${path}`)
      }
      return {path, version: after[path]}
    })
}

function parseReleaseDetails(body) {
  if (typeof body !== 'string' || body.length === 0) {
    throw new Error('release pull request body must remain the release-please body')
  }
  if (!body.startsWith(RELEASE_HEADER) || !body.trimEnd().endsWith(RELEASE_FOOTER)) {
    throw new Error('release pull request body must remain the release-please body')
  }

  const openings = body.match(/<details>/g)?.length ?? 0
  const details = [...body.matchAll(/<details><summary>([^<]+)<\/summary>[\s\S]*?<\/details>/g)]
  if (details.length === 0 || details.length !== openings) {
    throw new Error('release pull request body contains malformed release details')
  }

  return details.map(([, summary]) => {
    const match = summary.match(SUMMARY)
    if (!match?.groups) {
      throw new Error(`release summary is not parseable: ${summary}`)
    }
    return {
      component: match.groups.component ?? '',
      version: match.groups.version,
    }
  })
}

export function verifyReleasePullRequestMetadata({
  headRef,
  baseRef,
  title,
  body,
  beforeManifest,
  afterManifest,
  config,
}) {
  if (!headRef.startsWith(RELEASE_BRANCH_PREFIX)) return []

  const expectedHeadRef = `${RELEASE_BRANCH_PREFIX}${baseRef.replaceAll('/', '--')}`
  if (headRef !== expectedHeadRef) {
    throw new Error(`release branch must remain ${expectedHeadRef}`)
  }
  if (title !== `chore: release ${baseRef}`) {
    throw new Error(`release title must remain "chore: release ${baseRef}"`)
  }

  const changed = changedManifestVersions(beforeManifest, afterManifest)
  if (changed.length === 0) {
    throw new Error('release pull request does not advance the release manifest')
  }

  const expected = changed.map(release => {
    const packageConfig = config.packages?.[release.path]
    if (packageConfig === undefined) {
      throw new Error(`release manifest changed unconfigured package ${release.path}`)
    }
    const configuredComponent = packageConfig.component
    if (typeof configuredComponent !== 'string' || configuredComponent.length === 0) {
      throw new Error(`release package ${release.path} must configure a component`)
    }
    return {
      ...release,
      component: packageConfig['include-component-in-tag'] === false
        ? ''
        : configuredComponent,
    }
  })

  const actual = parseReleaseDetails(body)
  if (actual.length !== expected.length) {
    throw new Error(
      `release body has ${actual.length} release entries; manifest advances ${expected.length}`,
    )
  }
  // release-please 17.3.0 treats this shape as a standalone component PR.
  // The combined branch has no component, so a configured package cannot be
  // correlated and no release is created.
  if (actual.length === 1 && actual[0].component === '') {
    throw new Error(
      'componentless single-package release metadata cannot correlate with the configured ' +
      'package branch; wait for a component-named release candidate instead of merging',
    )
  }

  const unmatched = [...actual]
  for (const release of expected) {
    const index = unmatched.findIndex(entry =>
      entry.component === release.component && entry.version === release.version)
    if (index === -1) {
      const name = release.component || release.path
      throw new Error(`release body is missing ${name} ${release.version}`)
    }
    unmatched.splice(index, 1)
  }

  return expected.map(({path, component, version}) => ({path, component, version}))
}

function readJsonAtRef(ref, path) {
  return JSON.parse(execFileSync('git', ['show', `${ref}:${path}`], {encoding: 'utf8'}))
}

if (process.argv[1]?.endsWith('verify-release-pr-metadata.mjs')) {
  const eventPath = process.argv[2]
  if (typeof eventPath !== 'string' || eventPath.length === 0) {
    console.error('usage: node scripts/verify-release-pr-metadata.mjs <github-event.json>')
    process.exit(2)
  }

  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf8'))
    const pullRequest = event.pull_request
    if (pullRequest === undefined) {
      throw new Error('GitHub event has no pull_request payload')
    }
    const verified = verifyReleasePullRequestMetadata({
      headRef: pullRequest.head.ref,
      baseRef: pullRequest.base.ref,
      title: pullRequest.title,
      body: pullRequest.body ?? '',
      beforeManifest: readJsonAtRef(
        pullRequest.base.sha,
        '.release-please-manifest.json',
      ),
      afterManifest: readJsonAtRef(
        pullRequest.head.sha,
        '.release-please-manifest.json',
      ),
      config: JSON.parse(readFileSync('release-please-config.json', 'utf8')),
    })
    if (verified.length === 0) {
      console.log('Not a release-please pull request; no release metadata to verify.')
    } else {
      console.log(
        `Verified release pull request metadata: ${verified
          .map(release => `${release.path}@${release.version}`)
          .join(', ')}`,
      )
    }
  } catch (error) {
    console.error(`Release pull request metadata verification failed: ${error.message}`)
    process.exit(1)
  }
}
