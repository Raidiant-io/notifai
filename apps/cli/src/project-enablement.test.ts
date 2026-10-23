import { execFileSync } from 'node:child_process'
import { mkdirSync,mkdtempSync,readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe,expect,it } from 'vitest'
import {
disableProject,
enableProject,
projectBinding,
projectDisabled,
projectEnabled,
projectEnablementState
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

})
