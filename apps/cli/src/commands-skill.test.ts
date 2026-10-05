import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandDeps } from './commands-core.js'
import { skillReadiness } from './commands-skill.js'
import { shippedSkillBundle } from './skill-integrity.js'

describe('development CLI skill parity', () => {
  it('reports an exact gap instead of calling a stale released skill ready', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-dev-skill-'))
    const installedPath = path.join(root, 'skills', 'notifai')
    mkdirSync(installedPath, { recursive: true })
    writeFileSync(path.join(installedPath, 'SKILL.md'), '# stale released skill\n')
    const deps = {
      cwd: root,
      env: {},
      io: { out() {}, err() {}, confirm: async () => false, openUrl() {} },
      store: { load: () => null, save() {}, clear() {}, describe: () => 'test' },
      nativeSkills: {
        list: async (scope: 'project' | 'global') => ({
          skills: scope === 'global'
            ? [{ name: 'notifai', scope, path: installedPath, source: null, sourceType: null, sourceUrl: null, ref: null }]
            : [],
        }),
        add: async () => 0,
        remove: async () => 0,
      },
    } satisfies CommandDeps

    const state = await skillReadiness(deps)
    expect(state).toMatchObject({
      status: 'gap',
      technical: {
        resolution: 'development-cli-skill-mismatch',
        ref: null,
        checkout_digest: expect.stringMatching(/^sha256:/),
        installed_digest: expect.stringMatching(/^sha256:/),
      },
    })
    expect(state.remedy).toBeUndefined()
  })
})

describe('harness-specific skill copies', () => {
  function installed(): { deps: CommandDeps; root: string; claude: string } {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-skill-copies-'))
    const bundle = shippedSkillBundle()
    if (!bundle.ok) throw new Error(bundle.error)
    const conventional = path.join(root, '.agents', 'skills', 'notifai')
    cpSync(bundle.bundle.skillRoot, conventional, { recursive: true })
    const claude = path.join(root, '.claude', 'skills', 'notifai')
    cpSync(bundle.bundle.skillRoot, claude, { recursive: true })
    const deps = {
      cwd: root,
      env: { HOME: root, USERPROFILE: root },
      io: { out() {}, err() {}, confirm: async () => false, openUrl() {} },
      store: { load: () => null, save() {}, clear() {}, describe: () => 'test' },
      nativeSkills: {
        list: async (scope: 'project' | 'global') => ({
          skills: scope === 'global'
            ? [{ name: 'notifai', scope, path: conventional, source: null, sourceType: null, sourceUrl: null, ref: null }]
            : [],
        }),
        add: async () => 0,
        remove: async () => 0,
      },
    } satisfies CommandDeps
    return { deps, root, claude }
  }

  it('is ready when every harness copy matches the shipped guidance', async () => {
    expect(await skillReadiness(installed().deps)).toMatchObject({ status: 'ready' })
  })

  it('reports the harness that loads an older copy instead of calling the skill ready', async () => {
    const f = installed()
    writeFileSync(path.join(f.claude, 'SKILL.md'), '# older guidance\n')
    const state = await skillReadiness(f.deps)
    expect(state).toMatchObject({
      status: 'gap',
      detail: expect.stringContaining('Claude Code loads its own copy'),
      technical: {
        resolution: 'stale-harness-skill-copy',
        stale_copies: [{ agent: 'claude-code', path: f.claude }],
      },
      remedy: { by: 'cli', command: 'notifai init --skills --skills-scope global' },
    })
  })
})
