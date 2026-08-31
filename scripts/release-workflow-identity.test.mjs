import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {parse} from 'yaml'
import {verifyReleasePleaseOutput} from './verify-release-please-output.mjs'

const read = file => readFileSync(file, 'utf8').replace(/\r\n?/gu, '\n')
const release = read('.github/workflows/release-please.yml')
const ci = read('.github/workflows/ci.yml')
const publish = read('.github/workflows/publish.yml')
const provider = read('.github/workflows/provider-posture.yml')
const ciWorkflow = parse(ci)
const publishWorkflow = parse(publish)
const providerWorkflow = parse(provider)
const releaseConfig = JSON.parse(readFileSync('release-please-config.json', 'utf8'))
const cliPackage = JSON.parse(readFileSync('apps/cli/package.json', 'utf8'))
const protocolPackage = JSON.parse(readFileSync('packages/protocol/package.json', 'utf8'))

test('all workflows stay LF-normalized, least-privilege, and action-SHA pinned', () => {
  for (const workflow of [release, ci, publish, provider]) {
    assert.doesNotMatch(workflow, /\r/)
    for (const match of workflow.matchAll(/uses: ([^\s@]+)@([^\s#]+)/gu)) {
      assert.match(match[2], /^[0-9a-f]{40}$/u, match[1])
    }
  }
  assert.deepEqual(ciWorkflow.permissions, {contents: 'read'})
  assert.deepEqual(providerWorkflow.permissions, {contents: 'read'})
  assert.doesNotMatch(release, /\bsecrets\.|\bvars\./u)
  assert.match(release, /token: \$\{\{ github\.token \}\}/u)
  assert.match(release, /persist-credentials: false/u)
})

test('CI has no tag trigger, cancels only PR work, and preserves exact manual identity', () => {
  assert.doesNotMatch(ci, /\n\s+tags:/u)
  assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u)
  assert.match(ci, /workflow_dispatch:\n    inputs:\n      expected_sha:/u)
  assert.match(ci, /if \[ "\$ACTUAL_SHA" != "\$EXPECTED_SHA" \]/u)
  assert.match(ci, /case "\$EVENT_NAME" in[\s\S]*workflow_dispatch\)/u)
  assert.match(ci, /node scripts\/ci-scope\.mjs/u)
  assert.match(ci, /check-secrets\.mjs --mode tree/u)
  assert.match(ci, /--mode range --base "\$base_sha" --head "\$head_sha"/u)
})

test('protected CI identities are explicit and path-selected before runner allocation', () => {
  const protectedJobs = [
    ['gates', ciWorkflow.jobs.gates, 'ubuntu-latest'],
    ['platform (macos-latest)', ciWorkflow.jobs['platform-macos'], 'macos-latest'],
    ['platform (windows-2025)', ciWorkflow.jobs['platform-windows-x64'], 'windows-2025'],
    ['platform (windows-11-arm)', ciWorkflow.jobs['platform-windows-arm'], 'windows-11-arm'],
  ]
  assert.deepEqual(protectedJobs.map(([name]) => name), [
    'gates',
    'platform (macos-latest)',
    'platform (windows-2025)',
    'platform (windows-11-arm)',
  ])
  for (const [name, job, runner] of protectedJobs) {
    assert.equal(job['runs-on'], runner, name)
    assert.equal(job.needs, 'scope', name)
    const setup = job.steps.find(step => String(step.uses).startsWith('actions/setup-node@'))
    assert.equal(setup.with['node-version'], '24', name)
  }
  assert.equal(ciWorkflow.jobs['platform-macos'].name, 'platform (macos-latest)')
  assert.equal(ciWorkflow.jobs['platform-windows-x64'].name, 'platform (windows-2025)')
  assert.equal(ciWorkflow.jobs['platform-windows-arm'].name, 'platform (windows-11-arm)')
  assert.match(ciWorkflow.jobs['platform-macos'].if, /outputs\.macos == 'true'/u)
  assert.match(ciWorkflow.jobs['platform-windows-x64'].if, /outputs\.windows == 'true'/u)
  assert.match(ciWorkflow.jobs['platform-windows-arm'].if, /outputs\.windows == 'true'/u)
  assert.equal(String(ciWorkflow.jobs.gates.if), '${{ always() }}')
  assert.match(ciWorkflow.jobs.gates.steps[0].if, /needs\.scope\.result != 'success'/u)
  assert.match(ciWorkflow.jobs.gates.steps[0].run, /exit 1/u)
})

test('Ubuntu owns consolidated generic evidence while native jobs stay boundary-specific', () => {
  const gates = ciWorkflow.jobs.gates.steps.map(step => `${step.name ?? ''}\n${step.run ?? ''}`).join('\n')
  for (const command of [
    'pnpm build',
    'pnpm -r test',
    'pnpm -r typecheck',
    'pnpm lint',
    'pnpm check:release',
    'pnpm check:packed',
    'verify-release-pr-metadata.mjs',
    'commitlint',
  ]) assert.match(gates, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))

  const mac = ciWorkflow.jobs['platform-macos'].steps.map(step => step.run ?? '').join('\n')
  assert.match(mac, /src\/codex-wake\.test\.ts/u)
  assert.doesNotMatch(mac, /typecheck|pnpm lint|check:release/u)
  for (const id of ['platform-windows-x64', 'platform-windows-arm']) {
    const windows = ciWorkflow.jobs[id].steps.map(step => step.run ?? '').join('\n')
    assert.match(windows, /src\/credentials\.test\.ts/u)
    assert.match(windows, /src\/install-hooks\.test\.ts/u)
    assert.match(windows, /pnpm check:packed/u)
    assert.doesNotMatch(windows, /typecheck|pnpm lint|check:release/u)
  }
})

