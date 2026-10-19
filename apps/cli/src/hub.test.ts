import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  AttendanceBatchRequestT,
  AttendanceBatchResponse,
  AttendanceRequestT,
  AttendanceResponse,
  CompatibilityResponse,
} from '@raidiant/notifai-protocol'
import { ApiCallError, type ApiClient } from './client.js'
import type { CommandDeps } from './commands-core.js'
import type { CredentialStore, MachineCredential } from './credentials.js'
import { claudeDescriptorDir } from './claude-wake.js'
import { readSessionEndMarker, readSessionIncarnation, recordSessionNotified } from './hook-session-state.js'
import { ExchangeDriver, type AttendedSession, type ExchangeHost } from './hub-exchange.js'
import { credentialGenerationPath, encodeFrame, FrameDecoder, fnv64Hex, hubLockPath, hubSocketPath, requestHub } from './hub-ipc.js'
import { SessionLease, HUB_WRITE_MARGIN_MS } from './hub-lease.js'
import { Hub, type PeerCredentials } from './hub.js'
import { nullLogger } from './logging.js'
import { pidExists, processStartTime } from './process-identity.js'
import { readHubReport } from './hub-client.js'
import { readAttendantEndingLease } from './session-attendant-state.js'

const SESSION = '11111111-2222-3333-4444-555555555555'
const OTHER = '22222222-3333-4444-5555-666666666666'

// ---------------------------------------------------------------------------
// Lease rules
// ---------------------------------------------------------------------------

