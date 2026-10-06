import assert from 'node:assert/strict'
import {readFileSync, readdirSync} from 'node:fs'
import test from 'node:test'
import {parse} from 'yaml'
import {verifyReleasePleaseOutput} from './verify-release-please-output.mjs'

const read = file => readFileSync(file, 'utf8').replace(/\r\n?/gu, '\n')
const release = read('.github/workflows/release-please.yml')
const ci = read('.github/workflows/ci.yml')
const publish = read('.github/workflows/publish.yml')
const standalone = read('.github/workflows/standalone-candidate.yml')
const releaseWorkflow = parse(release)
const ciWorkflow = parse(ci)
const publishWorkflow = parse(publish)
const releaseConfig = JSON.parse(readFileSync('release-please-config.json', 'utf8'))

test('all workflows stay LF-normalized, least-privilege, and action-SHA pinned', () => {
  for (const workflow of readdirSync('.github/workflows').filter(name => name.endsWith('.yml')).map(name => read(`.github/workflows/${name}`))) {
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
  assert.match(String(ciWorkflow.jobs.gates.if), /always\(\)/u)
  assert.match(String(ciWorkflow.jobs.gates.if), /!inputs\.standalone_only/u)
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
    ['ci.yml', 'prepare-native-release.yml', 'publish-native-release.yml', 'publish.yml', 'release-please.yml', 'standalone-candidate.yml'],
    readdirSync('.github/workflows').filter(name => name.endsWith('.yml')).sort(),
  )
  assert.equal(ciWorkflow.jobs['dependency-review'], undefined)
  const workflow = parse(standalone)
  assert.deepEqual(Object.keys(workflow.on).sort(), ['workflow_call', 'workflow_dispatch'])
  assert.deepEqual(workflow.permissions, {contents: 'read'})
  assert.equal(workflow.on.workflow_dispatch.inputs.expected_sha.required, true)
  assert.equal(workflow.on.workflow_call.inputs.expected_sha.required, true)
})

