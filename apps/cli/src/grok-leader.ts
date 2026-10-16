/** Grok's local leader protocol. Connect only; never start a daemon or load a
 * saved session. Roster reads omit sessionId so they cannot attach a client. */
import { lstatSync, readdirSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import path from 'node:path'
import { accountHome } from './platform.js'
import type { HarnessProbe } from './session-attendant.js'
import type { SessionWriteResult } from './session-handoff.js'
import type { WriteGuard } from './wake-support.js'

const MAX_FRAME = 4 * 1024 * 1024
const RPC_MS = 2_000
const FRESH_MS = 5_000

type Row = { sessionId: string; resident: boolean; activity: string; cwd: string }
type Frame = Record<string, unknown>

function object(value: unknown): value is Frame {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function socketIdentity(file: string): string {
  const stat = lstatSync(file)
  if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('grok-leader-not-owned')
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
}

class Peer {
  private buffer: Buffer = Buffer.alloc(0)
  private nextId = 0
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private registration: ((frame: Frame) => void) | null = null
  private closed = false

  private constructor(private socket: Socket) {
    socket.on('data', chunk => this.receive(chunk))
    socket.on('error', () => this.close())
    socket.on('close', () => this.close())
  }

  static async connect(file: string, identity = socketIdentity(file)): Promise<Peer> {
    if (socketIdentity(file) !== identity) throw new Error('grok-leader-replaced')
    const peer = new Peer(createConnection(file))
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('grok-leader-registration-timeout')), RPC_MS)
        peer.registration = frame => {
          clearTimeout(timer)
          if (frame['type'] !== 'registered' || frame['ready'] !== true || frame['leader_protocol_version'] !== 1) {
            reject(new Error('grok-leader-protocol-unavailable'))
          } else resolve()
        }
        peer.socket.once('connect', () => peer.send({ type: 'register', client_type: 'notifai', mode: 'stdio', capabilities: {} }))
      })
      if (socketIdentity(file) !== identity) throw new Error('grok-leader-replaced')
      return peer
    } catch (error) { peer.close(); throw error }
  }

  private send(frame: Frame): void {
    if (this.closed) throw new Error('grok-leader-disconnected')
    const body = Buffer.from(JSON.stringify(frame))
    if (body.length > MAX_FRAME) throw new Error('grok-leader-frame-too-large')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    this.socket.write(Buffer.concat([header, body]))
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (length > MAX_FRAME) { this.close(); return }
      if (this.buffer.length < 4 + length) return
      let frame: Frame
      try { frame = JSON.parse(this.buffer.subarray(4, 4 + length).toString()) as Frame }
      catch { this.close(); return }
      if (!object(frame)) { this.close(); return }
      this.buffer = this.buffer.subarray(4 + length)
      if (frame['type'] === 'registered') {
        this.registration?.(frame)
        this.registration = null
      } else if (frame['type'] === 'acp' && typeof frame['payload'] === 'string') {
        let reply: Frame
        try { reply = JSON.parse(frame['payload']) as Frame } catch { this.close(); return }
        if (!object(reply)) { this.close(); return }
        const pending = this.pending.get(reply['id'] as number)
        if (pending === undefined) continue
        this.pending.delete(reply['id'] as number)
        if (reply['error'] !== undefined) pending.reject(new Error('grok-session-rpc-refused'))
        else pending.resolve(reply['result'])
      } else if (['shutdown', 'shutting_down', 'error'].includes(String(frame['type']))) this.close()
    }
  }

  call(method: string, params: Frame, beforeWrite?: () => boolean, timeoutMs = RPC_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('grok-session-rpc-timeout')) }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      try {
        if (beforeWrite !== undefined && !beforeWrite()) throw new Error('grok-write-fenced')
        this.send({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
      } catch (error) {
        this.pending.delete(id); clearTimeout(timer); reject(error)
      }
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new Error('grok-leader-disconnected'))
    this.pending.clear()
    this.socket.destroy()
  }
}

function rows(result: unknown): Row[] {
  const value = result as { result?: { sessions?: unknown } } | null
  const sessions = value?.result?.sessions
  if (!Array.isArray(sessions) || !sessions.every(row => row !== null && typeof row === 'object' &&
    typeof row.sessionId === 'string' && typeof row.resident === 'boolean' &&
    typeof row.activity === 'string' && typeof row.cwd === 'string')) throw new Error('grok-roster-invalid')
  return sessions as Row[]
}

function sockets(env: NodeJS.ProcessEnv): string[] {
  if (env['GROK_LEADER_SOCKET']?.trim()) return [env['GROK_LEADER_SOCKET']]
  const home = env['GROK_HOME']?.trim() || path.join(accountHome(env), '.grok')
  try { return readdirSync(home).filter(name => /^leader(?:-[\w-]+)?\.sock$/.test(name)).map(name => path.join(home, name)) }
  catch { return [] }
}

