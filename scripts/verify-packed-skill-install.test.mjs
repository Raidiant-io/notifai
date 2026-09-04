import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { PACKED_SKILL_SMOKE_PATHS, skillSmokeWarranted } from './packed-skill-smoke.mjs'
import { repositoryRoot } from './cross-platform.mjs'

const read = (file) => readFileSync(path.join(repositoryRoot, file), 'utf8').replace(/\r\n?/gu, '\n')
const packageJson = JSON.parse(read('package.json'))
const packedInstall = read('scripts/verify-packed-install.mjs')
const skillSmoke = read('scripts/verify-packed-skill-install.mjs')
const agents = read('AGENTS.md')
const releasing = read('docs/RELEASING.md')
const ci = read('.github/workflows/ci.yml')
const publish = read('.github/workflows/publish.yml')
const ciWorkflow = parse(ci)
const publishWorkflow = parse(publish)

test('the deterministic packed gate does not spawn the third-party skills installer', () => {
  assert.doesNotMatch(packedInstall, /nativeSkills\.add/u)
  assert.doesNotMatch(packedInstall, /skillsAddArgv/u)
  assert.doesNotMatch(packedInstall, /npxLaunch/u)
  assert.doesNotMatch(packedInstall, /npm exec/u)
  assert.match(packedInstall, /verify-packed-skill-install\.mjs/u)
  assert.match(packedInstall, /stageShippedSkillBundle/u)
  assert.doesNotMatch(packageJson.scripts['check:packed'], /node scripts\/verify-packed-skill-install\.mjs/u)
  assert.match(packageJson.scripts['check:packed'], /verify-packed-install\.mjs/u)
  assert.match(packageJson.scripts['check:packed'], /run-external\.test\.mjs/u)
  assert.match(packageJson.scripts['check:packed'], /verify-packed-skill-install\.test\.mjs/u)
})

test('the integration smoke is a separately named command with per-phase timeouts', () => {
  assert.match(packageJson.scripts['check:packed-skill-smoke'], /verify-packed-skill-install\.mjs/u)
  assert.match(skillSmoke, /phase npm-exec-skills-installer/u)
  assert.match(skillSmoke, /phase skill-registry-metadata/u)
  assert.match(skillSmoke, /timeoutMs: TIMEOUTS\.npmExecSkills/u)
  assert.match(skillSmoke, /--if-changed/u)
  assert.match(skillSmoke, /registry metadata for .* already succeeded/u)
})

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

test('release CI keeps packed-install deterministic and path-gates the installer smoke', () => {
  const gates = ciWorkflow.jobs.gates.steps.map((step) => `${step.name ?? ''}\n${step.run ?? ''}`).join('\n')
  assert.match(gates, /pnpm check:packed/u)
  assert.match(gates, /pnpm check:packed-skill-smoke -- --if-changed/u)
  assert.doesNotMatch(packageJson.scripts['check:packed'], /packed-skill-smoke/u)
  for (const id of ['platform-windows-x64', 'platform-windows-arm']) {
    const windows = ciWorkflow.jobs[id].steps.map((step) => step.run ?? '').join('\n')
    assert.match(windows, /pnpm check:packed/u)
    assert.doesNotMatch(windows, /check:packed-skill-smoke/u)
  }
})

test('publication always runs the installer smoke against the exact packed tarballs', () => {
  const pack = publishWorkflow.jobs.npm.steps.find(
    (candidate) => candidate.name === 'Pack once and verify the exact release artifacts',
  )
  assert.match(pack.run, /scripts\/verify-packed-install\.mjs/u)
  assert.match(pack.run, /scripts\/verify-packed-skill-install\.mjs/u)
  assert.doesNotMatch(pack.run, /--if-changed/u)
})

test('docs tell agents when the installer smoke is warranted', () => {
  assert.match(agents, /pnpm check:packed-skill-smoke/u)
  assert.match(agents, /adapter, installer pin, or packaged skill bundle/u)
  assert.match(releasing, /check:packed-skill-smoke/u)
  assert.doesNotMatch(agents.split('## Gates')[1].split('## Releasing')[0], /check:packed-skill-smoke/u)
})

