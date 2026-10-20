/** Verified existing Codex connection shared by queue and answer adapters. */
import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import { codexHome } from './codex-wake.js'
import { canonicalSocketPath } from './local-path.js'
import { connectUnixWebSocket, type UnixWebSocket } from './unix-websocket.js'

const execute = promisify(execFile)
export type CodexControlMethod = 'thread/queue/list' | 'thread/queue/add' | 'thread/queue/delete' | 'thread/turns/list' | 'turn/steer' |
  // Whether a terminal still shows a thread (`codex-attach-signal.ts`).
  'thread/loaded/list' | 'thread/read' | 'mcpServerStatus/list' | 'thread/resume' | 'thread/unsubscribe'
export interface CodexControl {
  namespace: string
  threadId: string
  /** The thread is loaded in the server; always true unless the caller allowed otherwise. */
  loaded: boolean
  /** The running app-server's own version report, when it printed one. */
  serverVersion?: string
  call(method: CodexControlMethod, params: unknown): Promise<unknown>
  close(): void
}

/**
 * The identity every Notifai connection to a Codex app-server initializes with.
 *
 * Codex keeps one originator per app-server process: the first client that
 * initializes with an ordinary name claims it, and every thread that process
 * later creates records it (rollout `session_meta.originator`, the
 * `originator` header and user agent of its model requests). Each such
 * initialize also rewrites the process-wide user-agent suffix. Codex exempts
 * exactly the names its own tooling uses for side connections; discovery's
 * `codex app-server daemon version` already initializes with this one just
 * before Notifai connects. Using it means a Notifai connection never labels a
 * User's threads, whether it connects before or after their terminals.
 */
export const CODEX_CONTROL_CLIENT_INFO = Object.freeze({ name: 'codex_app_server_daemon', title: 'Notifai', version: '1' })

/** Positive evidence that this request sent no bytes. RPC refusal is uncertain. */
export class CodexControlNotSent extends Error {}

/** Discovery proves a running endpoint, its namespace and an already loaded
 * thread. It never loads, resumes or takes ownership of a thread. Every Notifai
 * connection to a Codex app-server is opened here, so it always initializes
 * with `CODEX_CONTROL_CLIENT_INFO`. With `allowUnloaded`, a thread the server
 * has not loaded is reported (`loaded: false`) instead of refused.
 * `executable` names the `codex` that discovers the server (default: the one
 * on PATH), and `acceptSocket` can refuse a server by its control socket
 * (as reported, and resolved) before anything connects to it. */
export async function connectCodexControl(
  sessionId: string, env: NodeJS.ProcessEnv, deadlineAt: number,
  now: () => number = () => performance.now(),
  unavailable?: (stage: string) => void,
  options: { allowUnloaded?: boolean; executable?: string; acceptSocket?: (reported: string, resolved: string) => boolean } = {},
): Promise<CodexControl | null> {
  let socket: UnixWebSocket | undefined
  let stage = 'discovery'
  try {
    const remaining = () => Math.max(1, Math.ceil(deadlineAt - now()))
    const { stdout } = await execute(options.executable ?? 'codex', ['app-server', 'daemon', 'version'], {
      env, timeout: remaining(), maxBuffer: 16_384,
    })
    const version = JSON.parse(stdout) as { status?: string; socketPath?: string; appServerVersion?: unknown; managedCodexVersion?: unknown }
    if (version.status !== 'running' || typeof version.socketPath !== 'string') throw new Error('No running daemon')
    const reported = [version.appServerVersion, version.managedCodexVersion].find(value => typeof value === 'string') as string | undefined
    stage = 'endpoint'
    const socketPath = canonicalSocketPath(version.socketPath)
    if (options.acceptSocket !== undefined && !options.acceptSocket(version.socketPath, socketPath)) throw new Error('Control socket refused')
    const endpoint = lstatSync(socketPath)
    if (!endpoint.isSocket() || (process.getuid !== undefined && endpoint.uid !== process.getuid())) throw new Error('Endpoint ownership unavailable')
    stage = 'connection'
    const home = realpathSync(codexHome(env))
    let seq = 0
    const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
    const fail = (error: Error) => { for (const p of pending.values()) p.reject(error); pending.clear() }
    const connected = await connectUnixWebSocket(socketPath, {
      message: raw => {
        let value: { id?: number; result?: unknown; error?: unknown }
        try { value = JSON.parse(raw) as typeof value } catch { return }
        if (value === null || typeof value !== 'object' || typeof value.id !== 'number') return
        const waiting = pending.get(value.id)
        if (waiting === undefined) return
        pending.delete(value.id)
        if (value.error !== undefined) waiting.reject(new Error('Native queue RPC refused; acceptance not established'))
        else waiting.resolve(value.result)
      },
      closed: () => fail(new Error('Native queue connection closed; acceptance unknown')),
    }, { maxPayload: 2 * 1024 * 1024, lifetimeMs: remaining() })
    socket = connected
    const call = (method: string, params: unknown): Promise<unknown> => {
      try {
        const current = lstatSync(socketPath)
        if (canonicalSocketPath(version.socketPath!) !== socketPath || current.dev !== endpoint.dev ||
            current.ino !== endpoint.ino || now() >= deadlineAt || !connected.open) {
          throw new Error('Native queue endpoint, connection or deadline changed')
        }
      } catch {
        return Promise.reject(new CodexControlNotSent('Native queue request was not sent'))
      }
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        connected.send(JSON.stringify({ id, method, params })).catch((error: Error) => { pending.delete(id); reject(error) })
      })
    }
    stage = 'initialize'
    const initialized = await call('initialize', { clientInfo: CODEX_CONTROL_CLIENT_INFO, capabilities: { experimentalApi: true } }) as { codexHome?: string }
    stage = 'namespace'
    if (initialized.codexHome === undefined || realpathSync(initialized.codexHome) !== home) throw new Error('Different native queue namespace')
    await connected.send(JSON.stringify({ method: 'initialized', params: {} }))
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
    if (!loaded && options.allowUnloaded !== true) throw new Error('Exact owner thread is not loaded; refuse to load it')
    return { namespace: home, threadId: sessionId, loaded, ...(reported === undefined ? {} : { serverVersion: reported }), call, close: () => connected.terminate() }
  } catch {
    socket?.terminate()
    unavailable?.(stage)
    return null
  }
}