export function hasGrokLeader(env: NodeJS.ProcessEnv): boolean { return sockets(env).length > 0 }

/** Bounded local evidence, like the Hermes bridge's state stream. A delivery
 * always repeats the authoritative roster read immediately before its write. */
export class GrokLeaderSession {
  private observed: HarnessProbe = { state: 'uncertain', reason: 'grok-unobserved' }
  private observedAt = 0
  private refreshing: Promise<void> | null = null
  private stopped = false
  private timer: ReturnType<typeof setInterval> | null = null

  private constructor(readonly socketPath: string, readonly sessionId: string, private cwd: string, private identity: string) {}

  static async discover(sessionId: string, cwd: string, env: NodeJS.ProcessEnv): Promise<GrokLeaderSession | null> {
    const candidates = sockets(env)
    if (candidates.length === 0 || candidates.length > 16) return null
    const found = await Promise.all(candidates.map(async file => {
      let peer: Peer | undefined
      try {
        const identity = socketIdentity(file)
        peer = await Peer.connect(file, identity)
        const matches = rows(await peer.call('_x.ai/sessions/list', {})).filter(row => row.sessionId === sessionId && row.resident && row.cwd === cwd)
        return matches.length === 1 ? { file, identity } : null
      } catch { return null } finally { peer?.close() }
    }))
    const owners = found.filter(owner => owner !== null)
    if (owners.length !== 1) return null
    const session = new GrokLeaderSession(owners[0]!.file, sessionId, cwd, owners[0]!.identity)
    await session.refresh()
    if (session.probe().state !== 'running') return null
    session.timer = setInterval(() => { void session.refresh() }, 2_000)
    return session
  }

  probe(): HarnessProbe {
    return this.stopped ? { state: 'ended', reason: 'harness-gone' }
      : performance.now() - this.observedAt > FRESH_MS
        ? { state: 'uncertain', reason: 'grok-roster-stale' } : this.observed
  }

  private observe(list: Row[]): void {
    const matches = list.filter(row => row.sessionId === this.sessionId)
    this.observedAt = performance.now()
    this.observed = matches.length === 0 || (matches.length === 1 && !matches[0]!.resident)
      ? { state: 'ended', reason: 'session-replaced' }
      : matches.length === 1 && matches[0]!.cwd === this.cwd && ['idle', 'working', 'needs_input'].includes(matches[0]!.activity)
        ? { state: 'running', activity: matches[0]!.activity === 'idle' ? 'idle' : 'working' }
        : { state: 'uncertain', reason: 'grok-session-ambiguous' }
    if (this.observed.state === 'ended') this.stopped = true
  }

  async refresh(): Promise<void> {
    if (this.refreshing !== null) return this.refreshing
    this.refreshing = (async () => {
      let peer: Peer | undefined
      try {
        peer = await Peer.connect(this.socketPath, this.identity)
        this.observe(rows(await peer.call('_x.ai/sessions/list', {})))
      } catch {
        this.observed = { state: 'uncertain', reason: 'grok-leader-unavailable' }
        try {
          if (socketIdentity(this.socketPath) !== this.identity) this.stopped = true
        } catch { this.stopped = true }
        this.observedAt = performance.now()
      } finally { peer?.close() }
    })().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  async write(text: string, begin: () => boolean, guard: WriteGuard): Promise<SessionWriteResult> {
    let peer: Peer | undefined
    let committed = false
    let began = false
    try {
      if (this.stopped) return { status: 'stopped' }
      peer = await Peer.connect(this.socketPath, this.identity)
      this.observe(rows(await peer.call('_x.ai/sessions/list', {})))
      if (this.probe().state !== 'running') return { status: 'stopped' }
      if (!guard.writable() || !begin()) return { status: 'cancelled' }
      committed = true
      const reply = await peer.call('_x.ai/interject', { sessionId: this.sessionId, text }, () => {
        if (!guard.writable() || guard.remainingMs() <= 0) return false
        began = true
        return true
      }, Math.min(RPC_MS, Math.max(1, guard.remainingMs()))) as { result?: { status?: unknown } }
      if (reply?.result?.status !== 'queued') throw new Error('grok-write-unconfirmed')
      return { status: 'written', route: 'inbox-socket' }
    } catch (error) {
      return began ? { status: 'failed', reason: 'grok-write-unconfirmed', error }
        : committed ? { status: 'aborted', reason: 'grok-write-fenced' }
        : { status: 'unavailable', reason: 'grok-session-unavailable' }
    } finally {
      // A targeted RPC attaches its client. Close promptly so Notifai cannot
      // keep an otherwise closed User session alive merely by observing it.
      peer?.close()
    }
  }

  close(): void { this.stopped = true; if (this.timer !== null) clearInterval(this.timer) }
}