test('dependency review is PR-only and selected only by dependency inputs', () => {
  const job = ciWorkflow.jobs['dependency-review']
  assert.equal(job.needs, 'scope')
  assert.match(job.if, /github\.event_name == 'pull_request'/u)
  assert.match(job.if, /outputs\.dependencies == 'true'/u)
})

test('weekly provider posture owns checksum-pinned full-history security evidence', () => {
  const posture = providerWorkflow.jobs['private-vulnerability-reporting']
  const step = posture.steps.find(candidate => candidate.run === 'node scripts/check-public-provider-posture.mjs')
  assert.equal(step.env.GH_TOKEN, '${{ github.token }}')
  const history = providerWorkflow.jobs['full-history-secrets']
  assert.equal(history.steps[0].with['fetch-depth'], 0)
  assert.match(provider, /GITLEAKS_VERSION: 8\.30\.1/u)
  assert.match(provider, /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/u)
  assert.match(provider, /check-secrets\.mjs --mode controls/u)
  assert.match(provider, /check-secrets\.mjs --mode full/u)
})

test('release-please is explicit, exact-main guarded, and uses a verified predecessor', () => {
  assert.match(release, /on:\n  workflow_dispatch:\n    inputs:\n      expected_sha:/u)
  assert.doesNotMatch(release, /\n  push:/u)
  assert.match(release, /\[ "\$GITHUB_REF" != refs\/heads\/main \]/u)
  assert.match(release, /\[ "\$ACTUAL_SHA" != "\$EXPECTED_SHA" \]/u)
  assert.match(release, /\.parents \| if length == 1 then \.\[0\]\.sha/u)
  assert.match(release, /verify-release-please-output\.mjs "\$\{\{ steps\.predecessor\.outputs\.sha \}\}"/u)
  assert.doesNotMatch(release, /github\.event\.before/u)
  assert.match(release, /release-please:\n(?:.*\n)*?    permissions:\n      contents: write\n      pull-requests: write/u)
  assert.match(release, /  dispatch:\n(?:.*\n)*?    permissions:\n      actions: write/u)
  const dispatch = release.slice(release.indexOf('\n  dispatch:'))
  assert.doesNotMatch(dispatch, /actions\/checkout|contents:|pull-requests:/u)
})

test('release refs dispatch CI and publication at one exact SHA', () => {
  assert.match(release, /dispatch_workflow ci\.yml "\$ref" "\$sha"/u)
  assert.match(release, /if \[ "\$returned_sha" != "\$expected_sha" \]/u)
  assert.match(release, /dispatch_workflow publish\.yml "\$PROTOCOL_TAG" "\$PROTOCOL_SHA"/u)
  assert.match(release, /dispatch_workflow publish\.yml "\$CLI_TAG" "\$CLI_SHA"/u)
})

test('publication requires exact-SHA CI before the protected OIDC job', () => {
  const integrity = publishWorkflow.jobs['dispatch-integrity']
  assert.deepEqual(integrity.permissions, {actions: 'read', contents: 'read'})
  assert.match(publish, /Require successful CI evidence at the exact release SHA/u)
  assert.match(publish, /node scripts\/require-ci-evidence\.mjs --expected-sha/u)
  assert.equal(publishWorkflow.jobs.npm.environment, 'npm-release')
  assert.deepEqual(publishWorkflow.jobs.npm.permissions, {contents: 'read', 'id-token': 'write'})
  const releaseTooling = publishWorkflow.jobs.npm.steps.find(
    candidate => candidate.name === 'Verify release-specific artifact tooling',
  )
  assert.doesNotMatch(releaseTooling.run, /pnpm (?:build|-r test|lint|-r typecheck|check:release)/u)
})

test('publication retains immutable release, live service, and native Windows evidence', () => {
  assert.doesNotMatch(publish, /\n  push:/u)
  assert.match(publish, /refs\/tags\/v\*\|refs\/tags\/protocol-v\*/u)
  assert.match(publish, /Require an immutable GitHub release/u)
  assert.match(publish, /check-public-provider-posture\.mjs/u)
  const service = publishWorkflow.jobs.npm.steps.find(
    candidate => candidate.name === 'Verify deployed service accepts this candidate',
  )
  assert.equal(service.run, 'node scripts/check-live-server-contract.mjs')
  assert.deepEqual(publishWorkflow.jobs['windows-cli'].strategy.matrix.os, [
    'windows-2025',
    'windows-11-arm',
  ])
  assert.match(publish, /verify-published-windows\.mjs/u)
})

