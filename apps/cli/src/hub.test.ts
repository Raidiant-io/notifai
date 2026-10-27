import type {
AttendanceBatchRequestT,
AttendanceBatchResponse,
AttendanceRequestT,
AttendanceResponse,
CompatibilityResponse,
} from '@raidiant/notifai-protocol'
import { spawn,type ChildProcess } from 'node:child_process'
import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import { createConnection,createServer,type Socket } from 'node:net'
import path from 'node:path'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { claudeDescriptorDir } from './claude-wake.js'
import { ApiCallError,type ApiClient } from './client.js'
import type { CodexWakeAdapters } from './codex-wake.js'
import type { CommandDeps } from './commands-core.js'
import { hookRunCommand } from './commands-hook-run.js'
import type { CredentialStore,MachineCredential } from './credentials.js'
import { beginSessionIncarnation,lifecycleStamp,markSessionEnded,readSessionEndMarker,readSessionIncarnation,readSessionState,recordSessionNotified,updateSessionState } from './hook-session-state.js'
import { ExchangeDriver,type AttendedSession,type ExchangeHost } from './hub-exchange.js'
import { credentialGenerationPath,encodeFrame,ensurePrivateDirectory,FrameDecoder,hubLockPath,hubSocketPath,requestHub } from './hub-ipc.js'
import { HUB_WRITE_MARGIN_MS,SessionLease } from './hub-lease.js'
import { Hub,type HubOptions,type PeerCredentials } from './hub.js'
import { recordClaudeSessionTitle } from './harness-session-title.js'
import { resolveSessionLabel } from './session-labels.js'
import { nullLogger } from './logging.js'
import { pidExists,processStartTime } from './process-identity.js'
import { attendantClaimPath,attendantStatusPath,readAttendantEndingLease,readAttendantLease,recordTurnEnd,recordTurnStart } from './session-attendant-state.js'
import { hasSessionInputs,stageSessionMessages } from './session-inputs.js'
import { runWakeCommand } from './wake-support.js'

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

  it('waits out another owner, and stops for good when the service withdraws a held generation', () => {
    const lease = new SessionLease('inc_aaaaaaaaaaaa', () => null)
    expect(lease.apply({ status: 'owned', retry_after_ms: 50 }, 0, 0, 0, null, false)).toEqual({ kind: 'owned', retryAfterMs: 1_000 })
    expect(lease.phase).toBe('waiting-for-lease')
    lease.apply(attending(2), 0, 0, 0, null, false)
    expect(lease.apply({ status: 'withdrawn' }, 0, 0, 0, null, false)).toEqual({ kind: 'withdrawn' })
    expect(lease.phase).toBe('withdrawn')
    expect(lease.generation).toBeNull()
  })

  it('reports an end from a held generation, and a withdrawal only from a held one', () => {
    const lease = new SessionLease('inc_aaaaaaaaaaaa', () => null)
    lease.final = 'withdrawn'
    expect(lease.finalEntry(SESSION)).toBeNull()
    lease.final = 'ended'
    expect(lease.finalEntry(SESSION)).toEqual({ session_id: SESSION, incarnation: 'inc_aaaaaaaaaaaa', state: 'ended' })
    expect(lease.finalEntry(SESSION, true)).not.toHaveProperty('end_reason')
    lease.confirmedEnd = true
    expect(lease.finalEntry(SESSION, true)).toHaveProperty('end_reason', 'closed')
    expect(lease.finalEntry(SESSION)).not.toHaveProperty('end_reason')

    lease.generation = 4
    expect(lease.finalEntry(SESSION)).toMatchObject({ generation: 4, state: 'ended' })
    expect(lease.apply({ status: 'withdrawn' }, 0, 0, 0, null, true)).toEqual({ kind: 'reported', state: 'ended', successor: null })
    expect(lease.final).toBeNull()
  })

  it('continues an ended session under its successor, and owes a plain end when the service refuses the successor', () => {
    const lease = new SessionLease('inc_aaaaaaaaaaaa', () => null)
    lease.generation = 2
    lease.final = 'ended'
    lease.successor = 'fork-session'
    expect(lease.finalEntry(SESSION)).toEqual({ session_id: SESSION, incarnation: 'inc_aaaaaaaaaaaa', generation: 2, state: 'ended',
      end_reason: 'continued', successor_session_id: 'fork-session' })
    expect(lease.apply({ status: 'unknown_successor' } as never, 0, 0, 0, null, true)).toEqual({ kind: 'successor-refused', successor: 'fork-session' })
    expect(lease.finalEntry(SESSION)).toEqual({ session_id: SESSION, incarnation: 'inc_aaaaaaaaaaaa', generation: 2, state: 'ended' })
    lease.successor = 'fork-session'
    expect(lease.apply({ status: 'withdrawn' }, 0, 0, 0, null, true)).toEqual({ kind: 'reported', state: 'ended', successor: 'fork-session' })
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
  upgrade?: (body: { session_id: string; label: string }) => Promise<unknown>
  /** True: this exchange never settles, abort or not (a wedged transport). */
  stall?: () => boolean
} = {}): FakeService {
  const batches: FakeService['batches'] = []
  const single: FakeService['single'] = []
  const held = new Set<() => void>()
  const hold = (waitSeconds: number, signal?: AbortSignal): Promise<void> => waitSeconds === 0 && !service.hold ? Promise.resolve() : new Promise((resolve, reject) => {
    // Like the service, a long-poll answers by its wait at the latest.
    const timer = waitSeconds > 0 ? setTimeout(() => done(), waitSeconds * 1_000) : undefined
    const done = (): void => { clearTimeout(timer); held.delete(done); resolve() }
    held.add(done)
    signal?.addEventListener('abort', () => { clearTimeout(timer); held.delete(done); reject(new Error('aborted')) }, { once: true })
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
      if (property === 'upgradeAgentSessionLabel' && options.upgrade !== undefined) return options.upgrade
      if (property === 'compatibility') {
        return async (): Promise<CompatibilityResponse> => ({ cli: {} as CompatibilityResponse['cli'], platforms: [],
          server_capabilities: (options.capabilities ?? ['session_attendance', 'session_attendance_batch']) as CompatibilityResponse['server_capabilities'] })
      }
      if (property === 'attendBatch') {
        return async (body: AttendanceBatchRequestT, { waitSeconds, signal }: { waitSeconds: number; signal?: AbortSignal }) => {
          batches.push({ body: structuredClone(body), waitSeconds })
          if (options.stall?.() === true) return new Promise(() => undefined)
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
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(5)
    else await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('hub exchange driver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
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

  it('stops authenticated work on 401 and sends a final end report once', async () => {
    const service = fakeService({ batch: () => new ApiCallError(401, 'unauthorized', 'revoked') })
    let client: ApiClient | null = service.client
    const host = driverHost(service, [new FakeSession(SESSION)], { client: () => client })
    host.unauthorized = () => { host.unauthorizedCount += 1; client = null }
    const driver = new ExchangeDriver(host)
    const running = driver.run()
    await until(() => host.unauthorizedCount === 1)
    const sent = service.batches.length
    await vi.advanceTimersByTimeAsync(50)
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

  const STOPPED_HOLD = ['session_attendance', 'session_attendance_batch', 'session_stopped_hold']
  const unique = (body: AttendanceBatchRequestT): boolean => new Set(body.sessions.map((entry) => entry.session_id)).size === body.sessions.length

  it('names each session once per batch: an owed end goes first, a later incarnation of it in the next exchange', async () => {
    const service = fakeService({ capabilities: STOPPED_HOLD, batch: (body) => unique(body)
      ? { message_cursor: 'c1', sessions: body.sessions.map((entry) => entry.state === 'stopped'
        ? { session_id: entry.session_id, status: 'stopped' as const, generation: entry.generation!, message_cursor: 'c1', messages: [] }
        : { session_id: entry.session_id, status: 'withdrawn' as const }) }
      : new ApiCallError(422, 'invalid_request', 'Each session_id may appear once per batch.') })
    // A swept end of one incarnation, and the same session adopted again as stopped.
    const ended = new FakeSession(SESSION)
    ended.ready = false
    ended.lease.generation = 1
    ended.lease.final = 'ended'
    const adopted = new FakeSession(SESSION)
    adopted.lease.incarnation = 'inc_adopted000001'
    adopted.lease.generation = 2
    adopted.lease.holdStopped = true
    const driver = new ExchangeDriver(driverHost(service, [ended, adopted]))
    const running = driver.run()
    await until(() => ended.outcomes.includes('reported') && adopted.outcomes.includes('stopped'))
    expect(service.batches.every(({ body }) => unique(body))).toBe(true)
    expect(service.batches[0]!.body.sessions).toEqual([{ session_id: SESSION, incarnation: ended.lease.incarnation, generation: 1, state: 'ended' }])
    expect(service.batches[1]!.body.sessions).toEqual([{ session_id: SESSION, incarnation: 'inc_adopted000001', generation: 2, state: 'stopped' }])
    driver.stop()
    service.release()
    await running
  })

  it('keeps attending after local bookkeeping fails inside an exchange (a full disk), instead of stopping for good', async () => {
    // The incident: a full disk made a file-lock mkdir fail inside the exchange.
    // The throw ended the loop while the process (and its claims) lived on.
    let refusals = 1
    const service = fakeService({ batch: (body) => ({ message_cursor: 'c1', sessions: body.sessions.map((entry) => refusals-- > 0
      ? { session_id: entry.session_id, status: 'withdrawn' as const }
      : { session_id: entry.session_id, status: 'attending' as const, generation: entry.generation ?? 1, lease_remaining_ms: 120_000,
        message_cursor: 'c1', messages: [] }) }) })
    const full = Object.assign(new Error("ENOSPC: no space left on device, mkdir 'session.json.lock'"), { code: 'ENOSPC' })
    let rotations = 0
    const session = new FakeSession(SESSION)
    const other = new FakeSession(OTHER)
    ;(session as { lease: SessionLease }).lease = new SessionLease('inc_aaaaaaaaaaaa', () => { rotations += 1; if (rotations === 1) throw full; return null })
    const driver = new ExchangeDriver(driverHost(service, [session, other]))
    let failed: unknown = null
    const running = driver.run().catch((err: unknown) => { failed = err })
    await until(() => rotations >= 1)
    await until(() => other.lease.phase === 'attending' && service.batches.length >= 3)
    expect(failed).toBeNull()
    expect(driver.stopped).toBe(false)
    driver.stop()
    service.release()
    await running
  })

  it('never resends a refused body: sets the refused entry aside, attends the rest, and backs off across rediscovery', async () => {
    const THIRD = '33333333-4444-5555-6666-777777777777'
    const service = fakeService({ capabilities: STOPPED_HOLD, batch: (body) => body.sessions.some((entry) => entry.session_id !== SESSION)
      ? new ApiCallError(422, 'invalid_request', 'Refused.')
      : { message_cursor: 'c1', sessions: body.sessions.map((entry) => ({ session_id: entry.session_id, status: 'attending' as const,
        generation: entry.generation ?? 1, lease_remaining_ms: 120_000, message_cursor: 'c1', messages: [] })) } })
    const good = new FakeSession(SESSION)
    const bad = [new FakeSession(OTHER), new FakeSession(THIRD)]
    for (const session of bad) {
      session.lease.generation = 2
      session.lease.holdStopped = true
    }
    const pauses: number[] = []
    const host = driverHost(service, [good, ...bad])
    const sleep = host.sleep
    host.sleep = (ms, signal) => { pauses.push(ms); return sleep(ms, signal) }
    const driver = new ExchangeDriver(host)
    const running = driver.run()
    await until(() => good.lease.phase === 'attending')
    // Well past every backoff, well inside the time a refused entry sits out.
    await vi.advanceTimersByTimeAsync(60_000)
    // The whole batch once, then each entry alone once: never the same body twice.
    expect(service.batches.slice(0, 4).map(({ body }) => body.sessions.map((entry) => entry.session_id)))
      .toEqual([[SESSION, OTHER, THIRD], [SESSION], [OTHER], [THIRD]])
    expect(service.batches.slice(4).every(({ body }) => body.sessions.every((entry) => entry.session_id === SESSION))).toBe(true)
    // Only a successful exchange resets the backoff; rediscovery after each refusal does not.
    expect(pauses).toEqual([1_000, 1_000, 2_000])
    driver.stop()
    service.release()
    await running
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

function startHub(env: NodeJS.ProcessEnv, service: FakeService, peers: Map<number, PeerCredentials>, store = memoryStore(), safetyTickMs?: number,
  codex: Partial<Pick<HubOptions, 'endConfirmMs' | 'codexHostKind' | 'codexHostHoldsThread'>> & { wake?: CodexWakeAdapters } = {},
  extra: Partial<HubOptions> = {}): { hub: Hub; done: Promise<number> } {
  const deps: CommandDeps = {
    io: { out: () => undefined, err: () => undefined, confirm: async () => false, openUrl: () => undefined },
    store, env, cwd: '/tmp', logger: nullLogger(), clientFactory: () => service.client,
    ...(codex.wake === undefined ? {} : { codexWake: codex.wake, codexQueueControl: async () => null }),
  }
  const hub = new Hub(deps, { deps, verifyPeer: async (socket) => {
    // The fake child's pid is whatever it said in hello; tests map it to a peer.
    void socket
    return peers.get(lastHelloPid) ?? null
  }, idleExitMs: 400, bootIdentity: () => 'test-boot', ...(safetyTickMs === undefined ? {} : { safetyTickMs }),
  // A short end confirmation unless a test says otherwise; no thread is held by default.
  endConfirmMs: codex.endConfirmMs ?? 50, codexHostHoldsThread: codex.codexHostHoldsThread ?? (() => false),
  ...(codex.codexHostKind === undefined ? {} : { codexHostKind: codex.codexHostKind }), ...extra })
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
  it('upgrades a registered fallback when a host title appears without another send', async () => {
    const env = hubEnv()
    writeDescriptor(env, SESSION)
    expect(resolveSessionLabel({ env, sessionId: SESSION, harness: 'claude-code' })).toMatchObject({ source: 'fallback' })
    recordSessionNotified(SESSION, env, Date.now())
    const upgrades: { session_id: string; label: string }[] = []
    const service = fakeService({ upgrade: async (body) => {
      upgrades.push(body)
      return { ...body, renamed_by: 'agent', updated_at: new Date().toISOString() }
    } })
    const peers = new Map<number, PeerCredentials>()
    const { hub, done } = startHub(env, service, peers, memoryStore(), 200)
    await hubListening(env)
    const child = await registered(env, SESSION, 900499, peerOf(900499, { pid: HARNESS.pid, comm: 'claude', start: HARNESS.start }), peers)
    try {
      await until(() => service.batches.length > 0)
      recordClaudeSessionTitle(SESSION, env, 'Repair the parser')
      await until(() => upgrades.length === 1)
      expect(upgrades).toEqual([{ session_id: SESSION, label: 'Repair the parser' }])
      expect(resolveSessionLabel({ env, sessionId: SESSION })).toMatchObject({ source: 'harness', previousSource: 'fallback' })
    } finally {
      child.socket.destroy()
      hub.requestExit('test')
      service.release()
      await done
    }
  })

  it('runs each session with its own PATH and desktop, never another session\'s', async () => {
    const env = { ...hubEnv(), PATH: '/hub/bin:/usr/bin:/bin', DISPLAY: ':9', WAYLAND_DISPLAY: 'wayland-9' }
    writeDescriptor(env, SESSION)
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const { hub, done } = startHub(env, service, peers)
    await hubListening(env)
    const peer = peerOf(900401, { pid: HARNESS.pid, comm: 'claude', start: HARNESS.start })
    const child = await registered(env, SESSION, 900401, peer, peers,
      { path: '/session/bin:/usr/bin', display: ':1', xauthority: '/run/user/1000/xauth' })
    expect(child.frames[0]).toEqual({ type: 'registered', session_id: SESSION })
    // The hub's own desktop (here, whichever process started it) is no session's.
    const own = hub.sessions.get(SESSION)!.env
    expect([own['PATH'], own['DISPLAY'], own['WAYLAND_DISPLAY'], own['XAUTHORITY']]).toEqual(['/session/bin:/usr/bin', ':1', undefined, '/run/user/1000/xauth'])
    // The next hub takes it over with the same environment.
    await until(() => {
      try { return (JSON.parse(readFileSync(attendantStatusPath(SESSION, env), 'utf8')) as { adoption?: unknown }).adoption !== undefined } catch { return false }
    })
    expect((JSON.parse(readFileSync(attendantStatusPath(SESSION, env), 'utf8')) as { adoption: Record<string, unknown> }).adoption)
      .toMatchObject({ session_path: '/session/bin:/usr/bin', display: { DISPLAY: ':1', XAUTHORITY: '/run/user/1000/xauth' } })
    child.socket.destroy()
    hub.requestExit('test')
    service.release()
    await done
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

  it('reports a swept end before the same conversation, resumed, is attended again: never one id twice in a batch', async () => {
    const env = hubEnv()
    writeDescriptor(env, SESSION)
    recordSessionNotified(SESSION, env, Date.now())
    let up = true
    const service = fakeService({ batch: (body) => {
      if (!up) return new Error('offline')
      // The service refuses a batch that names one session twice.
      if (new Set(body.sessions.map((entry) => entry.session_id)).size !== body.sessions.length) {
        return new ApiCallError(422, 'invalid_request', 'Each session_id may appear once per batch.')
      }
      return { message_cursor: 'c1', sessions: body.sessions.map((entry) => entry.state === 'running'
        ? { session_id: entry.session_id, status: 'attending' as const, generation: entry.generation ?? 1, lease_remaining_ms: 120_000, message_cursor: 'c1', messages: [] }
        : { session_id: entry.session_id, status: 'withdrawn' as const }) }
    } })
    const peers = new Map<number, PeerCredentials>()
    const first = startHub(env, service, peers)
    await hubListening(env)
    const peer = (pid: number) => peerOf(pid, { pid: HARNESS.pid, comm: 'claude', start: HARNESS.start })
    const child = await registered(env, SESSION, 900011, peer(900011), peers)
    await until(() => service.batches.length >= 2)
    expect(readAttendantEndingLease(SESSION, env)).toMatchObject({ generation: 1 })
    // The hub and the child go away together; the conversation is closed while no hub runs.
    first.hub.requestExit('test-crash')
    service.release()
    await first.done
    child.socket.destroy()
    rmSync(attendantClaimPath(SESSION, env), { force: true })
    markSessionEnded(SESSION, env, Date.now())
    // The User resumes it: its child starts a hub, whose start sweep owes the old end.
    up = false
    const batchesBefore = service.batches.length
    // Long enough an idle exit that the resumed child finds this hub again.
    const second = startHub(env, service, peers, memoryStore(), undefined, {}, { idleExitMs: 10_000 })
    await hubListening(env)
    const resumed = await registered(env, SESSION, 900012, peer(900012), peers, { source: 'resume' })
    up = true
    const sent = (): AttendanceBatchRequestT[] => service.batches.slice(batchesBefore).map((batch) => batch.body)
    const reportedEnd = (): boolean => sent().some((body) => body.sessions.length === 1 && body.sessions[0]!.state === 'ended')
    const duplicate = (): boolean => sent().some((body) => new Set(body.sessions.map((entry) => entry.session_id)).size !== body.sessions.length)
    await until(() => reportedEnd() || duplicate(), 10_000)
    expect(duplicate()).toBe(false)
    // The resumed child waited for the old end; it comes back and is attended.
    expect(resumed.frames[0]).toEqual({ type: 'refused', reason: 'session-ending', retry: true })
    await until(() => second.hub.status()['pending_end_reports'] === 0)
    const again = await registered(env, SESSION, 900013, peer(900013), peers, { source: 'resume' })
    expect(again.frames[0]).toMatchObject({ type: 'registered' })
    await until(() => sent().some((body) => body.sessions.some((entry) => entry.state === 'running')))
    expect(duplicate()).toBe(false)
    again.socket.destroy()
    second.hub.requestExit('test')
    service.release()
    await second.done
  }, 20_000)

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

  it('hands over to another active build at once, even while a question waits, keeping every lease and the question', async () => {
    const env = hubEnv()
    writeDescriptor(env, SESSION)
    recordSessionNotified(SESSION, env, Date.now())
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const running = 'a'.repeat(64), incompatible = 'b'.repeat(64), next = 'c'.repeat(64)
    let active = running
    const planned: string[] = []
    const owners: string[] = []
    const runHook = async (event: string, envelope: Record<string, unknown> | null): Promise<number> => {
      if (event === 'question-settlement') owners.push(String(envelope?.['session_id']))
      return 0
    }
    let successor: { hub: Hub; done: Promise<number> } | null = null
    const first = startHub(env, service, peers, memoryStore(), undefined, {}, { runHook, handover: {
      builds: () => ({ running, active }),
      plan: async (build) => {
        planned.push(build)
        return { schema: 1, version: '1.1.0', hub_ipc_versions: build === incompatible ? { min: 2, max: 2 } : { min: 1, max: 1 }, hook_changes: [] }
      },
      startSuccessor: () => { successor = startHub(env, service, peers, memoryStore(), undefined, {}, { runHook }) },
    } })
    await hubListening(env)
    const peer = (pid: number) => peerOf(pid, { pid: HARNESS.pid, comm: 'claude', start: HARNESS.start })
    const child = await registered(env, SESSION, 900040, peer(900040), peers)
    expect(child.frames[0]).toMatchObject({ type: 'registered' })
    await until(() => readAttendantEndingLease(SESSION, env)?.generation === 1)
    // Its own build is active: nothing to do.
    expect(await first.hub.checkBuildHandover()).toBeNull()
    expect(first.hub.status()).toMatchObject({ handover: null })

    // An active build whose hub could not serve this child: it stays, and says why.
    active = incompatible
    expect(await first.hub.checkBuildHandover()).toEqual(['session-child-incompatible'])
    expect(first.hub.status()).toMatchObject({ seamless_handover: true, handover: { active_build: incompatible, waiting_for: ['session-child-incompatible'] } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(child.closed).toBe(false)

    // Another build became active (a manual update) while a question waits: it leaves at once,
    // keeping the lease and the question, and the next hub continues both.
    active = next
    const question = { question: 'Deploy?', summary: 'Deploy?', request_id: 'req_wait' }
    updateSessionState(SESSION, env, (state) => ({ ...state, pending: [question as never] }))
    expect(await first.hub.checkBuildHandover()).toEqual([])
    service.release()
    expect(await first.done).toBe(0)
    expect(readSessionState(SESSION, env).pending).toEqual([question])
    await until(() => child.closed)
    await until(() => successor !== null)
    await hubListening(env)
    const handedOver = service.batches.length
    const again = await registered(env, SESSION, 900041, peer(900041), peers, { hook_event: 'UserPromptSubmit', source: undefined })
    expect(again.frames[0]).toMatchObject({ type: 'registered' })
    await until(() => service.batches.slice(handedOver).some((batch) => batch.body.sessions.some((entry) => entry.session_id === SESSION)))
    const entries = service.batches.flatMap((batch) => batch.body.sessions)
    expect(entries.every((entry) => entry.state === 'running')).toBe(true)
    const after = service.batches.slice(handedOver).flatMap((batch) => batch.body.sessions)
    expect(after.every((entry) => entry.generation === 1)).toBe(true)
    expect(readSessionEndMarker(SESSION, env)).toBeNull()
    expect(planned).toEqual([incompatible, next])
    // Its child re-registered with the question still waiting: the next hub runs its answer owner.
    expect(owners).toContain(SESSION)
    again.socket.destroy()
    service.release()
    await (successor as { done: Promise<number> } | null)!.done
  })
})

// ---------------------------------------------------------------------------
// SessionEnd is not final: the end confirmation, handoffs and writer sets
// ---------------------------------------------------------------------------

describe('hub end confirmation and writers', () => {
  interface StandIn { pid: number; start: string; process: ChildProcess }
  const standIns: ChildProcess[] = []
  afterEach(() => { for (const proc of standIns.splice(0)) proc.kill('SIGKILL') })

  /** A real process standing in for one Claude Code or Codex process. */
  async function standIn(): Promise<StandIn> {
    const proc = spawn('sleep', ['60'], { stdio: 'ignore' })
    standIns.push(proc)
    await until(() => processStartTime(proc.pid!) !== null)
    return { pid: proc.pid!, start: processStartTime(proc.pid!)!, process: proc }
  }

  function describeHost(env: NodeJS.ProcessEnv, host: StandIn, sessionId = SESSION): void {
    writeFileSync(path.join(claudeDescriptorDir(env), `${host.pid}.json`), JSON.stringify({
      pid: host.pid, sessionId, cwd: '/tmp', startedAt: Date.now(), procStart: host.start, version: '2.1.304', peerProtocol: 1,
      messagingSocketPath: `/tmp/b3hub-${host.pid}.sock`, status: 'idle',
    }))
  }

  /** A child of `host` that answers every write the hub asks of it. */
  async function writerChild(env: NodeJS.ProcessEnv, peers: Map<number, PeerCredentials>, childPid: number, host: StandIn,
    overrides: Record<string, unknown> = {}): Promise<FakeChild & { writes: number }> {
    const child = await registered(env, SESSION, childPid, peerOf(childPid, { pid: host.pid, comm: 'claude', start: host.start }), peers,
      { harness_pid: host.pid, harness_start: host.start, stamp_wall: Date.now(), ...overrides }) as FakeChild & { writes: number }
    child.writes = 0
    const answered = new Set<unknown>()
    child.socket.on('data', () => {
      for (const frame of child.frames) {
        if (frame['type'] !== 'write' || answered.has(frame['id'])) continue
        answered.add(frame['id'])
        child.writes += 1
        child.send({ type: 'written', id: frame['id'], result: 'ok' })
      }
    })
    return child
  }

  /** A service that hands one Session Note to the session once asked to. */
  function noteService(): FakeService & { note(): void } {
    let pending = false
    let sent = false
    const service = fakeService({
      batch: (body) => ({
        message_cursor: sent ? 'c2' : 'c1',
        sessions: body.sessions.map((entry) => {
          if (entry.state !== 'running') return { session_id: entry.session_id, status: 'withdrawn' as const }
          const messages = pending && entry.accepts_messages ? [{ message_id: 'sm_r1', kind: 'note' as const, body: 'Later',
            created_at: new Date().toISOString(), agent_acknowledgement_text_required: false }] : []
          if (messages.length > 0) { pending = false; sent = true }
          return { session_id: entry.session_id, status: 'attending' as const, generation: entry.generation ?? 1, lease_remaining_ms: 120_000,
            message_cursor: sent ? 'c2' : 'c1', messages }
        }),
      }),
    })
    return Object.assign(service, { note: () => { pending = true; service.release() } })
  }

  const ended = (service: FakeService): boolean => service.batches.some((batch) => batch.body.sessions.some((entry) => entry.state === 'ended'))
  const question = (env: NodeJS.ProcessEnv): void => updateSessionState(SESSION, env, (state) => ({ ...state,
    pending: [{ question: 'Deploy?', summary: 'Deploy?', request_id: 'req_r1', collapse_key: 'ck_r1', device_ids: ['dev_r1'] } as never] }))
  const sessionEnd = (harnessPid: number): Promise<Record<string, unknown> | null> =>
    requestHub(env0!, { type: 'session-end-candidate', session_id: SESSION, harness_pid: harnessPid })
  let env0: NodeJS.ProcessEnv | null = null

  it('preserves a crashed conversation and its question after the end confirmation', async () => {
    const env = env0 = hubEnv()
    recordSessionNotified(SESSION, env, Date.now())
    const host = await standIn()
    describeHost(env, host)
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const { hub, done } = startHub(env, service, peers, memoryStore(), 100, { endConfirmMs: 600 })
    await hubListening(env)
    const child = await writerChild(env, peers, 900200, host)
    expect(child.frames[0]).toMatchObject({ type: 'registered' })
    await until(() => service.batches.length >= 1)
    question(env)
    // `/exit`: SessionEnd, then the process goes.
    expect(await sessionEnd(host.pid)).toEqual({ type: 'ok', held: true })
    host.process.kill('SIGKILL')
    child.send({ type: 'ended', session_id: SESSION, harness_pid: host.pid, reason: 'harness-gone' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    service.release()
    expect(ended(service)).toBe(false)
    expect(readSessionEndMarker(SESSION, env)).toBeNull()
    expect(readSessionState(SESSION, env).pending).toHaveLength(1)
    await until(() => hub.sessions.get(SESSION)?.stopped != null, 5_000)
    expect(ended(service)).toBe(false)
    expect(readSessionEndMarker(SESSION, env)).toBeNull()
    expect(readSessionState(SESSION, env).pending).toHaveLength(1)
    child.socket.destroy()
    hub.requestExit('test')
    service.release()
    await done
  })

  it('recovers a wedged exchange and re-adopts the conversation a new process continues: its end reported first, one owner per id', async () => {
    const env = env0 = hubEnv()
    recordSessionNotified(SESSION, env, Date.now())
    const first = await standIn()
    describeHost(env, first)
    // One exchange never settles and ignores its abort: the transport the incident's hub was stuck on.
    let wedge = false
    const service = fakeService({ stall: () => { if (!wedge) return false; wedge = false; return true } })
    const peers = new Map<number, PeerCredentials>()
    const { hub, done } = startHub(env, service, peers, memoryStore(), 100, {}, { watchdogTickMs: 50, exchangeStallMs: 1_500 })
    await hubListening(env)
    const a = await writerChild(env, peers, 900230, first)
    await until(() => service.batches.length >= 2)
    wedge = true
    service.release()
    await until(() => !wedge)
    const wedgedAt = service.batches.length
    // The conversation ends while the exchange is wedged: its end is owed and cannot go.
    await requestHub(env, { type: 'session-end', session_id: SESSION })
    await until(() => hub.sessions.get(SESSION)?.ending != null)
    first.process.kill('SIGKILL')
    a.socket.destroy()
    // The User continues it in a new process: same id, its first registration waits for that end.
    const second = await standIn()
    describeHost(env, second)
    const peer = peerOf(900231, { pid: second.pid, comm: 'claude', start: second.start })
    const register = (): Promise<FakeChild> => registered(env, SESSION, 900231, peer, peers,
      { harness_pid: second.pid, harness_start: second.start, stamp_wall: Date.now(), source: 'resume' })
    let child = await register()
    expect(child.frames[0]).toEqual({ type: 'refused', reason: 'session-ending', retry: true })
    expect(service.batches.length).toBe(wedgedAt)
    // The watchdog restarts the loop; the child, as a real one does, comes back after a passing refusal.
    const deadline = Date.now() + 8_000
    while (child.frames[0]?.['type'] !== 'registered') {
      expect(child.frames[0]).toEqual({ type: 'refused', reason: 'session-ending', retry: true })
      if (Date.now() > deadline) throw new Error('the conversation was never adopted again')
      child.socket.destroy()
      await new Promise((resolve) => setTimeout(resolve, 100))
      child = await register()
    }
    await until(() => service.batches.slice(wedgedAt).some(({ body }) => body.sessions.some((entry) => entry.state === 'running')))
    const after = service.batches.slice(wedgedAt).map(({ body }) => body.sessions.filter((entry) => entry.session_id === SESSION))
    expect(after.every((entries) => entries.length <= 1)).toBe(true)
    const endAt = after.findIndex((entries) => entries[0]?.state === 'ended')
    const runAt = after.findIndex((entries) => entries[0]?.state === 'running')
    expect(endAt).toBeGreaterThanOrEqual(0)
    expect(runAt).toBeGreaterThan(endAt)
    expect(after[runAt]![0]!.incarnation).not.toBe(after[endAt]![0]!.incarnation)
    expect(hub.sessions.get(SESSION)?.harnessProcess.pid).toBe(second.pid)
    child.socket.destroy()
    hub.requestExit('test')
    service.release()
    await done
  })

  it('serves two places at once: a note reaches only the most recently opened, the other takes over when it closes, and a standby leaving changes nothing', async () => {
    const env = env0 = hubEnv()
    recordSessionNotified(SESSION, env, Date.now())
    const older = await standIn()
    const newer = await standIn()
    describeHost(env, older)
    describeHost(env, newer)
    const service = noteService()
    const peers = new Map<number, PeerCredentials>()
    const { hub, done } = startHub(env, service, peers, memoryStore(), 100, { endConfirmMs: 400 })
    await hubListening(env)
    const a = await writerChild(env, peers, 900220, older, { stamp_wall: Date.now() - 1_000 })
    await until(() => service.batches.length >= 1)
    const b = await writerChild(env, peers, 900221, newer, { stamp_wall: Date.now() })
    // Neither is refused: the second is a writer too, and the most recently opened is primary.
    expect(b.frames[0]).toEqual({ type: 'registered', session_id: SESSION })
    expect(hub.sessions.get(SESSION)?.harnessProcess.pid).toBe(newer.pid)
    expect(hub.sessions.get(SESSION)?.standbys.map((writer) => writer.harnessProcess.pid)).toEqual([older.pid])
    expect(readSessionIncarnation(SESSION, env)?.harness_process?.pid).toBe(newer.pid)
    service.note()
    await until(() => b.writes === 1)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(a.writes).toBe(0)
    expect(b.writes).toBe(1)

    // The older place runs `/exit`: only it leaves.
    expect(await sessionEnd(older.pid)).toEqual({ type: 'ok', held: true })
    await until(() => a.frames.some((frame) => frame['type'] === 'bye'))
    expect(hub.sessions.get(SESSION)?.standbys).toEqual([])
    expect(hub.sessions.get(SESSION)?.endCandidate).toBeNull()

    // A third place opens it, then the primary closes: the next takes over with no end.
    const third = await standIn()
    describeHost(env, third)
    const c = await writerChild(env, peers, 900222, third, { stamp_wall: Date.now() - 5_000 })
    expect(hub.sessions.get(SESSION)?.harnessProcess.pid).toBe(newer.pid)
    newer.process.kill('SIGKILL')
    b.send({ type: 'ended', session_id: SESSION, harness_pid: newer.pid, reason: 'harness-gone' })
    await until(() => hub.sessions.get(SESSION)?.harnessProcess.pid === third.pid)
    expect(readSessionIncarnation(SESSION, env)?.harness_process?.pid).toBe(third.pid)
    await new Promise((resolve) => setTimeout(resolve, 700))
    service.release()
    expect(ended(service)).toBe(false)
    // The last place closes: ended after the confirmation.
    third.process.kill('SIGKILL')
    c.send({ type: 'ended', session_id: SESSION, harness_pid: third.pid, reason: 'harness-gone' })
    service.release()
    await until(() => ended(service), 5_000)
    for (const child of [a, b, c]) child.socket.destroy()
    service.release()
    await done
  })
})

// ---------------------------------------------------------------------------
// Codex SessionEnd: closed, or an app conversation Codex only unloaded
// ---------------------------------------------------------------------------

describe('hub and Codex SessionEnd', () => {
  function codexRollout(env: NodeJS.ProcessEnv, originator: string): string {
    const directory = path.join(env['XDG_STATE_HOME']!, '..', 'codex', 'sessions')
    mkdirSync(directory, { recursive: true })
    const file = path.join(directory, `rollout-${SESSION}.jsonl`)
    writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: SESSION, originator, source: 'vscode' } })}\n`)
    return file
  }


  /** A codex host for this test: this process, or a real child process the test can stop. */
  async function codexSession(env: NodeJS.ProcessEnv, service: FakeService, peers: Map<number, PeerCredentials>, childPid: number,
    transcript: string, host = HARNESS): Promise<FakeChild> {
    const child = await registered(env, SESSION, childPid, peerOf(childPid, { pid: host.pid, comm: 'codex', start: host.start }), peers,
      { harness: 'codex', harness_pid: host.pid, harness_start: host.start, transcript_path: transcript, codex_home: path.dirname(path.dirname(transcript)),
        claude_config_dir: undefined, inbox_token: undefined })
    expect(child.frames[0]).toEqual({ type: 'registered', session_id: SESSION })
    // One finished turn: the thread is idle and attended.
    const key = readSessionIncarnation(SESSION, env)!.key
    recordTurnStart(SESSION, env, key, 'turn-1')
    recordTurnEnd(SESSION, env, 'turn-1')
    await requestHub(env, { type: 'hint', session_id: SESSION }, { role: 'hint' })
    await until(() => service.batches.some((batch) => batch.body.sessions.some((entry) => entry.session_id === SESSION && entry.state === 'running')))
    return child
  }

  const status = (env: NodeJS.ProcessEnv): Record<string, unknown> => JSON.parse(readFileSync(attendantStatusPath(SESSION, env), 'utf8')) as Record<string, unknown>
  const reportedEnd = (service: FakeService): boolean => service.batches.some((batch) => batch.body.sessions.some((entry) => entry.state === 'ended'))
  const noWake: CodexWakeAdapters = { available: () => true, queue: async () => { throw new Error('no wake expected') } }
  const question = (env: NodeJS.ProcessEnv, sessionId = SESSION): void => updateSessionState(sessionId, env, (state) => ({ ...state,
    pending: [{ question: 'Deploy?', summary: 'Deploy?', request_id: `req_${sessionId.slice(0, 4)}` } as never] }))
  const stopped = (hub: Hub, sessionId = SESSION): boolean => (hub.sessions.get(sessionId)?.stopped ?? null) !== null

  it('keeps an unloaded Codex app conversation open, sends no renewals, and attends it again when it is opened', async () => {
    const env = hubEnv()
    recordSessionNotified(SESSION, env, Date.now())
    const transcript = codexRollout(env, 'Codex Desktop')
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const { hub, done } = startHub(env, service, peers, memoryStore(), 100, { endConfirmMs: 50, codexHostKind: () => 'app-server', wake: noWake })
    await hubListening(env)
    const child = await codexSession(env, service, peers, 900060, transcript)
    question(env)

    // Codex unloads it: SessionEnd asks the hub, then Codex stops the child.
    expect(await requestHub(env, { type: 'session-end-candidate', session_id: SESSION, transcript_path: transcript })).toEqual({ type: 'ok', held: true })
    child.socket.destroy()
    await until(() => status(env)['reason'] === 'stopped')
    expect(hub.sessions.get(SESSION)?.stopped).toMatchObject({ cause: 'app', watch: 'harness' })
    // Its question still waits, so the hub stays to watch the app.
    await new Promise((resolve) => setTimeout(resolve, 600))
    service.release()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const during = service.batches.length
    service.release()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(service.batches.slice(during).flatMap((batch) => batch.body.sessions).filter((entry) => entry.session_id === SESSION)).toEqual([])
    expect(reportedEnd(service)).toBe(false)
    expect(readSessionEndMarker(SESSION, env)).toBeNull()

    // The User opens it: Codex starts the session again in the same app server.
    const reopened = await registered(env, SESSION, 900061, peerOf(900061, { pid: HARNESS.pid, comm: 'codex', start: HARNESS.start }), peers,
      { harness: 'codex', transcript_path: transcript, claude_config_dir: undefined, inbox_token: undefined, source: 'resume' })
    expect(reopened.frames[0]).toEqual({ type: 'registered', session_id: SESSION })
    const before = service.batches.length
    service.release()
    await until(() => service.batches.slice(before).some((batch) => batch.body.sessions.some((entry) => entry.session_id === SESSION && entry.state === 'running' && entry.generation === 1)))
    expect(reportedEnd(service)).toBe(false)
    reopened.socket.destroy()
    hub.requestExit('test')
    service.release()
    await done
  })

  it('cancels the end when the conversation starts again inside the delay', async () => {
    const env = hubEnv()
    recordSessionNotified(SESSION, env, Date.now())
    const transcript = codexRollout(env, 'codex-tui')
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const { hub, done } = startHub(env, service, peers, memoryStore(), 100, { endConfirmMs: 300, codexHostKind: () => 'other', wake: noWake })
    await hubListening(env)
    const child = await codexSession(env, service, peers, 900080, transcript)
    await requestHub(env, { type: 'session-end-candidate', session_id: SESSION, transcript_path: transcript })
    child.socket.destroy()
    const again = await registered(env, SESSION, 900081, peerOf(900081, { pid: HARNESS.pid, comm: 'codex', start: HARNESS.start }), peers,
      { harness: 'codex', transcript_path: transcript, claude_config_dir: undefined, inbox_token: undefined, source: 'resume' })
    expect(again.frames[0]).toMatchObject({ type: 'registered' })
    await new Promise((resolve) => setTimeout(resolve, 500))
    service.release()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(reportedEnd(service)).toBe(false)
    expect(readSessionEndMarker(SESSION, env)).toBeNull()
    again.socket.destroy()
    hub.requestExit('test')
    service.release()
    await done
  })

  it('adopts a stopped conversation after a restart: still open, its answer owner running, its answer queued, preserved when the app disappears', async () => {
    const env = hubEnv()
    recordSessionNotified(SESSION, env, Date.now())
    const transcript = codexRollout(env, 'Codex Desktop')
    const app = spawn('sleep', ['60'], { stdio: 'ignore' })
    await until(() => processStartTime(app.pid!) !== null)
    const host = { pid: app.pid!, start: processStartTime(app.pid!)! }
    const queued: string[] = []
    const wake: CodexWakeAdapters = { available: () => true, queue: async (threadId) => { queued.push(threadId) } }
    const owners: string[] = []
    const runHook = async (event: string, envelope: Record<string, unknown> | null): Promise<number> => {
      if (event === 'question-settlement') owners.push(String(envelope?.['session_id']))
      return 0
    }
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const options = { endConfirmMs: 50, codexHostKind: () => 'app-server' as const, wake }
    const first = startHub(env, service, peers, memoryStore(), 100, options, { runHook })
    let second: { hub: Hub; done: Promise<number> } | null = null
    try {
      await hubListening(env)
      const child = await codexSession(env, service, peers, 900140, transcript, host)
      question(env)
      await requestHub(env, { type: 'session-end-candidate', session_id: SESSION, transcript_path: transcript })
      child.socket.destroy()
      await until(() => status(env)['reason'] === 'stopped')
      // What the next hub needs is on disk.
      expect(status(env)['adoption']).toMatchObject({ harness: 'codex', transcript_path: transcript, transcript_seen: true,
        harness_process: host, place: 'codex-app', stopped: { cause: 'app', watch: 'harness' } })
      // The hub goes away without handing anything over (a crash looks the same).
      first.hub.requestExit('test-crash')
      service.release()
      await first.done

      const before = service.batches.length
      second = startHub(env, service, peers, memoryStore(), 100, options, { runHook })
      await until(() => stopped(second!.hub))
      await until(() => owners.includes(SESSION))
      expect(status(env)).toMatchObject({ phase: 'exited', reason: 'stopped', generation: 1 })
      for (let i = 0; i < 3; i += 1) { service.release(); await new Promise((resolve) => setTimeout(resolve, 100)) }
      // Still open: no renewal, no end.
      expect(service.batches.slice(before).flatMap((batch) => batch.body.sessions).filter((entry) => entry.session_id === SESSION)).toEqual([])
      expect(readSessionEndMarker(SESSION, env)).toBeNull()
      // An answer staged for it waits in the conversation as one queued wake.
      const incarnation = readSessionIncarnation(SESSION, env)!.incarnation
      stageSessionMessages(SESSION, env, { incarnation, generation: 1 }, [{ message_id: 'sm_adopted', kind: 'note', body: 'Later',
        created_at: new Date().toISOString(), agent_acknowledgement_text_required: true }])
      second.hub.inputStaged(SESSION)
      await until(() => queued.length === 1)
      // Quitting the app ends it and its questions expire.
      app.kill('SIGKILL')
      service.release()
      await new Promise(resolve => setTimeout(resolve, 350))
      expect(reportedEnd(service)).toBe(false)
      expect(readSessionEndMarker(SESSION, env)).toBeNull()
    } finally {
      app.kill('SIGKILL')
      second?.hub.requestExit('test')
      service.release()
      await second?.done
    }
  })

  describe('a Codex thread whose hooks never ran (not approved in its CODEX_HOME), that sends', () => {
    const running = (service: FakeService, from = 0) => service.batches.slice(from).flatMap((batch) => batch.body.sessions)
      .filter((entry) => entry.session_id === SESSION && entry.state === 'running')
    /** A later send from the thread itself: the marker already exists, as it does for a thread that sent before. */
    const send = (env: NodeJS.ProcessEnv, codexHome: string): void =>
      recordSessionNotified(SESSION, env, Date.now(), { codexHome, cwd: '/tmp', originatorOverride: 'T3 Code' })

    async function server(): Promise<{ app: ChildProcess; host: { pid: number; start: string } }> {
      const app = spawn('sleep', ['60'], { stdio: 'ignore' })
      await until(() => processStartTime(app.pid!) !== null)
      return { app, host: { pid: app.pid!, start: processStartTime(app.pid!)! } }
    }

    it('is attended without a child while a Codex process holds the thread, so the apps show it running', async () => {
      const env = hubEnv()
      const transcript = codexRollout(env, 'T3 Code')
      const codexHome = path.dirname(path.dirname(transcript))
      recordSessionNotified(SESSION, env, Date.now())
      const { app, host } = await server()
      const service = fakeService()
      const { hub, done } = startHub(env, service, new Map(), memoryStore(), 100,
        { codexHostHoldsThread: (_home, _id, pid) => pid === host.pid, codexHostKind: () => 'app-server' },
        { codexThreadHolders: () => [host.pid] })
      try {
        await hubListening(env)
        send(env, codexHome)
        await until(() => running(service).length > 0)
        expect(running(service)[0]).toMatchObject({ accepts_messages: false })
        expect(hub.sessions.get(SESSION)?.registration).toMatchObject({ place: 't3', codexHome, harnessProcess: host })
        await until(() => (JSON.parse(readFileSync(attendantStatusPath(SESSION, env), 'utf8')) as Record<string, unknown>)['phase'] === 'attending')
      } finally {
        app.kill('SIGKILL')
        hub.requestExit('test')
        service.release()
        await done
      }
    })

    it('is not attended when nothing holds the thread', async () => {
      const env = hubEnv()
      const transcript = codexRollout(env, 'T3 Code')
      recordSessionNotified(SESSION, env, Date.now())
      const service = fakeService()
      const { hub, done } = startHub(env, service, new Map(), memoryStore(), 100, {}, { codexThreadHolders: () => [] })
      await hubListening(env)
      send(env, path.dirname(path.dirname(transcript)))
      await new Promise((resolve) => setTimeout(resolve, 400))
      service.release()
      expect(hub.sessions.has(SESSION)).toBe(false)
      expect(running(service)).toEqual([])
      hub.requestExit('test')
      service.release()
      await done
    })

    it('runs again after a hub restart once it sends, though no child ever comes back for it', async () => {
      const env = hubEnv()
      const transcript = codexRollout(env, 'T3 Code')
      const codexHome = path.dirname(path.dirname(transcript))
      recordSessionNotified(SESSION, env, Date.now())
      const { app, host } = await server()
      const service = fakeService()
      const options = { codexHostHoldsThread: (_home: string | null, _id: string, pid: number) => pid === host.pid, codexHostKind: () => 'app-server' as const }
      const first = startHub(env, service, new Map(), memoryStore(), 100, options, { codexThreadHolders: () => [host.pid] })
      let second: { hub: Hub; done: Promise<number> } | null = null
      try {
        await hubListening(env)
        send(env, codexHome)
        await until(() => running(service).length > 0)
        first.hub.requestExit('test-crash')
        service.release()
        await first.done

        second = startHub(env, service, new Map(), memoryStore(), 100, options, { codexThreadHolders: () => [host.pid] })
        await hubListening(env)
        await until(() => second!.hub.sessions.has(SESSION))
        const before = service.batches.length
        send(env, codexHome)
        await until(() => running(service, before).length > 0)
      } finally {
        app.kill('SIGKILL')
        second?.hub.requestExit('test')
        service.release()
        await second?.done
      }
    })
  })

  describe('on Codex\'s shared server, where a closed terminal reports nothing', () => {
    type Attach = Awaited<ReturnType<NonNullable<NonNullable<HubOptions['codexAttach']>['state']>>>
    type AttachInput = Parameters<NonNullable<NonNullable<HubOptions['codexAttach']>['state']>>[0]

    /** A note for an idle CLI thread on the shared server; `state` answers the checks. */
    async function sharedServer(options: {
      verified?: boolean | (() => boolean)
      checkBuild?: NonNullable<HubOptions['codexAttach']>['checkBuild']
      clock?: HubOptions['clock']
      state?: (input: AttachInput) => Promise<Attach> | Attach
      watchMs?: number
      wake?: CodexWakeAdapters
      hostKind?: HubOptions['codexHostKind']
    }) {
      const env = hubEnv()
      recordSessionNotified(SESSION, env, Date.now())
      const transcript = codexRollout(env, 'codex-tui')
      const queued: string[] = []
      const asked: AttachInput[] = []
      const builds: number[] = []
      const wake: CodexWakeAdapters = { available: () => true, queue: async (threadId) => { queued.push(threadId) } }
      let note = false
      const service = fakeService({ batch: (body) => ({
        message_cursor: 'c1',
        sessions: body.sessions.map((entry) => entry.state === 'running'
          ? { session_id: entry.session_id, status: 'attending' as const, generation: entry.generation ?? 1, lease_remaining_ms: 120_000, message_cursor: 'c1',
              messages: note ? [{ message_id: 'sm_idle', kind: 'note' as const, body: 'Later', created_at: '2026-10-20T00:00:00.000Z', agent_acknowledgement_text_required: true }] : [] }
          : { session_id: entry.session_id, status: 'withdrawn' as const }),
      }) })
      const peers = new Map<number, PeerCredentials>()
      const { hub, done } = startHub(env, service, peers, memoryStore(), 100, { codexHostKind: options.hostKind ?? (() => 'shared-server'), wake: options.wake ?? wake }, {
        codexAttach: {
          verified: () => typeof options.verified === 'function' ? options.verified() : options.verified ?? true,
          state: async (input) => { asked.push(input); return await (options.state?.(input) ?? { state: 'unknown', confirmed: false, reason: 'test' }) },
          checkBuild: async (host) => { builds.push(host.pid); return await options.checkBuild?.(host) ?? null },
          watchMs: options.watchMs ?? 60_000,
        },
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      })
      await hubListening(env)
      const child = await codexSession(env, service, peers, 900120, transcript)
      for (const type of ['task_started', 'task_complete']) {
        writeFileSync(transcript, `${JSON.stringify({ type: 'event_msg', payload: { type, turn_id: 'turn-1' } })}\n`, { flag: 'a' })
      }
      const pending = (): boolean => {
        const lease = readAttendantLease(SESSION, env)
        return lease !== null && hasSessionInputs(SESSION, env, lease)
      }
      const deliverNote = async (rounds = 12): Promise<void> => {
        note = true
        for (let i = 0; i < rounds; i += 1) {
          service.release()
          hub.inputStaged(SESSION)
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      const stop = async (): Promise<void> => {
        child.socket.destroy()
        hub.requestExit('test')
        // An exchange may still wait on the service: answer until the hub has gone.
        let gone = false
        void done.then(() => { gone = true })
        while (!gone) {
          service.release()
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      return { env, hub, service, queued, asked, builds, pending, deliverNote, stop }
    }

    it.each([
      ['a terminal shows it', { state: 'attached', confirmed: true, reason: 'terminal-live+joined' } as Attach, 1, false],
      ['only a terminal that joined it shows it', { state: 'attached', confirmed: true, reason: 'terminal-gone+joined' } as Attach, 1, false],
      ['no terminal shows it', { state: 'closed', confirmed: true, reason: 'terminal-live+reloaded' } as Attach, 0, true],
      ['Notifai cannot tell', { state: 'unknown', confirmed: false, reason: 'check-failed' } as Attach, 0, false],
      ['the conversation is busy', { state: 'unknown', confirmed: false, reason: 'thread-busy' } as Attach, 0, false],
    ])('when a note arrives and %s, wakes it only if the confirmation says a terminal shows it', async (_name, verdict, wakes, ends) => {
      const run = await sharedServer({ state: () => verdict })
      try {
        await run.deliverNote()
        if (ends) await until(() => reportedEnd(run.service))
        expect(run.queued).toEqual(Array(wakes).fill(SESSION))
        // Before a wake both checks run, on the thread's own server.
        expect(run.asked.length).toBeGreaterThan(0)
        expect(run.asked[0]).toMatchObject({ threadId: SESSION, confirm: 'always', host: HARNESS })
        // Closed by the User: its questions expire. Otherwise the note still waits or was handed in.
        expect(reportedEnd(run.service)).toBe(ends)
        if (!ends && wakes === 0) expect(run.pending()).toBe(true)
      } finally {
        await run.stop()
      }
    })

    it('never asks, and never wakes, before Codex\'s behaviour was checked for the server\'s binary; it starts that check', async () => {
      const run = await sharedServer({ verified: false, state: () => ({ state: 'attached', confirmed: true, reason: 'x' }) })
      try {
        await run.deliverNote()
        expect(run.asked).toEqual([])
        expect(run.queued).toEqual([])
        expect(run.builds).toContain(HARNESS.pid)
        expect(run.pending()).toBe(true)
        expect(reportedEnd(run.service)).toBe(false)
      } finally {
        await run.stop()
      }
    })

    it('kills a stalled Codex child at the hub send deadline and retains the input', async () => {
      let pid: number | undefined
      let killed = false
      const run = await sharedServer({ state: () => ({ state: 'attached', confirmed: true, reason: 'terminal-live+joined' }),
        wake: { available: () => true, queue: async (_thread, _cwd, _text, _spawn, signal) => {
          try { await runWakeCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal, onSpawn: child => { pid = child } }) }
          finally { killed = true }
        } },
      })
      // Keep real clocks and all other timers; shorten only the production send budget.
      const timeout = globalThis.setTimeout
      const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn, ms, ...args) =>
        timeout(fn, ms === 30_000 ? 100 : ms, ...args)) as typeof setTimeout)
      try {
        await run.deliverNote(3)
        await until(() => killed)
        expect(pid).toBeTypeOf('number')
        await until(() => !pidExists(pid!))
        expect(readSessionState(SESSION, run.env).input_wake_fault).toMatchObject({ kind: 'transport', attempts: 1 })
        expect(readSessionState(SESSION, run.env).input_wake).toBeUndefined()
        expect(run.pending()).toBe(true)
      } finally { timer.mockRestore(); if (pid !== undefined && pidExists(pid)) process.kill(pid, 'SIGKILL'); await run.stop() }
    })

    it('watches an open question\'s conversation and expires its questions once no terminal shows it, ignoring the SessionEnd its own request causes', async () => {
      let ownEnd: unknown = null
      let candidateAfter: unknown = 'unset'
      let hubRef: Hub | null = null
      // The watch already looks during setup: the terminal closes only once the question is open.
      let terminalClosed = false
      const run = await sharedServer({
        watchMs: 50,
        state: async (input) => {
          if (!terminalClosed || input.confirm !== 'closed') return { state: 'unknown', confirmed: false, reason: 'test' }
          // The confirming request reloads the thread: Codex runs SessionEnd from the shared server.
          input.beforeConfirm?.()
          ownEnd = await requestHub(input.env, { type: 'session-end-candidate', session_id: SESSION, harness_pid: HARNESS.pid })
          candidateAfter = hubRef?.sessions.get(SESSION)?.endCandidate ?? null
          return { state: 'closed', confirmed: true, reason: 'terminal-gone+reloaded' }
        },
      })
      hubRef = run.hub
      try {
        question(run.env)
        terminalClosed = true
        await until(() => reportedEnd(run.service))
        expect(ownEnd).toEqual({ type: 'ok', held: true })
        // Not an end candidate: the hub decided from its own request.
        expect(candidateAfter).toBeNull()
        expect(run.queued).toEqual([])
      } finally {
        await run.stop()
      }
    })
  })

})

describe('SessionEnd hook', () => {
  async function fakeHub(env: NodeJS.ProcessEnv, answer: Record<string, unknown>): Promise<{ requests: Record<string, unknown>[]; close(): Promise<void> }> {
    const requests: Record<string, unknown>[] = []
    ensurePrivateDirectory(path.dirname(hubSocketPath(env)))
    const server = createServer((socket) => {
      const decoder = new FrameDecoder()
      socket.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame['type'] === 'hello') continue
          requests.push(frame)
          socket.end(encodeFrame(answer))
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(hubSocketPath(env), resolve))
    return { requests, close: () => new Promise((resolve) => server.close(() => resolve())) }
  }

  async function sessionEnd(env: NodeJS.ProcessEnv, originator: string): Promise<void> {
    const directory = path.join(env['XDG_STATE_HOME']!, '..', 'codex', 'sessions')
    mkdirSync(directory, { recursive: true })
    const transcript = path.join(directory, 'rollout.jsonl')
    writeFileSync(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: SESSION, originator } })}\n`)
    beginSessionIncarnation(SESSION, env, { stamp: lifecycleStamp(), harnessProcess: HARNESS })
    updateSessionState(SESSION, env, (state) => ({ ...state, harness: 'codex', pending: [{ question: 'Deploy?', summary: 'Deploy?' } as never] }))
    const deps: CommandDeps = {
      io: { out: () => undefined, err: () => undefined, confirm: async () => false, openUrl: () => undefined },
      store: memoryStore(), env, cwd: '/tmp', logger: nullLogger(),
    }
    await hookRunCommand(deps, 'session-end', async () => JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: '/tmp',
      hook_event_name: 'SessionEnd', reason: 'other' }), 'codex')
  }

  it('leaves an app conversation\'s end to the hub that holds it, cleaning up nothing', async () => {
    const env = hubEnv()
    const hub = await fakeHub(env, { type: 'ok', held: true })
    try {
      await sessionEnd(env, 'Codex Desktop')
      expect(hub.requests).toEqual([expect.objectContaining({ type: 'session-end-candidate', session_id: SESSION })])
      expect(readSessionEndMarker(SESSION, env)).toBeNull()
      expect(readSessionState(SESSION, env).pending).toHaveLength(1)
    } finally { await hub.close() }
  })

  it('ends it at once when no hub holds it', async () => {
    for (const originator of ['Codex Desktop', 'codex-tui']) {
      const env = hubEnv()
      const hub = await fakeHub(env, { type: 'refused', reason: 'unknown-session' })
      try {
        await sessionEnd(env, originator)
        expect(hub.requests.some((request) => request['type'] === 'session-end-candidate')).toBe(true)
        expect(readSessionEndMarker(SESSION, env)).not.toBeNull()
        expect(readSessionState(SESSION, env).pending ?? []).toEqual([])
      } finally { await hub.close() }
    }
  })
})

// ---------------------------------------------------------------------------
// Stopped, not closed: the Claude desktop app's own pause, the machine going down
// ---------------------------------------------------------------------------

describe('hub: conversations stopped by their app or the machine', () => {
  interface StandIn { pid: number; start: string; process: ChildProcess }
  const standIns: ChildProcess[] = []
  afterEach(() => { for (const proc of standIns.splice(0)) proc.kill('SIGKILL') })
  // The answer owners are the question waiters' own tests; here the hub's decisions are.
  const noHook = async (): Promise<number> => 0

  async function standIn(): Promise<StandIn> {
    const proc = spawn('sleep', ['60'], { stdio: 'ignore' })
    standIns.push(proc)
    await until(() => processStartTime(proc.pid!) !== null)
    return { pid: proc.pid!, start: processStartTime(proc.pid!)!, process: proc }
  }

  function describeHost(env: NodeJS.ProcessEnv, host: StandIn): void {
    writeFileSync(path.join(claudeDescriptorDir(env), `${host.pid}.json`), JSON.stringify({
      pid: host.pid, sessionId: SESSION, cwd: '/tmp', startedAt: Date.now(), procStart: host.start, version: '2.1.304', peerProtocol: 1,
      messagingSocketPath: `/tmp/b3hub-${host.pid}.sock`, status: 'idle',
    }))
  }

  /** The conversation's transcript, where Claude Code keeps it. */
  function transcript(env: NodeJS.ProcessEnv): string {
    const directory = path.join(env['CLAUDE_CONFIG_DIR']!, 'projects', '-tmp')
    mkdirSync(directory, { recursive: true })
    const file = path.join(directory, `${SESSION}.jsonl`)
    writeFileSync(file, '{}\n')
    return file
  }

  /** The desktop app's own records: its session (`local_*.json`) and its log. */
  function desktopApp(env: NodeJS.ProcessEnv, archived = false): { sessions: string; log: string } {
    const root = path.join(env['XDG_STATE_HOME']!, '..', 'desktop')
    const sessions = path.join(root, 'claude-code-sessions')
    mkdirSync(path.join(sessions, 'acct', 'org'), { recursive: true })
    writeFileSync(path.join(sessions, 'acct', 'org', 'local_r2-app.json'), JSON.stringify({ sessionId: 'local_r2-app', cliSessionId: SESSION, isArchived: archived }))
    writeFileSync(path.join(root, 'main.log'), '')
    return { sessions, log: path.join(root, 'main.log') }
  }

  function logPause(log: string): void {
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    writeFileSync(log, `${stamp} [info] [CCD] Pausing session local_r2-app (governor_evict)\n`, { flag: 'a' })
  }

  async function writerChild(env: NodeJS.ProcessEnv, peers: Map<number, PeerCredentials>, childPid: number, host: StandIn,
    overrides: Record<string, unknown> = {}, app?: StandIn): Promise<FakeChild & { writes: number }> {
    const child = await registered(env, SESSION, childPid, peerOf(childPid, { pid: host.pid, comm: 'claude', start: host.start },
      app === undefined ? undefined : { pid: app.pid, comm: 'Claude', start: app.start }), peers,
    { harness_pid: host.pid, harness_start: host.start, stamp_wall: Date.now(), entrypoint: 'cli', ...overrides }) as FakeChild & { writes: number }
    child.writes = 0
    const done = new Set<unknown>()
    const answer = (): void => {
      for (const frame of child.frames) {
        if (frame['type'] !== 'write' || done.has(frame['id'])) continue
        done.add(frame['id'])
        child.writes += 1
        child.send({ type: 'written', id: frame['id'], result: 'ok' })
      }
    }
    child.socket.on('data', answer)
    // A write can arrive with the registration itself (a stopped conversation's answer).
    answer()
    return child
  }

  const ended = (service: FakeService): boolean => service.batches.some((batch) => batch.body.sessions.some((entry) => entry.state === 'ended'))
  const renewals = (service: FakeService): number => service.batches.flatMap((batch) => batch.body.sessions)
    .filter((entry) => entry.session_id === SESSION && entry.state === 'running').length
  const status = (env: NodeJS.ProcessEnv): Record<string, unknown> => JSON.parse(readFileSync(attendantStatusPath(SESSION, env), 'utf8')) as Record<string, unknown>
  const question = (env: NodeJS.ProcessEnv, deadline?: number): void => updateSessionState(SESSION, env, (state) => ({ ...state,
    pending: [{ question: 'Deploy?', summary: 'Deploy?', request_id: 'req_r2', collapse_key: 'ck_r2', device_ids: ['dev_r2'],
      ...(deadline === undefined ? {} : { reply_deadline_at: deadline }) } as never] }))
  /** The User answered on the phone while the conversation was stopped: the hub's answer owner staged it. */
  const answered = (env: NodeJS.ProcessEnv): void => updateSessionState(SESSION, env, (state) => {
    const pending = state.pending![0]!
    const reply = { reply_id: 'rpl_r2', seq: 1, delivery_id: 'del_r2', device_id: 'dev_r2', device_name: 'Phone', text: 'Yes',
      answers: [], source: null, created_at: new Date().toISOString() }
    return { ...state, pending: [], waiting_answers: [{ pending, reply, replies: [reply], agent_acknowledgement_required: true, delivery_claim: true } as never],
      acknowledgement_due: [{ request_id: 'req_r2', recorded_at: Date.now(), text_required: true }] }
  })
  const end = (env: NodeJS.ProcessEnv, child: FakeChild, host: StandIn): Promise<Record<string, unknown> | null> => {
    const held = requestHub(env, { type: 'session-end-candidate', session_id: SESSION, harness_pid: host.pid })
    host.process.kill('SIGKILL')
    child.send({ type: 'ended', session_id: SESSION, harness_pid: host.pid, reason: 'harness-gone' })
    return held
  }
  async function stopHub(hub: Hub, service: FakeService, done: Promise<number>): Promise<void> {
    let exited = false
    void done.then(() => { exited = true })
    hub.requestExit('test')
    while (!exited) { service.release(); await new Promise((resolve) => setTimeout(resolve, 20)) }
  }

  it('keeps a conversation the desktop app paused, renews nothing, and hands the answer in where the app reopens it', async () => {
    const env = hubEnv()
    recordSessionNotified(SESSION, env, Date.now())
    const app = await standIn()
    const host = await standIn()
    describeHost(env, host)
    const desktop = desktopApp(env)
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const { hub, done } = startHub(env, service, peers, memoryStore(), 100, { endConfirmMs: 200 }, { claudeDesktop: desktop, powerWatch: false, runHook: noHook })
    await hubListening(env)
    const first = await writerChild(env, peers, 900400, host, { entrypoint: 'claude-desktop', transcript_path: transcript(env) }, app)
    expect(first.frames[0]).toEqual({ type: 'registered', session_id: SESSION })
    await until(() => renewals(service) >= 1)
    question(env)
    const incarnation = readSessionIncarnation(SESSION, env)!
    // The app pauses it: its log says so, then the process goes (SessionEnd `other`).
    logPause(desktop.log)
    expect(await end(env, first, host)).toEqual({ type: 'ok', held: true })
    await until(() => hub.sessions.get(SESSION)?.stopped !== null && hub.sessions.get(SESSION)?.stopped !== undefined, 5_000)
    expect(hub.sessions.get(SESSION)?.stopped?.cause).toBe('app')
    expect(status(env)).toMatchObject({ phase: 'exited', reason: 'stopped', generation: 1, accepts_messages: false })
    expect((status(env)['adoption'] as Record<string, unknown>)['stopped']).toMatchObject({ cause: 'app' })
    const quiet = renewals(service)
    await new Promise((resolve) => setTimeout(resolve, 600))
    service.release()
    expect(renewals(service)).toBe(quiet)
    expect(ended(service)).toBe(false)
    expect(readSessionEndMarker(SESSION, env)).toBeNull()
    // A service that does not hold stopped sessions is told nothing new: the lease just lapses.
    expect(service.batches.flatMap((batch) => batch.body.sessions).some((entry) => entry.state === 'stopped')).toBe(false)
    // The User answers on the phone meanwhile.
    answered(env)
    hub.inputStaged(SESSION)
    // The app reopens it: a new process, `--resume` of the same id.
    const respawned = await standIn()
    describeHost(env, respawned)
    const second = await writerChild(env, peers, 900401, respawned, { entrypoint: 'claude-desktop', source: 'resume' }, app)
    expect(second.frames[0]).toEqual({ type: 'registered', session_id: SESSION })
    expect(hub.sessions.get(SESSION)?.stopped).toBeNull()
    expect(readSessionIncarnation(SESSION, env)).toMatchObject({ key: incarnation.key, incarnation: incarnation.incarnation,
      harness_process: { pid: respawned.pid } })
    // The answer goes in once, through the new place.
    await until(() => second.writes === 1, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(second.writes).toBe(1)
    expect(ended(service)).toBe(false)
    second.socket.destroy()
    first.socket.destroy()
    await stopHub(hub, service, done)
  })

  it('where the service holds stopped sessions: reports the stop, sees held notes, drops an answer at its window, and comes back under a new incarnation', async () => {
    const env = hubEnv()
    recordSessionNotified(SESSION, env, Date.now())
    const app = await standIn()
    const host = await standIn()
    describeHost(env, host)
    const desktop = desktopApp(env)
    const note = { message_id: 'sm_r7b_note', created_at: new Date().toISOString(), agent_acknowledgement_text_required: true, kind: 'note' as const, body: 'Use staging' }
    // The service: one row, stopped by its holder; only a new incarnation takes it back.
    let row: { incarnation: string | null; generation: number; state: 'running' | 'stopped' | 'ended' } = { incarnation: null, generation: 0, state: 'running' }
    const service = fakeService({
      capabilities: ['session_attendance', 'session_attendance_batch', 'session_stopped_hold'],
      batch: (body) => ({ message_cursor: 'c1', sessions: body.sessions.map((entry) => {
        if (entry.state === 'stopped') {
          if (entry.incarnation !== row.incarnation) return { session_id: entry.session_id, status: 'withdrawn' as const }
          row.state = 'stopped'
          return { session_id: entry.session_id, status: 'stopped' as const, generation: row.generation, message_cursor: 'c1', messages: [note] }
        }
        if (entry.state === 'running') {
          if (entry.incarnation === row.incarnation && row.state !== 'running') return { session_id: entry.session_id, status: 'withdrawn' as const }
          if (entry.incarnation !== row.incarnation) row = { incarnation: entry.incarnation, generation: row.generation + 1, state: 'running' }
          return { session_id: entry.session_id, status: 'attending' as const, generation: row.generation, lease_remaining_ms: 120_000, message_cursor: 'c1', messages: [] }
        }
        row.state = 'ended'
        return { session_id: entry.session_id, status: 'withdrawn' as const }
      }) }),
    })
    const peers = new Map<number, PeerCredentials>()
    const { hub, done } = startHub(env, service, peers, memoryStore(), 50, { endConfirmMs: 200 }, { claudeDesktop: desktop, powerWatch: false, runHook: noHook })
    await hubListening(env)
    const first = await writerChild(env, peers, 900420, host, { entrypoint: 'claude-desktop', transcript_path: transcript(env) }, app)
    await until(() => renewals(service) >= 1)
    const firstIncarnation = readSessionIncarnation(SESSION, env)!.incarnation
    // A question whose window ends soon, answered on the phone just before.
    question(env, Date.now() + 1_500)
    answered(env)
    logPause(desktop.log)
    expect(await end(env, first, host)).toEqual({ type: 'ok', held: true })
    await until(() => hub.sessions.get(SESSION)?.stopped?.cause === 'app', 5_000)
    // The stop is reported from the held generation, and the note sent meanwhile is seen, not claimed.
    await until(() => (hub.sessions.get(SESSION)?.held.length ?? 0) === 1, 5_000)
    const stops = service.batches.flatMap((batch) => batch.body.sessions).filter((entry) => entry.state === 'stopped')
    expect(stops[0]).toEqual({ session_id: SESSION, incarnation: firstIncarnation, generation: 1, state: 'stopped' })
    expect(row.state).toBe('stopped')
    expect(readSessionState(SESSION, env).waiting_answers).toHaveLength(1)
    // The answer's window ends while it is stopped: it goes here too, so it is never handed in later.
    await until(() => (readSessionState(SESSION, env).waiting_answers ?? []).length === 0, 5_000)
    expect(readSessionState(SESSION, env).acknowledgement_due ?? []).toEqual([])
    // The held note still keeps it: stopped, not ended.
    expect(hub.sessions.get(SESSION)?.stopped).not.toBeNull()
    expect(ended(service)).toBe(false)
    // The app reopens it: the service refuses the old incarnation, a new one acquires.
    const respawned = await standIn()
    describeHost(env, respawned)
    const second = await writerChild(env, peers, 900421, respawned, { entrypoint: 'claude-desktop', source: 'resume' }, app)
    expect(second.frames[0]).toEqual({ type: 'registered', session_id: SESSION })
    await until(() => row.state === 'running' && row.incarnation !== firstIncarnation, 5_000)
    expect(row.generation).toBe(2)
    expect(readSessionIncarnation(SESSION, env)!.incarnation).toBe(row.incarnation)
    await until(() => hub.sessions.get(SESSION)?.lease.phase === 'attending', 5_000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    // Nothing was handed in: the only answer was dropped at its window.
    expect(second.writes).toBe(0)
    expect(ended(service)).toBe(false)
    second.socket.destroy()
    first.socket.destroy()
    await stopHub(hub, service, done)
  })

  it('holds every end while the machine shuts down; the next boot keeps the conversation and delivers at its resume', async () => {
    const env = hubEnv()
    recordSessionNotified(SESSION, env, Date.now())
    const host = await standIn()
    describeHost(env, host)
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    let post: ((event: { kind: 'shutdown' | 'cancelled' | 'other'; name: string }) => void) | null = null
    const powerWatch = (onEvent: typeof post & {}): ReturnType<NonNullable<Exclude<HubOptions['powerWatch'], false>>> => {
      post = onEvent
      return { state: () => ({ source: 'loginwindow', unavailable: null }), persisted: () => undefined, stop: () => undefined }
    }
    const first = startHub(env, service, peers, memoryStore(), 100, { endConfirmMs: 150 }, { powerWatch, claudeDesktop: null, runHook: noHook })
    await hubListening(env)
    const child = await writerChild(env, peers, 900430, host, { transcript_path: transcript(env) })
    await until(() => renewals(service) >= 1)
    question(env)
    // The shutdown begins; then the terminal app quits and its window hangs up on `claude`.
    post!({ kind: 'shutdown', name: 'com.apple.system.loginwindow.shutdownInitiated' })
    await end(env, child, host)
    await new Promise((resolve) => setTimeout(resolve, 700))
    service.release()
    expect(ended(service)).toBe(false)
    expect(first.hub.sessions.get(SESSION)?.endCandidate).not.toBeNull()
    expect(readSessionEndMarker(SESSION, env)).toBeNull()
    // launchd terminates the hub: the end stays undecided, on disk.
    child.socket.destroy()
    await stopHub(first.hub, service, first.done)
    expect(ended(service)).toBe(false)
    // The next boot.
    const second = startHub(env, service, peers, memoryStore(), 100, { endConfirmMs: 150 }, { powerWatch: false, claudeDesktop: null, runHook: noHook,
      bootIdentity: () => 'next-boot' })
    await hubListening(env)
    await until(() => second.hub.sessions.get(SESSION)?.stopped?.cause === 'machine', 5_000)
    expect(status(env)).toMatchObject({ phase: 'exited', reason: 'stopped' })
    expect(readSessionState(SESSION, env).pending).toHaveLength(1)
    answered(env)
    // `claude --resume` in a terminal after the reboot.
    const resumed = await standIn()
    describeHost(env, resumed)
    const back = await writerChild(env, peers, 900431, resumed, { source: 'resume', boot: 'next-boot' })
    expect(back.frames[0]).toEqual({ type: 'registered', session_id: SESSION })
    await until(() => back.writes === 1, 5_000)
    expect(ended(service)).toBe(false)
    expect(readSessionIncarnation(SESSION, env)?.harness_process?.pid).toBe(resumed.pid)
    back.socket.destroy()
    await stopHub(second.hub, service, second.done)
  })

  it('keeps a conversation the machine took down with no end at all (power loss), and ends one with nothing waiting as before', async () => {
    for (const waiting of [true, false]) {
      const env = hubEnv()
      recordSessionNotified(SESSION, env, Date.now())
      const host = await standIn()
      describeHost(env, host)
      const service = fakeService()
      const peers = new Map<number, PeerCredentials>()
      const first = startHub(env, service, peers, memoryStore(), 100, { endConfirmMs: 150 }, { powerWatch: false, claudeDesktop: null, runHook: noHook })
      await hubListening(env)
      const child = await writerChild(env, peers, 900450, host, { transcript_path: transcript(env) })
      await until(() => renewals(service) >= 1)
      if (waiting) question(env)
      // The power goes: no SessionEnd, no exit report, the hub just stops.
      await stopHub(first.hub, service, first.done)
      child.socket.destroy()
      host.process.kill('SIGKILL')
      const second = startHub(env, service, peers, memoryStore(), 100, { endConfirmMs: 150 }, { powerWatch: false, claudeDesktop: null, runHook: noHook,
        bootIdentity: () => 'after-power-loss' })
      if (waiting) {
        await until(() => second.hub.sessions.get(SESSION)?.stopped?.cause === 'machine', 5_000)
        expect(ended(service)).toBe(false)
        expect(readSessionState(SESSION, env).pending).toHaveLength(1)
      } else {
        await until(() => ended(service), 5_000)
      }
      await stopHub(second.hub, service, second.done)
    }
  })

  it('never hands what waits to a scripted run of the same conversation, and its end ends nothing', async () => {
    const env = hubEnv()
    recordSessionNotified(SESSION, env, Date.now())
    const app = await standIn()
    const host = await standIn()
    describeHost(env, host)
    const desktop = desktopApp(env)
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const { hub, done } = startHub(env, service, peers, memoryStore(), 100, { endConfirmMs: 150 }, { claudeDesktop: desktop, powerWatch: false, runHook: noHook })
    await hubListening(env)
    const child = await writerChild(env, peers, 900470, host, { entrypoint: 'claude-desktop', transcript_path: transcript(env) }, app)
    await until(() => renewals(service) >= 1)
    question(env)
    logPause(desktop.log)
    await end(env, child, host)
    await until(() => hub.sessions.get(SESSION)?.stopped?.cause === 'app', 5_000)
    answered(env)
    // `claude -p --resume <id>`: refused for good, and nothing is written into it.
    const scripted = await standIn()
    describeHost(env, scripted)
    const run = await writerChild(env, peers, 900471, scripted, { entrypoint: 'sdk-cli', source: 'resume' })
    expect(run.frames[0]).toMatchObject({ type: 'refused', reason: 'place-receives-nothing', retry: false })
    expect(await requestHub(env, { type: 'session-end-candidate', session_id: SESSION, harness_pid: scripted.pid })).toEqual({ type: 'ok', held: true })
    expect(hub.sessions.get(SESSION)?.stopped?.cause).toBe('app')
    expect(hub.sessions.get(SESSION)?.endCandidate).toBeNull()
    expect(readSessionIncarnation(SESSION, env)?.harness_process?.pid).toBe(host.pid)
    expect(ended(service)).toBe(false)
    child.socket.destroy()
    await stopHub(hub, service, done)
  })
})

describe('hub: Codex conversations stopped by their app or the machine, Orca panes, and forks', () => {
  interface StandIn { pid: number; start: string; process: ChildProcess }
  const standIns: ChildProcess[] = []
  afterEach(() => { for (const proc of standIns.splice(0)) proc.kill('SIGKILL') })
  const noHook = async (): Promise<number> => 0

  async function standIn(): Promise<StandIn> {
    const proc = spawn('sleep', ['60'], { stdio: 'ignore' })
    standIns.push(proc)
    await until(() => processStartTime(proc.pid!) !== null)
    return { pid: proc.pid!, start: processStartTime(proc.pid!)!, process: proc }
  }

  function codexHome(env: NodeJS.ProcessEnv): string {
    return path.join(env['XDG_STATE_HOME']!, '..', 'codex')
  }

  function rollout(env: NodeJS.ProcessEnv, sessionId: string, originator: string, forkedFrom?: string): string {
    const directory = path.join(codexHome(env), 'sessions', '2026', '10', '20')
    mkdirSync(directory, { recursive: true })
    const file = path.join(directory, `rollout-2026-10-20T08-00-00-${sessionId}.jsonl`)
    writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, originator,
      ...(forkedFrom === undefined ? {} : { forked_from_id: forkedFrom }) } })}\n`)
    return file
  }


  /** A Codex host registered for a thread, idle after one turn. */
  async function codexChild(env: NodeJS.ProcessEnv, peers: Map<number, PeerCredentials>, childPid: number, host: StandIn, transcript: string,
    extra: Record<string, unknown> = {}, app?: StandIn, sessionId = SESSION): Promise<FakeChild> {
    const child = await registered(env, sessionId, childPid, peerOf(childPid, { pid: host.pid, comm: 'codex', start: host.start },
      app === undefined ? undefined : { pid: app.pid, comm: 'node', start: app.start }), peers,
    { harness: 'codex', harness_pid: host.pid, harness_start: host.start, transcript_path: transcript, codex_home: codexHome(env),
      claude_config_dir: undefined, inbox_token: undefined, stamp_wall: Date.now(), ...extra })
    if (child.frames[0]?.['type'] === 'registered') {
      const key = readSessionIncarnation(sessionId, env)!.key
      recordTurnStart(sessionId, env, key, 'turn-1')
      recordTurnEnd(sessionId, env, 'turn-1')
    }
    return child
  }

  const ended = (service: FakeService, sessionId = SESSION): boolean => service.batches.some((batch) => batch.body.sessions.some((entry) =>
    entry.session_id === sessionId && entry.state === 'ended'))
  const renewals = (service: FakeService, sessionId = SESSION): number => service.batches.flatMap((batch) => batch.body.sessions)
    .filter((entry) => entry.session_id === sessionId && entry.state === 'running').length
  const status = (env: NodeJS.ProcessEnv): Record<string, unknown> => JSON.parse(readFileSync(attendantStatusPath(SESSION, env), 'utf8')) as Record<string, unknown>
  const question = (env: NodeJS.ProcessEnv, sessionId = SESSION): void => updateSessionState(sessionId, env, (state) => ({ ...state,
    pending: [{ question: 'Deploy?', summary: 'Deploy?', request_id: `req_${sessionId.slice(0, 4)}` } as never] }))
  const note = (env: NodeJS.ProcessEnv, id: string): void => {
    const incarnation = readSessionIncarnation(SESSION, env)!.incarnation
    stageSessionMessages(SESSION, env, { incarnation, generation: 1 }, [{ message_id: id, kind: 'note', body: 'Later',
      created_at: new Date().toISOString(), agent_acknowledgement_text_required: true }])
  }
  /** The harness goes: the child's kernel watch reports it. */
  const exit = (child: FakeChild, host: StandIn): void => {
    host.process.kill('SIGKILL')
    child.send({ type: 'ended', session_id: SESSION, harness_pid: host.pid, reason: 'harness-gone' })
  }
  async function stopHub(hub: Hub, service: FakeService, done: Promise<number>): Promise<void> {
    let exited = false
    void done.then(() => { exited = true })
    hub.requestExit('test')
    while (!exited) { service.release(); await new Promise((resolve) => setTimeout(resolve, 20)) }
  }
  const queueing = (queued: string[]): CodexWakeAdapters => ({ available: () => true, queue: async (threadId) => { queued.push(threadId) } })

  it('keeps a T3 thread stopped 31 minutes after its last activity while T3 runs, queues one wake, and delivers at the next send', async () => {
    const env = hubEnv()
    recordSessionNotified(SESSION, env, Date.now())
    const transcript = rollout(env, SESSION, 'T3 Code')
    const t3 = await standIn()
    const server = await standIn()
    const queued: string[] = []
    let shift = 0
    const clock = { monotonic: () => performance.now(), wall: () => Date.now() + shift }
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const { hub, done } = startHub(env, service, peers, memoryStore(), 100, { endConfirmMs: 150, codexHostKind: () => 'app-server',
      wake: queueing(queued) }, { powerWatch: false, runHook: noHook, clock })
    await hubListening(env)
    const child = await codexChild(env, peers, 900620, server, transcript, { originator_override: 'T3 Code' }, t3)
    expect(child.frames[0]).toEqual({ type: 'registered', session_id: SESSION })
    await until(() => renewals(service) >= 1)
    question(env)
    // Half an hour later T3 stops its idle provider: the app-server goes.
    shift = 31 * 60_000
    exit(child, server)
    await until(() => hub.sessions.get(SESSION)?.stopped !== null && hub.sessions.get(SESSION)?.stopped !== undefined, 5_000)
    expect(hub.sessions.get(SESSION)?.stopped).toMatchObject({ cause: 'app', watch: 'host-app' })
    expect(status(env)).toMatchObject({ phase: 'exited', reason: 'stopped' })
    expect((status(env)['adoption'] as Record<string, unknown>)['place']).toBe('t3')
    // An answer (a note here) arrives: one content-free wake goes into the thread's own queue.
    note(env, 'sm_t3')
    hub.inputStaged(SESSION)
    await until(() => queued.length === 1)
    hub.inputStaged(SESSION)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(queued).toEqual([SESSION])
    expect(ended(service)).toBe(false)
    // The User's next send: T3 starts a provider again and the thread loads, its queued wake first.
    const again = await standIn()
    const back = await codexChild(env, peers, 900621, again, transcript, { originator_override: 'T3 Code', source: 'resume' }, t3)
    expect(back.frames[0]).toEqual({ type: 'registered', session_id: SESSION })
    expect(hub.sessions.get(SESSION)?.stopped).toBeNull()
    expect(readSessionIncarnation(SESSION, env)?.harness_process?.pid).toBe(again.pid)
    const before = renewals(service)
    await until(() => { service.release(); return renewals(service) > before }, 5_000)
    expect(ended(service)).toBe(false)
    back.socket.destroy()
    child.socket.destroy()
    await stopHub(hub, service, done)
  })

  it('never hands a stopped thread to a `codex exec` run of it, and that run\'s end ends nothing', async () => {
    const env = hubEnv()
    recordSessionNotified(SESSION, env, Date.now())
    const transcript = rollout(env, SESSION, 'Codex Desktop')
    const server = await standIn()
    const exec = await standIn()
    const service = fakeService()
    const peers = new Map<number, PeerCredentials>()
    const { hub, done } = startHub(env, service, peers, memoryStore(), 100, { endConfirmMs: 150,
      codexHostKind: (pid) => pid === exec.pid ? 'exec' : 'app-server', wake: queueing([]) }, { powerWatch: false, runHook: noHook })
    await hubListening(env)
    const child = await codexChild(env, peers, 900640, server, transcript)
    await until(() => renewals(service) >= 1)
    question(env)
    await requestHub(env, { type: 'session-end-candidate', session_id: SESSION, transcript_path: transcript, harness_pid: server.pid })
    child.socket.destroy()
    await until(() => hub.sessions.get(SESSION)?.stopped?.cause === 'app', 5_000)
    const run = await codexChild(env, peers, 900641, exec, transcript, { source: 'resume' })
    expect(run.frames[0]).toMatchObject({ type: 'refused', reason: 'place-receives-nothing', retry: false })
    expect(await requestHub(env, { type: 'session-end-candidate', session_id: SESSION, transcript_path: transcript, harness_pid: exec.pid }))
      .toEqual({ type: 'ok', held: true })
    expect(hub.sessions.get(SESSION)?.stopped?.cause).toBe('app')
    expect(readSessionIncarnation(SESSION, env)?.harness_process?.pid).toBe(server.pid)
    expect(ended(service)).toBe(false)
    run.socket.destroy()
    await stopHub(hub, service, done)
  })

  // -- Claude Code in an Orca terminal pane, and forks ---------------------------

  function describeHost(env: NodeJS.ProcessEnv, host: StandIn, sessionId = SESSION): void {
    writeFileSync(path.join(claudeDescriptorDir(env), `${host.pid}.json`), JSON.stringify({
      pid: host.pid, sessionId, cwd: '/tmp', startedAt: Date.now(), procStart: host.start, version: '2.1.304', peerProtocol: 1,
      messagingSocketPath: `/tmp/b3hub-${host.pid}.sock`, status: 'idle',
    }))
  }

  function claudeTranscript(env: NodeJS.ProcessEnv, sessionId: string, lines: unknown[] = [{}]): string {
    const directory = path.join(env['CLAUDE_CONFIG_DIR']!, 'projects', '-tmp')
    mkdirSync(directory, { recursive: true })
    const file = path.join(directory, `${sessionId}.jsonl`)
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
    return file
  }

  async function claudeChild(env: NodeJS.ProcessEnv, peers: Map<number, PeerCredentials>, childPid: number, host: StandIn,
    overrides: Record<string, unknown> = {}, sessionId = SESSION): Promise<FakeChild> {
    return registered(env, sessionId, childPid, peerOf(childPid, { pid: host.pid, comm: 'claude', start: host.start }), peers,
      { harness_pid: host.pid, harness_start: host.start, stamp_wall: Date.now(), entrypoint: 'cli', session_id: sessionId, ...overrides })
  }

  /** A Claude Code conversation in an Orca pane, with a question waiting; returns what ends it. */
  async function paneSession(env: NodeJS.ProcessEnv, service: FakeService, peers: Map<number, PeerCredentials>, childPid: number,
    host: StandIn): Promise<FakeChild> {
    describeHost(env, host)
    const child = await claudeChild(env, peers, childPid, host, { orca_pane: '1', transcript_path: claudeTranscript(env, SESSION) })
    expect(child.frames[0]).toEqual({ type: 'registered', session_id: SESSION })
    await until(() => renewals(service) >= 1)
    question(env)
    return child
  }

  const paneEnd = async (env: NodeJS.ProcessEnv, child: FakeChild, host: StandIn): Promise<void> => {
    await requestHub(env, { type: 'session-end-candidate', session_id: SESSION, harness_pid: host.pid })
    exit(child, host)
  }

  it('keeps a conversation whose Orca pane lost its terminal host, and expires one whose pane the User closed', async () => {
    for (const variant of ['host-died', 'pane-closed'] as const) {
      const env = hubEnv()
      recordSessionNotified(SESSION, env, Date.now())
      const terminalHost = await standIn()
      const host = await standIn()
      const service = fakeService()
      const peers = new Map<number, PeerCredentials>()
      const { hub, done } = startHub(env, service, peers, memoryStore(), 100, { endConfirmMs: 150 },
        { powerWatch: false, claudeDesktop: null, runHook: noHook, orcaTerminalHostOf: () => ({ pid: terminalHost.pid, start: terminalHost.start }) })
      await hubListening(env)
      const child = await paneSession(env, service, peers, 900700, host)
      expect((status(env)['adoption'] as Record<string, unknown>)['terminal_host']).toEqual({ pid: terminalHost.pid, start: terminalHost.start })
      if (variant === 'host-died') terminalHost.process.kill('SIGKILL')
      await paneEnd(env, child, host)
      if (variant === 'host-died') {
        await until(() => hub.sessions.get(SESSION)?.stopped?.cause === 'app', 5_000)
        expect(hub.sessions.get(SESSION)?.stopped?.watch).toBeNull()
        expect(ended(service)).toBe(false)
        // Orca resumes it in the same pane when the User opens the tab.
        const resumed = await standIn()
        describeHost(env, resumed)
        const back = await claudeChild(env, peers, 900701, resumed, { orca_pane: '1', source: 'resume' })
        expect(back.frames[0]).toEqual({ type: 'registered', session_id: SESSION })
        expect(hub.sessions.get(SESSION)?.stopped).toBeNull()
        back.socket.destroy()
      } else {
        await until(() => hub.sessions.get(SESSION)?.stopped != null, 5_000)
        expect(ended(service)).toBe(false)
        expect(readSessionEndMarker(SESSION, env)).toBeNull()
        expect(readSessionState(SESSION, env).pending).toHaveLength(1)
      }
      child.socket.destroy()
      await stopHub(hub, service, done)
    }
  })

  it('continues a stopped Codex thread under its fork where the service can move its questions, and ends it as before when it cannot', async () => {
    for (const variant of ['moved', 'refused'] as const) {
      const env = hubEnv()
      recordSessionNotified(SESSION, env, Date.now())
      // The fork already notified, so the service knows it.
      recordSessionNotified(OTHER, env, Date.now())
      const transcript = rollout(env, SESSION, 'Codex Desktop')
      const server = await standIn()
      const service = fakeService({
        capabilities: ['session_attendance', 'session_attendance_batch', 'session_stopped_hold'],
        batch: (body) => ({ message_cursor: 'c1', sessions: body.sessions.map((entry) => {
          if (entry.state === 'stopped') return { session_id: entry.session_id, status: 'stopped' as const, generation: entry.generation!, message_cursor: 'c1', messages: [] }
          if (entry.state === 'running') {
            return { session_id: entry.session_id, status: 'attending' as const, generation: entry.generation ?? 1, lease_remaining_ms: 120_000, message_cursor: 'c1', messages: [] }
          }
          if (entry.state === 'ended' && 'end_reason' in entry && entry.end_reason === 'continued' && variant === 'refused') {
            return { session_id: entry.session_id, status: 'unknown_successor' as const }
          }
          return { session_id: entry.session_id, status: 'withdrawn' as const }
        }) }),
      })
      const peers = new Map<number, PeerCredentials>()
      const { hub, done } = startHub(env, service, peers, memoryStore(), 100, { endConfirmMs: 150, codexHostKind: () => 'app-server',
        wake: queueing([]) }, { powerWatch: false, runHook: noHook })
      await hubListening(env)
      const child = await codexChild(env, peers, 900730, server, transcript)
      await until(() => renewals(service) >= 1)
      question(env)
      await requestHub(env, { type: 'session-end-candidate', session_id: SESSION, transcript_path: transcript, harness_pid: server.pid })
      child.socket.destroy()
      await until(() => hub.sessions.get(SESSION)?.stopped?.cause === 'app', 5_000)
      await until(() => service.batches.some((batch) => batch.body.sessions.some((entry) => entry.state === 'stopped')), 5_000)
      const forkHost = await standIn()
      const fork = await codexChild(env, peers, 900731, forkHost, rollout(env, OTHER, 'codex-tui', SESSION), { source: 'startup' }, undefined, OTHER)
      expect(fork.frames[0]).toEqual({ type: 'registered', session_id: OTHER })
      await until(() => ended(service), 5_000)
      const ends = service.batches.flatMap((batch) => batch.body.sessions).filter((entry) => entry.session_id === SESSION && entry.state === 'ended')
      expect(ends[0]).toMatchObject({ state: 'ended', generation: 1, end_reason: 'continued', successor_session_id: OTHER })
      if (variant === 'moved') {
        // The question is the fork's to collect now; nothing of it expired here.
        await until(() => readSessionEndMarker(SESSION, env) !== null, 5_000)
        expect(readSessionState(OTHER, env).pending?.map((entry) => entry.request_id)).toEqual(['req_1111'])
        expect(readSessionState(SESSION, env).pending ?? []).toEqual([])
        expect(ends).toHaveLength(1)
      } else {
        // The service does not know the fork: a plain end follows, and the question expires with the session.
        await until(() => service.batches.flatMap((batch) => batch.body.sessions).filter((entry) =>
          entry.session_id === SESSION && entry.state === 'ended' && !('end_reason' in entry)).length === 1, 5_000)
        await until(() => readSessionEndMarker(SESSION, env) !== null, 5_000)
        expect(readSessionState(OTHER, env).pending ?? []).toEqual([])
      }
      fork.socket.destroy()
      await stopHub(hub, service, done)
    }
  })
})
