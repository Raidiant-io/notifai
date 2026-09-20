import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { updateSkillCommand } from './commands-update-skill.js'
import { shippedSkillBundle } from './skill-integrity.js'
import type { CommandDeps } from './commands-core.js'
import type { NativeSkill } from './native-skills.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-skill-refresh-'))
  roots.push(root)
  const bundle = shippedSkillBundle()
  if (!bundle.ok) throw new Error(bundle.error)
  const destination = path.join(root, 'installed')
  cpSync(bundle.bundle.skillRoot, destination, { recursive: true })
  writeFileSync(path.join(destination, 'SKILL.md'), 'stale guidance')
  const installed: NativeSkill = { name: 'notifai', scope: 'global', path: destination, source: null,
    sourceType: null, sourceUrl: null, ref: 'old' }
  const add = vi.fn(async () => { cpSync(bundle.bundle.skillRoot, destination, { recursive: true }); return 0 })
  const out: string[] = []
  const forbidden = () => { throw new Error('refresh must not run authentication, service or delivery setup') }
  const deps = { cwd: root, env: { HOME: root },
    io: { out: (line: string) => out.push(line), err: forbidden },
    store: { load: forbidden, save: forbidden, clear: forbidden, describe: forbidden }, clientFactory: forbidden,
    nativeSkills: { add, remove: forbidden, list: async (scope: string) => ({ skills: scope === 'global' ? [installed] : [] }) },
  } as unknown as CommandDeps
  return { deps, out, add }
}

it('refreshes only the existing skill scope without authentication or notification setup', async () => {
  const f = fixture()
  expect(await updateSkillCommand(f.deps, { json: true })).toBe(0)
  expect(f.add).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global', skill: 'notifai' }))
  expect(JSON.parse(f.out[0]!)).toMatchObject({ ok: true, changed: true, scope: 'global' })
  expect(await updateSkillCommand(f.deps, { json: true })).toBe(0)
  expect(f.add).toHaveBeenCalledTimes(1)
})

it('does not call a failed native installer a successful refresh', async () => {
  const f = fixture()
  f.add.mockImplementation(async () => 1)
  expect(await updateSkillCommand(f.deps, { json: true })).toBe(1)
  expect(JSON.parse(f.out[0]!)).toMatchObject({ ok: false })
})

it('does not choose a scope when no existing skill is known', async () => {
  const f = fixture()
  f.deps.nativeSkills!.list = async () => ({ skills: [] })
  expect(await updateSkillCommand(f.deps, { json: true })).toBe(1)
  expect(f.add).not.toHaveBeenCalled()
})
