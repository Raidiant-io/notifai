#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { repositoryRoot } from './cross-platform.mjs'
import { installedChangelog } from '../apps/cli/dist/update-handoff.js'

const { values } = parseArgs({ options: { runtime: { type: 'string' } } })
assert.ok(values.runtime, '--runtime is required')
const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-native-changelog-'))
try {
  // Run the actual artifact's admitted read-only diagnostic outside the source
  // checkout. No installation, account state or service access is needed.
  const result = spawnSync(path.resolve(values.runtime), ['self-check', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(result.error, undefined)
  const report = JSON.parse(result.stdout)
  assert.equal(report.changelog?.available, true,
    `compiled artifact must carry readable release notes: ${JSON.stringify(report.changelog)}`)
  assert.ok(report.changelog.text?.includes(`## [${report.build.version}]`),
    'compiled artifact must expose notes for its own version')
  const expected = installedChangelog(report.build.version, undefined, path.join(repositoryRoot, 'apps/cli'))
  assert.deepEqual({ ...report.changelog, path: expected.path }, expected,
    'compiled release selection, text and truncation status must match canonical package notes')
  assert.equal(report.processVerified, true, 'native process identity must remain verified')
  assert.equal(report.skill.digest.startsWith('sha256:'), true)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(report.ok, true)
  process.stdout.write('Native artifact changelog, skill and process identity verified\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