test('native finalization and publication retain exact artifacts across independent retries', () => {
  const prepare = parse(read('.github/workflows/prepare-native-release.yml'))
  const nativePublish = parse(read('.github/workflows/publish-native-release.yml'))
  for (const workflow of [prepare, nativePublish]) {
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
    assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' })
    assert.equal(workflow.on.workflow_dispatch.inputs.expected_sha.required, true)
    assert.equal(workflow.concurrency['cancel-in-progress'], false)
    const admission = workflow.jobs.admission.steps.map(step => step.run ?? '').join('\n')
    assert.match(admission, /test "\$GITHUB_SHA" = "\$EXPECTED_SHA"/)
    assert.match(admission, /require-native-evidence\.mjs/)
  }
  assert.equal(prepare.on.workflow_dispatch.inputs.candidate_run_id.required, true)
  assert.equal(nativePublish.on.workflow_dispatch.inputs.final_run_id.required, true)
  assert.equal(prepare.jobs.finalize.environment, 'native-release')
  // Finalization reuses the admitted executables, but the runtime verification
  // compiles its isolated Bun and Windows registry fixtures on the fresh runner.
  const toolSteps = prepare.jobs.finalize.steps
  const bun = toolSteps.findIndex(step => step.uses?.startsWith('oven-sh/setup-bun@'))
  const compiler = toolSteps.findIndex(step => step.uses?.startsWith('ilammy/msvc-dev-cmd@'))
  const runtimeCheck = toolSteps.findIndex(step => step.run?.includes('check-standalone-runtime.mjs'))
  assert.ok(bun >= 0 && bun < runtimeCheck, 'Native finalization must provision its pinned fixture runtime')
  assert.equal(toolSteps[bun].with['bun-version'], '1.4.2')
  assert.ok(compiler >= 0 && compiler < runtimeCheck, 'Windows finalization must provision the registry fixture compiler')
  assert.equal(toolSteps[compiler].if, "runner.os == 'Windows'")
  assert.equal(toolSteps[compiler].with.arch, '${{ matrix.arch }}')
  assert.equal(nativePublish.jobs.publish.environment, 'native-release')
  assert.deepEqual(nativePublish.jobs.publish.permissions, { actions: 'read', contents: 'write' })
  const finalization = prepare.jobs.finalize.steps.map(step => step.run ?? '').join('\n')
  assert.doesNotMatch(finalization, /build-standalone|build-launcher/)
  assert.ok(finalization.indexOf('admit-native-candidate') < finalization.indexOf('sign-macos-standalone'))
  assert.ok(finalization.indexOf('sign-macos-standalone') < finalization.indexOf('check-standalone.mjs'))
  assert.ok(finalization.indexOf('check-standalone.mjs') < finalization.indexOf('package-standalone.mjs'))
  const signing = prepare.jobs.finalize.steps.find(step => step.name === 'Sign and notarize the final macOS CLI bytes')
  assert.equal(signing.if, "runner.os == 'macOS'")
  const publishSteps = nativePublish.jobs.publish.steps.map(step => step.run ?? '').join('\n')
  assert.doesNotMatch(publishSteps, /build-standalone|build-launcher|sign-macos-standalone/)
  assert.ok(publishSteps.indexOf('require-native-evidence') < publishSteps.indexOf('gh run download'))
  assert.ok(publishSteps.indexOf('assemble-native-release') < publishSteps.indexOf('publish-native-release.mjs'))
  assert.ok(publishSteps.indexOf('check-live-server-contract') < publishSteps.indexOf('publish-native-release.mjs'))
  assert.equal(nativePublish.on.workflow_dispatch.inputs.channel.default, 'none')
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
  assert.match(release, /dispatch_workflow prepare-native-release\.yml "\$CLI_TAG" "\$CLI_SHA" "\$CANDIDATE_RUN_ID"/u)
  assert.match(release, /dispatch_workflow publish\.yml "\$INSTALLER_TAG" "\$INSTALLER_SHA"/u)
  assert.doesNotMatch(release, /dispatch_workflow publish\.yml "\$CLI_TAG"/u)
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
    ['INSTALLER_RELEASE_CREATED', 'installer_release_created'],
    ['INSTALLER_TAG', 'installer_tag'],
    ['INSTALLER_SHA', 'installer_sha'],
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
  assert.match(command, /gh run watch "\$CANDIDATE_RUN_ID" --exit-status/u)
  assert.match(command, /require-native-evidence\.mjs --kind candidate --expected-sha "\$GITHUB_SHA" --run-id "\$CANDIDATE_RUN_ID"/u)
  assert.ok(
    command.indexOf('require-native-evidence.mjs') < command.indexOf('dispatch_workflow publish.yml'),
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

test('npm publication excludes the native CLI and verifies exact selected bytes', () => {
  assert.doesNotMatch(publish, /\n  push:/u)
  assert.match(publish, /refs\/tags\/installer-v\*\|refs\/tags\/protocol-v\*/u)
  assert.doesNotMatch(publish, /refs\/tags\/v\*/u)
  assert.match(publish, /Require an immutable GitHub release/u)
  const steps = publishWorkflow.jobs.npm.steps
  const index = name => steps.findIndex(step => step.name === name)
  const pack = index('Pack once and verify the exact npm artifact')
  const service = index('Verify deployed service accepts this candidate')
  const publishIndex = index('Publish the selected npm package with OIDC provenance')
  const verify = index('Verify published package bytes and metadata')
  assert.ok(pack >= 0 && pack < service && service < publishIndex && publishIndex < verify)
  assert.ok(index('Build protocol for the live service contract check') < service)
  assert.match(steps[pack].run, /verify-packed-npm-installer\.mjs "\$tarball"/u)
  assert.match(steps[pack].run, /check-packed-boundary\.mjs --tarball "\$tarball" --gitleaks/u)
  assert.match(steps[publishIndex].run, /npm publish "\$NPM_TARBALL" --access public --provenance/u)
  assert.match(steps[verify].run, /--expected-tarball "\$NPM_TARBALL"/u)
  assert.ok(index('Require a usable signed default for the npm installer') < publishIndex)
  const retry = steps.find(step => step.name === 'Verify an existing package before declaring a retry successful')
  assert.equal(retry.if, "steps.plan.outputs.publish == 'false'")
  assert.match(retry.run, /--expected-tarball "\$NPM_TARBALL"/u)
  assert.equal(publishWorkflow.jobs['windows-cli'], undefined)
})

test('native releases begin as tag-addressable drafts and never publish from release-please', () => {
  assert.equal(releaseConfig.packages['apps/cli'].draft, true)
  assert.equal(releaseConfig.packages['apps/cli']['force-tag-creation'], true)
  assert.notEqual(releaseConfig.packages['packages/protocol'].draft, true)
  assert.doesNotMatch(release, /dispatch_workflow publish-native-release/u)
})

test('the rootless combined manifest and release outputs remain exact', () => {
  assert.equal(releaseConfig.packages['.'], undefined)
  assert.equal(releaseConfig['group-pull-request-title-pattern'], undefined)
  assert.deepEqual(Object.keys(releaseConfig.packages).sort(), ['apps/cli', 'packages/installer', 'packages/protocol'])
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
  assert.throws(
    () => verifyReleasePleaseOutput({
      before: {'apps/cli': '9.0.0', 'packages/protocol': '5.0.0'},
      after: {'apps/cli': '9.1.0-beta.1', 'packages/protocol': '5.0.0'},
      config: releaseConfig,
      sha,
      outputs: {releasesCreated: 'true', packages: {}},
    }),
    /only stable package releases/u,
  )
})
