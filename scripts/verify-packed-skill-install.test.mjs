import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
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


// Loading the reusable verifier while the install entrypoint awaits it must not
// re-enter that entrypoint (the former dynamic cycle exited Node with code 13).
test('shared verifier loads independently of either command entrypoint', () => {
  for (const entry of ['verify-packed-install.mjs', 'verify-packed-skill-install.mjs']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      process.argv[1] = ${JSON.stringify(new URL('./', import.meta.url).pathname)} + ${JSON.stringify(entry)};
      const { verifyPackedSkillInstaller } = await import(${JSON.stringify(new URL('./verify-installed-skill.mjs', import.meta.url).href)});
      if (typeof verifyPackedSkillInstaller !== 'function') throw new Error('missing verifier');
      console.log('loaded');
    `], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'loaded');
  }
});
