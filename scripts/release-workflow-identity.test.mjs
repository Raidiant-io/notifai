import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {parse} from 'yaml'
import {verifyReleasePleaseOutput} from './verify-release-please-output.mjs'

const read = file => readFileSync(file, 'utf8').replace(/\r\n?/gu, '\n')
const release = read('.github/workflows/release-please.yml')
const ci = read('.github/workflows/ci.yml')
const publish = read('.github/workflows/publish.yml')
const releaseWorkflow = parse(release)
const ciWorkflow = parse(ci)
const publishWorkflow = parse(publish)
const releaseConfig = JSON.parse(readFileSync('release-please-config.json', 'utf8'))
const cliPackage = JSON.parse(readFileSync('apps/cli/package.json', 'utf8'))
const protocolPackage = JSON.parse(readFileSync('packages/protocol/package.json', 'utf8'))

test('all workflows stay LF-normalized, least-privilege, and action-SHA pinned', () => {
  for (const workflow of [release, ci, publish]) {
    assert.doesNotMatch(workflow, /\r/)
    for (const match of workflow.matchAll(/uses: ([^\s@]+)@([^\s#]+)/gu)) {
      assert.match(match[2], /^[0-9a-f]{40}$/u, match[1])
    }
  }
  assert.deepEqual(ciWorkflow.permissions, {contents: 'read'})
  assert.doesNotMatch(release, /\bsecrets\.|\bvars\./u)
  assert.match(release, /token: \$\{\{ github\.token \}\}/u)
  assert.match(release, /persist-credentials: false/u)
})

test('CI runs only for an exact release candidate', () => {
  assert.doesNotMatch(ci, /\n  (?:pull_request|push|schedule):/u)
  assert.match(ci, /cancel-in-progress: false/u)
  assert.match(ci, /workflow_dispatch:\n    inputs:\n      expected_sha:/u)
  assert.match(ci, /if \[ "\$ACTUAL_SHA" != "\$EXPECTED_SHA" \]/u)
  assert.match(ci, /check-secrets\.mjs --mode full/u)
  assert.doesNotMatch(ci, /node scripts\/ci-scope\.mjs/u)
})

test('release CI identities are explicit and all depend on exact candidate admission', () => {
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
  assert.match(ciWorkflow.jobs['platform-macos'].if, /needs\.scope\.result == 'success'/u)
  assert.match(ciWorkflow.jobs['platform-windows-x64'].if, /needs\.scope\.result == 'success'/u)
  assert.match(ciWorkflow.jobs['platform-windows-arm'].if, /needs\.scope\.result == 'success'/u)
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
    'pnpm check:packed-skill-smoke -- --if-changed',
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

test('public hosted workflows exist only for release preparation and publication', () => {
  assert.deepEqual(
    ['ci.yml', 'publish.yml', 'release-please.yml'],
    readdirSync('.github/workflows').filter(name => name.endsWith('.yml')).sort(),
  )
  assert.equal(ciWorkflow.jobs['dependency-review'], undefined)
})

test('release-please is explicit, exact-main guarded, and uses a verified predecessor', () => {
  assert.match(release, /on:\n  workflow_dispatch:\n    inputs:\n      expected_sha:/u)
  assert.doesNotMatch(release, /\n  push:/u)
  assert.match(release, /\[ "\$GITHUB_REF" != refs\/heads\/main \]/u)
  assert.match(release, /\[ "\$ACTUAL_SHA" != "\$EXPECTED_SHA" \]/u)
  assert.match(release, /\.parents \| if length == 1 then \.\[0\]\.sha/u)
  assert.match(release, /verify-release-please-output\.mjs "\$\{\{ steps\.predecessor\.outputs\.sha \}\}"/u)
  assert.match(release, /Verify generated release pull request metadata/u)
  assert.match(release, /node scripts\/verify-release-pr-metadata\.mjs "\$event_path"/u)
  assert.doesNotMatch(release, /github\.event\.before/u)
  assert.match(release, /release-please:\n(?:.*\n)*?    permissions:\n      contents: write\n      pull-requests: write/u)
  assert.match(release, /  dispatch:\n(?:.*\n)*?    permissions:\n      actions: write/u)
  const dispatch = release.slice(release.indexOf('\n  dispatch:'))
  assert.doesNotMatch(dispatch, /pull-requests:/u)
  assert.match(dispatch, /persist-credentials: false/u)
})

test('release refs dispatch CI and publication at one exact SHA', () => {
  assert.match(release, /dispatch_workflow ci\.yml "\$ref" "\$sha"/u)
  assert.match(release, /if \[ "\$returned_sha" != "\$expected_sha" \]/u)
  assert.match(release, /dispatch_workflow publish\.yml "\$PROTOCOL_TAG" "\$PROTOCOL_SHA"/u)
  assert.match(release, /dispatch_workflow publish\.yml "\$CLI_TAG" "\$CLI_SHA"/u)
})

test('release candidate dispatch maps every strict-shell release output', () => {
  const job = releaseWorkflow.jobs.dispatch
  const step = job.steps.find(candidate => candidate.name === 'Dispatch release evidence and publication')

  assert.match(job.if, /outputs\.release_refs != ''/u)
  assert.match(step.run, /set -euo pipefail/u)
  for (const [name, output] of [
    ['RELEASE_REFS', 'release_refs'],
    ['RELEASES_CREATED', 'releases_created'],
    ['CLI_RELEASE_CREATED', 'cli_release_created'],
    ['CLI_TAG', 'cli_tag'],
    ['CLI_SHA', 'cli_sha'],
    ['PROTOCOL_RELEASE_CREATED', 'protocol_release_created'],
    ['PROTOCOL_TAG', 'protocol_tag'],
    ['PROTOCOL_SHA', 'protocol_sha'],
  ]) {
    assert.equal(step.env[name], `\${{ needs.release-please.outputs.${output} }}`)
  }
  assert.match(step.run, /JSON\.parse\(process\.env\.RELEASE_REFS \|\| "\[\]"\)/u)
})

test('created releases dispatch and wait for exact-SHA CI before publish', () => {
  const job = releaseWorkflow.jobs.dispatch
  const dispatchIndex = job.steps.findIndex(step => step.name === 'Dispatch release evidence and publication')

  assert.equal(job['timeout-minutes'], 30)
  assert.deepEqual(job.permissions, {actions: 'write', contents: 'read'})
  assert.match(job.if, /outputs\.releases_created == 'true'/u)
  assert.ok(dispatchIndex >= 0, 'release dispatch step is missing')
  const command = job.steps[dispatchIndex].run
  assert.match(command, /if \[ "\$RELEASES_CREATED" = "true" \]; then/u)
  assert.match(command, /dispatch_workflow ci\.yml "\$GITHUB_REF_NAME" "\$GITHUB_SHA"/u)
  assert.match(command, /require-ci-evidence\.mjs --expected-sha "\$GITHUB_SHA" --wait/u)
  assert.ok(
    command.indexOf('require-ci-evidence.mjs') < command.indexOf('dispatch_workflow publish.yml'),
    'publication must follow exact-SHA CI evidence',
  )
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
  assert.match(pack.run, /scripts\/verify-packed-skill-install\.mjs/u)
  assert.doesNotMatch(pack.run, /--if-changed/u)
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
