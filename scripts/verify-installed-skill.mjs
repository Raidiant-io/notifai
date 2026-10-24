import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { requireStatus, runExternal } from './run-external.mjs'
import { PACKED_SKILL_SMOKE_TIMEOUTS as TIMEOUTS } from './packed-skill-smoke.mjs'

export async function verifyPackedSkillInstaller(prepared, scratch) {
  // The distributed native executable performs every refresh; npm carries no product modules.
  const project = path.join(scratch, 'skill project Ω')
  const skill = path.join(project, '.agents/skills/notifai/SKILL.md')
  mkdirSync(path.dirname(skill), { recursive: true })
  writeFileSync(skill, 'Outdated fixture guidance\n')
  const env = { ...prepared.env, CODEX_HOME: path.join(prepared.home, 'codex'),
    XDG_CONFIG_HOME: path.join(prepared.home, 'config'), XDG_STATE_HOME: path.join(prepared.home, 'state'),
    PATH: process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '' }
  const execute = phase => JSON.parse(requireStatus(runExternal(prepared.nativeCommand, ['update', '--refresh-skill', '--json'], {
    cwd: project, env, timeoutMs: TIMEOUTS.cliCommand, phase })).stdout)
  const first = execute('native-packed-skill-refresh')
  const shipped = readFileSync(skill, 'utf8')
  if (first.ok !== true || first.changed !== true || shipped === 'Outdated fixture guidance\n') {
    throw new Error('Native refresh did not replace an outdated skill copy')
  }
  writeFileSync(skill, shipped + '\n<!-- local edit -->\n')
  const edited = execute('native-packed-skill-edited')
  if (edited.ok !== true || readFileSync(skill, 'utf8') !== shipped) throw new Error('Native refresh did not restore the shipped skill')
  const retry = execute('native-packed-skill-retry')
  if (retry.ok !== true || retry.changed !== false || readFileSync(skill, 'utf8') !== shipped) throw new Error('Native skill refresh is not idempotent')
  return { ok: true, build: prepared.nativeReceipt.build,
    checks: ['signed-native-bundle', 'native-outdated-copy-refresh', 'edited-copy-restore', 'idempotent-refresh'] }
}

