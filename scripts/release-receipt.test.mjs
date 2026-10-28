import assert from 'node:assert/strict'
import test from 'node:test'
import { inputPath, validateReceipt, admitSourceJob, findReceipt, githubReader, ReceiptLookupUnavailable } from './release-receipt.mjs'
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
  assert.deepEqual(findReceipt({ digest, ...l, currentRun: '3' }), { ...receipt, reused_from_run: 1 })
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
