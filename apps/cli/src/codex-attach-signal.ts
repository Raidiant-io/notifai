/**
 * Whether a terminal still shows a conversation on Codex's shared server.
 *
 * A plain `codex` terminal joins the shared server, which keeps the thread
 * loaded for about 30 minutes after the terminal closes and tells no one:
 * no hook, no notification. A wake queued there would start a turn nobody
 * sees. Two checks answer the question instead:
 *
 * 1. **Passive** (15–80 ms, no side effects). Each plain `codex` terminal runs
 *    its own `codex_tui` MCP server on a localhost port, and the shared server
 *    names that port for every thread the terminal loaded. The thread counts
 *    as shown when a live `codex` process still listens there, that process
 *    started before the thread's last load (its writer lock's mtime, rewritten
 *    on every load and untouched by a join), and it has not loaded a newer
 *    thread since.
 * 2. **Confirming request.** `thread/resume {config:{}}` on an idle loaded
 *    thread *joins* the caller when another client is subscribed, and *reloads*
 *    the thread when nobody is (its writer lock is rewritten, and Codex runs
 *    SessionEnd). Notifai unsubscribes at once either way. It is never sent to
 *    a thread the server has not loaded: that would load it.
 *
 * Both depend on Codex behaviour Codex does not promise. They are used only on
 * a Codex build the local behaviour check has verified (`codex-attach-canary.ts`);
 * anything else, and any error, timeout or missing piece, answers `unknown`,
 * which every caller treats as "not shown": no wake.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { connectCodexControl, type CodexControl } from './codex-native-control.js'
import { stateDir } from './config.js'
import { normalizeProcessStart, processStartTime, processWallStart, type ProcessIdentity } from './process-identity.js'

/**
 * What Notifai can say about a thread on the shared server:
 * - `attached`: a terminal shows it;
 * - `closed`: no terminal shows it (the terminal closed or moved on);
 * - `not-loaded`: the server has unloaded it;
 * - `unknown`: Notifai cannot tell (unverified Codex build, an error, a busy
 *   thread): treated as not shown.
 *
 * `confirmed` is true only when the confirming request decided it: a join
 * for `attached`, a reload for `closed`.
 */
export type CodexAttachState =
  | { state: 'attached' | 'closed'; confirmed: boolean; reason: string }
  | { state: 'not-loaded' | 'unknown'; confirmed: false; reason: string }

/**
 * When to send the confirming request after the passive check:
 * `attached` before a wake (the passive "shown" has one rare unsafe shape),
 * `closed` before expiring questions (its "not shown" has one rare safe shape),
 * `always` for both, `never` for the passive check alone.
 */
export type CodexAttachConfirm = 'attached' | 'closed' | 'always' | 'never'

export interface CodexAttachInput {
  threadId: string
  /** Carries the thread's `CODEX_HOME`. */
  env: NodeJS.ProcessEnv
  /** The shared server that hosts the thread. */
  host: ProcessIdentity
  confirm: CodexAttachConfirm
  /** Runs just before the confirming request: its reload's SessionEnd is Notifai's own. */
  beforeConfirm?: () => void
  /** Default 5 s. */
  deadlineMs?: number
}

export interface CodexListener { pid: number; startedAtMs: number }

export interface CodexAttachDeps {
  /** Whether the behaviour check passed for the binary this server runs. */
  verified(host: ProcessIdentity, env: NodeJS.ProcessEnv): boolean
  connect(threadId: string, env: NodeJS.ProcessEnv, deadlineAt: number): Promise<CodexControl | null>
  /** The live `codex` process listening on a localhost port, or null. */
  listener(port: number): CodexListener | null
  /** Milliseconds since the epoch of the thread's last load, or null. */
  lockMtime(home: string, threadId: string): number | null
  now(): number
}

const DEFAULT_DEADLINE_MS = 5_000

export function codexThreadLockMtime(home: string, threadId: string): number | null {
  try { return statSync(path.join(home, 'thread-writer-locks', `${threadId}.lock`)).mtimeMs } catch { return null }
}

