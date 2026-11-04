/**
 * A minimal client of the local Orca app's runtime RPC, for the one place
 * Notifai answers through Orca itself: a Codex question card in an Orca chat
 * (`orca-chat-answers.ts`).
 *
 * The protocol is Orca's own and undocumented. The app writes its endpoint
 * (a Unix socket, or a named pipe on Windows) and an `authToken` to
 * `<userData>/orca-runtime.json`; each request is one JSON line
 * `{id, authToken, method, params}` and the reply is the line with the same
 * id. The token controls all of Orca, so it is read only for the request that
 * needs it and never logged, stored, printed or sent anywhere but that socket.
 * Every capability is checked (`status.get`) before use, and any refusal,
 * malformed reply or timeout reads as "unavailable": the caller keeps
 * Notifai's ordinary route.
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** Orca's runtime metadata file, under its `userData` directory. */
export const ORCA_RUNTIME_METADATA = 'orca-runtime.json'

/** Where Orca keeps its `userData`, as its own CLI resolves it. */
export function orcaUserDataPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, home = os.homedir()): string | null {
  const explicit = env['ORCA_USER_DATA_PATH']?.trim()
  if (explicit !== undefined && explicit !== '') return path.isAbsolute(explicit) ? explicit : null
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'orca')
  if (platform === 'win32') {
    const appData = env['APPDATA']?.trim()
    return appData === undefined || appData === '' ? null : path.join(appData, 'orca')
  }
  const config = env['XDG_CONFIG_HOME']?.trim()
  return path.join(config !== undefined && config !== '' ? config : path.join(home, '.config'), 'orca')
}

interface RuntimeEndpoint { endpoint: string; authToken: string }

/**
 * The endpoint and token, read now. On POSIX the file must be this user's and
 * private (Orca writes it 0600), and a Unix-socket endpoint must be one too.
 */
function readEndpoint(userData: string, platform: NodeJS.Platform): RuntimeEndpoint | null {
  const file = path.join(userData, ORCA_RUNTIME_METADATA)
  try {
    if (platform !== 'win32') {
      const stat = lstatSync(file)
      if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) return null
    }
    const meta = JSON.parse(readFileSync(file, 'utf8')) as { authToken?: unknown; transports?: unknown }
    if (typeof meta.authToken !== 'string' || meta.authToken === '' || !Array.isArray(meta.transports)) return null
    const local = meta.transports.find((entry: { kind?: unknown; endpoint?: unknown }) =>
      (platform === 'win32' ? entry?.kind === 'named-pipe' : entry?.kind === 'unix') && typeof entry.endpoint === 'string') as
      { endpoint: string } | undefined
    if (local === undefined) return null
    if (platform !== 'win32') {
      const socket = lstatSync(local.endpoint)
      if (!socket.isSocket() || (process.getuid !== undefined && socket.uid !== process.getuid())) return null
    } else if (!local.endpoint.startsWith('\\\\.\\pipe\\')) return null
    return { endpoint: local.endpoint, authToken: meta.authToken }
  } catch {
    return null
  }
}

export type OrcaRpcResult = { ok: true; result: unknown } | { ok: false; code: string }

export interface OrcaRuntime {
  /** One request on its own connection. Never throws; a timeout or refusal is `ok: false`. */
  call(method: string, params: unknown, timeoutMs?: number): Promise<OrcaRpcResult>
}

export function orcaRuntime(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): OrcaRuntime | null {
  const userData = orcaUserDataPath(env, platform)
  if (userData === null) return null
  return {
    call: (method, params, timeoutMs = 4_000) => new Promise((resolve) => {
      // Read per request: Orca rewrites the file when it restarts.
      const endpoint = readEndpoint(userData, platform)
      if (endpoint === null) { resolve({ ok: false, code: 'runtime_unavailable' }); return }
      const id = randomUUID()
      let settled = false
      let buffer = ''
      const socket = createConnection(endpoint.endpoint)
      const finish = (value: OrcaRpcResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        resolve(value)
      }
      const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), timeoutMs)
      socket.setEncoding('utf8')
      socket.once('error', () => finish({ ok: false, code: 'connection_failed' }))
      socket.once('close', () => finish({ ok: false, code: 'connection_closed' }))
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ id, authToken: endpoint.authToken, method, params })}\n`)
      })
      socket.on('data', (chunk: string) => {
        buffer += chunk
        if (buffer.length > 8 * 1024 * 1024) { finish({ ok: false, code: 'reply_too_large' }); return }
        let at: number
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at)
          buffer = buffer.slice(at + 1)
          let frame: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: unknown } }
          try { frame = JSON.parse(line) as typeof frame } catch { continue }
          if (frame?.id !== id) continue
          finish(frame.ok === true ? { ok: true, result: frame.result }
            : { ok: false, code: typeof frame.error?.code === 'string' ? frame.error.code : 'refused' })
        }
      })
    }),
  }
}

/** Orca's canonical JSON: sorted keys, `undefined` entries dropped. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
}

/** The `payloadFingerprint` Orca checks on a mutation: sha256 over `{method, sessionId, fields}`. */
export function orcaPayloadFingerprint(method: string, sessionId: string, fields: unknown): string {
  return createHash('sha256').update(canonical({ method, sessionId, fields })).digest('hex')
}

/** A durable operation id in Orca's shape: 13-digit milliseconds, a dash, 32 hex. */
export function orcaOperationId(now = Date.now()): string {
  return `${Math.trunc(now).toString().padStart(13, '0')}-${randomUUID().replaceAll('-', '').toLowerCase()}`
}

/** The capability strings `status.get` lists; null when Orca cannot be asked. */
export async function orcaCapabilities(runtime: OrcaRuntime, timeoutMs?: number): Promise<Set<string> | null> {
  const reply = await runtime.call('status.get', {}, timeoutMs)
  const capabilities = reply.ok ? (reply.result as { capabilities?: unknown } | null)?.capabilities : undefined
  return Array.isArray(capabilities) ? new Set(capabilities.filter((entry): entry is string => typeof entry === 'string')) : null
}
