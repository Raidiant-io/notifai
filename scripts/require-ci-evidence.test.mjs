import assert from 'node:assert/strict'
import test from 'node:test'
import {validateCiEvidence} from './require-ci-evidence.mjs'

const sha = 'a'.repeat(40)
const run = {id: 42, head_sha: sha, status: 'completed', conclusion: 'success'}
const jobs = [
  {name: 'scope', conclusion: 'success'},
  {name: 'gates', conclusion: 'success'},
  {name: 'platform (macos-latest)', conclusion: 'skipped'},
  {name: 'platform (windows-2025)', conclusion: 'success'},
  {name: 'platform (windows-11-arm)', conclusion: 'success'},
]

test('accepts one exact-SHA run whose applicable evidence succeeded', () => {
  assert.equal(validateCiEvidence({runs: [run], jobs, expectedSha: sha}), run)
})

test('fails closed on absent or ambiguous exact-SHA CI runs', () => {
  assert.throws(
    () => validateCiEvidence({runs: [], jobs, expectedSha: sha}),
    /Run CI manually at the exact SHA/,
  )
  assert.throws(
    () => validateCiEvidence({runs: [run, {...run, id: 43}], jobs, expectedSha: sha}),
    /found 2/,
  )
})

test('requires gates and every explicit native context', () => {
  assert.throws(
    () => validateCiEvidence({
      runs: [run],
      jobs: jobs.map(job => job.name === 'gates' ? {...job, conclusion: 'failure'} : job),
      expectedSha: sha,
    }),
    /gates must succeed/,
  )
  assert.throws(
    () => validateCiEvidence({
      runs: [run],
      jobs: jobs.filter(job => job.name !== 'platform \(macos-latest\)'),
      expectedSha: sha,
    }),
    /platform \(macos-latest\)/,
  )
})