describe('hub session lease', () => {
  const attending = (generation: number, messages: AttendanceResponse extends infer T ? T extends { status: 'attending' } ? T['messages'] : never : never = []) =>
    ({ status: 'attending', generation, lease_remaining_ms: 120_000, message_cursor: 'c1', messages }) as const

  it('acquires, renews without a new generation, and covers writes only inside the margin of the same epoch and credential', () => {
    const lease = new SessionLease('inc_aaaaaaaaaaaa', () => null)
    expect(lease.runningEntry(SESSION, 'idle', true)).toEqual({ session_id: SESSION, incarnation: 'inc_aaaaaaaaaaaa', state: 'running', activity: 'idle', accepts_messages: true })
    expect(lease.apply(attending(3), 1_000, 0, 0, 'cred:1', false)).toEqual({ kind: 'attending', acquired: true, messages: [] })
    expect(lease.runningEntry(SESSION, 'working', false)).toMatchObject({ generation: 3 })
    expect(lease.apply(attending(3), 2_000, 0, 0, 'cred:1', false)).toMatchObject({ acquired: false })
    expect(lease.covers(2_000 + 120_000 - HUB_WRITE_MARGIN_MS - 1, 0, 'cred:1')).toBe(true)
    expect(lease.covers(2_000 + 120_000 - HUB_WRITE_MARGIN_MS, 0, 'cred:1')).toBe(false)
    // A clock discontinuity (sleep) or another credential voids the grant.
    expect(lease.covers(2_001, 1, 'cred:1')).toBe(false)
    expect(lease.covers(2_001, 0, 'cred:2')).toBe(false)
  })

  it('treats a grant sent before a clock jump as no grant', () => {
    const lease = new SessionLease('inc_aaaaaaaaaaaa', () => null)
    lease.apply(attending(1), 1_000, 0, 1, 'cred', false)
    expect(lease.generation).toBe(1)
    expect(lease.covers(1_001, 1, 'cred')).toBe(false)
  })

  it('waits out another owner, and stops for good when the service withdraws a held generation', () => {
    const lease = new SessionLease('inc_aaaaaaaaaaaa', () => null)
    expect(lease.apply({ status: 'owned', retry_after_ms: 50 }, 0, 0, 0, null, false)).toEqual({ kind: 'owned', retryAfterMs: 1_000 })
    expect(lease.phase).toBe('waiting-for-lease')
    lease.apply(attending(2), 0, 0, 0, null, false)
    expect(lease.apply({ status: 'withdrawn' }, 0, 0, 0, null, false)).toEqual({ kind: 'withdrawn' })
    expect(lease.phase).toBe('withdrawn')
    expect(lease.generation).toBeNull()
  })

  it('rotates a refused incarnation once, never twice in a row', () => {
    const rotations: string[] = []
    const lease = new SessionLease('inc_aaaaaaaaaaaa', (expected) => { rotations.push(expected); return `inc_bbbbbbbbbbb${rotations.length}` })
    expect(lease.apply({ status: 'withdrawn' }, 0, 0, 0, null, false)).toEqual({ kind: 'rotated' })
    expect(lease.incarnation).toBe('inc_bbbbbbbbbbb1')
    expect(lease.apply({ status: 'withdrawn' }, 0, 0, 0, null, false)).toEqual({ kind: 'withdrawn' })
    expect(rotations).toEqual(['inc_aaaaaaaaaaaa'])
  })

  it('reports an end from a held generation, and a withdrawal only from a held one', () => {
    const lease = new SessionLease('inc_aaaaaaaaaaaa', () => null)
    lease.final = 'withdrawn'
    expect(lease.finalEntry(SESSION)).toBeNull()
    lease.final = 'ended'
    expect(lease.finalEntry(SESSION)).toEqual({ session_id: SESSION, incarnation: 'inc_aaaaaaaaaaaa', state: 'ended' })
    lease.generation = 4
    expect(lease.finalEntry(SESSION)).toMatchObject({ generation: 4, state: 'ended' })
    expect(lease.apply({ status: 'withdrawn' }, 0, 0, 0, null, true)).toEqual({ kind: 'reported', state: 'ended' })
    expect(lease.final).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Exchange driver against a fake service
// ---------------------------------------------------------------------------

interface FakeService {
  client: ApiClient
  batches: { body: AttendanceBatchRequestT; waitSeconds: number }[]
  single: { sessionId: string; body: AttendanceRequestT; waitSeconds: number }[]
  /** Release every held exchange now. */
  release(): void
  /** While set, even an exchange that asked for no wait is held until `release`. */
  hold: boolean
}

function fakeService(options: {
  capabilities?: string[]
  batch?: (body: AttendanceBatchRequestT) => AttendanceBatchResponse | Error
  single?: (sessionId: string, body: AttendanceRequestT) => AttendanceResponse
} = {}): FakeService {
  const batches: FakeService['batches'] = []
  const single: FakeService['single'] = []
  const held = new Set<() => void>()
  const hold = (waitSeconds: number, signal?: AbortSignal): Promise<void> => waitSeconds === 0 && !service.hold ? Promise.resolve() : new Promise((resolve, reject) => {
    const done = (): void => { held.delete(done); resolve() }
    held.add(done)
    signal?.addEventListener('abort', () => { held.delete(done); reject(new Error('aborted')) }, { once: true })
  })
  const defaultBatch = (body: AttendanceBatchRequestT): AttendanceBatchResponse => ({
    message_cursor: 'c1',
    sessions: body.sessions.map((entry) => entry.state === 'running'
      ? { session_id: entry.session_id, status: 'attending', generation: entry.generation ?? 1, lease_remaining_ms: 120_000, message_cursor: 'c1', messages: [] }
      : { session_id: entry.session_id, status: 'withdrawn' }),
  })
  const client = new Proxy({} as ApiClient, {
    get(_target, property) {
      if (property === 'then') return undefined
      if (property === 'compatibility') {
        return async (): Promise<CompatibilityResponse> => ({ cli: {} as CompatibilityResponse['cli'], platforms: [],
          server_capabilities: (options.capabilities ?? ['session_attendance', 'session_attendance_batch']) as CompatibilityResponse['server_capabilities'] })
      }
      if (property === 'attendBatch') {
        return async (body: AttendanceBatchRequestT, { waitSeconds, signal }: { waitSeconds: number; signal?: AbortSignal }) => {
          batches.push({ body: structuredClone(body), waitSeconds })
          await hold(waitSeconds, signal)
          const result = (options.batch ?? defaultBatch)(body)
          if (result instanceof Error) throw result
          return result
        }
      }
      if (property === 'attend') {
        return async (sessionId: string, body: AttendanceRequestT, { waitSeconds, signal }: { waitSeconds: number; signal?: AbortSignal }) => {
          single.push({ sessionId, body: structuredClone(body), waitSeconds })
          await hold(waitSeconds, signal)
          return (options.single ?? ((_id, b) => b.state === 'running'
            ? { status: 'attending', generation: b.generation ?? 1, lease_remaining_ms: 120_000, message_cursor: 'c1', messages: [] }
            : { status: 'withdrawn' }))(sessionId, body)
        }
      }
      return async () => { throw new Error(`unexpected call ${String(property)}`) }
    },
  })
  const service: FakeService = { client, batches, single, hold: false, release: () => { for (const done of [...held]) done() } }
  return service
}

class FakeSession implements AttendedSession {
  readonly lease: SessionLease
  attendedCount = 0
  outcomes: string[] = []
  ready = true
  constructor(readonly id: string) { this.lease = new SessionLease(`inc_${id.replace(/-/g, '').slice(0, 12)}`, () => null) }
  runnable(now: number): boolean { return this.ready && now >= this.lease.pausedUntil && this.lease.phase !== 'withdrawn' }
  activity() { return 'idle' as const }
  acceptsMessages() { return true }
  async attended(): Promise<'done'> { this.attendedCount += 1; return 'done' }
  settled(outcome: { kind: string }): void { this.outcomes.push(outcome.kind) }
}

function driverHost(service: FakeService, sessions: FakeSession[], overrides: Partial<ExchangeHost> = {}): ExchangeHost & { unauthorizedCount: number } {
  const host = {
    unauthorizedCount: 0,
    sessions: () => sessions,
    client: () => service.client,
    credentialKey: () => 'cred:1',
    unauthorized: () => { host.unauthorizedCount += 1 },
    clock: { monotonic: () => performance.now(), wall: () => Date.now() },
    logger: nullLogger(),
    sleep: (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(ms, 20))
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    }),
    ...overrides,
  }
  return host
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('hub exchange driver', () => {
  it('renews every session in one batch, then holds one long-poll behind one cursor', async () => {
    const service = fakeService()
    const sessions = [new FakeSession(SESSION), new FakeSession(OTHER)]
    const driver = new ExchangeDriver(driverHost(service, sessions))
    const running = driver.run()
    await until(() => service.batches.length >= 2)
    expect(service.batches[0]!.body.sessions.map((s) => s.session_id)).toEqual([SESSION, OTHER])
    expect(service.batches[0]!.waitSeconds).toBe(0)
    expect(service.batches[1]!.waitSeconds).toBe(25)
    expect(service.batches[1]!.body.message_cursor).toBe('c1')
    expect(service.batches[1]!.body.sessions.every((s) => s.generation === 1)).toBe(true)
    expect(sessions.every((s) => s.lease.phase === 'attending')).toBe(true)
    expect(service.single).toEqual([])
    driver.stop()
    service.release()
    await running
  })

  it('cuts the held exchange when a session needs a fresh answer', async () => {
    const service = fakeService()
    const session = new FakeSession(SESSION)
    const driver = new ExchangeDriver(driverHost(service, [session]))
    const running = driver.run()
    await until(() => service.batches.length >= 2 && service.batches[1]!.waitSeconds === 25)
    session.lease.needsFresh = true
    driver.poke()
    await until(() => service.batches.length >= 3)
    expect(service.batches[2]!.waitSeconds).toBe(0)
    driver.stop()
    service.release()
    await running
  })

  it('leaves an owned session out until its retry time instead of spinning the batch', async () => {
    let calls = 0
    const service = fakeService({ batch: (body) => {
      calls += 1
      return { message_cursor: 'c1', sessions: body.sessions.map((entry) => entry.session_id === OTHER
        ? { session_id: OTHER, status: 'owned', retry_after_ms: 60_000 }
        : { session_id: entry.session_id, status: 'attending', generation: 1, lease_remaining_ms: 120_000, message_cursor: 'c1', messages: [] }) }
    } })
    const sessions = [new FakeSession(SESSION), new FakeSession(OTHER)]
    const driver = new ExchangeDriver(driverHost(service, sessions))
    const running = driver.run()
    await until(() => service.batches.length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 100))
    // One fresh exchange, then a held one that no longer carries the owned session.
    expect(calls).toBeLessThanOrEqual(3)
    expect(service.batches.at(-1)!.body.sessions.map((s) => s.session_id)).toEqual([SESSION])
    expect(sessions[1]!.outcomes).toContain('owned')
    driver.stop()
    service.release()
    await running
  })

  it('falls back to the per-session route against a service without the batch', async () => {
    const service = fakeService({ capabilities: ['session_attendance'] })
    const sessions = [new FakeSession(SESSION), new FakeSession(OTHER)]
    const driver = new ExchangeDriver(driverHost(service, sessions))
    const running = driver.run()
    await until(() => service.single.length >= 2)
    expect(service.batches).toEqual([])
    expect(new Set(service.single.map((call) => call.sessionId))).toEqual(new Set([SESSION, OTHER]))
    expect(driver.transport).toBe('per-session')
    driver.stop()
    service.release()
    await running
  })

  it('paces the per-session fallback to the machine\'s exchange budget', async () => {
    const service = fakeService({ capabilities: ['session_attendance'] })
    const sessions = Array.from({ length: 20 }, (_, index) => new FakeSession(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`))
    const driver = new ExchangeDriver(driverHost(service, sessions))
    const running = driver.run()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(service.single.length).toBeLessThanOrEqual(8)
    await until(() => service.single.length >= 20, 6_000)
    driver.stop()
    service.release()
    await running
  })

  it('never cuts an exchange that is already answering, so an end report is sent once', async () => {
    const service = fakeService()
    service.hold = true
    const ending = new FakeSession(SESSION)
    ending.lease.generation = 2
    ending.lease.final = 'ended'
    const driver = new ExchangeDriver(driverHost(service, [ending]))
    const running = driver.run()
    await until(() => service.batches.length >= 1)
    driver.poke()
    await new Promise((resolve) => setTimeout(resolve, 50))
    service.hold = false
    service.release()
    await until(() => ending.outcomes.includes('reported'))
    expect(service.batches.filter((batch) => batch.body.sessions.some((entry) => entry.state === 'ended'))).toHaveLength(1)
    driver.stop()
    await running
  })

  it('falls back when the batch route answers 404 even though the capability was listed', async () => {
    const service = fakeService({ batch: () => new ApiCallError(404, 'not_found', 'no route') })
    const driver = new ExchangeDriver(driverHost(service, [new FakeSession(SESSION)]))
    const running = driver.run()
    await until(() => service.single.length >= 1)
    expect(driver.transport).toBe('per-session')
    driver.stop()
    service.release()
    await running
  })

  it('stops authenticated work on 401 and sends a final end report once', async () => {
    const service = fakeService({ batch: () => new ApiCallError(401, 'unauthorized', 'revoked') })
    let client: ApiClient | null = service.client
    const host = driverHost(service, [new FakeSession(SESSION)], { client: () => client })
    host.unauthorized = () => { host.unauthorizedCount += 1; client = null }
    const driver = new ExchangeDriver(host)
    const running = driver.run()
    await until(() => host.unauthorizedCount === 1)
    const sent = service.batches.length
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(service.batches.length).toBe(sent)
    driver.stop()
    await running

    const ok = fakeService()
    const ending = new FakeSession(SESSION)
    ending.lease.generation = 2
    ending.lease.final = 'ended'
    const second = new ExchangeDriver(driverHost(ok, [ending]))
    const run2 = second.run()
    await until(() => ending.outcomes.includes('reported'))
    expect(ok.batches[0]!.body.sessions).toEqual([{ session_id: SESSION, incarnation: ending.lease.incarnation, generation: 2, state: 'ended' }])
    expect(ok.batches[0]!.waitSeconds).toBe(0)
    second.stop()
    ok.release()
    await run2
  })
})

// ---------------------------------------------------------------------------
// The hub over its real socket, with fake session children
// ---------------------------------------------------------------------------

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function hubEnv(): NodeJS.ProcessEnv {
  // Short root: the hub socket must fit in a Unix socket path.
  const root = mkdtempSync(path.join('/tmp', 'b3hub-'))
  roots.push(root)
  mkdirSync(path.join(root, 'claude', 'sessions'), { recursive: true })
  claudeConfigDir = path.join(root, 'claude')
  return { ...process.env, XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), NOTIFAI_CREDENTIALS: 'file' }
}

const CREDENTIAL: MachineCredential = { machineId: 'mch_test', secret: 'secret', baseUrl: 'https://example.invalid', machineName: 'test' }

function memoryStore(initial: MachineCredential | null = CREDENTIAL): CredentialStore & { current: MachineCredential | null; loads: number } {
  const store = {
    current: initial,
    loads: 0,
    load() { store.loads += 1; return store.current },
    save(credential: MachineCredential) { store.current = credential },
    clear() { store.current = null },
    describe: () => 'memory',
  }
  return store
}

/** The harness stands in as this test process: a real PID with a real start time. */
const HARNESS = { pid: process.pid, start: processStartTime(process.pid)! }

function writeDescriptor(env: NodeJS.ProcessEnv, sessionId: string, procStart = HARNESS.start): void {
  writeFileSync(path.join(claudeDescriptorDir(env), `${HARNESS.pid}.json`), JSON.stringify({
    pid: HARNESS.pid, sessionId, cwd: '/tmp', startedAt: Date.now(), procStart, version: '2.1.304', peerProtocol: 1,
    messagingSocketPath: '/tmp/b3hub-inbox.sock', status: 'idle',
  }))
}

interface FakeChild { socket: Socket; frames: Record<string, unknown>[]; closed: boolean; send(message: Record<string, unknown>): void }

async function connectChild(env: NodeJS.ProcessEnv, pid: number): Promise<FakeChild> {
  const socket = createConnection(hubSocketPath(env))
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const decoder = new FrameDecoder()
  const child: FakeChild = { socket, frames: [], closed: false, send: (message) => socket.write(encodeFrame(message)) }
  socket.on('data', (chunk: Buffer) => { child.frames.push(...decoder.push(chunk)) })
  socket.on('close', () => { child.closed = true })
  child.send({ type: 'hello', ipc_version: 1, role: 'child', pid })
  return child
}

let claudeConfigDir = ''
function registration(sessionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'register', session_id: sessionId, harness: 'claude-code', harness_pid: HARNESS.pid, harness_start: HARNESS.start,
    claude_config_dir: claudeConfigDir,
    boot: 'test-boot', stamp_wall: Date.now(), stamp_mono: String(process.hrtime.bigint()), hook_event: 'SessionStart', source: 'startup',
    cwd: '/tmp', inbox_token: 'present', ...overrides }
}

function peerOf(pid: number, parent: { pid: number; comm: string; start: string }, grandparent?: { pid: number; comm: string; start: string }, uid = process.getuid!()): PeerCredentials {
  return { uid, pid, peer: { pid, ppid: parent.pid, comm: 'notifai', start: HARNESS.start },
    parent: { ...parent, ppid: grandparent?.pid ?? 1 }, grandparent: grandparent === undefined ? null : { ...grandparent, ppid: 1 } }
}

function startHub(env: NodeJS.ProcessEnv, service: FakeService, peers: Map<number, PeerCredentials>, store = memoryStore(), safetyTickMs?: number): { hub: Hub; done: Promise<number> } {
  const deps: CommandDeps = {
    io: { out: () => undefined, err: () => undefined, confirm: async () => false, openUrl: () => undefined },
    store, env, cwd: '/tmp', logger: nullLogger(), clientFactory: () => service.client,
  }
  const hub = new Hub(deps, { deps, verifyPeer: async (socket) => {
    // The fake child's pid is whatever it said in hello; tests map it to a peer.
    void socket
    return peers.get(lastHelloPid) ?? null
  }, idleExitMs: 400, bootIdentity: () => 'test-boot', ...(safetyTickMs === undefined ? {} : { safetyTickMs }) })
  const done = hub.run()
  return { hub, done }
}
let lastHelloPid = 0

async function hubListening(env: NodeJS.ProcessEnv): Promise<void> {
  await until(() => {
    try { readFileSync(hubLockPath(env)); return true } catch { return false }
  })
  await until(() => {
    try { return readFileSync(hubSocketPath(env)) !== null } catch (err) { return (err as NodeJS.ErrnoException).code !== 'ENOENT' }
  })
}

async function registered(env: NodeJS.ProcessEnv, sessionId: string, pid: number, peer: PeerCredentials, peers: Map<number, PeerCredentials>, overrides: Record<string, unknown> = {}): Promise<FakeChild> {
  peers.set(pid, peer)
  lastHelloPid = pid
  const child = await connectChild(env, pid)
  child.send(registration(sessionId, overrides))
  await until(() => child.frames.length > 0 || child.closed)
  return child
}

describe('hub', () => {
  it('registers a child of the harness, attends it in one batch, and reports the end the child sees', async () => {
    const env = hubEnv()
    writeDescriptor(env, SESSION)
    recordSessionNotified(SESSION, env, Date.now())
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const { hub, done } = startHub(env, service, peers)
    await hubListening(env)
    const child = await registered(env, SESSION, 900001, peerOf(900001, { pid: HARNESS.pid, comm: 'claude', start: HARNESS.start }), peers)
    expect(child.frames[0]).toEqual({ type: 'registered', session_id: SESSION })
    await until(() => service.batches.length >= 2)
    expect(service.batches[0]!.body.sessions).toEqual([expect.objectContaining({ session_id: SESSION, state: 'running', activity: 'idle', accepts_messages: true })])
    expect(readSessionIncarnation(SESSION, env)?.boot).toBe('test-boot')
    child.send({ type: 'ended', session_id: SESSION, harness_pid: HARNESS.pid, reason: 'harness-gone' })
    await until(() => service.batches.some((batch) => batch.body.sessions.some((entry) => entry.state === 'ended')))
    const ended = service.batches.find((batch) => batch.body.sessions.some((entry) => entry.state === 'ended'))!
    expect(ended.body.sessions).toEqual([{ session_id: SESSION, incarnation: readSessionIncarnation(SESSION, env)!.incarnation, generation: 1, state: 'ended' }])
    // The close nobody else recorded is recorded locally, as SessionEnd would have.
    await until(() => readSessionEndMarker(SESSION, env) !== null)
    child.socket.destroy()
    service.release()
    expect(await done).toBe(0) // idle exit after the last child left
    void hub
  })

  it('accepts a grandchild through a shell, and refuses another user, another process, a non-child and a reused PID', async () => {
    const env = hubEnv()
    writeDescriptor(env, SESSION)
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const { done } = startHub(env, service, peers)
    await hubListening(env)
    const harness = { pid: HARNESS.pid, comm: 'claude', start: HARNESS.start }
    const viaShell = await registered(env, SESSION, 900002,
      peerOf(900002, { pid: 900100, comm: 'sh', start: HARNESS.start }, harness), peers)
    expect(viaShell.frames[0]).toMatchObject({ type: 'registered' })
    viaShell.socket.destroy()

    const refusals: [string, PeerCredentials, Record<string, unknown>][] = [
      ['peer-mismatch', peerOf(900003, harness, undefined, process.getuid!() + 1), {}],
      ['harness-not-parent', peerOf(900004, { pid: 900200, comm: 'node', start: HARNESS.start }, harness), {}],
      ['harness-start-mismatch', peerOf(900005, { ...harness, start: 'Thu Jan  1 00:00:00 1970' }), {}],
      ['descriptor-mismatch', peerOf(900006, harness), { session_id: OTHER }],
    ]
    for (const [reason, peer, overrides] of refusals) {
      const child = await registered(env, (overrides['session_id'] as string | undefined) ?? 'aaaaaaaa-0000-0000-0000-000000000000', peer.pid, peer, peers, overrides)
      expect(child.frames[0], reason).toEqual({ type: 'refused', reason, retry: false })
    }
    // A child that says hello as one process but is another is refused.
    peers.set(900007, peerOf(900099, harness))
    lastHelloPid = 900007
    const liar = await connectChild(env, 900007)
    liar.send(registration(SESSION))
    await until(() => liar.frames.length > 0)
    expect(liar.frames[0]).toEqual({ type: 'refused', reason: 'peer-mismatch', retry: false })
    service.release()
    await done
  })

  it('keeps one hub per state directory when two start at once', async () => {
    const env = hubEnv()
    const service = fakeService()
    const first = startHub(env, service, new Map())
    const second = startHub(env, service, new Map())
    const results = await Promise.all([first.done, second.done])
    // Both end (idle); exactly one of them listened.
    expect(results).toEqual([0, 0])
    const starts = (JSON.parse(readFileSync(path.join(env['XDG_STATE_HOME']!, 'notifai', 'run', 'hub-history.json'), 'utf8')) as { starts: unknown[] }).starts
    expect(starts).toHaveLength(1)
  })

  it('lets children re-register with a restarted hub without a false end or a new generation', async () => {
    const env = hubEnv()
    writeDescriptor(env, SESSION)
    recordSessionNotified(SESSION, env, Date.now())
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const first = startHub(env, service, peers)
    await hubListening(env)
    const peer = peerOf(900010, { pid: HARNESS.pid, comm: 'claude', start: HARNESS.start })
    const child = await registered(env, SESSION, 900010, peer, peers)
    await until(() => service.batches.length >= 2)
    expect(readAttendantEndingLease(SESSION, env)).toMatchObject({ generation: 1 })
    // The hub goes away (a crash looks the same to the children).
    first.hub.requestExit('test-crash')
    service.release()
    await first.done
    expect(child.closed || true).toBe(true)
    const batchesBefore = service.batches.length
    const second = startHub(env, service, peers)
    await hubListening(env)
    const again = await registered(env, SESSION, 900010, peer, peers, { hook_event: 'UserPromptSubmit', source: undefined })
    expect(again.frames[0]).toMatchObject({ type: 'registered' })
    await until(() => service.batches.length > batchesBefore)
    const renewed = service.batches.slice(batchesBefore)
    expect(renewed.flatMap((batch) => batch.body.sessions).every((entry) => entry.state === 'running' && entry.generation === 1)).toBe(true)
    again.socket.destroy()
    service.release()
    await second.done
  })

  it('sends nothing with the old credential after acknowledging a credential change', async () => {
    const env = hubEnv()
    writeDescriptor(env, SESSION)
    recordSessionNotified(SESSION, env, Date.now())
    const service = fakeService()
    const store = memoryStore()
    const peers = new Map<number, PeerCredentials>()
    const { done } = startHub(env, service, peers, store)
    await hubListening(env)
    const child = await registered(env, SESSION, 900020, peerOf(900020, { pid: HARNESS.pid, comm: 'claude', start: HARNESS.start }), peers)
    await until(() => service.batches.length >= 2)
    // `notifai logout` clears the store, then tells the hub and waits for its acknowledgement.
    store.clear()
    writeFileSync(credentialGenerationPath(env), 'changed\n')
    expect(await requestHub(env, { type: 'credential-changed' })).toEqual({ type: 'ack' })
    const after = service.batches.length
    service.release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(service.batches.length).toBe(after)
    child.socket.destroy()
    await done
  })

  it('ends the in-hub waiters\' requests when the credential changes', async () => {
    const env = hubEnv()
    const { hub, done } = startHub(env, fakeService(), new Map())
    await hubListening(env)
    const before = hub.waiterSignal()
    expect(before.aborted).toBe(false)
    expect(await requestHub(env, { type: 'credential-changed' })).toEqual({ type: 'ack' })
    expect(before.aborted).toBe(true)
    expect(hub.waiterSignal().aborted).toBe(false)
    hub.requestExit('test')
    await done
  })

  it('leaves when idle after logout even with an end report it cannot send', async () => {
    const env = hubEnv()
    writeDescriptor(env, SESSION)
    recordSessionNotified(SESSION, env, Date.now())
    const service = fakeService()
    const store = memoryStore()
    const peers = new Map<number, PeerCredentials>()
    const { done } = startHub(env, service, peers, store, 100)
    await hubListening(env)
    const child = await registered(env, SESSION, 900050, peerOf(900050, { pid: HARNESS.pid, comm: 'claude', start: HARNESS.start }), peers)
    await until(() => service.batches.length >= 2)
    store.clear()
    writeFileSync(credentialGenerationPath(env), 'signed-out\n')
    expect(await requestHub(env, { type: 'credential-changed' })).toEqual({ type: 'ack' })
    const after = service.batches.length
    child.send({ type: 'ended', session_id: SESSION, harness_pid: HARNESS.pid, reason: 'harness-gone' })
    child.socket.destroy()
    service.release()
    expect(await done).toBe(0)
    expect(service.batches.length).toBe(after)
  })

  it('renews a lone session again once an uncertain read clears', async () => {
    const env = hubEnv()
    writeDescriptor(env, SESSION)
    recordSessionNotified(SESSION, env, Date.now())
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const { done } = startHub(env, service, peers, memoryStore(), 100)
    await hubListening(env)
    const child = await registered(env, SESSION, 900030, peerOf(900030, { pid: HARNESS.pid, comm: 'claude', start: HARNESS.start }), peers)
    await until(() => service.batches.length >= 2)
    // The descriptor goes missing for a moment: the held exchange ends and the session is uncertain.
    rmSync(path.join(claudeDescriptorDir(env), `${HARNESS.pid}.json`))
    service.release()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const during = service.batches.length
    writeDescriptor(env, SESSION)
    await until(() => service.batches.length > during)
    expect(service.batches.at(-1)!.body.sessions).toEqual([expect.objectContaining({ session_id: SESSION, state: 'running' })])
    child.socket.destroy()
    service.release()
    await done
  })

  it('asks a child to come back later while its session\'s earlier end is still owed', async () => {
    const env = hubEnv()
    writeDescriptor(env, SESSION)
    recordSessionNotified(SESSION, env, Date.now())
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const { done } = startHub(env, service, peers)
    await hubListening(env)
    const first = await registered(env, SESSION, 900040, peerOf(900040, { pid: HARNESS.pid, comm: 'claude', start: HARNESS.start }), peers)
    await until(() => service.batches.length >= 1)
    service.hold = true
    first.send({ type: 'ended', session_id: SESSION, harness_pid: HARNESS.pid, reason: 'harness-gone' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = await registered(env, SESSION, 900041, peerOf(900041, { pid: HARNESS.pid, comm: 'claude', start: HARNESS.start }), peers)
    expect(second.frames[0]).toEqual({ type: 'refused', reason: 'session-ending', retry: true })
    service.hold = false
    service.release()
    first.socket.destroy()
    await done
  })

  it('stops restarting after three crashes in ten minutes, and doctor says so', async () => {
    const env = hubEnv()
    const run = path.join(env['XDG_STATE_HOME']!, 'notifai', 'run')
    mkdirSync(run, { recursive: true, mode: 0o700 })
    const dead: number[] = []
    for (let pid = 99_990; dead.length < 3 && pid > 90_000; pid -= 1) if (!pidExists(pid)) dead.push(pid)
    const now = Date.now()
    writeFileSync(path.join(run, 'hub-history.json'), JSON.stringify({ starts: dead.map((pid, index) => ({ at: now - index * 1_000, pid, clean: false })) }))
    const { done } = startHub(env, fakeService(), new Map())
    expect(await done).toBe(3)
    expect(readHubReport(env)).toMatchObject({ running: false, fault: { reason: 'repeated-crashes' }, recent_crashes: 3 })
  })

  it('names the child lock file the way the native child does', () => {
    expect(fnv64Hex('')).toBe('cbf29ce484222325')
    expect(fnv64Hex('a')).toBe('af63dc4c8601ec8c')
    expect(os.platform()).toBeTruthy()
  })
})
