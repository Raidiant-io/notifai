/**
 * Which Codex home a thread runs in now, and cleaning up a wake left in the
 * home it ran in before.
 *
 * Codex keeps one queue per `CODEX_HOME`, read only by the process that runs
 * the thread in that home. Orca's "Restart Session" onto another account
 * resumes the thread with another `CODEX_HOME` (hard-linking only the
 * rollout), and a resumed Codex terminal runs no hook before its first
 * prompt, so Notifai would go on writing wakes into the old home, where
 * nothing runs them, and where they would fire later if the thread ever runs
 * there again. The thread's writer lock says where it runs: the process that
 * has it loaded holds `<home>/thread-writer-locks/<id>.lock` (`lsof` on
 * macOS, `/proc` on Linux; unknown on Windows, where the recorded home
 * stands).
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CODEX_CONTROL_CLIENT_INFO } from './codex-native-control.js'
import { codexThreadHoldersAsync } from './codex-session-end.js'
import { orcaUserDataPath } from './orca-runtime.js'
import { processStartTime, type ProcessIdentity } from './process-identity.js'
import { isSessionInputWake } from './session-inputs.js'

const same = (home: string): string => { try { return realpathSync(home) } catch { return path.resolve(home) } }

/**
 * The homes a thread may run in: the recorded one, the homes of the other
 * conversations Notifai attends, Orca's account homes, and `~/.codex`.
 */
export function codexHomeCandidates(input: { recorded: string | null; known: Iterable<string | null>; env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform; home?: string }): string[] {
  const home = input.home ?? (input.env['HOME']?.trim() || os.homedir())
  const found: string[] = []
  const add = (candidate: string | null | undefined) => {
    if (candidate === null || candidate === undefined || candidate === '') return
    if (!found.some((entry) => same(entry) === same(candidate))) found.push(candidate)
  }
  add(input.recorded)
  for (const known of input.known) add(known)
  const orca = orcaUserDataPath(input.env, input.platform ?? process.platform, home)
  if (orca !== null) {
    const accounts = path.join(orca, 'codex-accounts')
    let names: string[] = []
    try { names = readdirSync(accounts) } catch { /* no Orca accounts */ }
    for (const name of names) if (existsSync(path.join(accounts, name, 'home'))) add(path.join(accounts, name, 'home'))
    if (existsSync(path.join(orca, 'codex-runtime-home', 'home'))) add(path.join(orca, 'codex-runtime-home', 'home'))
  }
  add(path.join(home, '.codex'))
  return found
}

export type CodexThreadHome = { home: string; holder: ProcessIdentity; ambiguous: boolean }

/**
 * The home whose writer lock a live process holds for this thread, other
 * than processes known to have exited: one holder is the home; several
 * (locks are per home) choose the most recently started. Null when nothing
 * holds it; unknown when a home cannot be read and nothing was found.
 */
export async function locateCodexThreadHome(threadId: string, candidates: readonly string[], seams: {
  holders?: (home: string, threadId: string) => number[] | 'unknown' | Promise<number[] | 'unknown'>
  startOf?: (pid: number) => string | null
  exited?: (identity: ProcessIdentity) => boolean
} = {}): Promise<CodexThreadHome | null | 'unknown'> {
  const holders = seams.holders ?? ((home, id) => codexThreadHoldersAsync(home, id))
  const startOf = seams.startOf ?? processStartTime
  let unknown = false
  const live: Array<{ home: string; holder: ProcessIdentity; at: number }> = []
  const found = await Promise.all(candidates.map(async (home) => ({ home, pids: await holders(home, threadId) })))
  for (const { home, pids } of found) {
    if (pids === 'unknown') { unknown = true; continue }
    for (const pid of pids) {
      if (pid === process.pid) continue
      const start = startOf(pid)
      if (start === null) continue
      const holder = { pid, start }
      if (seams.exited?.(holder) === true) continue
      const at = Date.parse(start)
      live.push({ home, holder, at: Number.isFinite(at) ? at : 0 })
    }
  }
  if (live.length === 0) return unknown ? 'unknown' : null
  live.sort((a, b) => b.at - a.at)
  const homes = new Set(live.map((entry) => same(entry.home)))
  return { home: live[0]!.home, holder: live[0]!.holder, ambiguous: homes.size > 1 }
}

