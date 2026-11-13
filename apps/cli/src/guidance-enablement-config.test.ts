import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { assessReadiness } from './commands-doctor.js'
import { guidanceCheckCommand } from './commands-guidance.js'
import { projectStatusCommand } from './commands-project.js'
import { disableProject, enableProject, projectBinding } from './project-enablement.js'
import { configSetCommand, configShowCommand, configUnsetCommand } from './commands-config.js'
import { EXIT, type CommandDeps } from './commands-core.js'
import { loadConfig, globalConfigPath, personalProjectConfigPath, sessionConfigPath } from './config.js'

it('persists the explicit-enablement policy only for the machine and reports its effective value', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-guidance-policy-'))
  execFileSync('git', ['init', '-q', root])
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
  const lines: string[] = []
  let confirmations = 0
  const deps: CommandDeps = { cwd: root, env, io: { out: s => lines.push(s), err: () => {}, confirm: async () => { confirmations++; return false }, openUrl: () => {} },
    store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'isolated store' } }
  const key = 'guidance.require_project_enablement'
  const shown = () => { lines.length = 0; configShowCommand(deps, { json: true }); return JSON.parse(lines.join('\n'))[key] }
  try {
    expect(shown()).toMatchObject({ value: false, source: 'default' })
    expect(await configSetCommand(deps, key, 'on', {})).toBe(EXIT.usage)
    expect(confirmations).toBe(1)
    expect(existsSync(globalConfigPath(env))).toBe(false)
    expect(await configSetCommand(deps, key, 'on', { yes: true, local: true })).toBe(EXIT.usage)
    expect(await configSetCommand(deps, key, 'on', { yes: true, session: 'test-session' })).toBe(EXIT.usage)
    expect(await configSetCommand(deps, key, 'on', { yes: true })).toBe(EXIT.ok)
    expect(shown()).toMatchObject({ value: true, source: `global:${globalConfigPath(env)}` })
    for (const file of [personalProjectConfigPath(root, env), sessionConfigPath('test-session', env)]) {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, '[guidance]\nrequire_project_enablement = false\n')
    }
    expect((loadConfig({ cwd: root, env, sessionId: 'test-session' }) as unknown as Record<string, unknown>)[key]).toMatchObject({ value: true })
    expect(await configUnsetCommand(deps, key, { yes: true })).toBe(EXIT.ok)
    expect(shown()).toMatchObject({ value: false })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('reports the effective lifecycle policy consistently in doctor, Project status and Cursor checks', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-policy-report-'))
  execFileSync('git', ['init', '-q', root])
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
  const lines: string[] = []
  const deps: CommandDeps = { cwd: root, env, io: { out: s => lines.push(s), err: () => {}, confirm: async () => false, openUrl: () => {} },
    store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'isolated store' } }
  const binding = projectBinding(root, env)!
  const check = () => { lines.length = 0; guidanceCheckCommand(deps); return JSON.parse(lines.join('\n')) }
  const status = () => { lines.length = 0; projectStatusCommand(deps, true); return JSON.parse(lines.join('\n')) }
  const readiness = async () => (await assessReadiness(deps, { readOnly: true })).states.find(s => s.id === 'project-enablement')!
  try {
    expect.soft(status()).toMatchObject({ enabled: false, disabled: false, lifecycle_guidance: true })
    expect.soft(await readiness()).toMatchObject({ status: 'ready' })
    expect.soft(check()).toMatchObject({ enabled: true, context: expect.any(String) })
    await configSetCommand(deps, 'guidance.require_project_enablement', 'on', { yes: true })
    expect.soft(status()).toMatchObject({ enabled: false, disabled: false, lifecycle_guidance: false })
    expect.soft(await readiness()).toMatchObject({ status: 'optional-gap', detail: expect.stringContaining('guidance.require_project_enablement') })
    const withheld = check()
    expect.soft(withheld.enabled).toBe(false)
    expect.soft(withheld.context).toBeUndefined()
    expect.soft(withheld.read_command).toContain('notifai guidance --session-token')
    enableProject(binding)
    expect.soft(check()).toMatchObject({ enabled: true })
    expect.soft(await readiness()).toMatchObject({ status: 'ready' })
    disableProject(binding)
    expect.soft(check()).toEqual({ enabled: false, disabled: true })
    expect.soft(status()).toMatchObject({ enabled: false, disabled: true, lifecycle_guidance: false })
    expect.soft(await readiness()).toMatchObject({ status: 'optional-gap', technical: { project_disabled: true } })
    const outside = mkdtempSync(path.join(os.tmpdir(), 'notifai-outside-policy-'))
    deps.cwd = outside
    expect.soft(check()).toMatchObject({ enabled: true, context: expect.stringContaining('--projectless') })
    expect.soft(status()).toMatchObject({ project: null, lifecycle_guidance: true })
    expect.soft(await readiness()).toMatchObject({ status: 'ready' })
    rmSync(outside, { recursive: true, force: true })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
