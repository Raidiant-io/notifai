#!/usr/bin/env node
import process from 'node:process'
import {fileURLToPath} from 'node:url'

const SHA = /^[0-9a-f]{40}$/u
const NATIVE_CHECKS = [
  'platform (macos-latest)',
  'platform (windows-2025)',
  'platform (windows-11-arm)',
]

export function validateCiEvidence({runs, jobs, expectedSha}) {
  const successful = runs.filter(run =>
    run.head_sha === expectedSha && run.status === 'completed' && run.conclusion === 'success',
  )
  if (successful.length !== 1) {
    throw new Error(
      `expected exactly one successful CI run for the release SHA; found ${successful.length}. ` +
      'Run CI manually at the exact SHA before publishing.',
    )
  }

  const byName = new Map()
  for (const job of jobs) {
    if (byName.has(job.name)) throw new Error(`CI evidence contains duplicate job name: ${job.name}`)
    byName.set(job.name, job)
  }
  for (const name of ['scope', 'gates']) {
    if (byName.get(name)?.conclusion !== 'success') {
      throw new Error(`${name} must succeed in the exact-SHA CI run before publishing`)
    }
  }
  for (const name of NATIVE_CHECKS) {
    const conclusion = byName.get(name)?.conclusion
    if (!['success', 'skipped'].includes(conclusion)) {
      throw new Error(`${name} must succeed when applicable or be explicitly skipped`)
    }
  }
  return successful[0]
}

async function githubJson(path, token, fetcher) {
  const response = await fetcher(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'notifai-release-ci-evidence',
    },
  })
  if (!response.ok) throw new Error(`GitHub Actions evidence request failed with HTTP ${response.status}`)
  return response.json()
}

export async function requireCiEvidence({repository, expectedSha, token, fetcher = fetch}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? '')) {
    throw new Error('GITHUB_REPOSITORY must identify one owner/repository')
  }
  if (!SHA.test(expectedSha ?? '')) throw new Error('expected SHA must be a full lowercase commit SHA')
  if (!token) throw new Error('GH_TOKEN is required to read exact-SHA CI evidence')

  const query = new URLSearchParams({head_sha: expectedSha, status: 'completed', per_page: '100'})
  const runPayload = await githubJson(
    `/repos/${repository}/actions/workflows/ci.yml/runs?${query}`,
    token,
    fetcher,
  )
  const candidates = (runPayload.workflow_runs ?? []).filter(run =>
    run.head_sha === expectedSha && run.status === 'completed' && run.conclusion === 'success',
  )
  if (candidates.length !== 1) return validateCiEvidence({runs: candidates, jobs: [], expectedSha})

  const jobsPayload = await githubJson(
    `/repos/${repository}/actions/runs/${candidates[0].id}/jobs?filter=latest&per_page=100`,
    token,
    fetcher,
  )
  if ((jobsPayload.total_count ?? 0) > (jobsPayload.jobs ?? []).length) {
    throw new Error('exact-SHA CI job evidence is incomplete; run CI manually and retry')
  }
  return validateCiEvidence({runs: candidates, jobs: jobsPayload.jobs ?? [], expectedSha})
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--expected-sha')
  requireCiEvidence({
    repository: process.env.GITHUB_REPOSITORY,
    expectedSha: index === -1 ? undefined : process.argv[index + 1],
    token: process.env.GH_TOKEN,
  }).then(
    run => console.log(`Verified exact-SHA CI evidence from run ${run.id}.`),
    error => {
      console.error(`CI evidence check FAILED: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    },
  )
}
