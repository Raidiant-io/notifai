#!/usr/bin/env node
// Source receipts are reusable only from authenticated first-party workflow jobs.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function inputPath(file) {
  // Documentation outside shipped materials is deliberately not a test input.
  // Everything else, including tests, workflows, tools and dependency pins is.
  // docs/USAGE.md is read by check-release, so it counts too.
  return !(file.startsWith('docs/') && !['docs/TRUST.md', 'docs/USAGE.md'].includes(file)) &&
    !['AGENTS.md', 'CLAUDE.md', 'agent-guidance-review.json'].includes(file)
}
export function inputDigest(root = process.cwd()) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean).filter(inputPath).sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file).update('\0').update(readFileSync(path.join(root, file))).update('\0')
  }
  return hash.digest('hex')
}
export function validateReceipt(receipt, digest) {
  assert.equal(receipt.schema, 1)
  assert.equal(receipt.kind, 'source')
  assert.equal(receipt.input_digest, digest, 'Release inputs changed')
  assert.equal(receipt.ok, true)
  assert.match(receipt.source_revision, /^[a-f0-9]{40}$/)
  return receipt
}
export function admitSourceJob(run, jobs, artifact) {
  assert.equal(run.head_repository?.full_name, 'Raidiant-io/notifai')
  assert.equal(run.path, '.github/workflows/publish.yml')
  assert.equal(run.event, 'workflow_dispatch')
  assert.ok(jobs.some(job => job.name === 'source' && job.conclusion === 'success'), 'Source job did not pass')
  assert.equal(artifact.name, `release-source-${run.head_sha}`)
  assert.equal(artifact.expired, false)
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/)
  return artifact
}
async function restore(file) {
  const digest = inputDigest()
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
  const api = suffix => JSON.parse(gh(['api', `repos/Raidiant-io/notifai/${suffix}`]))
  const runs = api('actions/workflows/publish.yml/runs?event=workflow_dispatch&per_page=30').workflow_runs
  for (const run of runs) {
    if (String(run.id) === process.env.GITHUB_RUN_ID) continue
    const artifacts = api(`actions/runs/${run.id}/artifacts?per_page=100`)
    const artifact = artifacts.artifacts.find(a => a.name === `release-source-${run.head_sha}` && !a.expired)
    if (!artifact) continue
    const jobs = api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`)
    assert.equal(jobs.jobs.length, jobs.total_count, 'Incomplete job evidence')
    admitSourceJob(run, jobs.jobs, artifact)
    const dir = mkdtempSync(path.join(os.tmpdir(), 'release-source-'))
    try {
      const archive = execFileSync('gh', ['api', `repos/Raidiant-io/notifai/actions/artifacts/${artifact.id}/zip`], { timeout: 30_000, maxBuffer: 1024 * 1024 })
      assert.equal(`sha256:${createHash('sha256').update(archive).digest('hex')}`, artifact.digest, 'Receipt archive digest differs')
      writeFileSync(path.join(dir, 'receipt.zip'), archive)
      const contents = execFileSync('unzip', ['-p', path.join(dir, 'receipt.zip'), 'release-source.json'], { maxBuffer: 64 * 1024 })
      writeFileSync(path.join(dir, 'release-source.json'), contents)
      const receipt = JSON.parse(readFileSync(path.join(dir, 'release-source.json'), 'utf8'))
      if (receipt.input_digest !== digest) continue
      validateReceipt(receipt, digest)
      assert.equal(receipt.source_revision, run.head_sha)
      writeFileSync(file, JSON.stringify({ ...receipt, reused_from_run: run.id }) + '\n')
      return true
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  return false
}
async function main() {
  const [command, kind, file] = process.argv.slice(2)
  if (command === 'scope') {
    const { version } = JSON.parse(readFileSync('apps/cli/package.json', 'utf8'))
    assert.equal(process.env.GITHUB_REF, `refs/tags/v${version}`)
    assert.ok(['none','beta','stable'].includes(kind))
    assert.match(version, /^\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$/)
    assert.ok(kind !== 'stable' || !version.includes('-'), 'Stable cannot expose beta bytes')
    assert.ok(kind !== 'beta' || version.includes('-beta.'), 'Beta requires a beta version')
  } else if (command === 'restore') {
    const reused = await restore(kind)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `reused=${reused}\n`)
  } else if (command === 'write') {
    assert.equal(kind, 'source')
    const receipt = { schema: 1, kind, ok: true, input_digest: inputDigest(), source_revision: process.env.GITHUB_SHA }
    validateReceipt(receipt, receipt.input_digest)
    writeFileSync(file, JSON.stringify(receipt) + '\n')
  } else throw new Error('Expected scope, restore or write')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