/** `ps -o lstart` text under UTC (`Tue Oct 20 18:53:09 2026`) as epoch milliseconds. */
export function parseProcessStart(text: string): number | null {
  const match = /^\w{3} (\w{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})$/.exec(text.trim().replace(/\s+/g, ' '))
  if (match === null) return null
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[1]!)
  if (month < 0) return null
  return Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]))
}

/** One `netstat` (macOS) or `ss` (Linux) call: the `codex` process listening on 127.0.0.1:port. */
export function codexListenerOn(port: number, platform: NodeJS.Platform = process.platform): CodexListener | null {
  let pid: number | null = null
  const run = (command: string, args: string[]): string => {
    try {
      return execFileSync(command, args, { encoding: 'utf8', timeout: 3_000, maxBuffer: 8 * 1024 * 1024,
        env: { PATH: '/usr/sbin:/usr/bin:/bin:/sbin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { return '' }
  }
  if (platform === 'darwin') {
    pid = parseNetstatListener(run('netstat', ['-anv', '-p', 'tcp']), port)
  } else if (platform === 'linux') {
    pid = parseSsListener(run('ss', ['-ltnpH', `sport = :${port}`]))
  }
  if (pid === null) return null
  const start = processWallStart(pid)
  const startedAtMs = start === null ? null : parseProcessStart(start)
  return startedAtMs === null ? null : { pid, startedAtMs }
}

/** macOS `netstat -anv -p tcp`: a LISTEN row on 127.0.0.1.<port> owned by `codex:<pid>`. */
export function parseNetstatListener(output: string, port: number): number | null {
  for (const line of output.split('\n')) {
    const words = line.trim().split(/\s+/)
    if (words[3] !== `127.0.0.1.${port}` || words[5] !== 'LISTEN') continue
    for (const word of words.slice(6)) {
      const owner = /^(.+):(\d+)$/.exec(word)
      if (owner !== null && owner[1]!.startsWith('codex')) return Number(owner[2])
    }
  }
  return null
}

/** Linux `ss -ltnpH`: `users:(("codex",pid=123,fd=9))`. */
export function parseSsListener(output: string): number | null {
  const owner = /users:\(\("(codex[^"]*)",pid=(\d+)/.exec(output)
  return owner === null ? null : Number(owner[2])
}

export const systemCodexAttachDeps: CodexAttachDeps = {
  verified: (host, env) => codexAttachVerified(host, env),
  connect: (threadId, env, deadlineAt) => connectCodexControl(threadId, env, deadlineAt, undefined, undefined, { allowUnloaded: true }),
  listener: (port) => codexListenerOn(port),
  lockMtime: codexThreadLockMtime,
  now: () => performance.now(),
}

/** The port of a `codex_tui` origin on this machine, or null. */
function localPort(origin: string): number | null {
  try {
    const url = new URL(origin)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null
    const port = Number(url.port)
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null
  } catch { return null }
}

async function tuiOrigin(control: CodexControl, threadId: string): Promise<string | null> {
  // Always name the server: without it Codex opens a session against the terminal's MCP server.
  const result = await control.call('mcpServerStatus/list', { threadId, serverName: 'codex_tui', detail: 'toolsAndAuthOnly' }) as
    { data?: Array<{ name?: unknown; httpOrigin?: unknown }> } | null
  const entry = result?.data?.find((server) => server.name === 'codex_tui') ?? result?.data?.[0]
  return typeof entry?.httpOrigin === 'string' && entry.httpOrigin !== '' ? entry.httpOrigin : null
}

async function loadedThreads(control: CodexControl): Promise<string[]> {
  const all: string[] = []
  let cursor: string | null = null
  for (let page = 0; page < 16; page += 1) {
    const result = await control.call('thread/loaded/list', cursor === null ? {} : { cursor }) as { data?: unknown; nextCursor?: unknown } | null
    if (!Array.isArray(result?.data)) throw new Error('Unrecognized loaded-thread response')
    all.push(...result.data.filter((id): id is string => typeof id === 'string'))
    if (result.nextCursor == null) return all
    if (typeof result.nextCursor !== 'string' || result.nextCursor === cursor) throw new Error('Unrecognized loaded-thread cursor')
    cursor = result.nextCursor
  }
  throw new Error('Loaded-thread listing exceeded its bound')
}

/** The passive check on one loaded thread (no side effects). */
export async function passiveAttachCheck(control: CodexControl, home: string, threadId: string,
  deps: Pick<CodexAttachDeps, 'listener' | 'lockMtime'>): Promise<{ attached: boolean; reason: string; terminal?: number }> {
  const origin = await tuiOrigin(control, threadId)
  if (origin === null) return { attached: false, reason: 'no-terminal-loaded-it' }
  const port = localPort(origin)
  if (port === null) return { attached: false, reason: 'not-a-local-terminal' }
  const loadedAt = deps.lockMtime(home, threadId)
  if (loadedAt === null) throw new Error('No writer lock for a loaded thread')
  const listener = deps.listener(port)
  if (listener === null) return { attached: false, reason: 'terminal-gone' }
  // A process that started after the thread's last load is not the terminal
  // that loaded it (a reused pid or port). `ps` reads whole seconds.
  if (listener.startedAtMs > loadedAt + 1_000) return { attached: false, reason: 'listener-newer-than-load' }
  for (const other of await loadedThreads(control)) {
    if (other === threadId || (deps.lockMtime(home, other) ?? 0) <= loadedAt) continue
    if (await tuiOrigin(control, other) === origin) return { attached: false, reason: 'terminal-moved-on', terminal: listener.pid }
  }
  return { attached: true, reason: 'terminal-live', terminal: listener.pid }
}

/**
 * The confirming request on an idle loaded thread: joined (a client is
 * subscribed) or reloaded (nobody was). Unsubscribes either way.
 */
export async function confirmBySubscribers(control: CodexControl, home: string, threadId: string,
  deps: Pick<CodexAttachDeps, 'lockMtime'>, beforeConfirm?: () => void): Promise<'joined' | 'reloaded' | 'busy'> {
  const read = await control.call('thread/read', { threadId }) as { thread?: { status?: { type?: unknown } } } | null
  // An active thread joins whoever asks, subscribed or not: no answer there.
  if (read?.thread?.status?.type !== 'idle') return 'busy'
  const before = deps.lockMtime(home, threadId)
  if (before === null) throw new Error('No writer lock for a loaded thread')
  beforeConfirm?.()
  try {
    await control.call('thread/resume', { threadId, config: {}, excludeTurns: true })
  } finally {
    await control.call('thread/unsubscribe', { threadId }).catch(() => undefined)
  }
  return deps.lockMtime(home, threadId) !== before ? 'reloaded' : 'joined'
}

/**
 * Whether a terminal shows a thread on the shared server, by the passive
 * check and, as `confirm` asks, the confirming request. Fails closed:
 * anything uncertain is `unknown`.
 */
export async function codexThreadAttachState(input: CodexAttachInput, overrides: Partial<CodexAttachDeps> = {}): Promise<CodexAttachState> {
  const deps = { ...systemCodexAttachDeps, ...overrides }
  if (!deps.verified(input.host, input.env)) return { state: 'unknown', confirmed: false, reason: 'codex-build-unverified' }
  const deadlineAt = deps.now() + (input.deadlineMs ?? DEFAULT_DEADLINE_MS)
  const control = await deps.connect(input.threadId, input.env, deadlineAt)
  if (control === null) return { state: 'unknown', confirmed: false, reason: 'no-server-connection' }
  try {
    if (!control.loaded) return { state: 'not-loaded', confirmed: false, reason: 'not-loaded' }
    const home = control.namespace
    const passive = await passiveAttachCheck(control, home, input.threadId, deps)
    const asks = input.confirm === 'always' || input.confirm === (passive.attached ? 'attached' : 'closed')
    if (!asks) return { state: passive.attached ? 'attached' : 'closed', confirmed: false, reason: passive.reason }
    const confirmed = await confirmBySubscribers(control, home, input.threadId, deps, input.beforeConfirm)
    if (confirmed === 'busy') return { state: 'unknown', confirmed: false, reason: 'thread-busy' }
    return confirmed === 'joined'
      ? { state: 'attached', confirmed: true, reason: `${passive.reason}+joined` }
      : { state: 'closed', confirmed: true, reason: `${passive.reason}+reloaded` }
  } catch {
    return { state: 'unknown', confirmed: false, reason: 'check-failed' }
  } finally {
    control.close()
  }
}

// -- the behaviour check's results, per Codex binary -------------------------------

/** What identifies a Codex binary: its real path, size and modification time. */
export interface CodexBinaryIdentity { path: string; size: number; mtimeMs: number }

export interface CodexAttachCanaryResult {
  binary: CodexBinaryIdentity
  /** `codex --version` of that binary, for people. */
  codexVersion: string | null
  outcome: 'passed' | 'failed'
  /** The first check that failed (1–8), or 0 when the check could not run. */
  step?: number
  detail?: string
  checkedAt: number
  /** Consecutive failures to run the check, rather than failed behaviour. */
  startFailures?: number
}

const RESULTS_FILE = 'codex-attach-canary.json'
const RESULTS_KEPT = 8

export function codexAttachResultsPath(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), RESULTS_FILE)
}

/** The executable a process runs, by its real path, or null. */
export function processExecutablePath(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (platform === 'linux') return readlinkSync(`/proc/${pid}/exe`)
    if (platform !== 'darwin') return null
    // macOS prints the full path the process was started with.
    const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000, env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return path.isAbsolute(comm) ? comm : null
  } catch { return null }
}

export function codexBinaryIdentity(executable: string): CodexBinaryIdentity | null {
  try {
    const real = realpathSync(executable)
    const stats = statSync(real)
    return stats.isFile() ? { path: real, size: stats.size, mtimeMs: Math.trunc(stats.mtimeMs) } : null
  } catch { return null }
}

/** The binary a running process was started from; null once it changed on disk, or when it cannot be read. */
export function hostBinaryIdentity(host: ProcessIdentity): CodexBinaryIdentity | null {
  const executable = processExecutablePath(host.pid)
  const start = processStartTime(host.pid)
  if (executable === null || start === null || normalizeProcessStart(start) !== normalizeProcessStart(host.start)) return null
  const identity = codexBinaryIdentity(executable)
  // Replaced in place after the process started: it may not run what is on disk now.
  if (identity === null || identity.mtimeMs > (parseProcessStart(processWallStart(host.pid) ?? '') ?? 0) + 1_000) return null
  return identity
}

export function sameBinary(a: CodexBinaryIdentity, b: CodexBinaryIdentity): boolean {
  return a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs
}

export function readCodexAttachResults(env: NodeJS.ProcessEnv): CodexAttachCanaryResult[] {
  try {
    const parsed = JSON.parse(readFileSync(codexAttachResultsPath(env), 'utf8')) as { results?: unknown }
    if (!Array.isArray(parsed.results)) return []
    return parsed.results.filter((entry): entry is CodexAttachCanaryResult => {
      const value = entry as Partial<CodexAttachCanaryResult> | null
      return value !== null && typeof value === 'object' && (value.outcome === 'passed' || value.outcome === 'failed') &&
        typeof value.checkedAt === 'number' && typeof value.binary?.path === 'string' &&
        typeof value.binary.size === 'number' && typeof value.binary.mtimeMs === 'number'
    })
  } catch { return [] }
}

/** The latest result for exactly this binary, or null. */
export function codexAttachResultFor(env: NodeJS.ProcessEnv, binary: CodexBinaryIdentity): CodexAttachCanaryResult | null {
  return readCodexAttachResults(env).find((entry) => sameBinary(entry.binary, binary)) ?? null
}

export function recordCodexAttachResult(env: NodeJS.ProcessEnv, result: CodexAttachCanaryResult): void {
  const others = readCodexAttachResults(env).filter((entry) => !sameBinary(entry.binary, result.binary))
  atomicWriteFileSync(codexAttachResultsPath(env), `${JSON.stringify({ results: [result, ...others].slice(0, RESULTS_KEPT) }, null, 2)}\n`,
    { mode: 0o600, requireCurrentUserOwner: true })
}

/** Whether the behaviour check passed for the binary this server runs. */
export function codexAttachVerified(host: ProcessIdentity, env: NodeJS.ProcessEnv): boolean {
  const binary = hostBinaryIdentity(host)
  return binary !== null && codexAttachResultFor(env, binary)?.outcome === 'passed'
}
