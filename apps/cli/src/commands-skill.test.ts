import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandDeps } from './commands-core.js'
import { nativeSkills } from './native-skills.js'
import { localIntegrationAssessment } from './integration-health.js'
import { skillReadiness } from './commands-skill.js'
import { appliesHere, firstBlocker } from './readiness.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const publishIntegration = <T>(action: () => T): T => action()

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-skill-readiness-'))
  roots.push(root)
  const cwd = path.join(root, 'project'), home = path.join(root, 'home')
  mkdirSync(cwd); mkdirSync(home)
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(root, 'state'), PATH: '' }
  const deps = { cwd, env, nativeSkills } as unknown as CommandDeps
  const place = async (scope: 'project' | 'global', harnesses: Parameters<typeof nativeSkills.place>[0]['harnesses']) =>
    expect(await nativeSkills.place({ scope, harnesses, cwd, env, publishIntegration })).toBe(0)
  const outdate = (directory: string) => {
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, 'SKILL.md'), 'guidance from an older release\n')
  }
  return { cwd, home, env, deps, place, outdate }
}

describe('skill readiness', () => {
  it('is ready when every harness loads the shipped guidance', async () => {
    const f = fixture()
    await f.place('global', ['claude-code', 'grok'])
    expect(await skillReadiness(f.deps)).toMatchObject({ id: 'skill', status: 'ready',
      detail: expect.stringContaining('Claude Code, Grok load the guidance shipped') })
  })

  it('holds an outdated copy only against the harnesses that load it', async () => {
    const f = fixture()
    await f.place('global', ['claude-code'])
    const grok = path.join(f.home, '.grok', 'skills', 'notifai')
    f.outdate(grok)
    const state = await skillReadiness(f.deps)
    expect(state).toMatchObject({ status: 'gap', harnesses: ['grok'],
      detail: `Grok loads outdated guidance from ${grok}`,
      remedy: { by: 'cli', command: 'notifai update --refresh-skill' } })
    expect(firstBlocker({ states: [state], harness: 'claude-code' })).toBeNull()
    expect(appliesHere({ states: [state], harness: 'grok' }, state)).toBe(true)
    expect(firstBlocker({ states: [state], harness: null })).toBe(state)
  })

  it('is optional when no harness has the skill', async () => {
    expect(await skillReadiness(fixture().deps)).toMatchObject({ status: 'optional-gap', detail: 'not installed for any harness' })
  })

  it('asks setup to place what it selected', async () => {
    const f = fixture()
    await f.place('global', ['claude-code'])
    expect(await skillReadiness(f.deps, 'project', ['claude-code'])).toMatchObject({ status: 'gap',
      remedy: { by: 'cli', command: 'notifai init --skills --skills-scope project --skills-harness claude-code' } })
    await f.place('project', ['claude-code'])
    expect(await skillReadiness(f.deps, 'project', ['claude-code'])).toMatchObject({ status: 'ready' })
  })

  it('notes a harness that loads the skill from both scopes', async () => {
    const f = fixture()
    await f.place('project', ['claude-code'])
    cpSync(path.join(f.cwd, '.claude', 'skills', 'notifai'), path.join(f.home, '.claude', 'skills', 'notifai'), { recursive: true })
    expect(await skillReadiness(f.deps)).toMatchObject({ status: 'optional-gap', harnesses: ['claude-code'] })
  })

  it('reports drift to the harness whose copy is outdated, and only to it', async () => {
    const f = fixture()
    await f.place('global', ['claude-code'])
    f.outdate(path.join(f.home, '.grok', 'skills', 'notifai'))
    const deps = { ...f.deps, hookAdapterHome: path.join(f.home, '.notifai') } as CommandDeps
    const codes = (harness?: 'claude-code' | 'grok') =>
      localIntegrationAssessment(deps, harness).faults.filter((fault) => fault.code === 'skill-drift')
    expect(codes('claude-code')).toEqual([])
    expect(codes('grok')).toHaveLength(1)
    expect(codes()).toHaveLength(1)
  })
})
