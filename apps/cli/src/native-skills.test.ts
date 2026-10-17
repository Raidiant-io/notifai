import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectSkillCopies, nativeSkills } from './native-skills.js'
import { shippedSkillBundle } from './skill-integrity.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const publishIntegration = <T>(action: () => T): T => action()

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-skill-copies-'))
  roots.push(root)
  const cwd = path.join(root, 'project'), home = path.join(root, 'home')
  mkdirSync(cwd); mkdirSync(home)
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(root, 'state'), PATH: '' }
  return { root, cwd, home, env }
}

function shippedSkillMd(): string {
  const bundle = shippedSkillBundle()
  if (!bundle.ok) throw new Error(bundle.error)
  return readFileSync(path.join(bundle.bundle.skillRoot, 'SKILL.md'), 'utf8')
}

function writeCopy(directory: string, contents = 'guidance from an older release\n'): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'SKILL.md'), contents)
}

describe('nativeSkills', () => {
  it('places, inspects, refreshes and removes bundled guidance without external programs', async () => {
    const { cwd, home, env } = fixture()
    expect(await nativeSkills.place({ scope: 'global', harnesses: [], cwd, env, publishIntegration })).toMatchObject({ code: 1 })
    expect(await nativeSkills.place({ scope: 'global', harnesses: ['claude-code'], cwd, env, publishIntegration })).toBe(0)
    const skill = path.join(home, '.claude', 'skills', 'notifai')
    expect(readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).toBe(shippedSkillMd())
    expect(inspectSkillCopies(cwd, env).copies).toEqual([
      { scopes: ['global'], path: skill, harnesses: ['claude-code'], condition: 'current' }])
    expect(await nativeSkills.refresh({ cwd, env, publishIntegration })).toEqual({ ok: true, changed: [] })
    expect(await nativeSkills.remove({ scopes: ['global'], cwd, env })).toBe(0)
    expect(inspectSkillCopies(cwd, env).copies).toEqual([])
  })

  it('refreshes a copy whoever placed it, and every harness that loads it', async () => {
    const { cwd, home, env } = fixture()
    const grok = path.join(home, '.grok', 'skills', 'notifai')
    const hermes = path.join(home, '.hermes', 'skills', 'notifai')
    writeCopy(grok)
    writeCopy(hermes, 'an edited copy\n')
    writeFileSync(path.join(hermes, 'extra.md'), 'an extra file\n')
    expect(inspectSkillCopies(cwd, env).copies.map((copy) => [copy.harnesses, copy.condition])).toEqual([
      [['hermes'], 'stale'], [['grok'], 'stale']])

    const refreshed = await nativeSkills.refresh({ cwd, env, publishIntegration })
    expect(refreshed).toEqual({ ok: true, changed: [hermes, grok] })
    expect(readFileSync(path.join(grok, 'SKILL.md'), 'utf8')).toBe(shippedSkillMd())
    expect(existsSync(path.join(hermes, 'extra.md'))).toBe(false)
    expect(inspectSkillCopies(cwd, env).copies.every((copy) => copy.condition === 'current')).toBe(true)
  })

  it('treats a linked skill directory as the copy it resolves to, and writes through the link', async () => {
    const { root, cwd, home, env } = fixture()
    // A harness profile whose skills directory links to the default one.
    const profile = path.join(root, 'profile')
    mkdirSync(profile)
    mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true })
    symlinkSync(path.join(home, '.claude', 'skills'), path.join(profile, 'skills'), 'dir')
    const linked = { ...env, CLAUDE_CONFIG_DIR: profile }
    expect(await nativeSkills.place({ scope: 'global', harnesses: ['claude-code'], cwd, env, publishIntegration })).toBe(0)
    expect(inspectSkillCopies(cwd, linked).copies).toEqual([{ scopes: ['global'],
      path: path.join(profile, 'skills', 'notifai'), harnesses: ['claude-code'], condition: 'current' }])

    writeFileSync(path.join(home, '.claude', 'skills', 'notifai', 'SKILL.md'), 'older guidance\n')
    expect((await nativeSkills.refresh({ cwd, env: linked, publishIntegration })).ok).toBe(true)
    expect(lstatSync(path.join(profile, 'skills')).isSymbolicLink()).toBe(true)
    expect(readFileSync(path.join(home, '.claude', 'skills', 'notifai', 'SKILL.md'), 'utf8')).toBe(shippedSkillMd())
  })

  it('counts one copy for harnesses that share a directory', async () => {
    const { cwd, env } = fixture()
    expect(await nativeSkills.place({ scope: 'project', harnesses: ['codex', 'cursor'], cwd, env, publishIntegration })).toBe(0)
    expect(inspectSkillCopies(cwd, env).copies).toEqual([{ scopes: ['project'],
      path: path.join(cwd, '.agents', 'skills', 'notifai'), harnesses: ['codex', 'cursor', 'opencode'], condition: 'current' }])
  })

  it('refuses a project destination that a link steers outside the project', async () => {
    const { root, cwd, env } = fixture()
    const elsewhere = path.join(root, 'elsewhere')
    mkdirSync(elsewhere)
    mkdirSync(path.join(cwd, '.claude'))
    symlinkSync(elsewhere, path.join(cwd, '.claude', 'skills'), 'dir')
    expect(await nativeSkills.place({ scope: 'project', harnesses: ['claude-code'], cwd, env, publishIntegration }))
      .toMatchObject({ code: 1, error: expect.stringContaining('outside the project') })
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('keeps a harness in one scope', async () => {
    const { cwd, home, env } = fixture()
    writeCopy(path.join(home, '.claude', 'skills', 'notifai'))
    writeCopy(path.join(home, '.grok', 'skills', 'notifai'))
    expect(await nativeSkills.place({ scope: 'project', harnesses: ['claude-code'], cwd, env, publishIntegration })).toBe(0)
    expect(inspectSkillCopies(cwd, env).copies.map((copy) => [copy.scopes, copy.harnesses])).toEqual([
      [['global'], ['grok']], [['project'], ['claude-code']]])
  })

  it('clears staging left by an interrupted write', async () => {
    const { cwd, home, env } = fixture()
    const skills = path.join(home, '.grok', 'skills')
    mkdirSync(path.join(skills, `.notifai-${'a'.repeat(24)}.old`), { recursive: true })
    mkdirSync(path.join(skills, 'another-skill'))
    expect(await nativeSkills.place({ scope: 'global', harnesses: ['grok'], cwd, env, publishIntegration })).toBe(0)
    expect(readdirSync(skills).sort()).toEqual(['another-skill', 'notifai'])
  })

  it('treats a directory that is both the project and the global location as one copy in both scopes', async () => {
    const { home, env } = fixture()
    expect(await nativeSkills.place({ scope: 'project', harnesses: ['claude-code'], cwd: home, env, publishIntegration })).toBe(0)
    expect(inspectSkillCopies(home, env).copies).toEqual([{ scopes: ['global', 'project'],
      path: path.join(home, '.claude', 'skills', 'notifai'), harnesses: ['claude-code'], condition: 'current' }])
    expect(await nativeSkills.remove({ scopes: ['project'], cwd: home, env })).toBe(0)
    expect(inspectSkillCopies(home, env).copies).toEqual([])
  })

  it('honours harness home overrides', () => {
    const { root, cwd, env } = fixture()
    const overrides = { CLAUDE_CONFIG_DIR: path.join(root, 'claude'), HERMES_HOME: path.join(root, 'hermes'),
      GROK_HOME: path.join(root, 'grok') }
    for (const home of Object.values(overrides)) writeCopy(path.join(home, 'skills', 'notifai'))
    expect(inspectSkillCopies(cwd, { ...env, ...overrides }).copies.map((copy) => [copy.harnesses, copy.path])).toEqual([
      [['claude-code'], path.join(overrides.CLAUDE_CONFIG_DIR, 'skills', 'notifai')],
      [['hermes'], path.join(overrides.HERMES_HOME, 'skills', 'notifai')],
      [['grok'], path.join(overrides.GROK_HOME, 'skills', 'notifai')],
    ])
  })
})
