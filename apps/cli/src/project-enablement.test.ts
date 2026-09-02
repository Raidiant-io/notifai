import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  disableProject,
  enableProject,
  projectBinding,
  projectEnabled,
} from './project-enablement.js'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}

describe('Project enablement', () => {
  it('is disabled by default and changes only through its User-owned marker', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-enablement-'))
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

    const atRoot = projectBinding(project, env)
    expect(atRoot).not.toBeNull()
    enableProject(atRoot!, new Date('2026-09-02T00:00:00.000Z'))

    // The hook fires wherever the agent happens to be standing.
    expect(projectEnabled(projectBinding(nested, env))).toBe(true)
  })

  it('does not extend that decision to an unrelated directory', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-enablement-unrelated-'))
    const project = path.join(root, 'workspace')
    const unrelated = path.join(root, 'elsewhere')
    mkdirSync(path.join(project, '.notifai'), { recursive: true })
    mkdirSync(unrelated, { recursive: true })
    writeFileSync(path.join(project, '.notifai', 'config.toml'), 'project = "workspace"\n')
    const env = { XDG_CONFIG_HOME: path.join(root, 'config') }

    enableProject(projectBinding(project, env)!, new Date('2026-09-02T00:00:00.000Z'))

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
})
