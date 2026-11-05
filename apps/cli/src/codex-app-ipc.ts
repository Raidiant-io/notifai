/**
 * The Codex desktop app's local IPC router: how Notifai starts the next turn
 * of a conversation the User stopped in the app.
 *
 * Codex runs nothing queued past a stopped turn (its interrupt pause), and
 * the app's own server is private to the app. The app's windows share
 * threads over a local router any process of this user may join
 * (`~/.codex/ipc/ipc.sock`; `\\.\pipe\codex-ipc` on Windows): 4-byte
 * little-endian length, then JSON. `thread-owner-discovery` names the window
 * that has the conversation open, and `thread-follower-start-turn` makes that
 * window start a turn itself, as the User sending a message there does.
 * Model, permissions and folder stay the conversation's own.
 *
 * Internal to the app and versioned per method: anything unexpected
 * (a version mismatch, no handler, no window that has the conversation open)
 * is a plain "not here", and the answer waits for the User's next message.
 * Nothing the router broadcasts is read or kept: it can carry conversation
 * content.
 */
import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** Method versions this was verified with (ChatGPT app 26.1029, bundled Codex 0.166.0-alpha.6, 2026-11-05). */
const DISCOVERY_VERSION = 1
const START_TURN_VERSION = 2
/** The router waits on every client for discovery; this bounds that wait. */
const DISCOVERY_TIMEOUT_MS = 5_000
const DISCOVERY_WAIT_MS = 14_000
const START_TIMEOUT_MS = 15_000

export type CodexAppOwner = { kind: 'owned'; clientId: string } | { kind: 'not-owned' } | { kind: 'unavailable'; reason: string }
export type CodexAppStart = 'started' | 'refused' | 'unknown'

/** Whether the thread's Codex build is one the router's methods were verified with (0.166 or later; a prerelease counts). */
export function codexAppIpcVerified(cliVersion: string | null | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(cliVersion ?? '')
  if (match === null) return false
  const [major, minor] = [Number(match[1]), Number(match[2])]
  return major > 0 || minor >= 166
}

/** Where the app's router listens for this user. */
export function codexAppIpcPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return '\\\\.\\pipe\\codex-ipc'
  const home = env['HOME']?.trim() || os.homedir()
  return path.join(home, '.codex', 'ipc', 'ipc.sock')
}

interface Frame { type?: unknown; requestId?: unknown; resultType?: unknown; error?: unknown; result?: unknown; handledByClientId?: unknown; method?: unknown }

/** One connection to the router, as a client that handles nothing. */
export interface CodexAppIpc {
  owner(threadId: string): Promise<CodexAppOwner>
  startTurn(owner: string, threadId: string, text: string): Promise<CodexAppStart>
  close(): void
}

export async function openCodexAppIpc(socketPath: string, deadlineAt: number, connect: (path: string) => Socket = createConnection): Promise<CodexAppIpc | null> {
  const remaining = () => Math.max(1, deadlineAt - Date.now())
  let socket: Socket
  try { socket = connect(socketPath) } catch { return null }
  let buffer = Buffer.alloc(0)
  let clientId = 'initializing-client'
  let closed = false
  const waiting = new Map<string, (frame: Frame | null) => void>()
  const write = (frame: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify(frame), 'utf8')
    const head = Buffer.alloc(4)
    head.writeUInt32LE(body.length, 0)
    socket.write(Buffer.concat([head, body]))
  }
  const finish = () => {
    closed = true
    for (const resolve of waiting.values()) resolve(null)
    waiting.clear()
  }
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0)
      // A frame beyond any the router sends ends the connection rather than buffering it.
      if (size > 16 * 1024 * 1024) { socket.destroy(); return }
      if (buffer.length < 4 + size) break
      let frame: Frame
      try { frame = JSON.parse(buffer.subarray(4, 4 + size).toString('utf8')) as Frame } catch { frame = {} }
      buffer = buffer.subarray(4 + size)
      if (frame.type === 'response' && typeof frame.requestId === 'string') {
        waiting.get(frame.requestId)?.(frame)
        waiting.delete(frame.requestId)
      } else if (frame.type === 'client-discovery-request') {
        write({ type: 'client-discovery-response', requestId: frame.requestId, response: { canHandle: false } })
      } else if (frame.type === 'request') {
        write({ type: 'response', requestId: frame.requestId, resultType: 'error', error: 'no-handler-for-request' })
      }
      // Broadcasts are neither read nor kept.
    }
  })
  socket.on('error', finish)
  socket.on('close', finish)
  const connected = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), remaining())
    socket.once('connect', () => { clearTimeout(timer); resolve(true) })
    socket.once('error', () => { clearTimeout(timer); resolve(false) })
  })
  if (!connected) { socket.destroy(); return null }
  const request = (method: string, params: unknown, extra: Record<string, unknown>, timeoutMs: number): Promise<Frame | null> => {
    if (closed) return Promise.resolve(null)
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(requestId); resolve(null) }, Math.min(timeoutMs, remaining()))
      waiting.set(requestId, (frame) => { clearTimeout(timer); resolve(frame) })
      write({ type: 'request', requestId, sourceClientId: clientId, method, params, ...extra })
    })
  }
  const init = await request('initialize', { clientType: 'notifai' }, { version: 0 }, 3_000)
  const id = (init?.result as { clientId?: unknown } | undefined)?.clientId
  if (init?.resultType !== 'success' || typeof id !== 'string') { socket.destroy(); return null }
  clientId = id
  return {
    owner: async (threadId) => {
      // The router answers "no window" only after every window had its say: about 10 seconds (live).
      const reply = await request('thread-owner-discovery', { hostId: 'local', conversationId: threadId },
        { version: DISCOVERY_VERSION, timeoutMs: DISCOVERY_TIMEOUT_MS }, DISCOVERY_WAIT_MS)
      if (reply === null) return { kind: 'unavailable', reason: 'no-reply' }
      if (reply.resultType === 'success' && typeof reply.handledByClientId === 'string') return { kind: 'owned', clientId: reply.handledByClientId }
      if (reply.error === 'no-client-found') return { kind: 'not-owned' }
      return { kind: 'unavailable', reason: typeof reply.error === 'string' ? reply.error : 'unexpected' }
    },
    startTurn: async (owner, threadId, text) => {
      const reply = await request('thread-follower-start-turn', {
        conversationId: threadId,
        turnStart: { request: { threadId, input: [{ type: 'text', text, text_elements: [] }] }, context: {} },
      }, { version: START_TURN_VERSION, targetClientId: owner, timeoutMs: START_TIMEOUT_MS }, START_TIMEOUT_MS + 1_000)
      // No reply: the window may have started it; it is never asked again.
      if (reply === null) return 'unknown'
      return reply.resultType === 'success' ? 'started' : 'refused'
    },
    close: () => { socket.destroy() },
  }
}
