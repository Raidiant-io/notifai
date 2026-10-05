import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SKILLS_INSTALLER_SPEC,
  addToEveryHarness,
  harnessSkillCopies,
  nativeSkills,
  runSkillsCommand,
  skillsAddArgv,
  skillsRemoveArgv,
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
  it('bounds a stalled native installer and reports incomplete integration', async () => {
    const result = await runSkillsCommand([], { cwd: os.tmpdir(), env: {}, timeoutMs: 100 }, () => ({
      file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], options: { stdio: 'ignore' },
    }))
    expect(result).toMatchObject({ code: 1, error: expect.stringContaining('timed out') })
  })
  it('keeps native installer stdout out of structured command output', () => {
    const moduleUrl = new URL('../dist/native-skills.js', import.meta.url).href
    const script = `import { runSkillsCommand } from ${JSON.stringify(moduleUrl)};
      const result = await runSkillsCommand([], { cwd: process.cwd(), env: process.env, diagnosticsToStderr: true },
        (_args, options) => ({ file: process.execPath, args: ['-e', 'console.log("installer progress")'], options }));
      console.log(JSON.stringify({ ok: result === 0 }));`
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(JSON.parse(output)).toEqual({ ok: true })
  })

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

  it('preserves an actual process launch failure instead of misreporting the network', async () => {
    const missingExecutable = path.join(
      os.tmpdir(),
      `notifai-missing-skills-installer-${process.pid}`,
    )
    const result = await runSkillsCommand([], { cwd: os.tmpdir(), env: {} }, () => ({
      file: missingExecutable,
      args: [],
      options: { cwd: os.tmpdir(), env: {}, stdio: 'ignore' },
    }))

    expect(result).toEqual({
      code: 1,
      error:
        'the native skills installer could not start on this machine; repair the local Node.js and npm installation, then rerun setup',
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

  it('runs a second, named install for the copies the first run left behind', async () => {
    const f = home()
    const claude = path.join(f.root, '.claude', 'skills', 'notifai')
    mkdirSync(claude, { recursive: true })
    writeFileSync(path.join(claude, 'SKILL.md'), '# older guidance\n')
    mkdirSync(path.join(f.root, '.grok'), { recursive: true })
    const runs: string[][] = []
    const run = async (args: string[]) => {
      runs.push(args)
      return 0
    }
    const result = await addToEveryHarness(
      { source: './.notifai/skill-source-test', skill: 'notifai', scope: 'global', cwd: f.root, env: f.env },
      f.digest,
      run as never,
    )
    expect(result).toBe(0)
    expect(runs).toHaveLength(2)
    expect(runs[0]).not.toContain('--agent')
    expect(runs[1]!.slice(-3)).toEqual(['--agent', 'claude-code', 'grok'])
  })

  it('runs the installer once when every harness copy is already current', async () => {
    const f = home()
    cpSync(f.conventional, path.join(f.root, '.claude', 'skills', 'notifai'), { recursive: true })
    const runs: string[][] = []
    const result = await addToEveryHarness(
      { source: './.notifai/skill-source-test', skill: 'notifai', scope: 'global', cwd: f.root, env: f.env },
      f.digest,
      (async (args: string[]) => { runs.push(args); return 0 }) as never,
    )
    expect(result).toBe(0)
    expect(runs).toHaveLength(1)
  })

  it('does not start a second install after the first one failed', async () => {
    const f = home()
    mkdirSync(path.join(f.root, '.claude'), { recursive: true })
    const runs: string[][] = []
    const result = await addToEveryHarness(
      { source: './.notifai/skill-source-test', skill: 'notifai', scope: 'global', cwd: f.root, env: f.env },
      f.digest,
      (async (args: string[]) => { runs.push(args); return 1 }) as never,
    )
    expect(result).toBe(1)
    expect(runs).toHaveLength(1)
  })
})
