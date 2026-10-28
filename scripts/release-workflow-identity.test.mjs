import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {existsSync, readFileSync, readdirSync} from 'node:fs'
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
    'node --test scripts/verify-packed-install.test.mjs',
    'commitlint',
  ]) assert.match(gates, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))

  const mac = ciWorkflow.jobs['platform-macos'].steps.map(step => step.run ?? '').join('\n')
  assert.match(mac, /src\/codex-wake\.test\.ts/u)
  assert.doesNotMatch(mac, /typecheck|pnpm lint|check:release/u)
  for (const id of ['platform-windows-x64', 'platform-windows-arm']) {
    const windows = ciWorkflow.jobs[id].steps.map(step => step.run ?? '').join('\n')
    assert.match(windows, /src\/credentials\.test\.ts/u)
    assert.match(windows, /src\/install-hooks\.test\.ts/u)
    assert.match(windows, /verify-packed-install\.test\.mjs/u)
    assert.doesNotMatch(windows, /typecheck|pnpm lint|check:release/u)
  }
})

test('public hosted workflows exist only for release preparation, publication and the Codex card canary', () => {
  assert.deepEqual(
    ['ci.yml', 'codex-card-canary.yml', 'prepare-native-release.yml', 'publish-native-release.yml', 'publish.yml', 'release-please.yml', 'standalone-candidate.yml', 'windows-access.yml', 'windows-question-forms.yml'],
    readdirSync('.github/workflows').filter(name => name.endsWith('.yml')).sort(),
  )
  assert.equal(ciWorkflow.jobs['dependency-review'], undefined)
  const workflow = parse(standalone)
  assert.deepEqual(Object.keys(workflow.on).sort(), ['workflow_call', 'workflow_dispatch'])
  assert.deepEqual(workflow.permissions, {contents: 'read'})
  assert.equal(workflow.on.workflow_dispatch.inputs.expected_sha.required, true)
  assert.equal(workflow.on.workflow_call.inputs.expected_sha.required, true)
  const windowsForms = parse(read('.github/workflows/windows-question-forms.yml'))
  assert.deepEqual(Object.keys(windowsForms.on).sort(), ['workflow_call', 'workflow_dispatch'])
  assert.deepEqual(windowsForms.permissions, {contents: 'read'})
  assert.doesNotMatch(read('.github/workflows/windows-question-forms.yml'), /secrets\./)
})

test('the Codex card canary is the only clock-driven workflow and watches an external dependency without secrets', () => {
  const text = read('.github/workflows/codex-card-canary.yml')
  const canary = parse(text)
  assert.deepEqual(Object.keys(canary.on).sort(), ['schedule', 'workflow_dispatch'])
  assert.deepEqual(canary.permissions, { contents: 'read' })
  assert.equal(canary.concurrency['cancel-in-progress'], false)
  assert.doesNotMatch(text, /\bsecrets\.|\bvars\./u)
  assert.deepEqual(Object.keys(canary.jobs), ['canary'])
  assert.equal(canary.jobs.canary['runs-on'], 'ubuntu-latest')
  assert.ok(canary.jobs.canary['timeout-minutes'] <= 20)
  const run = canary.jobs.canary.steps.map(step => step.run ?? '').join('\n')
  assert.match(run, /npm install -g @openai\/codex@latest/u)
  assert.ok(run.indexOf('pnpm build') < run.indexOf('scripts/codex-card-canary.test.mjs'))
  assert.ok(run.indexOf('scripts/codex-card-canary.test.mjs') < run.indexOf('scripts/codex-card-canary.mjs'))
  for (const name of readdirSync('.github/workflows').filter(name => name.endsWith('.yml') && name !== 'codex-card-canary.yml')) {
    assert.doesNotMatch(read(`.github/workflows/${name}`), /\n  schedule:/u, name)
  }
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
  assert.equal(nativePublish.on.workflow_dispatch.inputs.mode.default, 'assemble')
  assert.equal(nativePublish.jobs.publish.steps.find(step => step.run?.includes('assemble-native-release')).if, "inputs.mode == 'assemble'")
  assert.equal(nativePublish.jobs.publish.steps.find(step => step.name === 'Restore the retained signed bundle without rebuilding or resigning').if, "inputs.mode != 'assemble'")
  assert.match(publishSteps, /--kind assembled/)
  assert.match(publishSteps, /native-release-bundle-\$EXPECTED_SHA/)
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
  // The metadata verifier compares proposals with published prerelease tags,
  // so the release job's checkout must carry the full tag history.
  const releaseCheckout = releaseWorkflow.jobs['release-please'].steps
    .find(step => step.uses?.startsWith('actions/checkout@'))
  assert.equal(releaseCheckout.with['fetch-depth'], 0)
  assert.doesNotMatch(release, /github\.event\.before/u)
  assert.match(release, /release-please:\n(?:.*\n)*?    permissions:\n      contents: write\n      pull-requests: write/u)
  assert.equal(releaseCheckout.with['persist-credentials'], false)
})

