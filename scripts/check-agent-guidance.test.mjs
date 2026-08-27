import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  behaviorDigest,
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
    'README.md': '# Notifai\n',
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
