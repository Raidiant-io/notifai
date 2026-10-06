import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { nativeSkills } from './native-skills.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('sets up, inspects, refreshes and removes bundled guidance without external programs', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-bundled-adapter-')); roots.push(root)
  const cwd = path.join(root, 'project'), home = path.join(root, 'home')
  mkdirSync(cwd); mkdirSync(home)
  const env = { HOME: home, USERPROFILE: home, XDG_STATE_HOME: path.join(root, 'state'), PATH: '' }
  const options = { cwd, env, scope: 'global' as const, skill: 'notifai' }
  expect(await nativeSkills.add(options)).toMatchObject({ code: 1 })
  expect(await nativeSkills.add({ ...options, agents: ['claude-code'] })).toBe(0)
  const listed = await nativeSkills.list('global', cwd, env)
  expect(listed.error).toBeUndefined()
  expect(listed.skills).toHaveLength(1)
  expect(readFileSync(path.join(listed.skills[0]!.path, 'SKILL.md'), 'utf8')).toContain('notifai')
  expect(await nativeSkills.add(options)).toBe(0)
  expect(await nativeSkills.remove({ cwd, env, scope: 'global', skill: 'notifai' })).toBe(0)
  expect((await nativeSkills.list('global', cwd, env)).skills).toEqual([])
})
