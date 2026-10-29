import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listProjectFolders, loadConfig, personalProjectConfigPath, projectLocation, updateProjectFolder } from './config.js'
import { projectFolderCommand, projectStatusCommand } from './commands-project.js'
import { configSetCommand } from './commands-config.js'
import type { CommandDeps } from './commands-core.js'
import { disableProject, inferredProjectName, projectBinding, projectEnablementState } from './project-enablement.js'
import { resolveDraftInvocation } from './commands-send-support.js'
import { buildDraft } from './send.js'
import { canonicalPath } from './local-path.js'
import { buildProgram } from './program.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = canonicalPath(mkdtempSync(path.join(os.tmpdir(), 'notifai-folder-projects-')))
  roots.push(root)
  const home = path.join(root, 'home')
  const folder = path.join(home, 'documents')
  const child = path.join(folder, 'drafts')
  mkdirSync(child, { recursive: true })
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
  const out: string[] = []
  const errors: string[] = []
  const deps: CommandDeps = {
    cwd: child, env,
    io: { out: line => out.push(line), err: line => errors.push(line), confirm: async () => false, openUrl: () => undefined },
    store: { load: () => null, save: () => undefined, clear: () => undefined, describe: () => 'test store' },
  }
  return { root, home, folder, child, env, deps, out, errors }
}

