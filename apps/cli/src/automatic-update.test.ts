import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import { afterEach, describe, expect, it } from 'vitest'
import { ensurePrivateDirectory } from './atomic-file.js'
import {
  attemptAutomaticUpdate,
  automaticActivationNotice,
  automaticUpdateReport,
  heldAutomaticUpdate,
  parseActivationPlan,
  readAutomaticUpdateRecord,
  updateAutomaticUpdateRecord,
  type AutomaticUpdateHost,
} from './automatic-update.js'
import type { ActivationPlan } from './activation-plan.js'
import { cachedAgentUpdateNotice } from './agent-update-notice.js'
import { globalConfigPath } from './config.js'
import { beginSessionIncarnation, lifecycleStamp, writeSessionState } from './hook-session-state.js'
import { Installation } from './installation.js'
import { nullLogger } from './logging.js'
import { processStartTime } from './process-identity.js'
import { Distribution, releaseSigningMessage } from './release-distribution.js'

const NOW = 1_900_000_000_000
const DAY = 86_400_000
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
  const fetcher = (async (input: string) => {
    const url = String(input)
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
  return { root, env, installation, options, publish, point, install, requests, channels }
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

function setAutomatic(f: Fixture, value: string): void {
  mkdirSync(path.dirname(globalConfigPath(f.env)), { recursive: true })
  writeFileSync(globalConfigPath(f.env), value)
}

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

  it('honours the off switch: no lookup, no download, no activation', async () => {
    const f = fixture()
    await f.publish('1.0.0'); await f.install('1.0.0', 'stable')
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    const before = f.requests.length
    for (const text of ['"updates.automatic" = false\n', '[updates]\nautomatic = false\n']) {
      setAutomatic(f, text)
      expect(await attemptAutomaticUpdate(host(f).host)).toEqual({ outcome: 'off' })
    }
    expect(f.requests.length).toBe(before)
    expect(activeVersion(f)).toBe('1.0.0')
    expect(automaticUpdateReport(f.env, { runsHere: true }).automatic).toEqual({ enabled: false, source: 'user', runs_here: true })
    setAutomatic(f, '"updates.automatic" = true\n')
    expect((await attemptAutomaticUpdate(host(f).host)).outcome).toBe('activated')
  })

  it('looks the release up at most once a day', async () => {
    const f = fixture()
    await f.publish('1.0.0'); await f.install('1.0.0', 'stable')
    expect(await attemptAutomaticUpdate(host(f).host)).toEqual({ outcome: 'current' })
    const after = f.requests.length
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    expect(await attemptAutomaticUpdate({ ...host(f).host, now: () => NOW + DAY - 1 })).toEqual({ outcome: 'current' })
    expect(f.requests.length).toBe(after)
    expect((await attemptAutomaticUpdate({ ...host(f).host, now: () => NOW + DAY })).outcome).toBe('activated')
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

  it('never activates an older release; a withdrawn build moves forward only', async () => {
    const f = fixture()
    await f.publish('1.0.0'); await f.publish('1.1.0')
    await f.install('1.1.0', 'stable')
    // The channel moves back after 1.1.0 is withdrawn: stay, download nothing, say so.
    f.point('stable', '1.0.0', ['1.1.0'])
    expect(await attemptAutomaticUpdate(host(f).host)).toEqual({ outcome: 'current' })
    expect(activeVersion(f)).toBe('1.1.0')
    expect(f.requests.some(url => url.endsWith('notifai-1.0.0-linux-x64.tar.gz'))).toBe(false)
    expect(automaticUpdateReport(f.env, { runsHere: true }).waiting_for).toEqual(['no-forward-release'])
    // Its replacement arrives: move forward to it.
    await f.publish('1.1.1'); f.point('stable', '1.1.1', ['1.1.0'])
    expect(await attemptAutomaticUpdate({ ...host(f).host, now: () => NOW + DAY })).toEqual({ outcome: 'activated', from: '1.1.0', to: '1.1.1' })
  })

  it('updates the runtime of an install made through the npm launcher and keeps it an npm install', async () => {
    const f = fixture()
    await f.publish('1.0.0'); await f.install('1.0.0', 'stable', 'npm')
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    expect((await attemptAutomaticUpdate(host(f).host)).outcome).toBe('activated')
    expect(install(f)).toMatchObject({ source: 'npm', channel: 'stable' })
  })

  it('activates while questions, answers and acknowledgements wait, because the next hub takes them over', async () => {
    const f = fixture()
    await f.publish('1.0.0'); await f.install('1.0.0', 'stable')
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    const open = 'open-session'
    beginSessionIncarnation(open, f.env, { stamp: lifecycleStamp(), harnessProcess: { pid: process.pid, start: processStartTime(process.pid)! } })
    writeSessionState(open, f.env, { harness: 'claude-code', pending: [{ request_id: 'req_open', question: 'Deploy?', asked_at: NOW }],
      acknowledgement_due: [{ request_id: 'req_done', recorded_at: NOW }] })
    expect(await attemptAutomaticUpdate(host(f).host)).toEqual({ outcome: 'activated', from: '1.0.0', to: '1.1.0' })
    expect(activeVersion(f)).toBe('1.1.0')
    expect(automaticUpdateReport(f.env, { runsHere: true })).toMatchObject({ staged: null, waiting_for: [] })
  })

  it('keeps an update staged when it would change trusted hook definitions, and offers it to agents', async () => {
    const f = fixture()
    await f.publish('1.0.0'); await f.install('1.0.0', 'stable')
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    const plan: ActivationPlan = { ...PLAN, hook_changes: [{ harness: 'codex', file: '/h/.codex/hooks.json', reasons: ['missing PreCompact'] }] }
    const { host: h, calls } = host(f, { plan: async () => plan })
    expect(await attemptAutomaticUpdate(h)).toEqual({ outcome: 'waiting', version: '1.1.0', waiting_for: ['hook-approval'] })
    expect(activeVersion(f)).toBe('1.0.0')
    expect(calls.resume).toEqual([])
    expect(automaticUpdateReport(f.env, { runsHere: true })).toMatchObject({ staged: '1.1.0', waiting_for: ['hook-approval'],
      hook_changes: [{ harness: 'codex', file: '/h/.codex/hooks.json' }] })
    expect(heldAutomaticUpdate(f.env, NOW)).toMatchObject({ version: '1.1.0', reason: 'action' })
    const notice = cachedAgentUpdateNotice({ env: f.env, now: NOW, updateCommand: 'notifai update', automaticRunsHere: true })
    expect(notice).toContain('Notifai 1.1.0 is downloaded but automatic updates are holding it back')
    expect(notice).toContain('/hooks')
    expect(cachedAgentUpdateNotice({ env: f.env, now: NOW + 1, updateCommand: 'notifai update', automaticRunsHere: true })).toBeUndefined()
  })

  it('refuses activation while a connected session child speaks an IPC version the new hub cannot serve', async () => {
    const f = fixture()
    await f.publish('1.0.0'); await f.install('1.0.0', 'stable')
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    const { host: h } = host(f, { childIpcVersions: () => [1, 1], plan: async () => ({ ...PLAN, hub_ipc_versions: { min: 2, max: 2 } }) })
    expect(await attemptAutomaticUpdate(h)).toEqual({ outcome: 'waiting', version: '1.1.0', waiting_for: ['session-child-incompatible'] })
    expect(activeVersion(f)).toBe('1.0.0')
    // With no such child left, it goes ahead.
    expect((await attemptAutomaticUpdate({ ...h, childIpcVersions: () => [] })).outcome).toBe('activated')
  })

  it('refuses a candidate that cannot describe its own activation', async () => {
    const f = fixture()
    await f.publish('1.0.0'); await f.install('1.0.0', 'stable')
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    expect(await attemptAutomaticUpdate(host(f, { plan: async () => null }).host))
      .toEqual({ outcome: 'waiting', version: '1.1.0', waiting_for: ['candidate-unverified'] })
    expect(activeVersion(f)).toBe('1.0.0')
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

  it('tells agents once after an automatic activation, and makes no weekly offer while automatic', async () => {
    const f = fixture()
    await f.publish('1.0.0'); await f.install('1.0.0', 'stable')
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    await attemptAutomaticUpdate(host(f).host)
    // A lookup recorded an available release earlier; automatic updates make no offer for it.
    mkdirSync(path.join(f.env['XDG_STATE_HOME']!, 'notifai'), { recursive: true })
    writeFileSync(path.join(f.env['XDG_STATE_HOME']!, 'notifai', 'cli-update-notice.json'), JSON.stringify({ available: '99.0.0' }))
    const read = (now: number) => cachedAgentUpdateNotice({ env: f.env, now, updateCommand: 'notifai update', currentVersion: '1.0.0', automaticRunsHere: true })
    const first = read(NOW)
    expect(first).toContain('Notifai updated itself from 1.0.0 to 1.1.0')
    expect(first).toContain('notifai update --check --json --from 1.0.0')
    expect(read(NOW + 1)).toBeUndefined()
    expect(read(NOW + 8 * DAY)).toBeUndefined()
    expect(automaticActivationNotice(f.env, NOW + 9 * DAY)).toBeUndefined()
    // With automatic updates off, the weekly offer is back.
    setAutomatic(f, '"updates.automatic" = false\n')
    expect(read(NOW + 9 * DAY)).toContain('offer to perform the update')
  })

  it('offers a staged update that has waited a week', async () => {
    const f = fixture()
    await f.publish('1.0.0'); await f.install('1.0.0', 'stable')
    await f.publish('1.1.0'); f.point('stable', '1.1.0')
    // Held back by something that clears by itself (an installation change in progress).
    updateAutomaticUpdateRecord(f.env, (record) => ({ record: { ...record, staged: { version: '1.1.0', build: 'b'.repeat(64), since: NOW },
      waiting_for: ['installation-busy'] }, result: undefined }))
    expect(heldAutomaticUpdate(f.env, NOW + 7 * DAY - 1)).toBeNull()
    expect(heldAutomaticUpdate(f.env, NOW + 7 * DAY)).toMatchObject({ version: '1.1.0', reason: 'starved' })
    expect(cachedAgentUpdateNotice({ env: f.env, now: NOW + 7 * DAY, updateCommand: 'notifai update', automaticRunsHere: true }))
      .toContain('kept it waiting on this machine for a week')
  })

  it('reports nothing to update outside a managed installation', async () => {
    const f = fixture()
    expect(await attemptAutomaticUpdate(host(f, { installation: () => { throw new Error('legacy npm layout') } }).host)).toEqual({ outcome: 'not-managed' })
    expect(existsSync(path.join(f.env['XDG_STATE_HOME']!, 'notifai', 'automatic-update.json'))).toBe(false)
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
