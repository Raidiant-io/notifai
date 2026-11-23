import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { equivalentBetas, inputDigest, inputPath, validateReceipt, admitSourceJob, findReceipt, githubReader, ReceiptLookupUnavailable } from './release-receipt.mjs'
import { nativeTargets } from './require-native-evidence.mjs'
const sha = 'a'.repeat(40), digest = 'b'.repeat(64)
test('documentation movement is excluded; shipped inputs and release tools are included', () => {
  assert.equal(inputPath('docs/RELEASING.md'), false)
  for (const file of ['docs/TRUST.md','docs/USAGE.md','apps/cli/src/main.ts','skills/notifai/SKILL.md','pnpm-lock.yaml','.github/workflows/publish.yml','scripts/release-receipt.mjs']) assert.equal(inputPath(file), true)
})
test('receipt reuse rejects changed input or unsuccessful evidence', () => {
  const receipt = { schema:1,kind:'source',ok:true,input_digest:digest,source_revision:sha }
  assert.equal(validateReceipt(receipt,digest),receipt)
  assert.throws(()=>validateReceipt(receipt,'c'.repeat(64)))
  assert.throws(()=>validateReceipt({...receipt,ok:false},digest))
})
test('failed sibling jobs do not discard successful source proof; foreign or failed source does', () => {
  const run={head_sha:sha,head_repository:{full_name:'Raidiant-io/notifai'},path:'.github/workflows/publish.yml',event:'workflow_dispatch',conclusion:'failure'}
  const jobs=[{name:'source',conclusion:'success'},{name:'native',conclusion:'failure'}]
  const artifact={name:`release-source-${sha}`,expired:false,digest:`sha256:${digest}`}
  assert.equal(admitSourceJob(run,jobs,artifact),artifact)
  assert.throws(()=>admitSourceJob({...run,event:'pull_request'},jobs,artifact))
  assert.throws(()=>admitSourceJob(run,[{name:'source',conclusion:'failure'}],artifact))
  assert.throws(()=>admitSourceJob(run,jobs,{...artifact,expired:true}))
})

const run = (id, conclusion = 'success') => ({ id, head_sha: sha, head_repository: { full_name: 'Raidiant-io/notifai' }, path: '.github/workflows/publish.yml', event: 'workflow_dispatch', conclusion })
const artifact = { id: 7, name: `release-source-${sha}`, expired: false, digest: `sha256:${digest}` }
const receipt = { schema: 1, kind: 'source', ok: true, input_digest: digest, source_revision: sha }

test('Stable reconstructs only the highest matching Beta source digest across release metadata', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'receipt-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.org',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' }).trim()
  const write = (file, content) => writeFileSync(path.join(root, file), content)
  const metadata = (version, manifestVersion) => {
    write('apps/cli/package.json', JSON.stringify({ version, scripts: { test: 'test' } }))
    write('.release-please-manifest.json', JSON.stringify({ 'apps/cli': manifestVersion, 'packages/protocol': '1.0.0' }))
    write('README.md', `Read this <!--x-release-please-start-notifai-->${version}<!--x-release-please-end-->`)
    write('apps/cli/CHANGELOG.md', `Release notes for ${version}`)
  }
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture') }
  git('init', '-q')
  mkdirSync(path.join(root, 'apps/cli'), { recursive: true })
  write('code.js', 'true')
  metadata('1.2.0-beta.10', '1.1.0')
  commit()
  const betaSha = git('rev-parse', 'HEAD'), betaDigest = inputDigest(root)
  for (const tag of ['v1.2.0-beta.2', 'v1.2.0-beta.10', 'v1.3.0-beta.1']) git('tag', tag)
  metadata('1.2.0', '1.2.0')
  commit()
  const stable = git('rev-parse', 'HEAD')
  const match = () => equivalentBetas(root, 'v1.2.0').next().value ?? null
  assert.notEqual(inputDigest(root), betaDigest)
  assert.deepEqual(match(), { tag: 'v1.2.0-beta.10', sha: betaSha, digest: betaDigest })
  assert.deepEqual([...equivalentBetas(root, 'v1.2.1')], [])
  for (const change of [
    () => write('apps/cli/package.json', '{"version":"1.2.0","scripts":{"test":"different"}}'),
    () => write('.release-please-manifest.json', '{"apps/cli":"1.2.0","packages/protocol":"1.1.0"}'),
    () => write('README.md', 'different guidance'),
    () => write('code.js', 'false'),
  ]) {
    change()
    commit()
    assert.equal(match(), null)
    git('reset', '--hard', stable)
  }
  git('update-index', '--chmod=+x', 'apps/cli/CHANGELOG.md')
  git('commit', '-qm', 'mode change')
  assert.equal(match(), null)
})

