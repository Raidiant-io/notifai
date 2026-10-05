#!/usr/bin/env node
/** Admit exactly the npm package named by this immutable release tag. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from './cross-platform.mjs'
import { PUBLISHABLE_PACKAGES } from './package-contract.mjs'
import { publicationLane } from './publication-lane.mjs'

export function planPublish({ head, refName, packages, tagCommits, published }) {
  const trigger = packages.find(entry => entry.tag === refName)
  if (!trigger || tagCommits.get(refName) !== head) {
    throw new Error('the triggering tag must name an npm package version at the checked-out commit')
  }
  const npmDistTag = publicationLane(trigger.version)
  return { ...trigger, npmDistTag, publish: !published.has(`${trigger.name}@${trigger.version}`) }
}

async function main() {
  const packages = PUBLISHABLE_PACKAGES.map(entry => {
    const { version } = JSON.parse(readFileSync(path.join(repositoryRoot, entry.directory, 'package.json'), 'utf8'))
    const component = entry.directory === 'packages/protocol' ? 'protocol' : 'installer'
    return { ...entry, version, tag: `${component}-v${version}` }
  })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const refName = process.env.GITHUB_REF_NAME
  const trigger = packages.find(entry => entry.tag === refName)
  if (!trigger) throw new Error('Only protocol and installer package tags may publish to npm')
  const tagCommit = execFileSync('git', ['rev-list', '-n', '1', `refs/tags/${refName}`], { encoding: 'utf8' }).trim()
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(trigger.name)}/${encodeURIComponent(trigger.version)}`, {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  if (![200, 404].includes(response.status)) throw new Error(`npm registry lookup failed (HTTP ${response.status})`)
  const plan = planPublish({ head, refName, packages, tagCommits: new Map([[refName, tagCommit]]),
    published: new Set(response.ok ? [`${trigger.name}@${trigger.version}`] : []) })
  const outputs = { package_name: plan.name, package_directory: plan.directory, version: plan.version,
    npm_dist_tag: plan.npmDistTag, publish: plan.publish }
  if (!process.env.GITHUB_OUTPUT) console.log(outputs)
  else appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
