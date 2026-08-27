#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const recordPath = path.join(repo, 'agent-guidance-review.json')
const roots = [
  'apps/cli/src',
  'packages/protocol/src',
  'skills/notifai',
  'README.md',
  'docs/TRUST.md',
]

function filesUnder(relative) {
  const absolute = path.join(repo, relative)
  const stat = statSync(absolute)
  if (stat.isFile()) return [relative]
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => filesUnder(path.join(relative, entry.name)))
}

const files = roots
  .flatMap(filesUnder)
  .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.mjs'))
  .sort()
const digest = createHash('sha256')
for (const file of files) {
  digest.update(file)
  digest.update('\0')
  digest.update(readFileSync(path.join(repo, file)))
  digest.update('\0')
}
const actual = `sha256:${digest.digest('hex')}`

if (process.argv.includes('--print')) {
  process.stdout.write(`${actual}\n`)
  process.exit(0)
}

const record = JSON.parse(readFileSync(recordPath, 'utf8'))
if (record.behavior_digest !== actual) {
  console.error('Agent Guidance review is stale: shipped agent behavior inputs changed.')
  console.error(`expected ${record.behavior_digest}`)
  console.error(`actual   ${actual}`)
  console.error('Review every shipped Agent Guidance surface, then update agent-guidance-review.json with the exact digest, outcome, and reason.')
  process.exit(1)
}
if (!['guidance-updated', 'reviewed-no-impact'].includes(record.outcome)) {
  console.error('agent-guidance-review.json outcome must be guidance-updated or reviewed-no-impact.')
  process.exit(1)
}
if (typeof record.reason !== 'string' || record.reason.trim().length < 20) {
  console.error('agent-guidance-review.json needs a concrete review reason (at least 20 characters).')
  process.exit(1)
}
for (const surface of ['lifecycle-hooks', 'notifai-skill', 'harness-setup', 'cli-readiness', 'domain-terms']) {
  if (!record.surfaces_reviewed?.includes(surface)) {
    console.error(`agent-guidance-review.json did not review required surface: ${surface}`)
    process.exit(1)
  }
}
console.log(`Agent Guidance review current (${actual}).`)
