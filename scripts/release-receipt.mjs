#!/usr/bin/env node
// Source receipts are reusable only from authenticated first-party workflow jobs.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { validateNativeEvidence } from './require-native-evidence.mjs'

export function inputPath(file) {
  // Documentation outside shipped materials is deliberately not a test input.
  // Everything else, including tests, workflows, tools and dependency pins is.
  // docs/USAGE.md is read by check-release, so it counts too.
  return !(file.startsWith('docs/') && !['docs/TRUST.md', 'docs/USAGE.md'].includes(file)) &&
    !['AGENTS.md', 'CLAUDE.md', 'agent-guidance-review.json'].includes(file)
}
export function inputDigest(root = process.cwd(), substitutions = new Map()) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean).filter(inputPath).sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file).update('\0').update(substitutions.get(file) ?? readFileSync(path.join(root, file))).update('\0')
  }
  return hash.digest('hex')
}

// Betas and Stable can be sibling commits. Compare their trees directly,
// including file modes, without trusting a digest supplied by the Beta to
// describe which differences are harmless.
export function* equivalentBetas(root, stableTag) {
  if (!/^v\d+\.\d+\.\d+$/.test(stableTag)) return
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const tags = git(['tag', '--list', `${stableTag}-beta.*`, '--sort=-version:refname']).trim().split('\n')
  for (const tag of tags) {
    if (!/^v\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(tag)) continue
    const candidate = equivalentBeta(root, git, stableTag, tag)
    if (candidate) yield candidate
  }
}
function equivalentBeta(root, git, stableTag, tag) {
  const sha = git(['rev-parse', `refs/tags/${tag}^{commit}`]).trim()
  const changes = git(['diff', '--no-ext-diff', '--raw', '-z', '--no-renames', '--ignore-submodules=none', sha, 'HEAD']).split('\0')
  const metadata = ['apps/cli/package.json', '.release-please-manifest.json', 'README.md', 'apps/cli/CHANGELOG.md']
  for (let i = 0; i < changes.length - 1; i += 2) {
    if (!/^:100644 100644 [0-9a-f]+ [0-9a-f]+ M$/.test(changes[i]) || !metadata.includes(changes[i + 1])) return null
  }
  const before = new Map(metadata.map(file => [file, execFileSync('git', ['show', `${sha}:${file}`], { cwd: root })]))
  const stable = stableTag.slice(1)
  const beta = tag.slice(1)
  for (const [file, field] of [['apps/cli/package.json', 'version'], ['.release-please-manifest.json', 'apps/cli']]) {
    const old = JSON.parse(before.get(file))
    const current = JSON.parse(readFileSync(path.join(root, file)))
    if (current[field] !== stable || !isDeepStrictEqual({ ...old, [field]: stable }, current)) return null
    if (field === 'version' && old[field] !== beta) return null
  }
  const marker = version => `<!--x-release-please-start-notifai-->${version}<!--x-release-please-end-->`
  const oldReadme = before.get('README.md').toString()
  if (!oldReadme.includes(marker(beta)) ||
    oldReadme.replace(marker(beta), marker(stable)) !== readFileSync(path.join(root, 'README.md'), 'utf8')) return null
  return { tag, sha, digest: inputDigest(root, before) }
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
// GitHub's Actions API intermittently answers 5xx (502 on job listings broke
// four releases). Only those, and timeouts, are retried; anything else is real.
const TRANSIENT = /\bHTTP 5\d\d\b|\bETIMEDOUT\b|\bECONNRESET\b|\bEAI_AGAIN\b/
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
export class ReceiptLookupUnavailable extends Error {}
export function githubReader({ exec = execFileSync, wait = pause, log = message => console.error(message), delays = [3000, 10000] } = {}) {
  return (args, options = {}) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return exec('gh', args, { timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], ...options })
      } catch (error) {
        const detail = `${error.code ?? ''} ${error.signal ?? ''} ${error.stderr ?? ''}`.trim()
        if (!TRANSIENT.test(detail) && !(error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM')) throw error
        const summary = detail.replace(/\s+/g, ' ').slice(0, 200)
        if (attempt >= delays.length) throw new ReceiptLookupUnavailable(`GitHub API stayed unavailable for gh ${args[1] ?? args[0]}: ${summary}`)
        log(`Source receipt lookup: GitHub API transient failure (${summary}); retrying in ${delays[attempt] / 1000}s (attempt ${attempt + 2} of ${delays.length + 1}).`)
        wait(delays[attempt])
      }
    }
  }
}
function acceptedBetaReceipt({ beta, api, download }) {
  const list = api(`actions/workflows/publish.yml/runs?event=workflow_dispatch&status=success&branch=${beta.tag}&head_sha=${beta.sha}&per_page=30`)
  for (const run of list.workflow_runs) {
    if (run.head_branch !== beta.tag || run.head_sha !== beta.sha) continue
    const artifacts = api(`actions/runs/${run.id}/artifacts?per_page=100`)
    const jobs = api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`)
    const sources = artifacts.artifacts.filter(a => a.name === `release-source-${beta.sha}`)
    if (sources.length !== 1 || jobs.jobs.length !== jobs.total_count || artifacts.artifacts.length !== artifacts.total_count) continue
    const [source] = sources
    // On an admitted Beta tag both promotions only run for channel=beta.
    const required = ['release-admission', 'release-result', 'promote-npm', 'promote-native']
    if (!required.every(name => jobs.jobs.some(job => job.name === name && job.conclusion === 'success'))) continue
    try {
      validateNativeEvidence({ run, jobs: jobs.jobs, artifacts: artifacts.artifacts, expectedSha: beta.sha, kind: 'npm' })
      admitSourceJob(run, jobs.jobs, source)
      const receipt = validateReceipt(download(source), beta.digest)
      assert.equal(receipt.source_revision, beta.sha)
      return { ...receipt, reuse: 'beta', reused_from_run: run.id,
        accepted_beta: { tag: beta.tag, source_revision: beta.sha, run_id: run.id } }
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error
      console.error(`Beta run ${run.id} is ineligible: ${error.message}`)
    }
  }
  return null
}
// Most releases change inputs, so read each candidate receipt first and list
// jobs only for the one whose inputs match. Admission stays as strict.
export function findReceipt({ digest, api, download, currentRun, betas = [] }) {
  for (const beta of betas) {
    const accepted = acceptedBetaReceipt({ beta, api, download })
    if (accepted) return accepted
  }
  const runs = api('actions/workflows/publish.yml/runs?event=workflow_dispatch&per_page=30').workflow_runs
  for (const run of runs) {
    if (String(run.id) === currentRun) continue
    const artifacts = api(`actions/runs/${run.id}/artifacts?per_page=100`)
    const artifact = artifacts.artifacts.find(a => a.name === `release-source-${run.head_sha}` && !a.expired)
    if (!artifact) continue
    const receipt = download(artifact)
    // A Stable receipt derived from Beta must requalify through Beta admission.
    if (receipt.accepted_beta || receipt.input_digest !== digest) continue
    const jobs = api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`)
    assert.equal(jobs.jobs.length, jobs.total_count, 'Incomplete job evidence')
    admitSourceJob(run, jobs.jobs, artifact)
    validateReceipt(receipt, digest)
    assert.equal(receipt.source_revision, run.head_sha)
    return { ...receipt, reused_from_run: run.id, reuse: 'exact' }
  }
  return null
}
function restore(file, channel, { gh = githubReader(), log = message => console.error(message) } = {}) {
  const digest = inputDigest()
  const api = suffix => JSON.parse(gh(['api', `repos/Raidiant-io/notifai/${suffix}`], { encoding: 'utf8' }))
  const download = artifact => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'release-source-'))
    try {
      const archive = gh(['api', `repos/Raidiant-io/notifai/actions/artifacts/${artifact.id}/zip`], { maxBuffer: 1024 * 1024 })
      assert.equal(`sha256:${createHash('sha256').update(archive).digest('hex')}`, artifact.digest, 'Receipt archive digest differs')
      writeFileSync(path.join(dir, 'receipt.zip'), archive)
      return JSON.parse(execFileSync('unzip', ['-p', path.join(dir, 'receipt.zip'), 'release-source.json'], { maxBuffer: 64 * 1024 }).toString('utf8'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  let receipt
  try {
    const betas = channel === 'stable' ? equivalentBetas(process.cwd(), process.env.GITHUB_REF_NAME) : []
    receipt = findReceipt({ digest, api, download, currentRun: process.env.GITHUB_RUN_ID, betas })
  } catch (error) {
    if (!(error instanceof ReceiptLookupUnavailable)) throw error
    // Not reusing is always safe: the full source tests run instead.
    log(`${error.message}. Running the source tests instead of reusing a receipt.`)
    return 'none'
  }
  if (!receipt) return 'none'
  const { reuse } = receipt
  log(reuse === 'beta' ? `Using source tests from accepted ${receipt.accepted_beta.tag} (run ${receipt.accepted_beta.run_id}).`
    : `Using exact-input source tests from run ${receipt.reused_from_run}.`)
  writeFileSync(file, JSON.stringify({ ...receipt, input_digest: digest, source_revision: process.env.GITHUB_SHA }) + '\n')
  return reuse
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
    const reuse = restore(kind, file)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      `tests_reused=${reuse !== 'none'}\nexact=${reuse === 'exact'}\n`)
  } else if (command === 'write') {
    assert.equal(kind, 'source')
    const receipt = { schema: 1, kind, ok: true, input_digest: inputDigest(), source_revision: process.env.GITHUB_SHA }
    validateReceipt(receipt, receipt.input_digest)
    writeFileSync(file, JSON.stringify(receipt) + '\n')
  } else throw new Error('Expected scope, restore or write')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
