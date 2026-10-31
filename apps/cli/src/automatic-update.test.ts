import { createHash,generateKeyPairSync,randomUUID,sign } from 'node:crypto'
import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import { afterEach,describe,expect,it,vi } from 'vitest'
import type { ActivationPlan } from './activation-plan.js'
import { ensurePrivateDirectory } from './atomic-file.js'
import {
attemptAutomaticUpdate,
parseActivationPlan,
readAutomaticUpdateRecord,
updateAutomaticUpdateRecord,
type AutomaticUpdateHost
} from './automatic-update.js'
import { buildProgram } from './program.js'
import { cliBinReadiness } from './cli-bin.js'
import { globalConfigPath,stateDir } from './config.js'
import { activeBytes } from './installation.js'
import { HISTORICAL_LOCAL_CONTINUITY, LOCAL_CONTINUITY } from './local-continuity.js'
import type { CommandDeps } from './commands-core.js'
import { nativeUpdateCommand } from './commands-native-installation.js'
import { releaseChannelCommand } from './commands-release-channel.js'
import { beginSessionIncarnation,lifecycleStamp,readSessionState,writeSessionState } from './hook-session-state.js'
import { Installation } from './installation.js'
import { nullLogger } from './logging.js'
import { processStartTime } from './process-identity.js'
import { Distribution,releaseSigningMessage } from './release-distribution.js'

