import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { npmRepairCommand } from './commands-npm-repair.js'
import type { CommandDeps } from './commands-core.js'
import { completeNpmReplacement, inspectNpmReplacement, replaceNpmPackage } from './npm-replacement.js'

const state = vi.hoisted(() => ({ home: '', phase: 'package_verified', pending: false, active: 'a'.repeat(64), generation: 1,
  candidate: 'b'.repeat(64), channel: 'stable', scope: '', probeFails: false,
  install: vi.fn(), transition: vi.fn(), census: vi.fn(), manager: { node: 'C:\\Program Files\\nodejs\\node.exe',
    npm: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', version: '11.17.0', sha256: 'c'.repeat(64) } }))
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
vi.mock('./distribution.js', async original => ({ ...await original<Record<string, unknown>>(),
  buildIdentity: () => ({ version: '2.0.0', sourceDirty: false, target: 'bun-windows-x64' }) }))
vi.mock('./hook-adapter.js', async original => ({ ...await original<Record<string, unknown>>(), resolveHookAdapterHome: () => state.home }))
vi.mock('./native-installation.js', () => ({ managedInstallation: () => ({
  inspect: () => ({ active: { active: state.active, generation: state.generation }, channel: state.channel,
    source: 'manual', pending: state.pending, uninstall_pending: state.pending, bootstrap_pending: state.pending }),
  activeRelease: () => ({ build: state.active, generation: state.generation, version: state.active === state.candidate ? '2.0.0' : '1.0.0', launcher: 'verified-native.exe' }),
  installCandidate: state.install, assertForwardTransition: state.transition,
}) }))
vi.mock('./native-installation-identity.js', () => ({ nativeInstallationIdentity: () => ({ installationId: '55555555-5555-4555-8555-555555555555' }) }))
vi.mock('./installation-access.js', () => ({ installationAccess: () => ({}), npmAdapterWindowsAccess: () => vi.fn() }))
vi.mock('./windows-npm-manager.js', () => ({ inspectWindowsNpmManager: () => ({ ...state.manager }) }))
vi.mock('./windows-npm-maintenance.js', () => ({ assertNpmScopeDirectories: vi.fn(), assertNpmMaintenanceQuiet: vi.fn(),
  inspectWindowsNpmReaders: state.census }))
vi.mock('./runtime-retention.js', () => ({ RuntimeRetention: class { inspectOwners() { return { status: 'clear' } } } }))
vi.mock('./process-identity.js', () => ({ currentProcessIdentity: () => ({ pid: 10, start: 'windows-filetime:100' }), processIdentityLiveness: () => 'gone' }))
vi.mock('./npm-replacement.js', async original => ({ ...await original<Record<string, unknown>>(),
  inspectNpmReplacement: vi.fn(), npmReplacementConfirmation: () => 'confirmed-scope',
  replaceNpmPackage: vi.fn(), verifyCompletedNpmPackage: vi.fn(), completeNpmReplacement: vi.fn(),
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
let root: string, deps: CommandDeps, output: string[]
beforeEach(() => {
  vi.clearAllMocks()
  state.census.mockImplementation(() => ({ readers: [], uncertain: false }))
  root = mkdtempSync(path.join(os.tmpdir(), 'notifai-repair-command-')); state.home = root
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' })
  state.phase = 'package_verified'; state.pending = false; state.active = 'a'.repeat(64); state.generation = 1; state.probeFails = false
  const directory = path.join(root, '.notifai', 'versions', state.candidate)
  mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, 'inventory.json'), 'pinned signed fixture')
  const inventory = createHash('sha256').update('pinned signed fixture').digest('hex')
  state.scope = JSON.stringify({ schema: 1, app: { prefix: { path: root }, states: [{ path: root }], observation: {} },
    manager: state.manager, native: { id: '55555555-5555-4555-8555-555555555555', build: 'a'.repeat(64), generation: 1, channel: 'stable' },
    candidate: { build: state.candidate, inventory_sha256: inventory } })
  vi.mocked(inspectNpmReplacement).mockImplementation(() => ({ phase: state.phase, scope: state.scope, prefix: root,
    target: { version: '2.0.0', inventory_sha256: inventory }, node: { file: state.manager.node }, npm: { file: state.manager.npm } }) as ReturnType<typeof inspectNpmReplacement>)
  state.install.mockImplementation(() => { state.active = state.candidate; state.generation = 2; state.pending = false; return { launcher_update_pending: false } })
  vi.mocked(execFileSync).mockImplementation(file => {
    if (file === state.manager.node && state.probeFails) throw new Error('interrupted after activation')
    return JSON.stringify({ ok: true, capabilities: { npm_adapter_routes: 1 }, build: { version: '2.0.0' } })
  })
  output = []
  deps = { cwd: root, env: { NODE_OPTIONS: '--require untrusted-file', BUN_OPTIONS: 'untrusted' },
    io: { interactive: false, out: (line: string) => output.push(line) } } as unknown as CommandDeps
})
afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform); rmSync(root, { recursive: true, force: true }) })
const resume = () => npmRepairCommand(deps, { migrateNpm: true, resume: path.join(root, 'operation'), confirm: 'confirmed-scope', json: true })

it('observes the handshake-owned manager during replacement admission', async () => {
  state.phase = 'prepared'
  const manager = { pid: 20, start: 'windows-filetime:200' }
  state.census.mockImplementation((_scope, observedManager) => {
    if (observedManager !== undefined && observedManager !== manager) throw new Error('Suspended manager was not identified')
    return { readers: [], uncertain: false }
  })
  vi.mocked(replaceNpmPackage).mockImplementation(async (_directory, _context, verifyMaintenance) => {
    verifyMaintenance(state.scope, 0, manager)
    return { manager, started: true, exit_code: 0, stdout: '', stderr: '' }
  })
  expect(await resume()).toBe(0)
  expect(state.census).toHaveBeenNthCalledWith(1, JSON.parse(state.scope).app, manager)
  expect(state.census).toHaveBeenNthCalledWith(2, JSON.parse(state.scope).app, undefined)
  expect(completeNpmReplacement).toHaveBeenCalledTimes(1)
})

it('resumes after native activation without rerunning npm or preserving Node runtime controls', async () => {
  state.probeFails = true
  expect(await resume()).toBe(1)
  expect(state.active).toBe(state.candidate)
  expect(completeNpmReplacement).not.toHaveBeenCalled()
  state.probeFails = false
  expect(await resume()).toBe(0)
  expect(replaceNpmPackage).not.toHaveBeenCalled()
  expect(completeNpmReplacement).toHaveBeenCalledTimes(1)
  const route = vi.mocked(execFileSync).mock.calls.filter(call => call[0] === state.manager.node).at(-1)!
  expect(route[2]).toMatchObject({ env: { TEMP: path.join(root, 'operation', 'tmp') } })
  expect((route[2] as { env: NodeJS.ProcessEnv }).env['NODE_OPTIONS']).toBeUndefined()
  expect((route[2] as { env: NodeJS.ProcessEnv }).env['BUN_OPTIONS']).toBeUndefined()
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ code: 'npm_repair_complete', runtime_active: true, command_verified: true })
})

it('recovers the exact pending native bootstrap after the package was verified', async () => {
  state.pending = true
  expect(await resume()).toBe(0)
  expect(replaceNpmPackage).not.toHaveBeenCalled()
  expect(state.install).toHaveBeenCalledWith(expect.objectContaining({ directory: path.join(root, '.notifai', 'versions', state.candidate),
    signedInventory: 'pinned signed fixture', upgrade: true, version: '2.0.0', channel: 'stable' }))
})

it('does not reinstall or reactivate an already completed operation', async () => {
  state.phase = 'complete'
  expect(await resume()).toBe(0)
  expect(replaceNpmPackage).not.toHaveBeenCalled()
  expect(state.install).not.toHaveBeenCalled()
  expect(execFileSync).not.toHaveBeenCalled()
})
