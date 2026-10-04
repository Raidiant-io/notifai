/** Verified existing Codex connection shared by queue and answer adapters. */
import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { codexHome } from './codex-wake.js'

const execute = promisify(execFile)
export type CodexControlMethod = 'thread/queue/list' | 'thread/queue/add' | 'thread/queue/delete' | 'thread/turns/list' | 'turn/steer'
export interface CodexControl {
  namespace: string
  threadId: string
  call(method: CodexControlMethod, params: unknown): Promise<unknown>
  close(): void
}

/** Positive evidence that this request sent no bytes. RPC refusal is uncertain. */
export class CodexControlNotSent extends Error {}

/** Discovery proves a running endpoint, its namespace and an already loaded
 * thread. It never loads, resumes or takes ownership of a thread. */
export async function connectCodexControl(
  sessionId: string, env: NodeJS.ProcessEnv, deadlineAt: number,
  now: () => number = () => performance.now(),
  unavailable?: (stage: string) => void,
): Promise<CodexControl | null> {
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
        return Promise.reject(new CodexControlNotSent('Native queue request was not sent'))
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
    const initialized = await call('initialize', { clientInfo: { name: 'notifai_control', version: '1' }, capabilities: { experimentalApi: true } }) as { codexHome?: string }
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
    return { namespace: home, threadId: sessionId, call, close: () => connected.terminate() }
  } catch {
    socket?.terminate()
    unavailable?.(stage)
    return null
  }
}
