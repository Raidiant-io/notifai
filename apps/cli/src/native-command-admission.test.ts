import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildProgram, type ProgramRunners } from './program.js'
import type { CommandDeps } from './commands.js'
import { writeSessionState, markSessionEnded } from './hook-session-state.js'
import { QUESTION_SETTLEMENT_INPUT_ENV } from './question-settlement-process.js'

const roots: string[] = []
const originalExecutable = process.execPath
afterEach(() => {
  Object.defineProperty(process, 'execPath', { value: originalExecutable })
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`) } }
function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-command-admission-')); roots.push(home)
  const root = path.join(home, '.notifai'), active = 'a'.repeat(64), retired = 'b'.repeat(64)
  const target = `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
  const id = '12345678-1234-1234-1234-123456789012', extension = process.platform === 'win32' ? '.exe' : ''
  mkdirSync(path.join(root, 'bin'), { recursive: true, mode: 0o700 })
  for (const build of [active, retired]) {
    mkdirSync(path.join(root, 'versions', build), { recursive: true, mode: 0o700 })
    writeFileSync(path.join(root, 'versions', build, `notifai-runtime${extension}`), 'fixture runtime', { mode: 0o700 })
    writeFileSync(path.join(root, 'versions', build, 'inventory.json'), JSON.stringify({ payload:
      Buffer.from(JSON.stringify({ version: '1.2.3' })).toString('base64') }), { mode: 0o600 })
  }
  writeFileSync(path.join(root, 'install.json'), JSON.stringify({ schema: 1, owner: 'notifai', id, target }), { mode: 0o600 })
  writeFileSync(path.join(root, 'active.json'), JSON.stringify({ schema: 1, active, previous: retired, generation: 2 }) + '\n', { mode: 0o600 })
  vi.stubGlobal('NOTIFAI_COMPILED_BUILD', { sourceDirty: false, target })
  const env = { HOME: home, USERPROFILE: home, XDG_STATE_HOME: home, NOTIFAI_NATIVE_ENTRY: 'launcher-v1' }
  const running = (build: string) => Object.defineProperty(process, 'execPath', {
    value: path.join(root, 'versions', build, `notifai-runtime${extension}`),
  })
  async function invoke(argv: string[], runners: Partial<ProgramRunners> = {}, extraEnv: NodeJS.ProcessEnv = {}) {
    const output: string[] = [], errors: string[] = [], admitted: string[] = []
    const deps: CommandDeps = { env: { ...env, ...extraEnv }, cwd: home,
      io: { out: line => output.push(line), err: line => errors.push(line), confirm: async () => false, openUrl() {} },
      store: { load: () => null, save() { throw new Error('Unexpected credential mutation') }, clear() {}, describe: () => 'fixture' } }
    let code: number | undefined
    try {
      await buildProgram(deps, { runners, exit(code) { throw new Exit(code) }, beforeAction(mode) { admitted.push(mode) } })
        .parseAsync(['node', 'notifai', ...argv])
    } catch (error) { if (!(error instanceof Exit)) throw error; code = error.code }
    return { code, output, errors, admitted }
  }
  return { home, active, retired, id, env, running, invoke }
}

it('admits active commands but refuses the same ordinary command from a retired payload before its action', async () => {
  const f = fixture()
  const configSet = vi.fn(async () => 0)
  f.running(f.active)
  expect(await f.invoke(['config', 'set', 'log_level', 'off', '--yes'], { configSet })).toMatchObject({ code: 0, admitted: ['managed'] })
  expect(configSet).toHaveBeenCalledTimes(1)
  f.running(f.retired)
  const result = await f.invoke(['config', 'set', 'log_level', 'off', '--yes'], { configSet })
  expect(result).toMatchObject({ code: 1, admitted: [] })
  expect(result.errors.join()).toContain('no longer active')
  expect(configSet).toHaveBeenCalledTimes(1)
})

it('refuses ordinary direct payload execution before any managed action', async () => {
  const f = fixture(), configSet = vi.fn(async () => 0)
  f.running(f.active)
  const result = await f.invoke(['config', 'set', 'log_level', 'off', '--yes'], { configSet }, { NOTIFAI_NATIVE_ENTRY: undefined })
  expect(result).toMatchObject({ code: 1, admitted: [] })
  expect(result.errors.join()).toContain('native launcher')
  expect(configSet).not.toHaveBeenCalled()
})

it('retained question owners need the exact installation, build, harness and live session', async () => {
  const f = fixture(), session = 'retained-session'
  f.running(f.retired)
  const args = ['hook', 'question-settlement', '--owner', 'notifai', '--harness', 'claude-code']
  const extraEnv = { [QUESTION_SETTLEMENT_INPUT_ENV]: JSON.stringify({ session_id: session, cwd: f.home }) }
  const hookRun = vi.fn(async () => 0)
  expect((await f.invoke(args, { hookRun }, extraEnv)).code).toBe(1)
  writeSessionState(session, f.env, { harness: 'claude-code', runtime_builds: [{ installation_id: f.id, build: f.active }] })
  expect((await f.invoke(args, { hookRun }, extraEnv)).code).toBe(1)
  writeSessionState(session, f.env, { harness: 'claude-code', runtime_builds: [{ installation_id: f.id, build: f.retired }] })
  expect(await f.invoke(args, { hookRun }, extraEnv)).toMatchObject({ code: 0, admitted: ['retained-owner'] })
  expect((await f.invoke([...args.slice(0, -1), 'codex'], { hookRun }, extraEnv)).code).toBe(1)
  markSessionEnded(session, f.env, Date.now())
  expect((await f.invoke(args, { hookRun }, extraEnv)).code).toBe(1)
  expect(hookRun).toHaveBeenCalledTimes(1)
})

it('portable doctor returns read-only installation advice without running setup observations', async () => {
  const f = fixture(), doctor = vi.fn(async () => 0)
  const result = await f.invoke(['doctor', '--json'], { doctor })
  expect(result.code).toBe(1)
  expect(JSON.parse(result.output.join())).toMatchObject({ status: 'native_installation_required', read_only: true })
  expect(doctor).not.toHaveBeenCalled()
})

it('refuses managed actions while uninstall has closed launch admission', async () => {
  const f = fixture(), configSet = vi.fn(async () => 0)
  f.running(f.active)
  writeFileSync(path.join(f.home, '.notifai', 'uninstall.json'), '{}', { mode: 0o600 })
  const result = await f.invoke(['config', 'set', 'log_level', 'off', '--yes'], { configSet })
  expect(result).toMatchObject({ code: 1, admitted: [] })
  expect(result.errors.join()).toContain('uninstall')
  expect(configSet).not.toHaveBeenCalled()
})