export function sameCodexHome(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && same(a) === same(b)
}

export type OrphanRemoval = 'deleted' | 'gone' | 'held' | 'shared-server' | 'not-a-wake' | 'failed'

/**
 * Settings that keep a short-lived server in another account's Codex home
 * from doing anything but answer: credentials in memory only (so it reads
 * none, refreshes none and rewrites no `auth.json`), no plugin sync (whose
 * Git work leaves `.tmp/git-*` behind when a server stops mid-sync), no
 * update check.
 */
export const QUIET_CODEX_SERVER_ARGS = Object.freeze(['-c', 'cli_auth_credentials_store="ephemeral"', '-c', 'features.plugins=false',
  '-c', 'check_for_update_on_startup=false', 'app-server'])

/** Credentials a server would take from its environment instead of its home: never handed to a quiet one. */
const CREDENTIAL_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY']

export interface QuietQueue {
  list(threadId: string, cursor?: string): Promise<{ data?: QueueItem[]; nextCursor?: unknown } | null>
  remove(threadId: string, queuedId: string): Promise<{ deleted?: unknown } | null>
  close(): Promise<void>
}
type QueueItem = { id?: unknown; input?: Array<{ type?: unknown; text?: unknown }> }

/** One quiet private `codex app-server` in `home`, for queue requests only; closed by ending its input, as a client leaving does. */
export function openQuietCodexQueue(input: { home: string; env: NodeJS.ProcessEnv; cwd: string; executable?: string; timeoutMs?: number }): QuietQueue {
  const env: NodeJS.ProcessEnv = { ...input.env, CODEX_HOME: input.home }
  for (const name of CREDENTIAL_ENV) delete env[name]
  const child = spawn(input.executable ?? 'codex', [...QUIET_CODEX_SERVER_ARGS], { cwd: input.cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  let exited = false
  const waiting = new Map<number, (value: { result?: unknown; error?: unknown } | null) => void>()
  child.on('exit', () => { exited = true; for (const resolve of waiting.values()) resolve(null); waiting.clear() })
  child.on('error', () => { exited = true; for (const resolve of waiting.values()) resolve(null); waiting.clear() })
  child.stdin?.on('error', () => undefined)
  let buffer = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    if (buffer.length > 8 * 1024 * 1024) { child.kill(); return }
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let message: { id?: unknown; method?: unknown; result?: unknown; error?: unknown }
      try { message = JSON.parse(line) as typeof message } catch { continue }
      if (typeof message.id === 'number' && message.method === undefined) { waiting.get(message.id)?.(message); waiting.delete(message.id) }
      // A server request (none is expected for queue calls) is declined.
      else if (message.id !== undefined && typeof message.method === 'string') child.stdin?.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'declined' } })}\n`)
    }
  })
  let next = 0
  const call = (method: string, params: unknown): Promise<{ result?: unknown; error?: unknown } | null> => new Promise((resolve) => {
    if (exited) { resolve(null); return }
    const id = ++next
    const timer = setTimeout(() => { waiting.delete(id); resolve(null) }, input.timeoutMs ?? 8_000)
    waiting.set(id, (value) => { clearTimeout(timer); resolve(value) })
    child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`)
  })
  const ready = (async () => {
    const init = await call('initialize', { clientInfo: CODEX_CONTROL_CLIENT_INFO, capabilities: { experimentalApi: true } })
    if (init === null || init.error !== undefined) return false
    child.stdin?.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    return true
  })()
  const result = async (method: string, params: unknown) => {
    if (!(await ready)) return null
    const reply = await call(method, params)
    return reply === null || reply.error !== undefined ? null : reply.result as never
  }
  return {
    list: (threadId, cursor) => result('thread/queue/list', { threadId, limit: 100, ...(cursor === undefined ? {} : { cursor }) }),
    remove: (threadId, queuedId) => result('thread/queue/delete', { threadId, queuedSubmissionId: queuedId }),
    close: async () => {
      if (exited) return
      child.stdin?.end()
      const gone = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000)
        child.once('exit', () => { clearTimeout(timer); resolve(true) })
      })
      if (!gone) child.kill('SIGTERM')
    },
  }
}

