import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,expect,it,vi } from 'vitest'
import type { CommandDeps } from './commands.js'
import { writeSessionState } from './hook-session-state.js'
import { buildProgram,type BuildProgramOptions,type ProgramRunners } from './program.js'
import { QUESTION_SETTLEMENT_INPUT_ENV } from './question-settlement-process.js'

const roots: string[] = []
const originalExecutable = process.execPath
const originalArgv = process.argv
afterEach(() => {
  Object.defineProperty(process, 'execPath', { value: originalExecutable })
  process.argv = originalArgv
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`) } }
function fixture(target = `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-command-admission-')); roots.push(home)
  const root = path.join(home, '.notifai'), active = 'a'.repeat(64), retired = 'b'.repeat(64)
  const id = '12345678-1234-1234-1234-123456789012', extension = process.platform === 'win32' ? '.exe' : ''
  mkdirSync(path.join(root, 'bin'), { recursive: true, mode: 0o700 })
  for (const build of [active, retired]) {
    mkdirSync(path.join(root, 'versions', build), { recursive: true, mode: 0o700 })
    writeFileSync(path.join(root, 'versions', build, `notifai-runtime${extension}`), 'fixture runtime', { mode: 0o700 })
    writeFileSync(path.join(root, 'versions', build, 'inventory.json'), JSON.stringify({ payload:
      Buffer.from(JSON.stringify({ version: '1.2.3' })).toString('base64') }), { mode: 0o600 })
  }
  writeFileSync(path.join(root, 'install.json'), JSON.stringify({ schema: 1, owner: 'notifai', id,
    runtime: { target, contract: 'notifai-session-state-v2' } }), { mode: 0o600 })
  writeFileSync(path.join(root, 'active.json'), JSON.stringify({ schema: 1, active, previous: retired, generation: 2 }) + '\n', { mode: 0o600 })
  vi.stubGlobal('NOTIFAI_COMPILED_BUILD', { sourceDirty: false, target })
  const env = { HOME: home, USERPROFILE: home, XDG_STATE_HOME: home, NOTIFAI_NATIVE_ENTRY: 'launcher-v1' }
  const running = (build: string) => Object.defineProperty(process, 'execPath', {
    value: path.join(root, 'versions', build, `notifai-runtime${extension}`),
  })
  async function invoke(argv: string[], runners: Partial<ProgramRunners> = {}, extraEnv: NodeJS.ProcessEnv = {},
    options: Pick<BuildProgramOptions, 'retryNativeSelection'> = {}) {
    const output: string[] = [], errors: string[] = [], admitted: string[] = []
    const deps: CommandDeps = { env: { ...env, ...extraEnv }, cwd: home,
      io: { out: line => output.push(line), err: line => errors.push(line), confirm: async () => false, openUrl() {} },
      store: { load: () => null, save() { throw new Error('Unexpected credential mutation') }, clear() {}, describe: () => 'fixture' } }
    process.argv = ['node', 'notifai', ...argv]
    let code: number | undefined
    try {
      await buildProgram(deps, { ...options, runners, exit(code) { throw new Exit(code) }, beforeAction(mode) { admitted.push(mode) } })
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

it.each(['bun-linux-x64', 'bun-darwin-arm64', 'bun-windows-x64'])('admits v1 ordinary and retained-owner writes only on compatible targets: %s', async target => {
  const f = fixture(target), compatible = !target.includes('linux')
  writeFileSync(path.join(f.home, '.notifai', 'install.json'), JSON.stringify({ schema: 1, owner: 'notifai', id: f.id,
    runtime: { target, contract: 'notifai-session-state-v1' } }), { mode: 0o600 })
  const configSet = vi.fn(async () => 0), hookRun = vi.fn(async () => 0), install = vi.fn(async () => 0)
  f.running(f.active)
  expect(await f.invoke(['config', 'set', 'log_level', 'off', '--yes'], { configSet })).toMatchObject({ code: compatible ? 0 : 1, admitted: compatible ? ['managed'] : [] })
  const session = 'historical-owner'
  writeSessionState(session, f.env, { harness: 'claude-code', runtime_builds: [{ installation_id: f.id, build: f.retired }] })
  f.running(f.retired)
  expect(await f.invoke(['hook', 'question-settlement', '--owner', 'notifai', '--harness', 'claude-code'], { hookRun },
    { [QUESTION_SETTLEMENT_INPUT_ENV]: JSON.stringify({ session_id: session, cwd: f.home }) })).toMatchObject({ code: compatible ? 0 : 1, admitted: compatible ? ['retained-owner'] : [] })
  expect(configSet).toHaveBeenCalledTimes(compatible ? 1 : 0)
  expect(hookRun).toHaveBeenCalledTimes(compatible ? 1 : 0)
  // The exact candidate's guarded lifecycle operation remains reachable.
  expect(await f.invoke(['install', '--upgrade', '--version', '2.0.0', '--channel', 'stable', '--no-init', '--no-path', '--json'], { install }))
    .toMatchObject({ code: 0, admitted: ['installer'] })
  expect(install).toHaveBeenCalledOnce()
})
