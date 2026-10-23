import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkGuidanceChanges, shippedGuidanceDigest } from './guidance-changes.mjs'

test('a reordered shipped instruction requires an authored note for its exact digest', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'guidance-notes-'))
  try {
    mkdirSync(path.join(root, 'apps/cli/src'), { recursive: true })
    mkdirSync(path.join(root, 'skills/notifai'), { recursive: true })
    const skill = path.join(root, 'skills/notifai/SKILL.md')
    writeFileSync(skill, 'Validate.\nSend.\n')
    const old = shippedGuidanceDigest(root)
    // The manifest key is portable even when the checkout uses Windows paths.
    assert.equal(old, createHash('sha256').update('skills/notifai/SKILL.md\0Validate.\nSend.\n\0').digest('hex'))
    const releases = [{ digest: old, note: 'Validate before sending.' }]
    const catalog = path.join(root, 'skills/guidance-changes.json')
    writeFileSync(catalog, JSON.stringify({ current: old, releases }))
    checkGuidanceChanges(root)
    writeFileSync(skill, 'Send.\nValidate.\n')
    assert.throws(() => checkGuidanceChanges(root), /without a release-authored note/)
    const current = shippedGuidanceDigest(root)
    releases.push({ digest: current, note: 'Send before validating.' })
    writeFileSync(catalog, JSON.stringify({ current, releases }))
    assert.equal(checkGuidanceChanges(root).releases.length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
