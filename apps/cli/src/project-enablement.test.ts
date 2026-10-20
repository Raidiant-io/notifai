import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, projectLocation, sharedProjectConfigPath } from './config.js'
import {
  disableProject,
  enableProject,
  inferredProjectName,
  projectBinding,
  projectEnabled,
} from './project-enablement.js'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}

describe('Project enablement', () => {
  it('is disabled by default and changes only through its User-owned marker', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-enablement-'))
    git(root, 'init')
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') }
    const binding = projectBinding(root, env)
    expect(binding).not.toBeNull()
    expect(projectEnabled(binding)).toBe(false)

    enableProject(binding!, new Date('2026-08-27T00:00:00.000Z'))
    expect(projectEnabled(binding)).toBe(true)
    disableProject(binding!)
    expect(projectEnabled(binding)).toBe(false)
  })

  it('covers a nested directory of a non-Git Project the User enabled at its root', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-enablement-nested-'))
    const project = path.join(root, 'workspace')
    const nested = path.join(project, 'apps', 'cli')
    mkdirSync(path.join(project, '.notifai'), { recursive: true })
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(project, '.notifai', 'config.toml'), 'project = "workspace"\n')
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') }

    const atRoot = projectBinding(project, env, 'workspace')
    expect(atRoot).not.toBeNull()
    enableProject(atRoot!, new Date('2026-09-02T00:00:00.000Z'))

    // The hook fires wherever the agent happens to be standing.
    expect(projectEnabled(projectBinding(nested, env, 'workspace'))).toBe(true)
  })

  it('does not extend that decision to an unrelated directory', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-enablement-unrelated-'))
    const project = path.join(root, 'workspace')
    const unrelated = path.join(root, 'elsewhere')
    mkdirSync(path.join(project, '.notifai'), { recursive: true })
    mkdirSync(unrelated, { recursive: true })
    writeFileSync(path.join(project, '.notifai', 'config.toml'), 'project = "workspace"\n')
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') }

    enableProject(projectBinding(project, env, 'workspace')!, new Date('2026-09-02T00:00:00.000Z'))

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

  it('gives a submodule of a configured repository that repository\'s name, config and enablement', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-enablement-submodule-'))
    const library = path.join(root, 'library')
    const superproject = path.join(root, 'Super')
    committedRepo(library)
    committedRepo(superproject)
    mkdirSync(path.join(superproject, '.notifai'))
    writeFileSync(path.join(superproject, '.notifai', 'config.toml'), 'sound = "default"\n')
    execFileSync('git', ['-C', superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'public/sub'], { stdio: 'ignore' })
    const submodule = path.join(superproject, 'public', 'sub')
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') }

    expect(inferredProjectName(submodule, env)).toBe('super')
    expect(loadConfig({ cwd: submodule, env }).sound.source).toBe(`project:${projectLocation(superproject, env)!.configPath}`)
    enableProject(projectBinding(superproject, env)!, new Date('2026-10-20T00:00:00.000Z'))
    expect(projectBinding(submodule, env)).toEqual(projectBinding(superproject, env))
    expect(projectEnabled(projectBinding(submodule, env))).toBe(true)
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
    expect(sharedProjectConfigPath(home, env)).toBeNull()
    expect(projectBinding(home, env, 'explicit')).toBeNull()
    expect(loadConfig({ cwd: repo, env }).project.value).toBeNull()
    expect(projectBinding(repo, env)?.project).toBe('app')
    expect(sharedProjectConfigPath(repo, env)).toBe(path.join(projectLocation(repo, env)!.root, '.notifai', 'config.toml'))
  })
})
