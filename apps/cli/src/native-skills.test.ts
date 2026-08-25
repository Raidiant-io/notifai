import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SKILLS_INSTALLER_SPEC, nativeSkills, skillsAddArgv } from './native-skills.js'

function writeLock(file: string, ref: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      skills: {
        notifai: {
          source: 'Raidiant-io/notifai',
          sourceType: 'github',
          sourceUrl: 'https://github.com/Raidiant-io/notifai.git',
          ref,
        },
      },
    })}\n`,
  )
}

describe('skillsAddArgv', () => {
  it('pins the installer package to an exact reviewed version', () => {
    const argv = skillsAddArgv({
      source: 'Raidiant-io/notifai#v8.0.0',
      skill: 'notifai',
      cwd: '/tmp',
      env: {},
    })
    expect(SKILLS_INSTALLER_SPEC).toMatch(/^skills@\d+\.\d+\.\d+$/)
    expect(argv).toEqual([
      '-y',
      SKILLS_INSTALLER_SPEC,
      'add',
      'Raidiant-io/notifai#v8.0.0',
      '--skill',
      'notifai',
    ])
    expect(argv).not.toContain('skills')
  })
})

describe('nativeSkills.list', () => {
  it('reads the project lock file instead of spawning npx', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-skills-project-'))
    writeLock(path.join(cwd, 'skills-lock.json'), 'v0.5.1')

    const result = await nativeSkills.list('project', cwd, { PATH: '/nonexistent' })
    expect(result.error).toBeUndefined()
    expect(result.skills).toEqual([
      expect.objectContaining({
        name: 'notifai',
        scope: 'project',
        source: 'Raidiant-io/notifai',
        sourceType: 'github',
        ref: 'v0.5.1',
      }),
    ])
  })

  it('reads the XDG global lock file instead of spawning npx', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-skills-xdg-'))
    const state = path.join(cwd, 'state')
    writeLock(path.join(state, 'skills', '.skill-lock.json'), 'v0.4.0')

    const result = await nativeSkills.list('global', cwd, {
      PATH: '/nonexistent',
      XDG_STATE_HOME: state,
    })
    expect(result.error).toBeUndefined()
    expect(result.skills).toEqual([
      expect.objectContaining({ name: 'notifai', scope: 'global', ref: 'v0.4.0' }),
    ])
  })

  it('falls back to the home-directory global lock', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-skills-home-'))
    const home = path.join(cwd, 'home')
    writeLock(path.join(home, '.agents', '.skill-lock.json'), 'v0.3.0')

    const result = await nativeSkills.list('global', cwd, { PATH: '/nonexistent', HOME: home })
    expect(result.error).toBeUndefined()
    expect(result.skills).toEqual([
      expect.objectContaining({ name: 'notifai', scope: 'global', ref: 'v0.3.0' }),
    ])
  })

  it('treats a missing lock as an empty inventory, not an installer error', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-skills-missing-'))
    const result = await nativeSkills.list('project', cwd, { PATH: '/nonexistent' })
    expect(result).toEqual({ skills: [] })
  })
})
