import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillInstallation } from './skill-installation.js'
import { createSkillManifest, verifySkillBundle } from './skill-integrity.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-owned-skills-')); roots.push(root)
  const home = path.join(root, 'home'), cwd = path.join(root, 'project')
  mkdirSync(home); mkdirSync(cwd)
  const env = { HOME: home, USERPROFILE: home, PATH: '', XDG_STATE_HOME: path.join(home, 'state') }
  const bundle = (version: string) => {
    const source = path.join(root, version)
    mkdirSync(path.join(source, 'notifai'), { recursive: true })
    writeFileSync(path.join(source, 'notifai', 'SKILL.md'), `---\nname: notifai\n---\nGuidance ${version}\n`)
    writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(createSkillManifest(path.join(source, 'notifai'), version)))
    const result = verifySkillBundle(source, version)
    if (!result.ok) throw new Error(result.error)
    return result.bundle
  }
  return { home, cwd, env, bundle, installer: new SkillInstallation({ cwd, env }) }
}

describe('bundled skill ownership', () => {
  it('installs only selected harnesses and keeps that selection during refresh', () => {
    const f = fixture()
    expect(f.installer.reconcile({ scope: 'global', agents: ['claude-code'], bundle: f.bundle('1.0.0') }).ok).toBe(true)
    const skill = path.join(f.home, '.claude', 'skills', 'notifai', 'SKILL.md')
    expect(readFileSync(skill, 'utf8')).toContain('Guidance 1.0.0')
    mkdirSync(path.join(f.home, '.grok'))
    expect(f.installer.reconcile({ scope: 'global', bundle: f.bundle('2.0.0') }).ok).toBe(true)
    expect(readFileSync(skill, 'utf8')).toContain('Guidance 2.0.0')
    expect(existsSync(path.join(f.home, '.grok', 'skills', 'notifai'))).toBe(false)
    expect(f.installer.inspect('global').agents).toEqual(['claude-code'])
  })
  it('preserves user edits, extra files and unrelated skills on refresh and removal', () => {
    const f = fixture(), bundle = f.bundle('1.0.0')
    expect(f.installer.reconcile({ scope: 'project', agents: ['claude-code'], bundle }).ok).toBe(true)
    const parent = path.join(f.cwd, '.claude', 'skills'), skill = path.join(parent, 'notifai')
    mkdirSync(path.join(parent, 'unrelated')); writeFileSync(path.join(parent, 'unrelated', 'SKILL.md'), 'mine')
    writeFileSync(path.join(skill, 'notes.md'), 'my additions')
    expect(f.installer.reconcile({ scope: 'project', bundle: f.bundle('2.0.0') }).ok).toBe(false)
    expect(f.installer.remove('project').ok).toBe(false)
    expect(readFileSync(path.join(skill, 'notes.md'), 'utf8')).toBe('my additions')
    expect(readFileSync(path.join(parent, 'unrelated', 'SKILL.md'), 'utf8')).toBe('mine')
    rmSync(path.join(skill, 'notes.md'))
    expect(f.installer.remove('project').ok).toBe(true)
    expect(existsSync(skill)).toBe(false)
    expect(existsSync(path.join(parent, 'unrelated'))).toBe(true)
  })
  it('does not adopt a teammate’s matching project files without ownership evidence', () => {
    const f = fixture(), bundle = f.bundle('1.0.0')
    const destination = path.join(f.cwd, '.claude', 'skills', 'notifai')
    mkdirSync(destination, { recursive: true })
    writeFileSync(path.join(destination, 'SKILL.md'), readFileSync(path.join(bundle.skillRoot, 'SKILL.md')))
    expect(f.installer.reconcile({ scope: 'project', agents: ['claude-code'], bundle }).ok).toBe(false)
    expect(f.installer.inspect('project').placements).toEqual([])
    expect(existsSync(destination)).toBe(true)
  })
  it('recovers an interrupted replacement from retained verified content', () => {
    const f = fixture()
    const first = f.bundle('1.0.0'), second = f.bundle('2.0.0')
    expect(f.installer.reconcile({ scope: 'global', agents: ['claude-code'], bundle: first }).ok).toBe(true)
    const interrupted = new SkillInstallation({ cwd: f.cwd, env: f.env, observe(phase) {
      if (phase === 'old-retained') throw new Error('simulated interruption')
    } })
    expect(interrupted.reconcile({ scope: 'global', bundle: second }).ok).toBe(false)
    expect(f.installer.inspect('global').pending).toBe(true)
    expect(f.installer.reconcile({ scope: 'global', bundle: second }).ok).toBe(true)
    expect(f.installer.inspect('global').pending).toBe(false)
    expect(readFileSync(path.join(f.home, '.claude', 'skills', 'notifai', 'SKILL.md'), 'utf8')).toContain('Guidance 2.0.0')
  })
  it('restores the old tree and restages when an interrupted copy was lost', () => {
    const f = fixture(), first = f.bundle('1.0.0'), second = f.bundle('2.0.0')
    expect(f.installer.reconcile({ scope: 'global', agents: ['claude-code'], bundle: first }).ok).toBe(true)
    const interrupted = new SkillInstallation({ cwd: f.cwd, env: f.env, observe(phase) {
      if (phase === 'old-retained') throw new Error('simulated interruption')
    } })
    expect(interrupted.reconcile({ scope: 'global', bundle: second }).ok).toBe(false)
    const parent = path.join(f.home, '.claude', 'skills')
    for (const file of readdirSync(parent)) if (file.endsWith('.new')) rmSync(path.join(parent, file), { recursive: true })
    expect(f.installer.reconcile({ scope: 'global', bundle: second }).ok).toBe(true)
    expect(readFileSync(path.join(parent, 'notifai', 'SKILL.md'), 'utf8')).toContain('Guidance 2.0.0')
    expect(readdirSync(parent)).toEqual(['notifai'])
  })
  it('uses OpenClaw’s configured workspace and rejects an ambiguous project', () => {
    const f = fixture(), bundle = f.bundle('1.0.0')
    mkdirSync(path.join(f.home, '.openclaw'))
    const config = path.join(f.home, '.openclaw', 'openclaw.json')
    writeFileSync(config, JSON.stringify({ agents: { defaults: { workspace: path.join(f.home, 'different-workspace') } } }))
    expect(f.installer.reconcile({ scope: 'project', agents: ['openclaw'], bundle }).ok).toBe(false)
    expect(existsSync(path.join(f.cwd, 'skills'))).toBe(false)
    writeFileSync(config, JSON.stringify({ agents: { entries: { first: { workspace: f.cwd }, second: { workspace: f.cwd } } } }))
    expect(f.installer.reconcile({ scope: 'project', agents: ['openclaw'], bundle }).ok).toBe(false)
    writeFileSync(config, JSON.stringify({ agents: { entries: { main: { workspace: f.cwd } } } }))
    expect(f.installer.reconcile({ scope: 'project', agents: ['openclaw'], bundle }).ok).toBe(true)
    expect(readFileSync(path.join(f.cwd, 'skills', 'notifai', 'SKILL.md'), 'utf8')).toContain('Guidance 1.0.0')
  })
  it('keeps global OpenClaw guidance in the explicitly selected profile', () => {
    const f = fixture(), bundle = f.bundle('1.0.0')
    const installer = new SkillInstallation({ cwd: f.cwd, env: { ...f.env, OPENCLAW_PROFILE: 'work' } })
    const result = installer.reconcile({ scope: 'global', agents: ['openclaw'], bundle })
    expect(result.ok, result.conflicts.join('; ')).toBe(true)
    expect(existsSync(path.join(f.home, '.openclaw-work', 'skills', 'notifai'))).toBe(true)
    expect(existsSync(path.join(f.home, '.openclaw'))).toBe(false)
  })
})
