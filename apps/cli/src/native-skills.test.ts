import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  harnessSkillCopies,
  nativeSkills,
  staleHarnessSkillCopies,
} from './native-skills.js'
import { shippedSkillBundle } from './skill-integrity.js'

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

describe('harness-specific skill copies', () => {
  function home(): { root: string; env: NodeJS.ProcessEnv; conventional: string; digest: string } {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-harness-copies-'))
    const bundle = shippedSkillBundle()
    if (!bundle.ok) throw new Error(bundle.error)
    const conventional = path.join(root, '.agents', 'skills', 'notifai')
    cpSync(bundle.bundle.skillRoot, conventional, { recursive: true })
    return { root, env: { HOME: root, USERPROFILE: root }, conventional, digest: bundle.bundle.manifest.digest }
  }
  const skill = (conventional: string) => ({ name: 'notifai', scope: 'global' as const, path: conventional })

  it('names the harness whose own older copy shadows a current conventional skill', () => {
    const f = home()
    const claude = path.join(f.root, '.claude', 'skills', 'notifai')
    mkdirSync(claude, { recursive: true })
    writeFileSync(path.join(claude, 'SKILL.md'), '# older guidance\n')
    expect(staleHarnessSkillCopies(skill(f.conventional), f.digest, f.root, f.env)).toEqual([
      { agent: 'claude-code', label: 'Claude Code', path: claude, detected: true },
    ])
  })

  it('accepts a current copy and a link to the conventional directory', () => {
    const f = home()
    cpSync(f.conventional, path.join(f.root, '.claude', 'skills', 'notifai'), { recursive: true })
    mkdirSync(path.join(f.root, '.grok', 'skills'), { recursive: true })
    symlinkSync(f.conventional, path.join(f.root, '.grok', 'skills', 'notifai'), 'dir')
    expect(staleHarnessSkillCopies(skill(f.conventional), f.digest, f.root, f.env)).toEqual([])
  })

  it('counts a detected harness with no copy only when asked what an install should cover', () => {
    const f = home()
    mkdirSync(path.join(f.root, '.claude'), { recursive: true })
    expect(staleHarnessSkillCopies(skill(f.conventional), f.digest, f.root, f.env)).toEqual([])
    expect(staleHarnessSkillCopies(skill(f.conventional), f.digest, f.root, f.env, true).map((copy) => copy.agent))
      .toEqual(['claude-code'])
  })

  it('honours the harness home overrides the installer honours', () => {
    const f = home()
    const moved = path.join(f.root, 'elsewhere')
    expect(harnessSkillCopies('global', 'notifai', f.root, { ...f.env, CLAUDE_CONFIG_DIR: moved })[0]).toMatchObject({
      agent: 'claude-code', path: path.join(moved, 'skills', 'notifai'), detected: false,
    })
    expect(harnessSkillCopies('project', 'notifai', f.root, f.env).map((copy) => copy.path)).toEqual([
      path.join(f.root, '.claude', 'skills', 'notifai'),
      path.join(f.root, '.hermes', 'skills', 'notifai'),
      path.join(f.root, '.grok', 'skills', 'notifai'),
      path.join(f.root, 'skills', 'notifai'),
    ])
  })

})
