#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DEFAULT_INPUT_ROOTS = [
  'apps/cli/src',
  'packages/protocol/src',
  'skills/notifai',
  'skills/guidance-changes.json',
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

const RELEASE_VERSION_MARKER =
  /<!--x-release-please-start-([^>]+)-->(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)<!--x-release-please-end-->/g

function behaviorInput(relative, contents) {
  if (relative !== 'README.md') return contents
  return contents.replace(
    RELEASE_VERSION_MARKER,
    '<!--x-release-please-start-$1--><generated-version><!--x-release-please-end-->',
  )
}

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
    .map((file) => file.split(path.sep).join('/'))
    .sort()
  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(file)
    digest.update('\0')
    digest.update(behaviorInput(file, readFileSync(path.join(repo, file), 'utf8')))
    digest.update('\0')
  }
  return `sha256:${digest.digest('hex')}`
}

/** Compare inputs with the commit that last recorded a review, including local edits. */
export function changedInputs(repo, recordPath, inputRoots = DEFAULT_INPUT_ROOTS) {
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    const reviewed = git(['log', '-1', '--format=%H', '--', path.relative(repo, recordPath)]).trim()
    if (!reviewed) return ['(review baseline unavailable; inspect all input roots)']
    const candidates = new Set([
      ...git(['diff', '--name-only', reviewed, '--', ...inputRoots]).split('\n'),
      ...git(['ls-files', '--others', '--exclude-standard', '--', ...inputRoots]).split('\n'),
    ])
    return [...candidates].filter(file => {
      if (!file || file.endsWith('.test.ts') || file.endsWith('.test.mjs')) return false
      try {
        return behaviorInput(file, git(['show', `${reviewed}:${file}`])) !==
          behaviorInput(file, readFileSync(path.join(repo, file), 'utf8'))
      } catch { return true } // Added or removed input.
    }).sort()
  } catch { return ['(Git review baseline unavailable; inspect all input roots)'] }
}

function reviewHelp(repo, recordPath, inputRoots) {
  return [
    'Changed behavior input paths since the recorded review:',
    ...changedInputs(repo, recordPath, inputRoots).map(file => `  ${file}`),
    `Required review surfaces: ${REQUIRED_SURFACES.join(', ')}`,
    'After reviewing, obtain the current digest: node scripts/check-agent-guidance.mjs --print',
    'Update agent-guidance-review.json with that digest, an explicit outcome, reason, and all surfaces reviewed.',
    'Validate the refreshed record: pnpm check:agent-guidance',
    'Procedure: docs/AGENT-GUIDANCE-REVIEW.md. No digest is approved automatically.',
  ].join('\n')
}

export function checkAgentGuidance({ repo, recordPath, inputRoots = DEFAULT_INPUT_ROOTS }) {
  const actual = behaviorDigest(repo, inputRoots)
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  if (record.behavior_digest !== actual) {
    throw new Error([
      'Agent Guidance review is stale: shipped agent behavior inputs changed.',
      `expected ${record.behavior_digest}`,
      `actual   ${actual}`,
      reviewHelp(repo, recordPath, inputRoots),
    ].join('\n'))
  }
  if (!['guidance-updated', 'reviewed-no-impact'].includes(record.outcome)) {
    throw new Error(`Agent Guidance review outcome must be guidance-updated or reviewed-no-impact.\n${reviewHelp(repo, recordPath, inputRoots)}`)
  }
  if (typeof record.reason !== 'string' || record.reason.trim().length < 20) {
    throw new Error(`Agent Guidance review needs a concrete review reason (at least 20 characters).\n${reviewHelp(repo, recordPath, inputRoots)}`)
  }
  for (const surface of REQUIRED_SURFACES) {
    if (!record.surfaces_reviewed?.includes(surface)) {
      throw new Error(`Agent Guidance review did not review required surface: ${surface}\n${reviewHelp(repo, recordPath, inputRoots)}`)
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
