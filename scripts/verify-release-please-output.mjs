#!/usr/bin/env node
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import process from 'node:process'

function enabled(value) {
  return value === true || value === 'true'
}

function expectedTag(packageConfig, version) {
  const includeV = packageConfig['include-v-in-tag'] ?? true
  const versionPart = `${includeV ? 'v' : ''}${version}`
  if (!(packageConfig['include-component-in-tag'] ?? true)) return versionPart

  const component = packageConfig.component
  if (typeof component !== 'string' || component.length === 0) {
    throw new Error('release package with a component tag must configure a non-empty component')
  }
  return `${component}${packageConfig['tag-separator'] ?? '-'}${versionPart}`
}

export function changedManifestVersions(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed = []
  for (const packagePath of [...paths].sort()) {
    if (before[packagePath] === after[packagePath]) continue
    if (typeof after[packagePath] !== 'string') {
      throw new Error(`release manifest removed ${packagePath}; cannot determine its expected tag`)
    }
    changed.push({path: packagePath, before: before[packagePath], version: after[packagePath]})
  }
  return changed
}

export function verifyReleasePleaseOutput({before, after, config, outputs, sha}) {
  const expected = changedManifestVersions(before, after).map((release) => {
    const packageConfig = config.packages?.[release.path]
    if (packageConfig === undefined) {
      throw new Error(`release manifest changed unconfigured package ${release.path}`)
    }
    return {...release, tag: expectedTag(packageConfig, release.version)}
  })

  if (expected.length === 0) return []
  if (!enabled(outputs.releasesCreated)) {
    throw new Error(
      `release manifest advanced ${expected.map(release => release.path).join(', ')}, ` +
      'but release-please reported no release; refusing a successful workflow run',
    )
  }

  for (const release of expected) {
    const actual = outputs.packages?.[release.path]
    if (!enabled(actual?.created)) {
      throw new Error(`${release.path} advanced to ${release.version}, but no package release was created`)
    }
    if (actual.tag !== release.tag) {
      throw new Error(
        `${release.path} advanced to ${release.version}, but release-please reported tag ` +
        `${actual.tag || '(none)'} instead of ${release.tag}`,
      )
    }
    if (actual.sha !== sha) {
      throw new Error(
        `${release.path} release ${release.tag} targets ${actual.sha || '(no SHA)'} instead of ${sha}`,
      )
    }
  }

  return expected
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readJsonAtRef(ref, path) {
  return JSON.parse(execFileSync('git', ['show', `${ref}:${path}`], {encoding: 'utf8'}))
}

if (process.argv[1]?.endsWith('verify-release-please-output.mjs')) {
  const beforeRef = process.argv[2]
  if (typeof beforeRef !== 'string' || beforeRef.length === 0) {
    console.error('usage: node scripts/verify-release-please-output.mjs <before-ref>')
    process.exit(2)
  }

  try {
    const expected = verifyReleasePleaseOutput({
      before: readJsonAtRef(beforeRef, '.release-please-manifest.json'),
      after: readJson('.release-please-manifest.json'),
      config: readJson('release-please-config.json'),
      sha: process.env.CURRENT_SHA,
      outputs: {
        releasesCreated: process.env.RELEASES_CREATED,
        packages: {
          'apps/cli': {
            created: process.env.CLI_RELEASE_CREATED,
            tag: process.env.CLI_TAG,
            sha: process.env.CLI_SHA,
          },
          'packages/protocol': {
            created: process.env.PROTOCOL_RELEASE_CREATED,
            tag: process.env.PROTOCOL_TAG,
            sha: process.env.PROTOCOL_SHA,
          },
        },
      },
    })
    if (expected.length === 0) {
      console.log('No release manifest version changed on this push.')
    } else {
      console.log(`Verified release-please outputs: ${expected.map(release => release.tag).join(', ')}`)
    }
  } catch (error) {
    console.error(`Release output verification failed: ${error.message}`)
    process.exit(1)
  }
}