test('release preparation does not start a second release graph', () => {
  assert.equal(releaseWorkflow.jobs.dispatch, undefined)
  assert.ok(publishWorkflow.jobs['native-publication'].needs.includes('source'))
  assert.equal(publishWorkflow.jobs['promote-npm'].needs, 'adapter-acceptance')
  assert.equal(publishWorkflow.jobs['promote-native'].needs, 'promote-npm')
  assert.equal(publishWorkflow.on.workflow_dispatch.inputs.channel.default, 'none')
})

test('publication requires exact-SHA CI before the protected OIDC job', () => {
  const integrity = publishWorkflow.jobs['dispatch-integrity']
  assert.deepEqual(integrity.permissions, {actions: 'read', contents: 'read'})
  assert.match(publish, /Require successful CI evidence at the exact release SHA/u)
  assert.match(publish, /node scripts\/require-ci-evidence\.mjs --expected-sha/u)
  assert.equal(publishWorkflow.jobs.npm.environment, 'npm-release')
  assert.deepEqual(publishWorkflow.jobs.npm.permissions, {contents: 'read', 'id-token': 'write'})
  assert.ok(publishWorkflow.jobs['native-publication'].needs.includes('source'))
  assert.ok(publishWorkflow.jobs.npm.needs.includes('native-publication'))
})

