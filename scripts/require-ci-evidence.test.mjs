import assert from 'node:assert/strict'
import test from 'node:test'
import {requireCiEvidence, validateCiEvidence, waitForCiEvidence} from './require-ci-evidence.mjs'

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
  assert.equal(validateCiEvidence({run, jobs, expectedSha: sha}), run)
})

test('fails closed on absent, unsuccessful or different-SHA evidence', () => {
  for (const candidate of [undefined, {...run, head_sha: 'b'.repeat(40)}, {...run, conclusion: 'failure'}]) {
    assert.throws(() => validateCiEvidence({run: candidate, jobs, expectedSha: sha}),
      /Run CI manually at the exact SHA/)
  }
})

test('requires gates and every explicit native context', () => {
  assert.throws(
    () => validateCiEvidence({
      run,
      jobs: jobs.map(job => job.name === 'gates' ? {...job, conclusion: 'failure'} : job),
      expectedSha: sha,
    }),
    /gates must succeed/,
  )
  assert.throws(
    () => validateCiEvidence({
      run,
      jobs: jobs.filter(job => job.name !== 'platform \(macos-latest\)'),
      expectedSha: sha,
    }),
    /platform \(macos-latest\)/,
  )
})

function evidenceFetcher(runPayloads) {
  return async (input) => {
    const url = String(input)
    if (url.includes('/actions/workflows/ci.yml/runs?')) {
      const payload = runPayloads.shift()
      assert.notEqual(payload, undefined, 'unexpected extra CI run poll')
      return Response.json({workflow_runs: payload})
    }
    if (url.includes('/actions/runs/42/jobs?')) {
      return Response.json({total_count: jobs.length, jobs})
    }
    return new Response('', {status: 404})
  }
}

test('waits for the existing exact-SHA CI run instead of dispatching another one', async () => {
  const sleeps = []
  const result = await waitForCiEvidence({
    repository: 'Raidiant-io/notifai',
    expectedSha: sha,
    token: 'test-token',
    fetcher: evidenceFetcher([
      [{...run, status: 'in_progress', conclusion: null}],
      [run],
    ]),
    timeoutMs: 100,
    intervalMs: 10,
    now: () => 0,
    sleep: async milliseconds => sleeps.push(milliseconds),
  })

  assert.deepEqual(result, run)
  assert.deepEqual(sleeps, [10])
})

test('stops immediately when exact-SHA CI reached a terminal failure', async () => {
  let slept = false
  await assert.rejects(
    waitForCiEvidence({
      repository: 'Raidiant-io/notifai',
      expectedSha: sha,
      token: 'test-token',
      fetcher: evidenceFetcher([[{...run, conclusion: 'failure'}]]),
      timeoutMs: 100,
      intervalMs: 10,
      now: () => 0,
      sleep: async () => { slept = true },
    }),
    /successful exact-SHA CI run is required/u,
  )
  assert.equal(slept, false)
})

test('bounds the wait when exact-SHA CI never finishes', async () => {
  let clock = 0
  const pending = [{...run, status: 'in_progress', conclusion: null}]
  await assert.rejects(
    waitForCiEvidence({
      repository: 'Raidiant-io/notifai',
      expectedSha: sha,
      token: 'test-token',
      fetcher: evidenceFetcher([pending, pending, pending]),
      timeoutMs: 20,
      intervalMs: 10,
      now: () => clock,
      sleep: async milliseconds => { clock += milliseconds },
    }),
    /timed out waiting for exact-SHA CI/u,
  )
})


test('paired tags reuse the newest successful exact-SHA run without mixing job evidence', async () => {
  const requested = []
  const newer = {...run, id: 43}
  const fetcher = async (input) => {
    const url = String(input)
    requested.push(url)
    if (url.includes('/actions/workflows/ci.yml/runs?')) {
      return Response.json({workflow_runs: [run, {...run, id: 99, head_sha: 'b'.repeat(40)}, newer]})
    }
    assert.ok(url.includes('/actions/runs/43/jobs?'))
    return Response.json({total_count: jobs.length, jobs})
  }
  assert.deepEqual(await requireCiEvidence({repository: 'Raidiant-io/notifai', expectedSha: sha,
    token: 'test-token', fetcher}), newer)
  assert.equal(requested.length, 2)
})

test('another successful run cannot fill missing jobs in the selected run', async () => {
  const fetcher = async (input) => String(input).includes('/actions/workflows/ci.yml/runs?')
    ? Response.json({workflow_runs: [run, {...run, id: 43}]})
    : Response.json({total_count: jobs.length, jobs: jobs.slice(1)})
  await assert.rejects(requireCiEvidence({repository: 'Raidiant-io/notifai', expectedSha: sha,
    token: 'test-token', fetcher}), /job evidence is incomplete/)
})
