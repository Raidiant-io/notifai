import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { detectedHarnesses } from './install-hooks.js'
import { parseApps } from './setup-journey.js'
import { agentAppCandidates, detectAgentApps, runnableAgentFile } from './agent-app-detection.js'
import { agentAppsReport } from './agent-apps.js'
import { skillReadiness } from './commands-skill.js'
import { HOOK_INSTALLABLE_HARNESSES } from './harnesses.js'
import { hooksInstallCommand } from './commands-hook-install.js'
import type { CommandDeps } from './commands-core.js'
import type { SkillInventory } from './native-skills.js'
import { hermesPluginDir, HERMES_PLUGIN_MARKER } from './hermes-plugin.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('does not detect uninstalled apps from leftover configuration', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'agent-apps-'))
  roots.push(home)
  for (const dir of ['.claude', '.codex', '.cursor', '.config/opencode', '.openclaw/agents', '.hermes', '.grok']) {
    mkdirSync(path.join(home, dir), { recursive: true })
  }
  expect(detectedHarnesses({ HOME: home, PATH: '', HERMES_HOME: path.join(home, '.hermes') }, 'linux')).toEqual([])
})

it('keeps known apps when a newer caller also requests an unknown app', () => {
  expect(parseApps('codex,future-agent', [])).toEqual(['codex'])
})

for (const platform of ['linux', 'darwin', 'win32'] as const) {
  for (const [index, command] of ['claude', 'codex', 'cursor-agent', 'opencode', 'openclaw', 'hermes', 'grok'].entries()) {
    it(`detects only ${command} from its executable on ${platform}, including GUI installs`, () => {
      const home = platform === 'win32' ? 'C:\\Users\\test' : '/u'
      const p = platform === 'win32' ? path.win32 : path.posix
      for (const dir of [p.join(home, '.local', 'bin'), p.join(home, '.bun', 'bin'), p.join(home, 'custom')]) {
        const env = { HOME: home, USERPROFILE: home, PATH: dir.endsWith('custom') ? dir : '' }
        const file = p.join(dir, platform === 'win32' ? `${command}.cmd` : command)
        expect(detectAgentApps(env, platform, candidate => candidate === file)).toEqual([HOOK_INSTALLABLE_HARNESSES[index]])
      }
    })
  }
}

it('does not search repository-relative PATH entries or treat a bundle directory as an app', () => {
  expect(detectAgentApps({ HOME: '/u', PATH: '.:bin' }, 'darwin', file => file === '/Applications/Cursor.app')).toEqual([])
  expect(agentAppCandidates('codex', { HOME: '/u', PATH: '.:bin' }, 'linux').every(file => path.isAbsolute(file))).toBe(true)
  expect(detectAgentApps({ HOME: '/u' }, 'darwin', file => file === '/Applications/Cursor.app/Contents/MacOS/Cursor')).toEqual(['cursor'])
})

it('requires a regular executable and follows only live executable symlinks', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-runnable-'))
  roots.push(root)
  const file = path.join(root, 'codex')
  writeFileSync(file, '#!/bin/sh\n', { mode: 0o644 })
  expect(runnableAgentFile(root, 'linux')).toBe(false)
  expect(runnableAgentFile(file, 'linux')).toBe(false)
  chmodSync(file, 0o755)
  const link = path.join(root, 'linked')
  symlinkSync(file, link)
  expect(runnableAgentFile(link, 'linux')).toBe(true)
  rmSync(file)
  expect(runnableAgentFile(link, 'linux')).toBe(false)
})

it('uses active configuration homes only for actual executables', () => {
  const env = { HOME: '/u', CLAUDE_CONFIG_DIR: '/profile/claude', CODEX_HOME: '/profile/codex', HERMES_HOME: '/profile/hermes' }
  const present = new Set(['/profile/claude/local/node_modules/.bin/claude', '/profile/hermes/hermes-agent/venv/bin/hermes'])
  expect(detectAgentApps(env, 'linux', file => present.has(file))).toEqual(['claude-code', 'hermes'])
  expect(detectAgentApps(env, 'linux', file => Object.values(env).includes(file))).toEqual([])
})

it('reports per-app trust, plugin and missing skill gaps without contaminating another app', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-report-'))
  roots.push(root)
  let inventory: SkillInventory = { expectedDigest: 'test', copies: [{ scopes: ['global'], path: '/test/skill', harnesses: ['claude-code'], condition: 'current' }] }
  const unexpected = () => { throw new Error('No network or credential access expected') }
  const deps: CommandDeps = {
    cwd: root, env: { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, '.config') },
    hookPlatform: 'linux', hookAdapterHome: path.join(root, 'adapter'),
    io: { out: () => {}, err: () => {} },
    store: { load: unexpected, save: unexpected, clear: unexpected, describe: unexpected },
    nativeSkills: { inspect: () => inventory, place: unexpected, refresh: unexpected, remove: unexpected },
  }
  for (const harness of ['claude-code', 'codex', 'opencode', 'openclaw'] as const) {
    expect(hooksInstallCommand(deps, { harness, narrate: false })).toBe(0)
  }
  // Model installed Hermes wiring without invoking its enablement command.
  const hermes = hermesPluginDir(deps.env)
  mkdirSync(hermes, { recursive: true })
  writeFileSync(path.join(hermes, '__init__.py'), `${HERMES_PLUGIN_MARKER}\n`)
  writeFileSync(path.join(hermes, 'plugin.yaml'), 'name: notifai\n')
  const states = ['hooks-trust', 'hooks-opencode-plugin', 'hooks-openclaw-plugin', 'hooks-hermes-plugin'].map((id, index) => ({
    id, title: id, status: 'gap' as const, detail: 'fixture fault', harnesses: [['codex'], ['opencode'], ['openclaw'], ['hermes']][index]!,
  }))
  // The legacy aggregate reports the available Claude copy as ready; the
  // additive report must still expose absent Codex and plugin-app coverage.
  expect((await skillReadiness(deps)).status).toBe('ready')
  const report = agentAppsReport(deps, states)
  expect(report.supported_ids).toEqual(HOOK_INSTALLABLE_HARNESSES)
  expect(report.apps.find(app => app.id === 'claude-code')).toMatchObject({ connected: true, gaps: [] })
  expect(report.apps.find(app => app.id === 'codex')?.gaps.map(gap => gap.id)).toEqual(['hooks-trust', 'skill'])
  expect(report.apps.find(app => app.id === 'opencode')?.gaps.map(gap => gap.id)).toEqual(['hooks-opencode-plugin', 'skill'])
  expect(report.apps.find(app => app.id === 'openclaw')?.gaps.map(gap => gap.id)).toEqual(['hooks-openclaw-plugin', 'skill'])
  expect(report.apps.find(app => app.id === 'hermes')?.gaps.map(gap => gap.id)).toEqual(['hooks-hermes-plugin', 'skill'])
  inventory = { ...inventory, error: 'incomplete scan' }
  expect(agentAppsReport(deps, states).apps.every(app => !app.connected)).toBe(true)
})
