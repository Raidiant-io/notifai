#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DEFAULT_INPUT_ROOTS = [
  'apps/cli/src',
  'packages/protocol/src',
  'skills/notifai',
  'README.md',
  'docs/TRUST.md',
]

export const REQUIRED_SURFACES = [
  'lifecycle-hooks',
  'notifai-skill',
  'harness-setup',
  'cli-readiness',
  'domain-terms',
]

function filesUnder(repo, relative) {
  const absolute = path.join(repo, relative)
  const stat = statSync(absolute)
  if (stat.isFile()) return [relative]
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => filesUnder(repo, path.join(relative, entry.name)))
}

export function behaviorDigest(repo, inputRoots = DEFAULT_INPUT_ROOTS) {
  const files = inputRoots
    .flatMap((relative) => filesUnder(repo, relative))
    .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.mjs'))
    .sort()
  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(file)
    digest.update('\0')
    digest.update(readFileSync(path.join(repo, file)))
    digest.update('\0')
  }
  return `sha256:${digest.digest('hex')}`
}

export function checkAgentGuidance({ repo, recordPath, inputRoots = DEFAULT_INPUT_ROOTS }) {
  const actual = behaviorDigest(repo, inputRoots)
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  if (record.behavior_digest !== actual) {
    throw new Error([
      'Agent Guidance review is stale: shipped agent behavior inputs changed.',
      `expected ${record.behavior_digest}`,
      `actual   ${actual}`,
      'Review every shipped Agent Guidance surface, then update the review record with the exact digest, outcome, and reason.',
    ].join('\n'))
  }
  if (!['guidance-updated', 'reviewed-no-impact'].includes(record.outcome)) {
    throw new Error('Agent Guidance review outcome must be guidance-updated or reviewed-no-impact.')
  }
  if (typeof record.reason !== 'string' || record.reason.trim().length < 20) {
    throw new Error('Agent Guidance review needs a concrete review reason (at least 20 characters).')
  }
  for (const surface of REQUIRED_SURFACES) {
    if (!record.surfaces_reviewed?.includes(surface)) {
      throw new Error(`Agent Guidance review did not review required surface: ${surface}`)
    }
  }
  return { actual, record }
}

function parseArgs(argv) {
  const publicRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const options = {
    repo: publicRepo,
    record: 'agent-guidance-review.json',
    roots: [],
    print: false,
  }
  const args = [...argv]
  while (args.length > 0) {
    const flag = args.shift()
    if (flag === '--print') {
      options.print = true
      continue
    }
    const value = args.shift()
    if (!value) throw new Error(`${flag} requires a value`)
    if (flag === '--repo') options.repo = path.resolve(value)
    else if (flag === '--record') options.record = value
    else if (flag === '--root') options.roots.push(value)
    else throw new Error(`unknown option: ${flag}`)
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const inputRoots = options.roots.length > 0 ? options.roots : DEFAULT_INPUT_ROOTS
  const recordPath = path.resolve(options.repo, options.record)
  if (options.print) {
    process.stdout.write(`${behaviorDigest(options.repo, inputRoots)}\n`)
    return
  }
  const { actual } = checkAgentGuidance({ repo: options.repo, recordPath, inputRoots })
  console.log(`Agent Guidance review current (${actual}).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
