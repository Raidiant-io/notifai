import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  behaviorDigest,
  changedInputs,
  checkAgentGuidance,
  DEFAULT_INPUT_ROOTS,
  REQUIRED_SURFACES,
} from './check-agent-guidance.mjs'

function write(root, relative, contents) {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'notifai-agent-guidance-'))
  const inputs = {
    'apps/cli/src/program.ts': 'program.option("--project <id>")\n',
    'apps/cli/src/readiness.ts': 'message: "Open /hooks and approve Notifai"\n',
    'packages/protocol/src/notification.ts': 'export const term = "Notification Request"\n',
    'skills/notifai/SKILL.md': '# Notifai\n',
    'skills/guidance-changes.json': JSON.stringify({ releases: [{ note: 'Read current guidance.' }] }),
    'README.md': [
      '# Notifai',
      '',
      'Install `@raidiant/notifai` <!--x-release-please-start-notifai-->9.2.2<!--x-release-please-end-->.',
      '',
    ].join('\n'),
    'docs/USAGE.md': '# Using Notifai\n',
    'docs/HARNESSES.md': '# Harness support\n',
    'docs/TRUST.md': '# Trust\n',
  }
  for (const [relative, contents] of Object.entries(inputs)) write(root, relative, contents)
  const recordPath = path.join(root, 'agent-guidance-review.json')
  writeFileSync(recordPath, JSON.stringify({
    version: 1,
    behavior_digest: behaviorDigest(root, DEFAULT_INPUT_ROOTS),
    outcome: 'reviewed-no-impact',
    reason: 'The fixture starts from a deliberately reviewed behavior baseline.',
    surfaces_reviewed: REQUIRED_SURFACES,
  }))
  return { root, recordPath }
}

function assertMutationIsCaught(relative, mutate) {
  const { root, recordPath } = fixture()
  try {
    const target = path.join(root, relative)
    writeFileSync(target, mutate(readFileSync(target, 'utf8')))
    assert.throws(
      () => checkAgentGuidance({ repo: root, recordPath }),
      /Agent Guidance review is stale/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('rejects a stale CLI flag review fixture', () => {
  assertMutationIsCaught('apps/cli/src/program.ts', (source) => source.replace('--project', '--workspace'))
})

test('rejects a stale hook-remedy review fixture', () => {
  assertMutationIsCaught('apps/cli/src/readiness.ts', (source) => source.replace('/hooks', '/config'))
})

test('rejects a stale domain-term review fixture', () => {
  assertMutationIsCaught('packages/protocol/src/notification.ts', (source) => source.replace('Notification Request', 'Alert'))
})

test('ignores only the generated README release version payload', () => {
  const { root, recordPath } = fixture()
  try {
    const readmePath = path.join(root, 'README.md')
    const before = behaviorDigest(root, DEFAULT_INPUT_ROOTS)
    writeFileSync(
      readmePath,
      readFileSync(readmePath, 'utf8').replace(
        '<!--x-release-please-start-notifai-->9.2.2<!--x-release-please-end-->',
        '<!--x-release-please-start-notifai-->9.3.0<!--x-release-please-end-->',
      ),
    )
    assert.equal(behaviorDigest(root, DEFAULT_INPUT_ROOTS), before)
    assert.doesNotThrow(() => checkAgentGuidance({ repo: root, recordPath }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('still rejects semantic README text beside a generated version marker', () => {
  assertMutationIsCaught('README.md', (source) => source.replace('Install', 'Uninstall'))
})

test('does not hide arbitrary text placed inside a release marker', () => {
  assertMutationIsCaught('README.md', (source) => source.replace('9.2.2', 'install from anywhere'))
})

test('rejects stale review after a release-authored guidance note changes', () => {
  assertMutationIsCaught('skills/guidance-changes.json', source => source.replace('Read current guidance.', 'Reload the full skill.'))
})


test('stale preflight lists added, edited and removed inputs without approving the record', () => {
  const { root, recordPath } = fixture()
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  try {
    git(['init'])
    git(['add', '.'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture'])
    const record = readFileSync(recordPath, 'utf8')
    write(root, 'apps/cli/src/added.ts', 'export const added = true')
    write(root, 'apps/cli/src/program.ts', 'changed')
    write(root, 'apps/cli/src/ignored.test.ts', 'test only')
    rmSync(path.join(root, 'apps/cli/src/readiness.ts'))
    assert.deepEqual(changedInputs(root, recordPath), [
      'apps/cli/src/added.ts', 'apps/cli/src/program.ts', 'apps/cli/src/readiness.ts',
    ])
    assert.throws(() => checkAgentGuidance({ repo: root, recordPath }), error => {
      assert.match(error.message, /apps\/cli\/src\/program.ts/)
      assert.match(error.message, /node scripts\/check-agent-guidance.mjs --print/)
      for (const surface of REQUIRED_SURFACES) assert.ok(error.message.includes(surface))
      return true
    })
    assert.equal(readFileSync(recordPath, 'utf8'), record)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an excluded path inside an input root cannot make the review stale, and is not listed', () => {
  const { root, recordPath } = fixture()
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  const excluded = ['docs/USAGE.md']
  try {
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    writeFileSync(recordPath, JSON.stringify({ ...record, behavior_digest: behaviorDigest(root, DEFAULT_INPUT_ROOTS, excluded) }))
    git(['init'])
    git(['add', '.'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture'])
    write(root, 'docs/USAGE.md', '# Using Notifai, reworded\n')
    checkAgentGuidance({ repo: root, recordPath, excluded })
    assert.deepEqual(changedInputs(root, recordPath, DEFAULT_INPUT_ROOTS, excluded), [])
    write(root, 'docs/HARNESSES.md', '# Harness support, changed\n')
    assert.throws(() => checkAgentGuidance({ repo: root, recordPath, excluded }), /docs\/HARNESSES.md/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