test('cross-version reuse requires the accepted Beta tag, promotion and all six installs in the same run', () => {
  const beta = { sha, tag: 'v1.2.0-beta.1', digest }
  const accepted = { ...run(10), status: 'completed', head_branch: beta.tag }
  const names = ['release-admission', 'source', 'npm', 'promote-npm', 'promote-native', 'release-result',
    ...nativeTargets.map(target => `npm adapter (${target})`)]
  const fixture = { run: accepted, jobs: names.map(name => ({ name, conclusion: 'success' })), receipt,
    artifacts: [artifact, ...nativeTargets.map((target, index) => ({ ...artifact, id: 100 + index,
      name: `npm-native-acceptance-${target}-${sha}`, size_in_bytes: 1024 }))] }
  function find(data, betas = [beta]) {
    const api = url => {
      if (url.includes('status=success')) return { workflow_runs: [data.run] }
      if (url.includes('/artifacts?')) return { artifacts: data.artifacts, total_count: data.artifacts.length }
      if (url.includes('/jobs?')) return { jobs: data.jobs, total_count: data.jobs.length }
      return { workflow_runs: [] }
    }
    return findReceipt({ digest: 'c'.repeat(64), betas, api, download: () => data.receipt })
  }
  const newerUnaccepted = { ...beta, tag: 'v1.2.0-beta.2' }
  assert.deepEqual(find(fixture, [newerUnaccepted, beta]).accepted_beta, { tag: beta.tag, source_revision: sha, run_id: 10 })
  for (const change of [
    f => { f.run.head_sha = 'd'.repeat(40) },
    f => { f.run.head_branch = 'main' },
    f => { f.run.head_repository.full_name = 'fork/notifai' },
    f => { f.run.conclusion = 'failure' },
    f => { f.jobs.find(job => job.name === 'promote-native').conclusion = 'skipped' },
    f => { f.jobs.pop() },
    f => { f.artifacts.at(-1).expired = true },
    f => { f.artifacts[0].expired = true },
    f => { f.receipt.input_digest = 'c'.repeat(64) },
    f => { f.receipt.source_revision = 'd'.repeat(40) },
  ]) {
    const changed = structuredClone(fixture)
    change(changed)
    assert.equal(find(changed), null)
  }
})
function lookup({ receipts }) {
  const requests = []
  const api = suffix => {
    requests.push(suffix)
    if (suffix.startsWith('actions/workflows/')) return { workflow_runs: [run(3), run(2), run(1)] }
    if (suffix.endsWith('/artifacts?per_page=100')) return { artifacts: [artifact] }
    return { total_count: 1, jobs: [{ name: 'source', conclusion: 'success' }] }
  }
  const download = () => receipts.shift()
  return { requests, api, download }
}
test('job listings are read only for a receipt whose inputs match', () => {
  const l = lookup({ receipts: [{ ...receipt, input_digest: 'c'.repeat(64) }, receipt] })
  assert.deepEqual(findReceipt({ digest, ...l, currentRun: '3' }), { ...receipt, reused_from_run: 1, reuse: 'exact' })
  assert.deepEqual(l.requests.filter(r => r.includes('/jobs')), ['actions/runs/1/jobs?filter=latest&per_page=100'])
  const none = lookup({ receipts: [{ ...receipt, input_digest: 'c'.repeat(64) }, { ...receipt, input_digest: 'd'.repeat(64) }] })
  assert.equal(findReceipt({ digest, ...none, currentRun: '3' }), null)
  assert.ok(!none.requests.some(r => r.includes('/jobs')))
})
test('a matching receipt is still admitted only from a successful source job', () => {
  const l = lookup({ receipts: [receipt] })
  l.api = (api => suffix => suffix.includes('/jobs') ? { total_count: 1, jobs: [{ name: 'source', conclusion: 'failure' }] } : api(suffix))(l.api)
  assert.throws(() => findReceipt({ digest, ...l, currentRun: '3' }))
})
test('a Stable consumer receipt cannot renew expired Beta evidence as an exact-input hit', () => {
  const derived = { ...receipt, reuse: 'beta', accepted_beta: { tag: 'v1.2.0-beta.1', source_revision: 'd'.repeat(40), run_id: 10 } }
  const l = lookup({ receipts: [derived, derived] })
  assert.equal(findReceipt({ digest, ...l, currentRun: '3' }), null)
})
test('GitHub 5xx and timeouts are retried with a log line; other failures are not', () => {
  const fail = stderr => Object.assign(new Error('Command failed'), { status: 1, stderr })
  let calls = 0
  const logs = [], waits = []
  const flaky = githubReader({ exec: () => { calls += 1; if (calls < 3) throw fail('gh: Server Error (HTTP 502)\n'); return 'ok' }, wait: ms => waits.push(ms), log: m => logs.push(m) })
  assert.equal(flaky(['api', 'x']), 'ok')
  assert.deepEqual(waits, [3000, 10000])
  assert.match(logs[0], /HTTP 502.*retrying in 3s \(attempt 2 of 3\)/)
  const down = githubReader({ exec: () => { throw fail('gh: Server Error (HTTP 503)\n') }, wait: () => {}, log: () => {} })
  assert.throws(() => down(['api', 'x']), ReceiptLookupUnavailable)
  const timeout = githubReader({ exec: () => { throw Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }) }, wait: () => {}, log: () => {} })
  assert.throws(() => timeout(['api', 'x']), ReceiptLookupUnavailable)
  let denied = 0
  const forbidden = githubReader({ exec: () => { denied += 1; throw fail('gh: Resource not accessible by integration (HTTP 403)\n') }, wait: () => {}, log: () => {} })
  assert.throws(() => forbidden(['api', 'x']), /Command failed/)
  assert.equal(denied, 1)
})
