#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from './cross-platform.mjs'
import { publicationLane, requireBetaAheadOfLatest } from './publication-lane.mjs'

const PACKAGES = new Map([
  ['@raidiant/notifai', 'apps/cli/package.json'],
  ['@raidiant/notifai-protocol', 'packages/protocol/package.json'],
])

export async function registryDistTags(name, fetchImpl = fetch) {
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 404) return {}
  if (!response.ok) throw new Error(`npm distribution lookup failed for ${name} (HTTP ${response.status})`)
  const tags = (await response.json())['dist-tags']
  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) {
    throw new Error(`npm distribution tags missing for ${name}`)
  }
  for (const [tag, version] of Object.entries(tags)) {
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error(`invalid npm distribution tag ${tag} for ${name}`)
    }
  }
  return tags
}

export function verifyDistribution({ name, version, before, after, distTag = publicationLane(version) }) {
  const lane = publicationLane(version)
  if (distTag.startsWith('candidate-')) {
    if (distTag !== `candidate-${version}` || after[distTag] !== version) throw new Error('Candidate tag must name the exact version')
    for (const tag of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (tag !== distTag && before[tag] !== after[tag]) throw new Error(`Candidate publication changed npm ${tag}`)
    }
    return
  }
  if (distTag !== lane) throw new Error('Promotion must use the version audience')
  for (const tag of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (tag !== lane && before[tag] !== after[tag]) throw new Error(`Promotion changed unrelated npm ${tag}`)
  }
  if (lane === 'beta') {
    if (before.latest !== undefined) requireBetaAheadOfLatest(version, before.latest)
    if (before.latest !== after.latest) {
      throw new Error(`${name}@${version} changed npm latest while publishing beta`)
    }
    if (after.beta !== version) {
      throw new Error(`${name}@${version} did not become npm beta`)
    }
  } else if (after.latest !== version) {
    throw new Error(`${name}@${version} did not become npm latest`)
  }
}

async function main() {
  const [command, file, name] = process.argv.slice(2)
  if (!['snapshot', 'verify'].includes(command) || !file || !PACKAGES.has(name)) {
    throw new Error('usage: verify-npm-distribution.mjs snapshot|verify <snapshot-file> <package-name>')
  }
  if (command === 'snapshot') {
    const snapshot = { [name]: await registryDistTags(name) }
    const { version } = JSON.parse(readFileSync(path.join(repositoryRoot, PACKAGES.get(name)), 'utf8'))
    if (snapshot[name].latest !== undefined) requireBetaAheadOfLatest(version, snapshot[name].latest)
    writeFileSync(file, JSON.stringify(snapshot))
    return
  }
  const before = JSON.parse(readFileSync(file, 'utf8'))[name]
  if (before === undefined) throw new Error(`missing npm distribution snapshot for ${name}`)
  const { version } = JSON.parse(readFileSync(path.join(repositoryRoot, PACKAGES.get(name)), 'utf8'))
  verifyDistribution({ name, version, before, after: await registryDistTags(name), distTag: process.env.NPM_DIST_TAG ?? publicationLane(version) })
  console.log(`Verified npm ${publicationLane(version)} distribution for ${name}@${version}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()
}