const NOW = 1_900_000_000_000
const roots: string[] = []
const originalExecutable = process.execPath
const originalArgv = process.argv
afterEach(() => {
  Object.defineProperty(process, 'execPath', { value: originalExecutable })
  process.argv = originalArgv
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** A signed fixture release channel served from memory, and a managed installation reading it. */
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-automatic-')); roots.push(root)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const signed = (kind: 'channel' | 'inventory', value: unknown): string => {
    const payload = Buffer.from(JSON.stringify(value))
    return JSON.stringify({ key_id: 'fixture', payload: payload.toString('base64'),
      signature: sign(null, releaseSigningMessage(kind, payload), privateKey).toString('base64') })
  }
  const releases = new Map<string, { inventory: string; archive: Buffer }>()
  const channels: Record<'stable' | 'beta', { sequence: number; version: string; withdrawn: string[] } | null> = { stable: null, beta: null }
  const requests: string[] = []
  const network = { up: true }
  const fetcher = (async (input: string) => {
    const url = String(input)
    if (!network.up) throw new TypeError('fetch failed')
    requests.push(url)
    for (const name of ['stable', 'beta'] as const) {
      if (url.endsWith(`/${name}.json`)) {
        const record = channels[name]
        if (record === null) return new Response('missing', { status: 404 })
        return new Response(signed('channel', { schema: 1, channel: name, sequence: record.sequence, version: record.version,
          inventory_sha256: digest(releases.get(record.version)!.inventory), withdrawn_versions: record.withdrawn }))
      }
    }
    const match = /\/v([^/]+)\/(.+)$/.exec(url)
    const release = match ? releases.get(match[1]!) : undefined
    if (!release) return new Response('missing', { status: 404 })
    return new Response(match![2] === 'inventory.json' ? release.inventory : release.archive)
  }) as unknown as typeof fetch
  const distribution = new Distribution({ fixture: publicKey.export({ format: 'pem', type: 'spki' }).toString() }, fetcher)
  const env: NodeJS.ProcessEnv = { XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config') }
  const v1BootstrapInventories: string[] = []
  const options = { root: path.join(root, '.notifai'), sessionsDirectory: path.join(stateDir(env), 'sessions'), v1BootstrapInventories, fileUse: () => ({ status: 'clear' as const }), target: 'bun-linux-x64' as const, distribution,
    access: { check() {}, directory: ensurePrivateDirectory, beforePublish() {}, protectExistingDirectory() {} }, probe: () => {} }
  const installation = new Installation(options)

  async function publish(version: string, contract = LOCAL_CONTINUITY): Promise<void> {
    const runtime = `runtime ${version}`, launcher = 'launcher v1'
    const writer = pack(), chunks: Buffer[] = []
    const consumed = (async () => { for await (const chunk of writer) chunks.push(chunk as Buffer) })()
    writer.entry({ name: 'notifai' }, launcher)
    writer.entry({ name: 'notifai-runtime' }, runtime)
    writer.finalize(); await consumed
    const archive = gzipSync(Buffer.concat(chunks))
    const inventory = signed('inventory', { schema: 2, local_continuity: { contract }, version,
      source_revision: 'a'.repeat(40), store_schema: 2, launcher_schema: 1, artifacts: [{ target: 'bun-linux-x64',
        filename: `notifai-${version}-linux-x64.tar.gz`, bytes: archive.length, sha256: digest(archive),
        runtime_sha256: digest(runtime), launcher_sha256: digest(launcher), materials: [] }] })
    releases.set(version, { inventory, archive })
    if (contract === HISTORICAL_LOCAL_CONTINUITY) v1BootstrapInventories.push(digest(inventory))
  }
  function point(channel: 'stable' | 'beta', version: string, withdrawn: string[] = []): void {
    channels[channel] = { sequence: (channels[channel]?.sequence ?? 0) + 1, version, withdrawn }
  }
  /** Install `version` as the active build, the way the native installer would. */
  async function install(version: string, channel: 'stable' | 'beta', source: 'shell' | 'npm' = 'shell'): Promise<void> {
    point(channel, version)
    await installation.installRelease({ channel, source, expectedGeneration: 0 })
  }
  async function historicalInstall(version: string) {
    point('stable', version)
    const staged = await installation.stageRelease({ channel: 'stable', expectedGeneration: 0 })
    const active = { schema: 1 as const, active: staged.build, previous: null, generation: 1 }
    writeFileSync(path.join(options.root, 'active.json'), activeBytes(active), { mode: 0o600 })
    writeFileSync(path.join(options.root, 'install.json'), JSON.stringify({ schema: 1, id: randomUUID(), owner: 'notifai', source: 'shell',
      runtime: { target: options.target, contract: HISTORICAL_LOCAL_CONTINUITY }, channel: 'stable', previousChannel: null,
      launcherBuild: staged.build, launcherUpdatePending: false }), { mode: 0o600 })
    ensurePrivateDirectory(path.join(options.root, 'bin'))
    writeFileSync(path.join(options.root, 'bin', 'notifai'), 'launcher v1', { mode: 0o700 })
  }
  return { root, env, installation, options, publish, point, install, historicalInstall, requests, channels, network }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

const PLAN: ActivationPlan = { schema: 1, version: null, hub_ipc_versions: { min: 1, max: 1 }, hook_changes: [] }

function host(f: Fixture, overrides: Partial<AutomaticUpdateHost> = {}) {
  const calls = { plan: [] as string[], resume: [] as [string, string][] }
  const value: AutomaticUpdateHost = {
    env: f.env,
    now: () => NOW,
    installation: () => f.installation,
    running: () => {
      const active = f.installation.inspect().active
      return active ? { build: active.active, version: f.installation.versionRelease(active.active).version } : null
    },
    childIpcVersions: () => [1],
    plan: async (launcher) => { calls.plan.push(launcher); return PLAN },
    resume: async (launcher, from) => { calls.resume.push([launcher, from]); return { ok: true } },
    logger: nullLogger(),
    ...overrides,
  }
  return { host: value, calls }
}

const activeVersion = (f: Fixture): string => f.installation.activeRelease().version
const install = (f: Fixture) => f.installation.inspect()


describe('automatic updates', () => {
  it('reports a contract-changing staged update as waiting until the pending session settles', async () => {
    const f = fixture()
    await f.publish('1.0.0', HISTORICAL_LOCAL_CONTINUITY); await f.historicalInstall('1.0.0')
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    beginSessionIncarnation('waiting-session', f.env, { stamp: lifecycleStamp(), harnessProcess: { pid: process.pid, start: processStartTime(process.pid)! } })
    writeSessionState('waiting-session', f.env, { harness: 'claude-code', pending: [{ request_id: 'req_open', question: 'Continue?', asked_at: NOW }] })
    const running = { build: install(f).active!.active, version: '1.0.0' }
    const events: Record<string, unknown>[] = []
    const logger = { ...nullLogger(), info: (_name: string, data?: Record<string, unknown>) => { events.push(data ?? {}) },
      error: (_name: string, data?: Record<string, unknown>) => { events.push(data ?? {}) } }
    const h = host(f, { running: () => running, logger }).host
    const doctor = () => cliBinReadiness({ PATH: path.join(f.options.root, 'bin') }, 'linux', {
      nativeHome: f.root, runningArtifactPath: path.join(f.options.root, 'versions', running.build, 'notifai-runtime'), currentVersion: '1.0.0' })
    expect(await attemptAutomaticUpdate(h)).toMatchObject({ outcome: 'waiting', waiting_for: ['continuity'] })
    expect(doctor()).toMatchObject({ status: 'ready', technical: { transaction: { install_pending: false, activation_waiting: true } } })
    expect(doctor().remedy).toBeUndefined()
    const question = readSessionState('waiting-session', f.env)
    // An older updater left no waiting marker; do not misclassify its crash journal.
    const journal = path.join(f.options.root, 'transaction.json')
    const oldJournal = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>
    delete oldJournal['waiting_for_sessions']
    writeFileSync(journal, JSON.stringify(oldJournal))
    expect(doctor()).toMatchObject({ status: 'gap', technical: { transaction: { install_pending: true, activation_waiting: false } } })
    expect(doctor().remedy?.command).toContain('update --repair --json')
    expect(await attemptAutomaticUpdate(h)).toMatchObject({ outcome: 'waiting', waiting_for: ['continuity'] })
    expect(events.filter(event => event['event'] === 'failed')).toEqual([])
    expect(install(f).active!.active).toBe(running.build)
    expect(readSessionState('waiting-session', f.env)).toEqual(question)
    // The owner settles its isolated session before the next automatic pass.
    rmSync(path.join(stateDir(f.env), 'sessions'), { recursive: true, force: true })
    expect(await attemptAutomaticUpdate(h)).toMatchObject({ outcome: 'activated', from: '1.0.0', to: '1.1.0' })
    expect(install(f).pending).toBe(false)
    expect(doctor().technical).toMatchObject({ transaction: { install_pending: false, activation_waiting: false } })
  })

  it('stages a newer release on the saved channel and activates it when nothing waits', async () => {
    const f = fixture()
    await f.publish('1.0.0'); await f.install('1.0.0', 'stable')
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    const { host: h, calls } = host(f)
    expect(await attemptAutomaticUpdate(h)).toEqual({ outcome: 'activated', from: '1.0.0', to: '1.1.0' })
    expect(activeVersion(f)).toBe('1.1.0')
    expect(install(f)).toMatchObject({ channel: 'stable', source: 'shell', active: { generation: 2 } })
    const staged = f.installation.activeRelease().launcher
    // The plan was asked of the staged build itself, and integration resumed through it.
    expect(calls.plan).toEqual([staged])
    expect(calls.resume).toEqual([[staged, '1.0.0']])
    expect(readAutomaticUpdateRecord(f.env)).toMatchObject({ staged: null, waiting_for: [], last_automatic: { from: '1.0.0', to: '1.1.0', at: NOW } })
  })

  it('clears a waiting marker before a resumed activation can be interrupted', async () => {
    const f = fixture()
    await f.publish('1.0.0'); await f.install('1.0.0', 'stable')
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    const running = { build: install(f).active!.active, version: '1.0.0' }
    let waiting = true
    const interrupted = new Installation({ ...f.options,
      externalWriters: () => waiting ? 'Existing work must finish.' : null,
      observe(point) { if (point === 'launcher') throw new Error('power lost') } })
    const h = host(f, { installation: () => interrupted, running: () => running }).host
    expect(await attemptAutomaticUpdate(h)).toMatchObject({ outcome: 'waiting' })
    expect(install(f)).toMatchObject({ pending: true, activation_waiting: true })
    waiting = false
    expect(await attemptAutomaticUpdate(h)).toMatchObject({ outcome: 'failed' })
    expect(install(f).activation_waiting).toBeUndefined()
    const doctor = cliBinReadiness({ PATH: path.join(f.options.root, 'bin') }, 'linux', {
      nativeHome: f.root, runningArtifactPath: path.join(f.options.root, 'versions', running.build, 'notifai-runtime') })
    expect(doctor).toMatchObject({ status: 'gap', technical: { transaction: { install_pending: true, activation_waiting: false } } })
    expect(doctor.remedy?.command).toContain('update --repair --json')
    expect(await attemptAutomaticUpdate(host(f, { running: () => running }).host)).toMatchObject({ outcome: 'activated' })
  })

  it('keeps a beta installation on beta when it moves on to a newer stable release, and never offers beta to stable', async () => {
    const beta = fixture()
    await beta.publish('0.9.0'); beta.point('stable', '0.9.0')
    await beta.publish('1.0.0-beta.1'); await beta.install('1.0.0-beta.1', 'beta')
    await beta.publish('1.0.0'); beta.point('stable', '1.0.0')
    expect(await attemptAutomaticUpdate(host(beta).host)).toEqual({ outcome: 'activated', from: '1.0.0-beta.1', to: '1.0.0' })
    expect(install(beta)).toMatchObject({ channel: 'beta' })

    const stable = fixture()
    await stable.publish('1.0.0'); await stable.install('1.0.0', 'stable')
    await stable.publish('1.1.0-beta.1'); stable.point('beta', '1.1.0-beta.1')
    expect(await attemptAutomaticUpdate(host(stable).host)).toEqual({ outcome: 'current' })
    expect(stable.requests.some(url => url.endsWith('/beta.json'))).toBe(false)
    expect(install(stable)).toMatchObject({ channel: 'stable' })
    expect(activeVersion(stable)).toBe('1.0.0')
  })

  it('recovers an interrupted swap forward at the next pass, and hands the hub over', async () => {
    const f = fixture()
    await f.publish('1.0.0'); await f.install('1.0.0', 'stable')
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    const running = { build: install(f).active!.active, version: '1.0.0' }
    const interrupted = new Installation({ ...f.options, observe(point) { if (point === 'metadata') throw new Error('power lost') } })
    const crashed = await attemptAutomaticUpdate({ ...host(f).host, installation: () => interrupted, running: () => running })
    expect(crashed.outcome).toBe('failed')
    expect(install(f).pending).toBe(true)
    // A question waits; it does not hold the recovery back.
    const open = 'open-session'
    beginSessionIncarnation(open, f.env, { stamp: lifecycleStamp(), harnessProcess: { pid: process.pid, start: processStartTime(process.pid)! } })
    writeSessionState(open, f.env, { harness: 'claude-code', runtime_builds: [{
      installation_id: JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8')).id as string, build: running.build }], pending: [{ request_id: 'req_open', question: 'Deploy?', asked_at: NOW }] })
    expect(await attemptAutomaticUpdate({ ...host(f).host, running: () => running })).toEqual({ outcome: 'activated', from: '1.0.0', to: '1.1.0' })
    expect(install(f)).toMatchObject({ pending: false, channel: 'stable' })
    expect(activeVersion(f)).toBe('1.1.0')
  })
})

describe('staged activation at the next command', () => {
  class CommandExit extends Error { constructor(readonly code: number) { super(`exit ${code}`) } }
  async function staged() {
    const f = fixture()
    await f.publish('1.0.0'); await f.install('1.0.0', 'stable')
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    const running = { build: install(f).active!.active, version: '1.0.0' }
    const installationId = (JSON.parse(readFileSync(path.join(f.options.root, 'install.json'), 'utf8')) as { id: string }).id
    beginSessionIncarnation('retained-question', f.env, { stamp: lifecycleStamp(), harnessProcess: { pid: process.pid, start: processStartTime(process.pid)! } })
    writeSessionState('retained-question', f.env, { harness: 'claude-code', runtime_builds: [{ installation_id: installationId, build: running.build }],
      pending: [{ request_id: 'req_retained', question: 'Continue?', asked_at: NOW }] })
    const question = readSessionState('retained-question', f.env)
    let waiting = true
    const installation = new Installation({ ...f.options, externalWriters: () => waiting ? 'An existing writer is not ready.' : null })
    expect(await attemptAutomaticUpdate(host(f, { installation: () => installation, running: () => running }).host)).toMatchObject({ outcome: 'waiting' })
    waiting = false
    const requestsBefore = f.requests.length
    vi.stubGlobal('NOTIFAI_COMPILED_BUILD', { sourceDirty: false, target: f.options.target })
    Object.defineProperty(process, 'execPath', { value: path.join(f.options.root, 'versions', running.build, 'notifai-runtime') })
    const action = vi.fn(async () => 0), forward = vi.fn(async () => 0), factory = vi.fn(() => installation)
    const argv = ['config', 'set', 'log_level', 'off', '--yes']
    async function invoke(args = argv, extraEnv: NodeJS.ProcessEnv = {}) {
      process.argv = ['node', 'notifai', ...args]
      const deps: CommandDeps = { cwd: f.root, env: { ...f.env, HOME: f.root, USERPROFILE: f.root,
        NOTIFAI_NATIVE_ENTRY: 'launcher-v1', NOTIFAI_NATIVE_ROUTE: 'stable-v1', ...extraEnv },
        io: { out() {}, err() {}, confirm: async () => false, openUrl() {} },
        store: { load() { throw new Error('No credentials before command admission') }, save() {}, clear() {}, describe: () => 'test' } }
      try {
        await buildProgram(deps, { activationInstallation: factory, retryNativeSelection: forward,
          runners: { configSet: action, doctor: action, hookRun: action, install: action },
          exit: code => { throw new CommandExit(code) } }).parseAsync(process.argv)
      } catch (error) { if (!(error instanceof CommandExit)) throw error; return { code: error.code, deps } }
      throw new Error('Command did not exit')
    }
    return { ...f, running, installationId, question, installation, action, forward, factory, argv, invoke,
      wait: () => { waiting = true }, allow: () => { waiting = false }, noLookup: () => expect(f.requests).toHaveLength(requestsBefore) }
  }

  it('activates before an ordinary command and forwards it once while compatible question owners retain their build', async () => {
    const f = await staged(), result = await f.invoke()
    expect(result.code).toBe(0)
    expect(f.forward).toHaveBeenCalledOnce()
    expect(f.forward).toHaveBeenCalledWith(expect.objectContaining({ executable: path.join(f.options.root, 'bin', 'notifai'), attempts: 0 }), f.argv, result.deps)
    expect(f.action).not.toHaveBeenCalled()
    expect(activeVersion(f)).toBe('1.1.0')
    expect(readSessionState('retained-question', f.env)).toEqual(f.question)
    expect(readAutomaticUpdateRecord(f.env)).toMatchObject({ resume_pending: { from: '1.0.0', to: '1.1.0' } })
    expect(readAutomaticUpdateRecord(f.env).last_automatic).toBeUndefined()
    f.noLookup()
  })

  it('does no heavy installation work on repeated commands while the update still waits', async () => {
    const f = await staged(); f.wait()
    expect((await f.invoke()).code).toBe(0)
    f.factory.mockClear()
    expect((await f.invoke()).code).toBe(0)
    expect(f.factory).not.toHaveBeenCalled()
    expect(f.forward).not.toHaveBeenCalled()
    expect(f.action).toHaveBeenCalledTimes(2)
    f.noLookup()
  })

  it('retries a waiting build after the per-command cooldown expires', async () => {
    const f = await staged(); f.wait()
    expect((await f.invoke()).code).toBe(0)
    const at = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(at + 60_001)
    f.allow()
    expect((await f.invoke()).code).toBe(0)
    expect(f.factory).toHaveBeenCalledTimes(2)
    expect(f.forward).toHaveBeenCalledOnce()
    expect(activeVersion(f)).toBe('1.1.0')
    f.noLookup()
  })

  it('retains failed integration handoff until a later automatic pass finishes it, without an early update notice or repeated hub handover', async () => {
    const f = await staged()
    expect((await f.invoke()).code).toBe(0)
    const resume = vi.fn().mockRejectedValueOnce(new Error('resume unavailable')).mockResolvedValueOnce({ ok: true })
    const h = host(f, { resume }).host
    expect(await attemptAutomaticUpdate(h)).toEqual({ outcome: 'current' })
    expect(readAutomaticUpdateRecord(f.env)).toMatchObject({ resume_pending: { from: '1.0.0', to: '1.1.0' } })
    expect(readAutomaticUpdateRecord(f.env).last_automatic).toBeUndefined()
    expect(await attemptAutomaticUpdate(h)).toMatchObject({ outcome: 'activated', from: '1.0.0', to: '1.1.0' })
    expect(resume).toHaveBeenCalledTimes(2)
    expect(readAutomaticUpdateRecord(f.env)).toMatchObject({ resume_pending: null, last_automatic: { from: '1.0.0', to: '1.1.0' } })
  })

  it('finishes already-activated integration even when automatic updates were then turned off', async () => {
    const f = await staged()
    expect((await f.invoke()).code).toBe(0)
    const file = globalConfigPath(f.env)
    ensurePrivateDirectory(path.dirname(file))
    writeFileSync(file, '[updates]\nautomatic = false\n', { mode: 0o600 })
    const resume = vi.fn(async () => ({ ok: true }))
    expect(await attemptAutomaticUpdate(host(f, { resume }).host)).toMatchObject({ outcome: 'activated' })
    expect(resume).toHaveBeenCalledOnce()
    f.noLookup()
  })

  it('resumes integration on the next automatic pass after command-triggered activation', async () => {
    const f = await staged()
    expect((await f.invoke()).code).toBe(0)
    const resume = vi.fn(async () => ({ ok: true }))
    expect(await attemptAutomaticUpdate(host(f, { resume }).host)).toMatchObject({ outcome: 'activated', from: '1.0.0', to: '1.1.0' })
    expect(resume).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledWith(f.installation.activeRelease().launcher, '1.0.0')
    expect(readAutomaticUpdateRecord(f.env)).toMatchObject({ resume_pending: null, last_automatic: { from: '1.0.0', to: '1.1.0' } })
  })

  it('keeps the waiting marker if interrupted during read-only continuity checks', async () => {
    const f = await staged()
    const interrupted = new Installation({ ...f.options, externalWriters: () => { throw new Error('killed during read-only checks') } })
    expect(() => interrupted.recover()).toThrow('killed during read-only checks')
    expect(install(f)).toMatchObject({ pending: true, activation_waiting: true, active: { active: f.running.build } })
  })

  it('continues the current command while the existing writer still needs its build', async () => {
    const f = await staged(); f.wait()
    expect((await f.invoke()).code).toBe(0)
    expect(f.forward).not.toHaveBeenCalled()
    expect(f.action).toHaveBeenCalledOnce()
    expect(install(f)).toMatchObject({ pending: true, activation_waiting: true, active: { active: f.running.build } })
    expect(readSessionState('retained-question', f.env)).toEqual(f.question)
    f.noLookup()
  })

  it.each([
    ['diagnostic', ['doctor', '--json'], {}],
    ['lifecycle callback', ['hook', 'post-tool-use', '--owner', 'notifai', '--harness', 'claude-code'], {}],
    ['explicit installer', ['install', '--no-init', '--no-path', '--json'], {}],
    ['pinned owner route', undefined, { NOTIFAI_NATIVE_ROUTE: undefined }],
    ['forwarded command', undefined, { NOTIFAI_NATIVE_RETRY: '1' }],
    ['turning updates off', ['config', 'set', 'updates.automatic', 'false', '--yes'], {}],
  ] as const)('leaves activation alone for a %s', async (_name, args, env) => {
    const f = await staged()
    expect((await f.invoke(args ? [...args] : f.argv, env)).code).toBe(0)
    expect(f.factory).not.toHaveBeenCalled()
    expect(f.forward).not.toHaveBeenCalled()
    expect(f.action).toHaveBeenCalledOnce()
    expect(install(f).active!.active).toBe(f.running.build)
    f.noLookup()
  })

  it('honors the saved automatic-update off switch', async () => {
    const f = await staged(), file = globalConfigPath(f.env)
    ensurePrivateDirectory(path.dirname(file))
    writeFileSync(file, '[updates]\nautomatic = false\n', { mode: 0o600 })
    expect((await f.invoke()).code).toBe(0)
    expect(f.factory).not.toHaveBeenCalled()
    expect(f.action).toHaveBeenCalledOnce()
    expect(install(f).active!.active).toBe(f.running.build)
    f.noLookup()
  })

  it('does not wait behind an installer or steal its live lock', async () => {
    const f = await staged(), lock = path.join(f.options.root, 'installation.lock')
    mkdirSync(lock, { mode: 0o700 })
    const ticket = path.join(lock, `ticket-1-${process.pid}-${'a'.repeat(24)}`)
    writeFileSync(ticket, '', { mode: 0o600 })
    const sleep = vi.spyOn(Atomics, 'wait').mockImplementation(() => { throw new Error('Startup must not wait for an installer') })
    expect((await f.invoke()).code).toBe(0)
    expect(sleep).not.toHaveBeenCalled()
    expect(readFileSync(ticket, 'utf8')).toBe('')
    expect(f.forward).not.toHaveBeenCalled()
    expect(f.action).toHaveBeenCalledOnce()
    expect(install(f).active!.active).toBe(f.running.build)
    f.noLookup()
  })

  it('leaves an interrupted journal without a waiting marker for explicit recovery', async () => {
    const f = await staged(), file = path.join(f.options.root, 'transaction.json')
    const journal = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    delete journal['waiting_for_sessions']
    const bytes = JSON.stringify(journal)
    writeFileSync(file, bytes)
    expect((await f.invoke()).code).toBe(0)
    expect(f.forward).not.toHaveBeenCalled()
    expect(f.action).toHaveBeenCalledOnce()
    expect(f.factory).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    expect(install(f).active!.active).toBe(f.running.build)
    f.noLookup()
  })

  it('never activates corrupted downloaded bytes', async () => {
    const f = await staged(), build = readAutomaticUpdateRecord(f.env).staged!.build
    writeFileSync(path.join(f.options.root, 'versions', build, 'notifai-runtime'), 'corrupted bytes')
    expect((await f.invoke()).code).toBe(0)
    expect(f.forward).not.toHaveBeenCalled()
    expect(f.action).toHaveBeenCalledOnce()
    expect(install(f).active!.active).toBe(f.running.build)
    f.noLookup()
  })

  it('does not bypass the Linux credential-contract bootstrap boundary', async () => {
    const f = fixture()
    await f.publish('1.0.0', HISTORICAL_LOCAL_CONTINUITY); await f.historicalInstall('1.0.0')
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    const running = { build: install(f).active!.active, version: '1.0.0' }
    beginSessionIncarnation('historical-question', f.env, { stamp: lifecycleStamp(), harnessProcess: { pid: process.pid, start: processStartTime(process.pid)! } })
    writeSessionState('historical-question', f.env, { harness: 'claude-code', pending: [{ request_id: 'req_old', question: 'Continue?', asked_at: NOW }] })
    expect(await attemptAutomaticUpdate(host(f, { running: () => running }).host)).toMatchObject({ outcome: 'waiting' })
    rmSync(path.join(stateDir(f.env), 'sessions'), { recursive: true, force: true })
    const previous = readFileSync(path.join(f.options.root, 'install.json'), 'utf8')
    const fileUse = vi.fn(() => ({ status: 'clear' as const, processes: [] }))
    const installation = new Installation({ ...f.options, fileUse })
    expect(installation.retryWaitingActivation({ installation_id: (JSON.parse(previous) as { id: string }).id, build: running.build })).toBeNull()
    expect(fileUse).not.toHaveBeenCalled()
    expect(readFileSync(path.join(f.options.root, 'install.json'), 'utf8')).toBe(previous)
    expect(install(f).active!.active).toBe(running.build)
  })
})

describe('choosing a release channel', () => {
  const DAY = 24 * 60 * 60 * 1000
  function command(f: Fixture) {
    const printed: Record<string, unknown>[] = []
    const deps: CommandDeps = { cwd: f.root, env: f.env,
      io: { out: (text) => { printed.push(JSON.parse(text) as Record<string, unknown>) }, err: () => {}, confirm: async () => false, openUrl: () => {} },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'test' } }
    const update = async (_deps: CommandDeps, channel: 'stable' | 'beta') => {
      const nested: string[] = []
      await nativeUpdateCommand({ ...deps, io: { ...deps.io, out: (text) => { nested.push(text) } } }, { channel, json: true },
        { installation: f.installation, prepareHooks: () => true, resume: () => ({ ok: true, files_complete: true, migration_complete: true }) })
      return JSON.parse(nested.join('')) as Record<string, unknown>
    }
    const run = async (channel?: string) => ({
      code: await releaseChannelCommand(deps, channel, { json: true }, { installation: f.installation, update }), report: printed.at(-1)! })
    const plainUpdate = async (flags: { channel?: string; allowDowngrade?: boolean } = {}) => ({
      code: await nativeUpdateCommand(deps, { ...flags, json: true }, { installation: f.installation, prepareHooks: () => true,
        resume: () => ({ ok: true, files_complete: true, migration_complete: true }) }), report: printed.at(-1)! })
    return { run, plainUpdate }
  }

  it('leaving beta keeps the newer beta and saves stable; the next newer stable release replaces it automatically', async () => {
    const f = fixture()
    await f.publish('0.9.0'); f.point('stable', '0.9.0')
    await f.publish('1.0.0-beta.1'); await f.install('1.0.0-beta.1', 'beta')
    const { run, plainUpdate } = command(f)
    expect(await run()).toEqual({ code: 0, report: { ok: true, operation: 'show', changed: false, channel: 'beta',
      active_version: '1.0.0-beta.1', waiting_for_stable: false } })

    const generation = install(f).active!.generation
    expect(await run('stable')).toEqual({ code: 0, report: { ok: true, operation: 'set', changed: true, channel: 'stable',
      previous_channel: 'beta', active_version: '1.0.0-beta.1', previous_version: '1.0.0-beta.1', waiting_for_stable: true } })
    expect(install(f)).toMatchObject({ channel: 'stable', pending: false, active: { generation: generation + 1 } })
    expect((await run()).report).toMatchObject({ channel: 'stable', active_version: '1.0.0-beta.1', waiting_for_stable: true })

    // Neither an explicit nor an automatic update installs the older stable release or a newer beta.
    expect(await plainUpdate()).toMatchObject({ code: 0, report: { ok: true, changed: false, version: '1.0.0-beta.1', channel: 'stable' } })
    await f.publish('1.0.0-beta.2'); f.point('beta', '1.0.0-beta.2')
    expect(await attemptAutomaticUpdate(host(f).host)).toEqual({ outcome: 'current' })
    expect(activeVersion(f)).toBe('1.0.0-beta.1')

    await f.publish('1.0.0'); f.point('stable', '1.0.0')
    expect(await attemptAutomaticUpdate(host(f, { now: () => NOW + 2 * DAY }).host)).toEqual({ outcome: 'activated', from: '1.0.0-beta.1', to: '1.0.0' })
    expect(install(f)).toMatchObject({ channel: 'stable' })
  })

  it('saves the channel offline and lets a stale staged beta go when leaving beta', async () => {
    const f = fixture()
    await f.publish('0.9.0'); f.point('stable', '0.9.0')
    await f.publish('1.0.0-beta.1'); await f.install('1.0.0-beta.1', 'beta')
    await f.publish('1.0.0-beta.2'); f.point('beta', '1.0.0-beta.2')
    const held: ActivationPlan = { ...PLAN, hook_changes: [{ harness: 'codex', file: 'hooks.json' }] } as ActivationPlan
    expect((await attemptAutomaticUpdate(host(f, { plan: async () => held }).host)).outcome).not.toBe('activated')
    const staged = readAutomaticUpdateRecord(f.env).staged
    expect(staged).toMatchObject({ version: '1.0.0-beta.2' })

    f.network.up = false
    const { run, plainUpdate } = command(f)
    const { code, report } = await run('stable')
    expect(code).toBe(0)
    expect(report).toMatchObject({ ok: true, channel: 'stable', active_version: '1.0.0-beta.1', waiting_for_stable: true })
    expect(typeof report['release_check_error']).toBe('string')
    expect(readAutomaticUpdateRecord(f.env)).toMatchObject({ staged: null })
    expect(readAutomaticUpdateRecord(f.env).checked_at).toBeUndefined()

    // Even a staged beta that survived the switch never activates on stable.
    f.network.up = true
    updateAutomaticUpdateRecord(f.env, record => ({ record: { ...record, checked_at: NOW, staged: staged! }, result: undefined }))
    expect(await attemptAutomaticUpdate(host(f).host)).toEqual({ outcome: 'current' })
    expect(activeVersion(f)).toBe('1.0.0-beta.1')

    // The explicit return to the signed stable release still works.
    expect(await plainUpdate({ channel: 'stable', allowDowngrade: true })).toMatchObject({ code: 0, report: { ok: true, version: '0.9.0', channel: 'stable' } })
  })

  it('choosing beta installs a newer beta now and never an older build', async () => {
    const f = fixture()
    await f.publish('1.0.0'); await f.install('1.0.0', 'stable')
    await f.publish('0.9.0-beta.1'); f.point('beta', '0.9.0-beta.1')
    const { run } = command(f)
    expect(await run('beta')).toMatchObject({ code: 0, report: { ok: true, channel: 'beta', active_version: '1.0.0' } })
    expect((await run()).report).not.toHaveProperty('update')

    expect((await run('stable')).report).toMatchObject({ channel: 'stable', active_version: '1.0.0', waiting_for_stable: false })
    await f.publish('1.1.0-beta.1'); f.point('beta', '1.1.0-beta.1')
    const { code, report } = await run('beta')
    expect(code).toBe(0)
    expect(report).toMatchObject({ ok: true, channel: 'beta', previous_channel: 'stable', active_version: '1.1.0-beta.1',
      previous_version: '1.0.0', update: { ok: true, version: '1.1.0-beta.1' } })
  })

  it('refuses without a standalone installation and rejects unknown channels', async () => {
    const f = fixture()
    const printed: string[] = []
    const deps = { cwd: f.root, env: f.env, io: { out: (text: string) => { printed.push(text) }, err: () => {}, confirm: async () => false, openUrl: () => {} },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'test' } } as CommandDeps
    expect(await releaseChannelCommand(deps, 'nightly', { json: true })).toBe(2)
    expect(await releaseChannelCommand(deps, undefined, { json: true })).toBe(1)
    expect(JSON.parse(printed.at(-1)!)).toMatchObject({ ok: false, code: 'native_installation_required', channel: null })
  })

  it('names the channels Stable and Beta for people', async () => {
    const f = fixture()
    await f.publish('0.9.0'); f.point('stable', '0.9.0')
    await f.publish('1.0.0-beta.1'); await f.install('1.0.0-beta.1', 'beta')
    const printed: string[] = []
    const deps = { cwd: f.root, env: f.env, io: { out: (text: string) => { printed.push(text) }, err: () => {}, confirm: async () => false, openUrl: () => {}, interactive: true },
      store: { load: () => null, save: () => {}, clear: () => {}, describe: () => 'test' } } as CommandDeps
    await releaseChannelCommand(deps, undefined, {}, { installation: f.installation })
    await releaseChannelCommand(deps, 'stable', {}, { installation: f.installation })
    expect(printed).toEqual(['Release channel: Beta. Notifai 1.0.0-beta.1 is active.',
      'Release channel: Stable. Notifai 1.0.0-beta.1 stays until a newer Stable release replaces it.'])
  })
})

describe('activation plan parsing', () => {
  it('accepts a well-formed plan and nothing else', () => {
    expect(parseActivationPlan(JSON.stringify(PLAN))).toEqual(PLAN)
    expect(parseActivationPlan('{"schema":1,"hub_ipc_versions":{"min":2,"max":1},"hook_changes":[]}')).toBeNull()
    expect(parseActivationPlan('{"schema":1,"hub_ipc_versions":{"min":1,"max":1},"hook_changes":[{"harness":"codex"}]}')).toBeNull()
    expect(parseActivationPlan('not json')).toBeNull()
  })
})
