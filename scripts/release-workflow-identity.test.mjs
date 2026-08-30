import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {parse} from 'yaml'
import {verifyReleasePleaseOutput} from './verify-release-please-output.mjs'

function readWorkflowText(path, read = readFileSync) {
  return read(path, 'utf8').replace(/\r\n?/g, '\n')
}

const release = readWorkflowText('.github/workflows/release-please.yml')
const ci = readWorkflowText('.github/workflows/ci.yml')
const publish = readWorkflowText('.github/workflows/publish.yml')
const ciWorkflow = parse(ci)
const publishWorkflow = parse(publish)
const releaseConfig = JSON.parse(readFileSync('release-please-config.json', 'utf8'))
const cliPackage = JSON.parse(readFileSync('apps/cli/package.json', 'utf8'))

const requiredChecks = [
  {name: 'commits', job: ciWorkflow.jobs.commits},
  {name: 'gates', job: ciWorkflow.jobs.gates},
  {name: 'secret-history', job: ciWorkflow.jobs['secret-history']},
  ...ciWorkflow.jobs.platform.strategy.matrix.os.map(os => ({
    name: `platform (${os})`,
    job: ciWorkflow.jobs.platform,
  })),
]

function eventConditionAllows(condition, eventName) {
  if (!condition.includes('github.event_name')) return true
  return condition.includes(`github.event_name == '${eventName}'`)
}

function simulateJob(job, {eventName, needs}) {
  const condition = String(job.if ?? '')
  const dependenciesSucceeded = Object.values(needs).every(result => result === 'success')
  const invokesAlways = condition.includes('always()')
  if ((!invokesAlways && !dependenciesSucceeded) || !eventConditionAllows(condition, eventName)) {
    return {result: 'skipped', steps: []}
  }

  let priorStepsSucceeded = true
  const steps = job.steps.map(step => {
    const stepCondition = String(step.if ?? '')
    const failedDependencies = [
      ...stepCondition.matchAll(/needs\.([a-z-]+)\.result != 'success'/g),
    ].map(match => match[1])
    const shouldRun = failedDependencies.length > 0
      ? failedDependencies.some(dependency => needs[dependency] !== 'success')
      : priorStepsSucceeded && eventConditionAllows(stepCondition, eventName)
    if (!shouldRun) return {name: step.name ?? step.uses ?? step.run, result: 'skipped'}

    const result = String(step.run ?? '')
      .split('\n')
      .some(line => line.trim() === 'exit 1')
      ? 'failure'
      : 'success'
    if (result === 'failure') priorStepsSucceeded = false
    return {name: step.name ?? step.uses ?? step.run, result}
  })

  return {result: priorStepsSucceeded ? 'success' : 'failure', steps}
}

test('workflow text is normalized to LF at the read boundary', () => {
  const crlfWorkflow = release.replaceAll('\n', '\r\n')
  const normalized = readWorkflowText('release-please.yml', () => crlfWorkflow)

  assert.doesNotMatch(normalized, /\r/)
  assert.match(
    normalized,
    /release-please:\n(?:.*\n)*?    permissions:\n      contents: write\n      pull-requests: write\n    outputs:/,
  )
})

test('release automation has no separately managed write credential', () => {
  assert.doesNotMatch(release, /\bsecrets\.|\bvars\./)
  assert.match(release, /token: \$\{\{ github\.token \}\}/)
  assert.match(release, /persist-credentials: false/)
})

test('the required commits job checks release PR metadata before merge', () => {
  assert.match(
    ci,
    /- name: Verify release pull request metadata\n        if: github\.event_name == 'pull_request'\n        run: node scripts\/verify-release-pr-metadata\.mjs "\$GITHUB_EVENT_PATH"/,
  )
  assert.match(
    release,
    /run: node scripts\/verify-release-please-output\.mjs "\$\{\{ github\.event\.before \}\}"/,
  )
})

test('write permissions are separated between release and dispatch jobs', () => {
  assert.match(
    release,
    /release-please:\n(?:.*\n)*?    permissions:\n      contents: write\n      pull-requests: write\n    outputs:/,
  )
  assert.match(
    release,
    /  dispatch:\n(?:.*\n)*?    permissions:\n      actions: write\n    steps:\n      - name: Dispatch workflows at exact release refs/,
  )
  const dispatchJob = release.slice(release.indexOf('\n  dispatch:'))
  assert.doesNotMatch(dispatchJob, /actions\/checkout|contents:|pull-requests:/)
  assert.doesNotMatch(release, /repository_dispatch/)
})

test('release branch CI is dispatched and checked at one exact SHA', () => {
  assert.match(release, /dispatch_workflow ci\.yml "\$ref" "\$sha"/)
  assert.match(release, /if \[ "\$returned_sha" != "\$expected_sha" \]/)
  assert.match(ci, /workflow_dispatch:\n    inputs:\n      expected_sha:/)
  assert.match(ci, /if \[ "\$ACTUAL_SHA" != "\$EXPECTED_SHA" \]/)
  assert.match(ci, /base=\$\(git merge-base origin\/main HEAD\)/)
})

