import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, personalProjectConfigPath, projectLocation } from './config.js'
import {
  disableProject,
  enableProject,
  inferredProjectName,
  projectBinding,
  projectDisabled,
  projectEnabled,
  projectEnablementState,
} from './project-enablement.js'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}

describe('Project enablement', () => {
  it('has no decision by default and changes only through its User-owned marker', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-enablement-'))
    git(root, 'init')
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') }
    const binding = projectBinding(root, env)
    expect(binding).not.toBeNull()
    expect(projectEnablementState(binding)).toBe('unset')
    expect(projectEnabled(binding)).toBe(false)

    enableProject(binding!, new Date('2026-08-27T00:00:00.000Z'))
    expect(projectEnablementState(binding)).toBe('enabled')
    disableProject(binding!, new Date('2026-08-28T00:00:00.000Z'))
    // The disable is a recorded decision, not the absence of one.
    expect(JSON.parse(readFileSync(binding!.markerPath, 'utf8'))).toMatchObject({ enabled: false })
    expect(projectEnablementState(binding)).toBe('disabled')
    expect(projectEnabled(binding)).toBe(false)
    expect(projectDisabled(binding)).toBe(true)
    enableProject(binding!)
    expect(projectEnablementState(binding)).toBe('enabled')
  })

  it('reads an unreadable record as no decision', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-enablement-corrupt-'))
    git(root, 'init')
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') }
    const binding = projectBinding(root, env)!
    mkdirSync(path.dirname(binding.markerPath), { recursive: true })
    writeFileSync(binding.markerPath, '{"version":1,')
    expect(projectEnablementState(binding)).toBe('unset')
  })

  it('does not extend a decision for an explicit Project outside Git to an unrelated directory', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-enablement-unrelated-'))
    const project = path.join(root, 'workspace')
    const unrelated = path.join(root, 'elsewhere')
    mkdirSync(project, { recursive: true })
    mkdirSync(unrelated, { recursive: true })
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') }

    enableProject(projectBinding(project, env, 'workspace')!, new Date('2026-09-02T00:00:00.000Z'))

    expect(projectEnabled(projectBinding(project, env, 'workspace'))).toBe(true)
    expect(projectEnabled(projectBinding(unrelated, env, 'workspace'))).toBe(false)
    expect(projectEnabled(projectBinding(unrelated, env))).toBe(false)
  })

  it('shares one decision across linked worktrees but not unrelated checkouts with the same name', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-enablement-git-'))
    const repo = path.join(root, 'same-name')
    const linked = path.join(root, 'linked')
    const unrelatedParent = path.join(root, 'other')
    const unrelated = path.join(unrelatedParent, 'same-name')
    mkdirSync(repo, { recursive: true })
    mkdirSync(unrelated, { recursive: true })
    for (const cwd of [repo, unrelated]) {
      git(cwd, 'init')
      git(cwd, 'config', 'user.email', 'test@example.invalid')
      git(cwd, 'config', 'user.name', 'Test')
      writeFileSync(path.join(cwd, 'file'), 'x')
      git(cwd, 'add', 'file')
      git(cwd, 'commit', '-m', 'fixture')
    }
    git(repo, 'worktree', 'add', linked, '-b', 'linked')
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') }
    const nested = path.join(repo, 'apps', 'cli')
    mkdirSync(nested, { recursive: true })
    const mainBinding = projectBinding(repo, env)
    const linkedBinding = projectBinding(linked, env)
    const nestedBinding = projectBinding(nested, env)
    const unrelatedBinding = projectBinding(unrelated, env)
    expect(linkedBinding?.markerPath).toBe(mainBinding?.markerPath)
    expect(nestedBinding?.markerPath).toBe(mainBinding?.markerPath)
    expect(unrelatedBinding?.markerPath).not.toBe(mainBinding?.markerPath)

    enableProject(mainBinding!, new Date('2026-09-02T00:00:00.000Z'))
    expect(projectEnabled(linkedBinding)).toBe(true)
    expect(projectEnabled(nestedBinding)).toBe(true)
    expect(projectEnabled(unrelatedBinding)).toBe(false)
  })

  it('does not share a decision with a second clone of the same repository', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-enablement-clone-'))
    const origin = path.join(root, 'origin')
    const clone = path.join(root, 'clone')
    mkdirSync(origin, { recursive: true })
    git(origin, 'init')
    git(origin, 'config', 'user.email', 'test@example.invalid')
    git(origin, 'config', 'user.name', 'Test')
    writeFileSync(path.join(origin, 'file'), 'x')
    git(origin, 'add', 'file')
    git(origin, 'commit', '-m', 'fixture')
    execFileSync('git', ['clone', origin, clone], { stdio: 'ignore' })
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') }

    enableProject(projectBinding(origin, env)!, new Date('2026-09-02T00:00:00.000Z'))

    expect(projectEnabled(projectBinding(clone, env))).toBe(false)
  })

  function committedRepo(cwd: string): void {
    mkdirSync(cwd, { recursive: true })
    git(cwd, 'init')
    git(cwd, 'config', 'user.email', 'test@example.invalid')
    git(cwd, 'config', 'user.name', 'Test')
    writeFileSync(path.join(cwd, 'file'), 'x')
    git(cwd, 'add', 'file')
    git(cwd, 'commit', '-m', 'fixture')
  }

  it('treats a submodule as its own Project, whatever the superproject commits', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-enablement-submodule-'))
    const library = path.join(root, 'library')
    const superproject = path.join(root, 'Super')
    committedRepo(library)
    committedRepo(superproject)
    // A committed file no longer names a Project root or configures anything.
    mkdirSync(path.join(superproject, '.notifai'))
    writeFileSync(path.join(superproject, '.notifai', 'config.toml'), 'project = "planted"\nsound = "default"\n')
    execFileSync('git', ['-C', superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'public/sub'], { stdio: 'ignore' })
    const submodule = path.join(superproject, 'public', 'sub')
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') }

    expect(inferredProjectName(superproject, env)).toBe('super')
    expect(inferredProjectName(submodule, env)).toBe('sub')
    expect(loadConfig({ cwd: submodule, env }).sound.source).toBe('default')
    expect(loadConfig({ cwd: superproject, env }).project.source).toBe('default')
    // Name and enablement key come from the same root, so they never disagree.
    const superBinding = projectBinding(superproject, env)!
    const subBinding = projectBinding(submodule, env)!
    expect(subBinding.project).toBe('sub')
    expect(subBinding.markerPath).not.toBe(superBinding.markerPath)
    enableProject(subBinding, new Date('2026-10-21T00:00:00.000Z'))
    expect(projectEnabled(projectBinding(path.join(submodule, '.'), env))).toBe(true)
    expect(projectEnabled(superBinding)).toBe(false)
  })

  it('lets the User name a Project from a file outside the repository', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-enablement-personal-'))
    const repo = path.join(root, 'app')
    committedRepo(repo)
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') }
    const file = personalProjectConfigPath(repo, env)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, 'project = "my-app"\n')
    const nested = path.join(repo, 'src')
    mkdirSync(nested)
    expect(loadConfig({ cwd: nested, env }).project).toEqual({ value: 'my-app', source: `project-local:${file}` })
  })

  it('never makes the home folder, or a plain folder above a checkout, a Project', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-enablement-home-'))
    const home = path.join(root, 'home')
    const code = path.join(home, 'Code')
    const repo = path.join(code, 'app')
    committedRepo(repo)
    for (const folder of [home, code]) {
      mkdirSync(path.join(folder, '.notifai'), { recursive: true })
      writeFileSync(path.join(folder, '.notifai', 'config.toml'), 'project = "swallowed"\n')
    }
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(root, 'config') }

    expect(projectLocation(home, env)).toBeNull()
    expect(projectBinding(home, env, 'explicit')).toBeNull()
    expect(loadConfig({ cwd: repo, env }).project.value).toBeNull()
    expect(projectBinding(repo, env)?.project).toBe('app')
    expect(path.basename(projectLocation(repo, env)!.root)).toBe('app')
  })
})
