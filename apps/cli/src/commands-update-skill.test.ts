import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { updateSkillCommand } from './commands-update-skill.js'
import { nativeSkills, type NativeSkills } from './native-skills.js'
import type { CommandDeps } from './commands-core.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const publication = <T>(action: () => T): T => action()

function fixture(skills: NativeSkills = nativeSkills) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-skill-refresh-'))
  roots.push(root)
  const grok = path.join(root, '.grok', 'skills', 'notifai')
  mkdirSync(grok, { recursive: true })
  writeFileSync(path.join(grok, 'SKILL.md'), 'stale guidance')
  const out: string[] = []
  const forbidden = () => { throw new Error('refresh must not run authentication, service or delivery setup') }
  const deps = { cwd: root, env: { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, '.config') },
    io: { out: (line: string) => out.push(line), err: forbidden },
    store: { load: forbidden, save: forbidden, clear: forbidden, describe: forbidden }, clientFactory: forbidden,
    nativeSkills: skills,
  } as unknown as CommandDeps
  return { deps, out, grok }
}

it('rewrites every outdated copy without authentication or notification setup', async () => {
  const f = fixture()
  expect(await updateSkillCommand(f.deps, { json: true }, publication)).toBe(0)
  expect(JSON.parse(f.out[0]!)).toMatchObject({ ok: true, changed: true, refreshed: [f.grok],
    copies: [{ scope: 'global', path: f.grok, harnesses: ['grok'] }] })
  expect(readFileSync(path.join(f.grok, 'SKILL.md'), 'utf8')).not.toBe('stale guidance')
  expect(await updateSkillCommand(f.deps, { json: true }, publication)).toBe(0)
  expect(JSON.parse(f.out[1]!)).toMatchObject({ ok: true, changed: false, refreshed: [] })
})

it('does not call a failed refresh a success', async () => {
  const f = fixture({ ...nativeSkills, refresh: async () => ({ ok: false, changed: [], error: 'disk full' }) })
  expect(await updateSkillCommand(f.deps, { json: true }, publication)).toBe(1)
  expect(JSON.parse(f.out[0]!)).toEqual({ ok: false, error: 'disk full' })
})

it('does not report success while a copy is still outdated', async () => {
  const f = fixture({ ...nativeSkills, refresh: async () => ({ ok: true, changed: [] }) })
  expect(await updateSkillCommand(f.deps, { json: true }, publication)).toBe(1)
  expect(JSON.parse(f.out[0]!).error).toContain(f.grok)
})