test('explicit release-branch CI cannot recurse into release automation', () => {
  assert.match(release, /on:\n  push:\n    branches: \[main\]/)
  assert.doesNotMatch(release, /on:\n(?:.*\n)*?  workflow_dispatch:/)
  assert.match(ci, /permissions:\n  contents: read\n\njobs:/)
  assert.doesNotMatch(ci, /\n\s+(?:actions|contents|pull-requests): write/)
})

test('a failed integrity dependency makes every required check run and fail', () => {
  assert.deepEqual(
    requiredChecks.map(check => check.name).sort(),
    [
      'commits',
      'gates',
      'platform (macos-latest)',
      'platform (ubuntu-latest)',
      'platform (windows-11-arm)',
      'platform (windows-2025)',
      'secret-history',
    ],
  )

  for (const check of requiredChecks) {
    const dependencyNames = Array.isArray(check.job.needs) ? check.job.needs : [check.job.needs]
    const outcome = simulateJob(check.job, {
      eventName: 'workflow_dispatch',
      needs: Object.fromEntries(
        dependencyNames.map(dependency => [dependency, 'failure']),
      ),
    })
    assert.equal(outcome.result, 'failure', `${check.name} must fail, not ${outcome.result}`)
    assert.deepEqual(
      outcome.steps.map(step => step.result),
      ['failure', ...Array(outcome.steps.length - 1).fill('skipped')],
      `${check.name} must stop after its explicit integrity failure`,
    )
  }
})

test('CI uses Node 24 once per supported desktop host', () => {
  const platform = ciWorkflow.jobs.platform
  assert.deepEqual(
    platform.strategy.matrix.os,
    ['ubuntu-latest', 'macos-latest', 'windows-2025', 'windows-11-arm'],
  )
  assert.equal(platform.strategy.matrix.node, undefined)
  const setupNode = platform.steps.find(step => String(step.uses).startsWith('actions/setup-node@'))
  assert.equal(setupNode.with['node-version'], '24')
})

test('a packed install failure becomes a failing required gates check', () => {
  const gates = ciWorkflow.jobs.gates
  const dependencyNames = Array.isArray(gates.needs) ? gates.needs : [gates.needs]
  assert.deepEqual(
    dependencyNames.sort(),
    ['dispatch-integrity', 'packed-install'],
    'the required gates check must wait for both integrity and packed installation',
  )
  const outcome = simulateJob(gates, {
    eventName: 'pull_request',
    needs: Object.fromEntries(
      dependencyNames.map(dependency => [
        dependency,
        dependency === 'packed-install' ? 'failure' : 'success',
      ]),
    ),
  })

  assert.equal(outcome.result, 'failure')
  assert.deepEqual(
    outcome.steps.map(step => step.result),
    ['failure', ...Array(outcome.steps.length - 1).fill('skipped')],
    'gates must stop after explicitly surfacing the packed-install failure',
  )
})

test('each created release tag dispatches protected publication at its exact SHA', () => {
  assert.match(release, /dispatch_workflow publish\.yml "\$PROTOCOL_TAG" "\$PROTOCOL_SHA"/)
  assert.match(release, /dispatch_workflow publish\.yml "\$CLI_TAG" "\$CLI_SHA"/)
  assert.match(publish, /workflow_dispatch:\n    inputs:\n      expected_sha:/)
  assert.doesNotMatch(publish, /\n  push:/)
  assert.match(publish, /if \[ "\$ACTUAL_SHA" != "\$EXPECTED_SHA" \]/)
  assert.match(publish, /refs\/tags\/v\*\|refs\/tags\/protocol-v\*/)
  assert.match(publish, /- name: Require an immutable GitHub release/)
  assert.match(publish, /node scripts\/check-public-provider-posture\.mjs/)
  assert.match(publish, /--release-tag "\$GITHUB_REF_NAME"/)
  assert.match(publish, /--expected-sha "\$\{\{ inputs\.expected_sha \}\}"/)
  assert.match(ci, /- name: Verify public provider posture/)
  assert.match(publish, /environment: npm-release/)
  const windows = publishWorkflow.jobs['windows-cli']
  assert.deepEqual(windows.strategy.matrix.os, ['windows-2025', 'windows-11-arm'])
  assert.equal(windows.strategy.matrix.node, undefined)
  const setupNode = windows.steps.find(step => String(step.uses).startsWith('actions/setup-node@'))
  assert.equal(setupNode.with['node-version'], '24')
  assert.match(
    publish,
    /run: node scripts\/verify-published-windows\.mjs "\$\{\{ needs\.npm\.outputs\.cli_version \}\}"/,
  )
})

