import { createHash,generateKeyPairSync,sign } from 'node:crypto'
import { mkdtempSync,rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import { afterEach,describe,expect,it } from 'vitest'
import type { ActivationPlan } from './activation-plan.js'
import { ensurePrivateDirectory } from './atomic-file.js'
import {
attemptAutomaticUpdate,
parseActivationPlan,
readAutomaticUpdateRecord,
updateAutomaticUpdateRecord,
type AutomaticUpdateHost
} from './automatic-update.js'
import type { CommandDeps } from './commands-core.js'
import { nativeUpdateCommand } from './commands-native-installation.js'
import { releaseChannelCommand } from './commands-release-channel.js'
import { beginSessionIncarnation,lifecycleStamp,writeSessionState } from './hook-session-state.js'
import { Installation } from './installation.js'
import { nullLogger } from './logging.js'
import { processStartTime } from './process-identity.js'
import { Distribution,releaseSigningMessage } from './release-distribution.js'

const NOW = 1_900_000_000_000
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

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
  const options = { root: path.join(root, 'managed'), target: 'bun-linux-x64' as const, distribution,
    access: { check() {}, directory: ensurePrivateDirectory, beforePublish() {}, protectExistingDirectory() {} }, probe: () => {} }
  const installation = new Installation(options)

  async function publish(version: string): Promise<void> {
    const runtime = `runtime ${version}`, launcher = 'launcher v1'
    const writer = pack(), chunks: Buffer[] = []
    const consumed = (async () => { for await (const chunk of writer) chunks.push(chunk as Buffer) })()
    writer.entry({ name: 'notifai' }, launcher)
    writer.entry({ name: 'notifai-runtime' }, runtime)
    writer.finalize(); await consumed
    const archive = gzipSync(Buffer.concat(chunks))
    const inventory = signed('inventory', { schema: 2, local_continuity: { contract: 'notifai-session-state-v2' }, version,
      source_revision: 'a'.repeat(40), store_schema: 2, launcher_schema: 1, artifacts: [{ target: 'bun-linux-x64',
        filename: `notifai-${version}-linux-x64.tar.gz`, bytes: archive.length, sha256: digest(archive),
        runtime_sha256: digest(runtime), launcher_sha256: digest(launcher), materials: [] }] })
    releases.set(version, { inventory, archive })
  }
  function point(channel: 'stable' | 'beta', version: string, withdrawn: string[] = []): void {
    channels[channel] = { sequence: (channels[channel]?.sequence ?? 0) + 1, version, withdrawn }
  }
  /** Install `version` as the active build, the way the native installer would. */
  async function install(version: string, channel: 'stable' | 'beta', source: 'shell' | 'npm' = 'shell'): Promise<void> {
    point(channel, version)
    await installation.installRelease({ channel, source, expectedGeneration: 0 })
  }
  const env: NodeJS.ProcessEnv = { XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config') }
  return { root, env, installation, options, publish, point, install, requests, channels, network }
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
    writeSessionState(open, f.env, { harness: 'claude-code', pending: [{ request_id: 'req_open', question: 'Deploy?', asked_at: NOW }] })
    expect(await attemptAutomaticUpdate({ ...host(f).host, running: () => running })).toEqual({ outcome: 'activated', from: '1.0.0', to: '1.1.0' })
    expect(install(f)).toMatchObject({ pending: false, channel: 'stable' })
    expect(activeVersion(f)).toBe('1.1.0')
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
