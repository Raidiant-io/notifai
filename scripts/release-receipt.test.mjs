import assert from 'node:assert/strict'
import test from 'node:test'
import { inputPath, validateReceipt, admitSourceJob } from './release-receipt.mjs'
const sha = 'a'.repeat(40), digest = 'b'.repeat(64)
test('documentation movement is excluded; shipped inputs and release tools are included', () => {
  assert.equal(inputPath('docs/RELEASING.md'), false)
  for (const file of ['docs/TRUST.md','apps/cli/src/main.ts','skills/notifai/SKILL.md','pnpm-lock.yaml','.github/workflows/publish.yml','scripts/release-receipt.mjs']) assert.equal(inputPath(file), true)
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
