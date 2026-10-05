#!/usr/bin/env node
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { validateCiEvidence, requireCiEvidence } from './require-ci-evidence.mjs'

export const nativeTargets = ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-arm64', 'bun-linux-x64', 'bun-windows-arm64', 'bun-windows-x64']
const repository = 'Raidiant-io/notifai'

export function validateNativeEvidence({ run, jobs, artifacts, expectedSha, kind }) {
  assert.ok(['candidate', 'final'].includes(kind), 'Unknown native evidence kind')
  assert.ok(/^[a-f0-9]{40}$/.test(expectedSha), 'Exact source SHA is required')
  assert.ok(run?.head_sha === expectedSha && run.status === 'completed' && run.conclusion === 'success' &&
    run.event === 'workflow_dispatch' && run.head_repository?.full_name === repository &&
    run.path === `.github/workflows/${kind === 'candidate' ? 'ci' : 'prepare-native-release'}.yml`,
  'A successful exact-source first-party workflow run is required')
  if (kind === 'candidate') validateCiEvidence({ run, jobs, expectedSha })
  const names = new Set()
  for (const job of jobs) { assert.ok(!names.has(job.name), 'Duplicate native job evidence'); names.add(job.name) }
  for (const target of nativeTargets) {
    const name = kind === 'candidate' ? `standalone / standalone (${target})` : `finalize (${target})`
    assert.equal(jobs.find(job => job.name === name)?.conclusion, 'success', `Missing successful native evidence: ${name}`)
    const namePrefix = kind === 'candidate' ? 'standalone' : 'native-final'
    const matches = artifacts.filter(artifact => artifact.name === `${namePrefix}-${target}-${expectedSha}`)
    assert.ok(matches.length === 1 && matches[0].expired === false && Number.isSafeInteger(matches[0].id) &&
      Number.isSafeInteger(matches[0].size_in_bytes) && matches[0].size_in_bytes > 0 && matches[0].size_in_bytes <= 1024 * 1024 * 1024 &&
      /^sha256:[a-f0-9]{64}$/.test(matches[0].digest), `Missing immutable retained artifact: ${target}`)
  }
  return run
}

export async function requireNativeEvidence({ expectedSha, runId, kind, token, fetcher = fetch }) {
  assert.ok(token && ['candidate', 'final'].includes(kind), 'Authenticated native evidence kind is required')
  if (!runId && kind === 'candidate') runId = (await requireCiEvidence({ repository, expectedSha, token, fetcher })).id
  assert.ok(/^[1-9][0-9]*$/.test(String(runId)), 'Exact retained workflow run ID is required')
  const get = async suffix => {
    const response = await fetcher(`https://api.github.com/repos/${repository}/actions/runs/${runId}${suffix}`, {
      redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'notifai-native-evidence' },
    })
    assert.ok(response.ok, `Native evidence unavailable: HTTP ${response.status}`)
    return response.json()
  }
  const run = await get(''), jobs = await get('/jobs?filter=latest&per_page=100'), artifacts = await get('/artifacts?per_page=100')
  assert.equal(jobs.total_count, jobs.jobs?.length, 'Incomplete native job evidence')
  assert.equal(artifacts.total_count, artifacts.artifacts?.length, 'Incomplete retained artifact evidence')
  return validateNativeEvidence({ run, jobs: jobs.jobs, artifacts: artifacts.artifacts, expectedSha, kind })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { 'expected-sha': { type: 'string' }, 'run-id': { type: 'string' }, kind: { type: 'string' } } })
  const run = await requireNativeEvidence({ expectedSha: values['expected-sha'], runId: values['run-id'], kind: values.kind, token: process.env.GH_TOKEN })
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${run.id}\n`)
  console.log(JSON.stringify({ ok: true, run_id: run.id, source_revision: run.head_sha, kind: values.kind }))
}