describe('machine-local folder Projects', () => {
  it('runs add, list, rename and remove through parsed CLI argv with stable local JSON', async () => {
    const f = fixture()
    const alias = path.join(f.root, 'alias')
    symlinkSync(f.folder, alias, 'dir')
    const codes: number[] = []
    const run = async (...args: string[]) => {
      await buildProgram(f.deps, { exit: code => { codes.push(code) } }).parseAsync(['node', 'notifai', 'project', 'folder', ...args])
      expect(codes.at(-1)).toBe(0)
      return JSON.parse(f.out.at(-1)!)
    }
    expect(await run('list', '--json')).toEqual({ folders: [] })
    expect(await run('add', alias, '--name', 'Writing', '--json')).toEqual({ folder: { path: f.folder, name: 'writing' } })
    expect(await run('list', '--json')).toEqual({ folders: [{ path: f.folder, name: 'writing' }] })
    expect(await run('rename', alias, '--name', 'Client Drafts', '--json')).toEqual({ folder: { path: f.folder, name: 'client-drafts' } })
    expect(readdirSync(f.folder)).toEqual(['drafts'])
    expect(await run('remove', alias, '--json')).toEqual({ folder: null })
    expect(await run('list', '--json')).toEqual({ folders: [] })
    expect(readdirSync(f.folder)).toEqual(['drafts'])
  })

  it('refuses unsafe roots, invalid names, Git checkouts and duplicate registrations', () => {
    const f = fixture()
    const file = path.join(f.root, 'file')
    writeFileSync(file, 'content')
    for (const directory of [file, path.join(f.root, 'missing')]) {
      expect(() => updateProjectFolder('add', directory, 'writing', f.env)).toThrow('not an existing directory')
    }
    for (const directory of [f.home, path.parse(f.root).root]) {
      expect(() => updateProjectFolder('add', directory, 'writing', f.env)).toThrow('home directory and filesystem root')
    }
    for (const name of ['', ' ', '---', '..', '📝']) {
      expect(() => updateProjectFolder('add', f.folder, name, f.env)).toThrow('Project name must contain')
    }
    updateProjectFolder('add', f.folder, 'writing', f.env)
    const alias = path.join(f.root, 'alias')
    symlinkSync(f.folder, alias, 'dir')
    expect(() => updateProjectFolder('add', alias, 'again', f.env)).toThrow('already registered; use notifai project folder rename')
    expect(() => updateProjectFolder('rename', f.folder, '', f.env)).toThrow('Project name must contain')
    for (const action of ['remove', 'rename'] as const) {
      expect(() => updateProjectFolder(action, f.child, 'writing', f.env)).toThrow('not registered')
    }
    execFileSync('git', ['init', f.child], { stdio: 'ignore' })
    const nested = path.join(f.child, 'src')
    mkdirSync(nested)
    for (const directory of [f.child, nested]) {
      expect(() => updateProjectFolder('add', directory, 'repo', f.env)).toThrow('is in a Git repository, which is already a Project')
    }
    expect(projectFolderCommand(f.deps, 'add', f.child, { name: 'repo', json: true })).toBe(2)
    expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ ok: false, error: expect.stringContaining('Git repository') })
    expect(listProjectFolders(f.env)).toEqual([{ path: f.folder, name: 'writing' }])
  })

  it('uses the nearest registered ancestor, with Git always taking precedence and no prefix matches', () => {
    const f = fixture()
    expect(inferredProjectName(f.child, f.env)).toBeNull()
    updateProjectFolder('add', f.folder, 'writing', f.env)
    expect(inferredProjectName(f.child, f.env)).toBe('writing')
    updateProjectFolder('add', f.child, 'drafts', f.env)
    const nested = path.join(f.child, 'notes')
    mkdirSync(nested)
    expect(projectLocation(nested, f.env)).toEqual({ root: f.child, checkout: false, name: 'drafts' })
    const sibling = `${f.folder}-other`
    mkdirSync(sibling)
    expect(inferredProjectName(sibling, f.env)).toBeNull()
    execFileSync('git', ['init', nested], { stdio: 'ignore' })
    expect(inferredProjectName(nested, f.env)).toBe('notes')
    expect(projectLocation(nested, f.env)).toEqual({ root: nested, checkout: true })
  })

  it('shares personal configuration and Enablement across descendants and folder renames', async () => {
    const f = fixture()
    updateProjectFolder('add', f.folder, 'writing', f.env)
    const binding = projectBinding(f.folder, f.env)!
    disableProject(binding)
    expect(projectBinding(f.child, f.env)).toEqual(binding)
    expect(personalProjectConfigPath(f.child, f.env)).toBe(personalProjectConfigPath(f.folder, f.env))
    const configFile = personalProjectConfigPath(f.folder, f.env)
    expect(await configSetCommand(f.deps, 'project', 'custom', { local: true, yes: true })).toBe(0)
    expect(loadConfig({ cwd: f.child, env: f.env }).project.value).toBe('custom')
    updateProjectFolder('rename', f.folder, 'renamed', f.env)
    expect(inferredProjectName(f.child, f.env)).toBe('renamed')
    expect(projectEnablementState(projectBinding(f.child, f.env))).toBe('disabled')
    expect(personalProjectConfigPath(f.child, f.env)).toBe(configFile)
    expect(projectStatusCommand(f.deps, true)).toBe(0)
    expect(JSON.parse(f.out.at(-1)!)).toEqual({ project: 'custom', enabled: false, disabled: true })
  })

  it('passes only the chosen name into drafts and preserves explicit, configured and Projectless precedence', () => {
    const f = fixture()
    updateProjectFolder('add', f.folder, 'writing', f.env)
    const invocation = resolveDraftInvocation(f.deps, {}, null)
    expect(invocation.ok).toBe(true)
    if (!invocation.ok) return
    const flags = { kind: 'update' as const, title: 'Writing', summary: 'Draft finished' }
    const config = loadConfig({ cwd: f.child, env: f.env })
    for (const [selection, expected] of [[{}, 'writing'], [{ project: 'explicit' }, 'explicit'], [{ projectless: true }, undefined]] as const) {
      const built = buildDraft(config, { ...flags, ...selection }, invocation.invocation)
      expect(built.ok).toBe(true)
      if (built.ok) {
        expect(built.draft.project).toBe(expected)
        expect(JSON.stringify(built.draft)).not.toContain(f.root)
      }
    }
    const configFile = personalProjectConfigPath(f.folder, f.env)
    mkdirSync(path.dirname(configFile), { recursive: true })
    writeFileSync(configFile, 'project = "configured"\n')
    const built = buildDraft(loadConfig({ cwd: f.child, env: f.env }), flags, invocation.invocation)
    expect(built.ok && built.draft.project).toBe('configured')
  })

  it('keeps an unreadable registry intact and reports the error through CLI JSON', async () => {
    const f = fixture()
    updateProjectFolder('add', f.folder, 'writing', f.env)
    const registry = path.join(f.env.XDG_CONFIG_HOME, 'notifai', 'project-folders.json')
    writeFileSync(registry, 'invalid json')
    const codes: number[] = []
    await buildProgram(f.deps, { exit: code => { codes.push(code) } }).parseAsync([
      'node', 'notifai', 'project', 'folder', 'add', f.child, '--name', 'drafts', '--json',
    ])
    expect(codes).toEqual([2])
    expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ ok: false, error: expect.stringContaining('Cannot read folder Projects') })
    expect(readFileSync(registry, 'utf8')).toBe('invalid json')
  })
})
