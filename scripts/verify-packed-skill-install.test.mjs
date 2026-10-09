import assert from 'node:assert/strict'
import test from 'node:test'
import { PACKED_SKILL_SMOKE_PATHS, skillSmokeWarranted } from './packed-skill-smoke.mjs'

test('adapter, pin, and bundle paths warrant the smoke; unrelated packed files do not', () => {
  assert.equal(skillSmokeWarranted(['apps/cli/src/native-skills.ts']), true)
  assert.equal(skillSmokeWarranted(['apps/cli/src/platform.ts']), true)
  assert.equal(skillSmokeWarranted(['apps/cli/src/skill-integrity.ts']), true)
  assert.equal(skillSmokeWarranted(['skills/notifai/SKILL.md']), true)
  assert.equal(skillSmokeWarranted(['scripts/verify-packed-skill-install.mjs']), true)
  assert.equal(skillSmokeWarranted(['apps/cli/src/commands.ts']), false)
  assert.equal(skillSmokeWarranted(['scripts/verify-packed-install.mjs']), false)
  assert.ok(PACKED_SKILL_SMOKE_PATHS.includes('apps/cli/src/native-skills.ts'))
})

