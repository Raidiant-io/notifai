#!/usr/bin/env node
/**
 * Decide which packages a tag-triggered trusted-publishing run may publish.
 *
 * The two release-please tags can arrive seconds apart. A run may publish a
 * package only when that package's exact version tag already points at the
 * checked-out commit; the CLI additionally waits for its exact protocol
 * dependency to be published or planned in this run.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from './cross-platform.mjs'

const CLI_NAME = '@raidiant/notifai'
const PROTOCOL_NAME = '@raidiant/notifai-protocol'

export function planPublish({ head, refName, packages, tagCommits, published }) {
  const trigger = packages.find((entry) => entry.tag === refName)
  if (trigger === undefined || tagCommits.get(refName) !== head) {
    throw new Error('the triggering tag must name a package version at the checked-out commit')
  }

  const plan = new Map()
  for (const entry of packages) {
    const isPublished = published.has(`${entry.name}@${entry.version}`)
    const taggedHere = tagCommits.get(entry.tag) === head
    plan.set(entry.name, {
      publish: !isPublished && taggedHere,
      verify: (!isPublished && taggedHere) || entry.name === trigger.name,
    })
  }

  const cli = packages.find((entry) => entry.name === CLI_NAME)
  const protocol = packages.find((entry) => entry.name === PROTOCOL_NAME)
  if (cli === undefined || protocol === undefined) throw new Error('publishable package set is incomplete')
  if (plan.get(CLI_NAME)?.publish) {
    const protocolReady =
      published.has(`${PROTOCOL_NAME}@${protocol.version}`) || plan.get(PROTOCOL_NAME)?.publish === true
    if (!protocolReady) {
      throw new Error(`the CLI cannot publish before ${PROTOCOL_NAME}@${protocol.version}`)
    }
  }
  return plan
}

async function registryVersions(packages) {
  const published = new Set()
  for (const entry of packages) {
    const name = encodeURIComponent(entry.name)
    const version = encodeURIComponent(entry.version)
    const response = await fetch(`https://registry.npmjs.org/${name}/${version}`)
    if (response.status === 200) published.add(`${entry.name}@${entry.version}`)
    else if (response.status !== 404) {
      throw new Error(`npm registry lookup failed for ${entry.name}@${entry.version} (HTTP ${response.status})`)
    }
  }
  return published
}

function commitForTag(tag) {
  try {
    return execFileSync('git', ['rev-list', '-n', '1', `refs/tags/${tag}`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

async function main() {
  const cli = JSON.parse(readFileSync(path.join(repositoryRoot, 'apps/cli/package.json'), 'utf8'))
  const protocol = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'packages/protocol/package.json'), 'utf8'),
  )
  const packages = [
    { name: PROTOCOL_NAME, version: protocol.version, tag: `protocol-v${protocol.version}` },
    { name: CLI_NAME, version: cli.version, tag: `v${cli.version}` },
  ]
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim()
  const tagCommits = new Map(packages.map((entry) => [entry.tag, commitForTag(entry.tag)]))
  const plan = planPublish({
    head,
    refName: process.env.GITHUB_REF_NAME ?? '',
    packages,
    tagCommits,
    published: await registryVersions(packages),
  })

  const outputs = [
    ['publish_protocol', plan.get(PROTOCOL_NAME)?.publish === true],
    ['verify_protocol', plan.get(PROTOCOL_NAME)?.verify === true],
    ['publish_cli', plan.get(CLI_NAME)?.publish === true],
    ['verify_cli', plan.get(CLI_NAME)?.verify === true],
  ]
  const outputFile = process.env.GITHUB_OUTPUT
  if (outputFile === undefined || outputFile === '') {
    console.log(Object.fromEntries(outputs))
    return
  }
  appendFileSync(outputFile, `${outputs.map(([key, value]) => `${key}=${value}`).join('\n')}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()
}