test('the publish workflow records the exact CLI version in GitHub output', () => {
  const step = publishWorkflow.jobs.npm.steps.find(
    candidate => candidate.name === 'Record the exact CLI version',
  )
  const directory = mkdtempSync(join(tmpdir(), 'notifai-publish-output-'))
  const output = join(directory, 'github-output')

  try {
    execFileSync('bash', ['-c', step.run], {
      cwd: process.cwd(),
      env: {...process.env, GITHUB_OUTPUT: output},
    })
    assert.equal(readFileSync(output, 'utf8'), `version=${cliPackage.version}\n`)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('publication reuses the exact tarballs that passed boundary and install checks', () => {
  const steps = publishWorkflow.jobs.npm.steps
  const cleanCheckout = steps.find(candidate => candidate.name === 'Verify the clean release checkout')
  const pack = steps.find(candidate => candidate.name === 'Pack once and verify the exact release artifacts')
  const publishProtocol = steps.find(candidate => candidate.name === 'Publish protocol with OIDC provenance')
  const verifyProtocol = steps.find(candidate => candidate.name === 'Verify published protocol bytes and metadata')
  const publishCli = steps.find(candidate => candidate.name === 'Publish CLI with OIDC provenance')
  const verifyCli = steps.find(candidate => candidate.name === 'Verify published CLI bytes and metadata')

  assert.doesNotMatch(cleanCheckout.run, /pnpm check:packed/)
  assert.match(pack.run, /pnpm --filter @raidiant\/notifai-protocol pack/)
  assert.match(pack.run, /pnpm --filter @raidiant\/notifai pack/)
  assert.match(pack.run, /scripts\/verify-packed-install\.mjs/)
  assert.match(pack.run, /--gitleaks(?:\s|$)/)
  assert.doesNotMatch(pack.run, /--gitleaks\s+gitleaks/)
  assert.match(pack.run, /PROTOCOL_TARBALL=\$protocol_tarball/)
  assert.match(pack.run, /CLI_TARBALL=\$cli_tarball/)
  assert.equal(publishProtocol.run, 'npm publish "$PROTOCOL_TARBALL" --access public --provenance')
  assert.match(verifyProtocol.run, /--expected-tarball "\$PROTOCOL_TARBALL"/)
  assert.equal(publishCli.run, 'npm publish "$CLI_TARBALL" --access public --provenance')
  assert.match(verifyCli.run, /--expected-tarball "\$CLI_TARBALL"/)
})

test('the rootless combined manifest does not use an empty group title template', () => {
  assert.equal(releaseConfig.packages['.'], undefined)
  assert.equal(releaseConfig['group-pull-request-title-pattern'], undefined)
  assert.deepEqual(Object.keys(releaseConfig.packages).sort(), ['apps/cli', 'packages/protocol'])
  assert.deepEqual(releaseConfig.plugins, [
    {type: 'node-workspace', updateAllPackages: true},
  ])
})

test('single-package releases are verified at their exact tags and dispatched', () => {
  const sha = 'a'.repeat(40)
  const cli = verifyReleasePleaseOutput({
    before: {'apps/cli': '9.0.0', 'packages/protocol': '5.0.0'},
    after: {'apps/cli': '9.1.0', 'packages/protocol': '5.0.0'},
    config: releaseConfig,
    sha,
    outputs: {
      releasesCreated: 'true',
      packages: {
        'apps/cli': {created: 'true', tag: 'v9.1.0', sha},
      },
    },
  })
  const protocol = verifyReleasePleaseOutput({
    before: {'apps/cli': '9.1.0', 'packages/protocol': '4.1.0'},
    after: {'apps/cli': '9.1.0', 'packages/protocol': '5.0.0'},
    config: releaseConfig,
    sha,
    outputs: {
      releasesCreated: 'true',
      packages: {
        'packages/protocol': {created: 'true', tag: 'protocol-v5.0.0', sha},
      },
    },
  })

  assert.deepEqual(cli, [
    {path: 'apps/cli', before: '9.0.0', version: '9.1.0', tag: 'v9.1.0'},
  ])
  assert.deepEqual(protocol, [
    {
      path: 'packages/protocol',
      before: '4.1.0',
      version: '5.0.0',
      tag: 'protocol-v5.0.0',
    },
  ])
  assert.match(release, /cli_release_created: \$\{\{ steps\.release-please\.outputs\['apps\/cli--release_created'\] \}\}/)
  assert.match(release, /protocol_release_created: \$\{\{ steps\.release-please\.outputs\['packages\/protocol--release_created'\] \}\}/)
  assert.match(release, /if \[ "\$CLI_RELEASE_CREATED" = "true" \]; then\n            dispatch_workflow publish\.yml "\$CLI_TAG" "\$CLI_SHA"/)
  assert.match(release, /if \[ "\$PROTOCOL_RELEASE_CREATED" = "true" \]; then\n            dispatch_workflow publish\.yml "\$PROTOCOL_TAG" "\$PROTOCOL_SHA"/)
})

test('an expected release with no release-please output fails loudly', () => {
  assert.throws(
    () => verifyReleasePleaseOutput({
      before: {'apps/cli': '9.0.0', 'packages/protocol': '5.0.0'},
      after: {'apps/cli': '9.1.0', 'packages/protocol': '5.0.0'},
      config: releaseConfig,
      sha: 'a'.repeat(40),
      outputs: {releasesCreated: 'false', packages: {}},
    }),
    /release manifest advanced apps\/cli, but release-please reported no release/,
  )
  assert.match(release, /- name: Require every expected package release/)
  assert.match(release, /run: node scripts\/verify-release-please-output\.mjs "\$\{\{ github\.event\.before \}\}"/)
})