test('npm publication stages the unified CLI then separately promotes exact verified bytes', () => {
  assert.doesNotMatch(publish, /\n  push:/u)
  assert.match(publish, /refs\/tags\/v\*\|refs\/tags\/protocol-v\*/u)
  assert.match(publish, /Require an immutable GitHub release/u)
  const steps = publishWorkflow.jobs.npm.steps
  const index = name => steps.findIndex(step => step.name === name)
  const build = index('Build the exact source verification modules')
  assert.ok(build >= 0 && build < index('Pack once or retain the already-published candidate'))
  const pack = index('Pack once or retain the already-published candidate')
  const service = index('Verify deployed service accepts this candidate')
  const publishIndex = index('Publish the selected npm package with OIDC provenance')
  const verify = index('Verify published package bytes and metadata')
  assert.ok(pack >= 0 && pack < service && service < publishIndex && publishIndex < verify)
  assert.ok(index('Build protocol for the live service contract check') < service)
  assert.match(steps[pack].run, /verify-packed-npm-adapter\.mjs "\$tarball"/u)
  assert.match(steps[pack].run, /check-packed-boundary\.mjs --tarball "\$tarball" --gitleaks/u)
  assert.match(steps[publishIndex].run, /^node scripts\/publish-npm-tarball\.mjs "\$NPM_TARBALL" "\$NPM_DIST_TAG" "\$PACKAGE_NAME" "\$VERSION"$/u)
  assert.match(read('scripts/publish-npm-tarball.mjs'), /\['publish', tarball, '--access', 'public', '--provenance', '--tag', distTag\]/u)
  assert.match(steps[verify].run, /--expected-tarball "\$NPM_TARBALL"/u)
  const promotion = index('Promote only the already-verified npm version')
  assert.ok(index('Admit both immutable distributions before promotion') < promotion)
  assert.equal(steps[promotion].if, "inputs.mode == 'promote' || steps.plan.outputs.package_name == '@raidiant/notifai-protocol'")
  assert.ok(index('Verify staged candidate discovery') < promotion)
  assert.match(steps[promotion].run, /verify-npm-distribution\.mjs promote/)
  assert.equal(publishWorkflow.on.workflow_dispatch.inputs.mode.default, 'release')
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

test('beta repair uses exact main, protected OIDC, shared serialization and receipt retention without publishing bytes', () => {
  const repair = publishWorkflow.jobs['beta-repair']
  assert.equal(repair.needs, 'dispatch-integrity')
  assert.equal(repair.if, "inputs.mode == 'repair-beta'")
  assert.match(publishWorkflow.jobs.npm.if, /inputs.mode != 'repair-beta'/)
  assert.equal(repair.environment, 'npm-release')
  assert.deepEqual(repair.permissions, { contents: 'read', actions: 'read', 'id-token': 'write' })
  assert.equal(repair.concurrency.group, publishWorkflow.jobs.npm.concurrency.group)
  assert.equal(repair.concurrency['cancel-in-progress'], false)
  const integrity = publishWorkflow.jobs['dispatch-integrity'].steps[0].run
  assert.match(integrity, /if \[ "\$MODE" = repair-beta \]; then\s+test "\$GITHUB_REF" = refs\/heads\/main/)
  const commands = repair.steps.map(step => step.run ?? '').join('\n')
  assert.match(commands, /repair-npm-beta\.mjs repair "\$PACKAGE_NAME" "\$VERSION"/)
  assert.doesNotMatch(commands, /npm (?:publish|pack)\b|build-npm-adapter/)
  assert.equal(repair.steps.find(step => step.uses?.startsWith('actions/upload-artifact@')).if, 'always()')
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

test('every release Bash step is syntactically valid before provider execution', () => {
  for (const name of readdirSync('.github/workflows').filter(name => name.endsWith('.yml'))) {
    const workflow = parse(read(`.github/workflows/${name}`))
    for (const job of Object.values(workflow.jobs)) for (const step of job.steps ?? []) {
      if (!step.run || ['powershell', 'pwsh'].includes(step.shell)) continue
      const script = step.run.replace(/\$\{\{[\s\S]*?\}\}/g, 'fixture')
      const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' })
      assert.equal(result.status, 0, `${name}: ${step.name}: ${result.stderr}`)
    }
  }
})


test('release test and script selectors exist and minimum Node executes the generated entrypoint', () => {
  for (const name of readdirSync('.github/workflows').filter(name => name.endsWith('.yml'))) {
    const text = read(`.github/workflows/${name}`)
    for (const match of text.matchAll(/(?:scripts|apps\/cli\/npm)\/[a-z0-9-]+(?:\.test)?\.mjs/g)) assert.ok(existsSync(match[0]), `${name}: ${match[0]}`)
    for (const match of text.matchAll(/src\/[a-z0-9-]+\.test\.ts/g)) {
      assert.ok(existsSync(`apps/cli/${match[0]}`) || existsSync(`packages/protocol/${match[0]}`), `${name}: ${match[0]}`)
    }
  }
  const minimum = parse(standalone).jobs.candidate.steps.find(step => step.name === 'Verify npm bootstrap on its minimum Node version')
  assert.match(minimum.run, /node dist\/npm\/notifai\/bin\/notifai.mjs --help/)
  const admission = publishWorkflow.jobs['dispatch-integrity'].steps.find(step => step.name === 'Require retained npm/native acceptance before CLI promotion')
  assert.match(admission.run, /--kind npm/)
  assert.equal(publishWorkflow.jobs['adapter-acceptance'].needs, 'npm')
  assert.equal(publishWorkflow.jobs['adapter-acceptance'].strategy.matrix.include.length, 6)
})

test('a deliberately retired package needs no release, while active package bumps still do', () => {
  const cli = { component: 'notifai', 'include-component-in-tag': false }
  const retired = { component: 'installer' }
  const input = {
    before: { 'apps/cli': '11.8.0', 'packages/installer': '1.0.0' },
    after: { 'apps/cli': '11.8.0' },
    beforeConfig: { packages: { 'apps/cli': cli, 'packages/installer': retired } },
    config: { packages: { 'apps/cli': cli } },
    existingPackagePaths: ['apps/cli'],
    outputs: { releasesCreated: false }, sha: 'a'.repeat(40),
  }
  assert.deepEqual(verifyReleasePleaseOutput(input), [])
  assert.throws(() => verifyReleasePleaseOutput({ ...input,
    existingPackagePaths: ['apps/cli', 'packages/installer'],
  }), /manifest removed/)
  assert.throws(() => verifyReleasePleaseOutput({ ...input, config: input.beforeConfig }), /manifest removed/)
  assert.throws(() => verifyReleasePleaseOutput({ ...input,
    after: { 'apps/cli': '12.0.0' },
  }), /reported no release/)
})

// GitHub propagates skipped ancestors unless downstream job conditions contain
// an explicit status function. Legacy admission is intentionally skipped here.
test('release acceptance cannot silently skip after the legacy admission branch', () => {
  for (const name of ['adapter-acceptance', 'promote-npm', 'promote-native']) {
    const job = publishWorkflow.jobs[name]
    assert.match(job.if, /always\(\)/)
    assert.ok(job.if.includes(`needs.${job.needs}.result == 'success'`))
  }
  const gate = publishWorkflow.jobs['release-result']
  assert.match(gate.if, /always\(\)/)
  assert.ok(gate.needs.includes('adapter-acceptance'))
  const script = gate.steps[0].run.split("node <<'NODE'\n")[1].split('\nNODE')[0]
  const base = Object.fromEntries(gate.needs.map(name => [name, {result:'success'}]))
  const run = results => spawnSync(process.execPath, ['-e', script.replace("fs.writeFileSync('release-record.json', JSON.stringify(record, null, 2));", '')],
    {env:{...process.env,RESULTS:JSON.stringify(results),CHANNEL:'none'},encoding:'utf8'})
  assert.equal(run(base).status, 0)
  for (const result of ['skipped','failure','cancelled']) {
    assert.notEqual(run({...base,'adapter-acceptance':{result}}).status, 0)
  }
})
