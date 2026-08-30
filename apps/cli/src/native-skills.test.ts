import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SKILLS_INSTALLER_SPEC,
  nativeSkills,
  runSkillsCommand,
  skillsAddArgv,
  skillsRemoveArgv,
} from './native-skills.js'

function writeLock(file: string, ref: string, skillPath?: string): void {
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
          ...(skillPath === undefined ? {} : { skillPath }),
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

  it('passes the verified project-relative package source without prompting', () => {
    const source = path.join('.notifai', 'skill-source-fixture')
    expect(
      skillsAddArgv({
        source,
        skill: 'notifai',
        cwd: '/tmp',
        env: {},
        scope: 'project',
      }),
    ).toEqual([
      '-y',
      SKILLS_INSTALLER_SPEC,
      'add',
      source,
      '--skill',
      'notifai',
      '--copy',
      '--yes',
    ])
  })

  it('uninstalls one skill in the named scope without a prompt', () => {
    expect(
      skillsRemoveArgv({
        skill: 'notifai',
        scope: 'project',
        cwd: '/tmp',
        env: {},
      }),
    ).toEqual(['-y', SKILLS_INSTALLER_SPEC, 'remove', 'notifai', '--yes'])
    expect(
      skillsRemoveArgv({
        skill: 'notifai',
        scope: 'global',
        cwd: '/tmp',
        env: {},
      }),
    ).toEqual(['-y', SKILLS_INSTALLER_SPEC, 'remove', 'notifai', '--global', '--yes'])
  })
})

describe('runSkillsCommand', () => {
  it('preserves a local launch failure instead of misreporting a network error', async () => {
    const result = await runSkillsCommand([], { cwd: '/tmp', env: {} }, () => {
      throw new Error(
        'this Windows Node.js installation is missing its bundled npm tools; repair or reinstall Node.js, then rerun setup',
      )
    })

    expect(result).toEqual({
      code: 1,
      error:
        'this Windows Node.js installation is missing its bundled npm tools; repair or reinstall Node.js, then rerun setup',
    })
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

  it('uses the validated installed directory instead of source-relative lock skillPath', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-skills-lock-path-'))
    writeLock(path.join(cwd, 'skills-lock.json'), 'v0.5.1', 'notifai/SKILL.md')

    const result = await nativeSkills.list('project', cwd, { PATH: '/nonexistent' })
    expect(result.skills).toEqual([
      expect.objectContaining({
        name: 'notifai',
        path: path.join(cwd, '.agents', 'skills', 'notifai'),
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
