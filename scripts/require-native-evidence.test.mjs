import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeTargets, requireNativeEvidence, validateNativeEvidence } from './require-native-evidence.mjs'

const expectedSha = 'a'.repeat(40)
function fixture(kind = 'candidate') {
  return { expectedSha, kind, run: { id: 42, head_sha: expectedSha, head_repository: { full_name: 'Raidiant-io/notifai' },
    path: `.github/workflows/${kind === 'candidate' ? 'ci' : kind === 'final' ? 'prepare-native-release' : kind === 'assembled' ? 'publish-native-release' : 'publish'}.yml`, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' },
  jobs: [...(kind === 'candidate' ? ['scope', 'gates', 'platform (macos-latest)', 'platform (windows-2025)', 'platform (windows-11-arm)'] : []),
    ...(kind === 'npm' ? ['npm'] : []),
    ...(kind === 'assembled' ? ['publish'] : nativeTargets.map(target => kind === 'candidate' ? `standalone / standalone (${target})` : kind === 'npm' ? `npm adapter (${target})` : `finalize (${target})`))]
    .map(name => ({ name, conclusion: 'success' })),
  artifacts: kind === 'assembled' ? [{ id: 1, name: `native-release-bundle-${expectedSha}`, expired: false, size_in_bytes: 1024, digest: `sha256:${'b'.repeat(64)}` }] : nativeTargets.map((target, i) => ({ id: i + 1, name: `${kind === 'candidate' ? 'standalone' : kind === 'npm' ? 'npm-native-acceptance' : 'native-final'}-${target}-${expectedSha}`,
    expired: false, size_in_bytes: 1024, digest: `sha256:${'b'.repeat(64)}` })) }
}
test('publication needs all six native targets and generic gates from one source run', () => {
  for (const kind of ['candidate', 'final', 'assembled', 'npm']) {
    const data = fixture(kind)
    assert.equal(validateNativeEvidence(data), data.run)
    for (const change of [
      d => { d.run.head_sha = 'c'.repeat(40) }, d => { d.run.head_repository.full_name = 'fork/notifai' },
      d => { d.run.event = 'pull_request' }, d => { d.run.path = '.github/workflows/another.yml' },
      d => { d.jobs.at(-1).conclusion = 'skipped' }, d => { d.jobs.push(d.jobs[0]) },
      d => { d.artifacts.pop() }, d => { d.artifacts.push(d.artifacts[0]) },
      d => { d.artifacts[0].expired = true }, d => { delete d.artifacts[0].digest },
    ]) { const changed = structuredClone(data); change(changed); assert.throws(() => validateNativeEvidence(changed)) }
  }
  const standaloneOnly = fixture(); standaloneOnly.jobs.find(job => job.name === 'gates').conclusion = 'skipped'
  assert.throws(() => validateNativeEvidence(standaloneOnly), /gates must succeed/)
})
test('provider admission rejects incomplete pages and uses an explicit retained run', async () => {
  const data = fixture('final'), requests = []
  let incomplete = false
  const fetcher = async url => {
    requests.push(url)
    if (url.includes('/jobs?')) return Response.json({ total_count: data.jobs.length + Number(incomplete), jobs: data.jobs })
    if (url.includes('/artifacts?')) return Response.json({ total_count: data.artifacts.length, artifacts: data.artifacts })
    return Response.json(data.run)
  }
  const options = { expectedSha, kind: 'final', runId: '42', token: 'fixture', fetcher }
  assert.equal((await requireNativeEvidence(options)).id, 42)
  assert.ok(requests.every(url => url.includes('/actions/runs/42')))
  incomplete = true
  await assert.rejects(requireNativeEvidence(options), /Incomplete native job/)
})
