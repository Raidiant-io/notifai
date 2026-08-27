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
    const mainBinding = projectBinding(repo, env)
    const linkedBinding = projectBinding(linked, env)
    const unrelatedBinding = projectBinding(unrelated, env)
    expect(linkedBinding?.markerPath).toBe(mainBinding?.markerPath)
    expect(unrelatedBinding?.markerPath).not.toBe(mainBinding?.markerPath)
  })
})
