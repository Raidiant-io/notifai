/** Optional native queue control. Discovery never starts or resumes a session. */
import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { codexHome } from './codex-wake.js'

const execute = promisify(execFile)
export interface NativeQueueItem { id: string; clientUserMessageId: string; input: Array<{ type: string; text?: string }> }
export interface QueueControl {
  namespace: string
  threadId: string
  add(token: string, text: string): Promise<string>
  find(token: string, text: string): Promise<'absent' | 'ambiguous' | { id: string }>
  remove(id: string): Promise<boolean>
  close(): void
}

/** Positive evidence that no request bytes were sent. */
export class NativeQueueNotSent extends Error {}

/** Missing capability is a preflight result. Once add begins, errors are
 * uncertain acceptance, never permission to try another writer. */
export async function connectCodexQueue(
  sessionId: string, env: NodeJS.ProcessEnv, deadlineAt: number,
  now: () => number = () => performance.now(),
  unavailable?: (stage: string) => void,
): Promise<QueueControl | null> {
  let socket: WebSocket | undefined
  let stage = 'discovery'
  try {
    const remaining = () => Math.max(1, Math.ceil(deadlineAt - now()))
    const { stdout } = await execute('codex', ['app-server', 'daemon', 'version'], {
      env, timeout: remaining(), maxBuffer: 16_384,
    })
    const version = JSON.parse(stdout) as { status?: string; socketPath?: string }
    if (version.status !== 'running' || typeof version.socketPath !== 'string') throw new Error('No running daemon')
    stage = 'endpoint'
    const socketPath = realpathSync(version.socketPath)
    const endpoint = lstatSync(socketPath)
    if (!endpoint.isSocket() || (process.getuid !== undefined && endpoint.uid !== process.getuid())) throw new Error('Endpoint ownership unavailable')
    stage = 'connection'
    const home = realpathSync(codexHome(env))
    socket = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: 2 * 1024 * 1024 })
    const connected = socket
    const timer = setTimeout(() => connected.terminate(), remaining())
    connected.once('close', () => clearTimeout(timer))
    let seq = 0
    const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
    const fail = (error: Error) => { for (const p of pending.values()) p.reject(error); pending.clear() }
    connected.on('error', fail)
    connected.on('close', () => fail(new Error('Native queue connection closed; acceptance unknown')))
    connected.on('message', raw => {
      let value: { id?: number; result?: unknown; error?: unknown }
      try { value = JSON.parse(raw.toString()) as typeof value } catch { return }
      if (value === null || typeof value !== 'object' || typeof value.id !== 'number') return
      const waiting = pending.get(value.id)
      if (waiting === undefined) return
      pending.delete(value.id)
      if (value.error !== undefined) waiting.reject(new Error('Native queue RPC refused; acceptance not established'))
      else waiting.resolve(value.result)
    })
    await new Promise<void>((resolve, reject) => {
      connected.once('open', resolve)
      connected.once('error', reject)
      connected.once('close', () => reject(new Error('Native queue unavailable')))
    })
    const call = (method: string, params: unknown): Promise<unknown> => {
      try {
        const current = lstatSync(socketPath)
        if (realpathSync(version.socketPath!) !== socketPath || current.dev !== endpoint.dev ||
            current.ino !== endpoint.ino || now() >= deadlineAt || connected.readyState !== WebSocket.OPEN) {
          throw new Error('Native queue endpoint, connection or deadline changed')
        }
      } catch {
        return Promise.reject(new NativeQueueNotSent('Native queue request was not sent'))
      }
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        connected.send(JSON.stringify({ id, method, params }), error => {
          if (error) { pending.delete(id); reject(error) }
        })
      })
    }
    stage = 'initialize'
    const initialized = await call('initialize', { clientInfo: { name: 'notifai_queue_control', version: '1' }, capabilities: { experimentalApi: true } }) as { codexHome?: string }
    stage = 'namespace'
    if (initialized.codexHome === undefined || realpathSync(initialized.codexHome) !== home) throw new Error('Different native queue namespace')
    connected.send(JSON.stringify({ method: 'initialized', params: {} }))
    stage = 'loaded-thread'
    let loaded = false
    let loadedCursor: string | null = null
    for (let page = 0; page < 16; page += 1) {
      const result = await call('thread/loaded/list', loadedCursor === null ? {} : { cursor: loadedCursor }) as { data?: string[]; nextCursor?: string | null }
      if (!Array.isArray(result.data)) throw new Error('Unrecognized loaded-thread response')
      if (result.data.includes(sessionId)) { loaded = true; break }
      if (result.nextCursor == null) break
      if (result.nextCursor === loadedCursor) throw new Error('Unrecognized loaded-thread cursor')
      loadedCursor = result.nextCursor
    }
    if (!loaded) throw new Error('Exact owner thread is not loaded; refuse to load it')
    const list = async (): Promise<NativeQueueItem[]> => {
      const all: NativeQueueItem[] = []
      let cursor: string | null = null
      for (let page = 0; page < 16; page += 1) {
        const result = await call('thread/queue/list', { threadId: sessionId, ...(cursor === null ? {} : { cursor }) }) as { data: NativeQueueItem[]; nextCursor: string | null }
        if (!Array.isArray(result.data) || !result.data.every(item => typeof item.id === 'string' && typeof item.clientUserMessageId === 'string' && Array.isArray(item.input))) throw new Error('Unrecognized native queue response')
        all.push(...result.data)
        if (result.nextCursor === null) return all
        if (typeof result.nextCursor !== 'string' || result.nextCursor === cursor) throw new Error('Unrecognized native queue cursor')
        cursor = result.nextCursor
      }
      throw new Error('Native queue inspection exceeded its bound')
    }
    stage = 'queue-list'
    await list() // Capability check before any mutation or election.
    return {
      namespace: home,
      threadId: sessionId,
      add: async (token, text) => {
        const response = await call('thread/queue/add', { threadId: sessionId, clientUserMessageId: token, input: [{ type: 'text', text }] }) as { queuedSubmission?: NativeQueueItem }
        if (typeof response.queuedSubmission?.id !== 'string' || response.queuedSubmission.clientUserMessageId !== token) throw new Error('Native queue receipt unknown')
        return response.queuedSubmission.id
      },
      find: async (token, text) => {
        const matches = (await list()).filter(item => item.clientUserMessageId === token)
        if (matches.length === 0) return 'absent'
        const match = matches[0]!
        return matches.length === 1 && match.input.length === 1 && match.input[0]?.type === 'text' && match.input[0].text === text ? { id: match.id } : 'ambiguous'
      },
      remove: async id => {
        const result = await call('thread/queue/delete', { threadId: sessionId, queuedSubmissionId: id }) as { deleted?: boolean }
        if (typeof result.deleted !== 'boolean') throw new Error('Native queue deletion unknown')
        return result.deleted
      },
      close: () => connected.terminate(),
    }
  } catch {
    socket?.terminate()
    unavailable?.(stage)
    return null
  }
}
