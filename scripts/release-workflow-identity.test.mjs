import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {parse} from 'yaml'

function readWorkflowText(path, read = readFileSync) {
  return read(path, 'utf8').replace(/\r\n?/g, '\n')
}

const release = readWorkflowText('.github/workflows/release-please.yml')
const ci = readWorkflowText('.github/workflows/ci.yml')
const publish = readWorkflowText('.github/workflows/publish.yml')
const ciWorkflow = parse(ci)

const requiredChecks = [
  {name: 'commits', job: ciWorkflow.jobs.commits},
  {name: 'gates', job: ciWorkflow.jobs.gates},
  {name: 'secret-history', job: ciWorkflow.jobs['secret-history']},
  ...ciWorkflow.jobs.platform.strategy.matrix.os.flatMap(os =>
    ciWorkflow.jobs.platform.strategy.matrix.node.map(node => ({
      name: `platform (${os}, ${node})`,
      job: ciWorkflow.jobs.platform,
    })),
  ),
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

test('a failed integrity dependency makes all nine required checks run and fail', () => {
  assert.deepEqual(
    requiredChecks.map(check => check.name).sort(),
    [
      'commits',
      'gates',
      'platform (macos-latest, 20)',
      'platform (macos-latest, 24)',
      'platform (ubuntu-latest, 20)',
      'platform (ubuntu-latest, 24)',
      'platform (windows-latest, 20)',
      'platform (windows-latest, 24)',
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
  assert.match(publish, /environment: npm-release/)
})