/** Whether Codex's shared server runs for this home: queue writes then go only through it, so nothing is removed here. */
export async function codexSharedServerRuns(home: string, env: NodeJS.ProcessEnv, executable = 'codex'): Promise<boolean | 'unknown'> {
  return await new Promise((resolve) => {
    execFile(executable, ['app-server', 'daemon', 'version'], { env: { ...env, CODEX_HOME: home }, timeout: 5_000, maxBuffer: 16_384, encoding: 'utf8' }, (err, stdout) => {
      try { resolve((JSON.parse(stdout) as { status?: unknown }).status === 'running') } catch { resolve(err === null ? false : 'unknown') }
    })
  })
}

/** Exactly Notifai's content-free wake: one text part, the wake text and nothing else. */
export function contentFreeWake(item: QueueItem): boolean {
  const parts = Array.isArray(item.input) ? item.input : []
  return parts.length === 1 && parts[0]?.type === 'text' && typeof parts[0].text === 'string' && isSessionInputWake(parts[0].text)
}

/**
 * Remove a wake Notifai left in a home the thread no longer runs in, through
 * Codex's own API in a quiet server (`openQuietCodexQueue`), never loading
 * the thread there. Only while nothing runs the thread in that home (looked
 * at again right before the delete) and no shared server runs for it, and
 * only an item that is exactly a content-free Notifai wake: a note, an answer
 * or anyone else's message stays.
 */
export async function removeOrphanCodexWake(input: { home: string; threadId: string; queuedId: string; env: NodeJS.ProcessEnv; cwd: string
  holders?: (home: string, threadId: string) => number[] | 'unknown' | Promise<number[] | 'unknown'>
  sharedServer?: (home: string) => Promise<boolean | 'unknown'>
  open?: (home: string) => QuietQueue }): Promise<OrphanRemoval> {
  const holders = input.holders ?? ((home: string, id: string) => codexThreadHoldersAsync(home, id))
  const free = async () => { const found = await holders(input.home, input.threadId); return found !== 'unknown' && found.every((pid) => pid === process.pid) }
  if (!(await free())) return 'held'
  if ((await (input.sharedServer ?? ((home) => codexSharedServerRuns(home, input.env)))(input.home)) !== false) return 'shared-server'
  const queue = (input.open ?? ((home) => openQuietCodexQueue({ home, env: input.env, cwd: input.cwd })))(input.home)
  try {
    let item: QueueItem | undefined
    let cursor: string | undefined
    for (let page = 0; page < 10 && item === undefined; page += 1) {
      const listed = await queue.list(input.threadId, cursor)
      if (listed === null || !Array.isArray(listed.data)) return 'failed'
      item = listed.data.find((entry) => entry?.id === input.queuedId)
      if (item !== undefined || typeof listed.nextCursor !== 'string') break
      cursor = listed.nextCursor
    }
    if (item === undefined) return 'gone'
    if (!contentFreeWake(item)) return 'not-a-wake'
    // The thread may have come back to this home meanwhile: then the wake is its own again.
    if (!(await free())) return 'held'
    const deleted = await queue.remove(input.threadId, input.queuedId)
    return deleted?.deleted === true ? 'deleted' : deleted?.deleted === false ? 'gone' : 'failed'
  } finally {
    await queue.close()
  }
}