test('publication prepares the protocol artifact before reading its built contract export', () => {
  const steps = publishWorkflow.jobs.npm.steps
  const contractIndex = steps.findIndex(
    candidate => candidate.name === 'Verify deployed service accepts this candidate',
  )
  const packIndex = steps.findIndex(
    candidate => candidate.name === 'Pack once and verify the exact release artifacts',
  )
  const publishIndex = steps.findIndex(candidate => candidate.name === 'Publish protocol with OIDC provenance')

  assert.ok(packIndex >= 0, 'artifact preparation step is missing')
  assert.ok(contractIndex > packIndex, 'contract check must consume an already-built protocol export')
  assert.ok(publishIndex > contractIndex, 'live compatibility must pass before the first npm mutation')
  assert.match(steps[packIndex].run, /pnpm --filter @raidiant\/notifai-protocol pack/u)
  assert.equal(protocolPackage.scripts.prepack, 'pnpm run build')
})

test('publication reuses the exact tarballs that passed boundary and install checks', () => {
  const steps = publishWorkflow.jobs.npm.steps
  const pack = steps.find(candidate => candidate.name === 'Pack once and verify the exact release artifacts')
  const publishProtocol = steps.find(candidate => candidate.name === 'Publish protocol with OIDC provenance')
  const verifyProtocol = steps.find(candidate => candidate.name === 'Verify published protocol bytes and metadata')
  const publishCli = steps.find(candidate => candidate.name === 'Publish CLI with OIDC provenance')
  const verifyCli = steps.find(candidate => candidate.name === 'Verify published CLI bytes and metadata')
  assert.match(pack.run, /pnpm --filter @raidiant\/notifai-protocol pack/u)
  assert.match(pack.run, /pnpm --filter @raidiant\/notifai pack/u)
  assert.match(pack.run, /scripts\/verify-packed-install\.mjs/u)
  assert.match(pack.run, /--gitleaks(?:\s|$)/u)
  assert.match(pack.run, /PROTOCOL_TARBALL=\$protocol_tarball/u)
  assert.match(pack.run, /CLI_TARBALL=\$cli_tarball/u)
  assert.equal(publishProtocol.run, 'npm publish "$PROTOCOL_TARBALL" --access public --provenance')
  assert.match(verifyProtocol.run, /--expected-tarball "\$PROTOCOL_TARBALL"/u)
  assert.equal(publishCli.run, 'npm publish "$CLI_TARBALL" --access public --provenance')
  assert.match(verifyCli.run, /--expected-tarball "\$CLI_TARBALL"/u)
})

test('the publish workflow records the exact CLI version in GitHub output', () => {
  const step = publishWorkflow.jobs.npm.steps.find(candidate => candidate.name === 'Record the exact CLI version')
  const directory = mkdtempSync(join(tmpdir(), 'notifai-publish-output-'))
  const output = join(directory, 'github-output')
  try {
    execFileSync('bash', ['-c', step.run], {cwd: process.cwd(), env: {...process.env, GITHUB_OUTPUT: output}})
    assert.equal(readFileSync(output, 'utf8'), `version=${cliPackage.version}\n`)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('the rootless combined manifest and release outputs remain exact', () => {
  assert.equal(releaseConfig.packages['.'], undefined)
  assert.equal(releaseConfig['group-pull-request-title-pattern'], undefined)
  assert.deepEqual(Object.keys(releaseConfig.packages).sort(), ['apps/cli', 'packages/protocol'])
  assert.deepEqual(releaseConfig.plugins, [{type: 'node-workspace', updateAllPackages: true}])

  const sha = 'a'.repeat(40)
  const cli = verifyReleasePleaseOutput({
    before: {'apps/cli': '9.0.0', 'packages/protocol': '5.0.0'},
    after: {'apps/cli': '9.1.0', 'packages/protocol': '5.0.0'},
    config: releaseConfig,
    sha,
    outputs: {releasesCreated: 'true', packages: {'apps/cli': {created: 'true', tag: 'v9.1.0', sha}}},
  })
  assert.deepEqual(cli, [{path: 'apps/cli', before: '9.0.0', version: '9.1.0', tag: 'v9.1.0'}])
  assert.throws(
    () => verifyReleasePleaseOutput({
      before: {'apps/cli': '9.0.0', 'packages/protocol': '5.0.0'},
      after: {'apps/cli': '9.1.0', 'packages/protocol': '5.0.0'},
      config: releaseConfig,
      sha,
      outputs: {releasesCreated: 'false', packages: {}},
    }),
    /release manifest advanced apps\/cli, but release-please reported no release/u,
  )
})
