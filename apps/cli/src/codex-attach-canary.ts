/**
 * The behaviour check behind the shared-server signal (`codex-attach-signal.ts`).
 *
 * The signal leans on Codex behaviour Codex does not promise, and a Codex
 * update can arrive at any time. So instead of trusting a version, Notifai
 * runs the exact binary that serves the User's shared server through the
 * shapes the signal depends on, in a throwaway home with its own private
 * server, a plain `codex` terminal in a pseudo-terminal and a local mock
 * model, and caches the result for that binary (its real path, size and
 * modification time). Until a binary has passed, the signal answers
 * `unknown` and nothing is woken on that server.
 *
 * Isolation: every Codex process gets only HOME, CODEX_HOME, PATH, TERM, LANG
 * and a dummy key, all inside the throwaway home; no account and no network.
 * Every connection is refused unless its control socket lies inside that
 * home, so the check can never reach the User's own server. Cleanup stops the
 * private server, then kills whatever is left running from that home (the
 * server's pid-update-loop survives `daemon stop`), then removes the home.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync, type WriteStream } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  codexAttachResultFor,
  codexBinaryIdentity,
  codexThreadAttachState,
  codexThreadLockMtime,
  confirmBySubscribers,
  hostBinaryIdentity,
  passiveAttachCheck,
  processExecutablePath,
  recordCodexAttachResult,
  systemCodexAttachDeps,
  type CodexAttachCanaryResult,
  type CodexBinaryIdentity,
} from './codex-attach-signal.js'
import { connectCodexControl, type CodexControl } from './codex-native-control.js'
import { locateCodexRollout } from './codex-session-end.js'
import { canonicalSocketPath } from './local-path.js'
import type { ProcessIdentity } from './process-identity.js'

const execute = promisify(execFile)

/** What each numbered check exercises; doctor names the first that failed (0: the check could not run). */
export const CODEX_ATTACH_CHECKS: Readonly<Record<number, string>> = Object.freeze({
  1: 'starting a terminal conversation on the shared server',
  2: 'finding the terminal that opened a conversation',
  3: 'noticing a terminal that moved on to a new conversation',
  4: 'asking the server whether a terminal shows a conversation',
  5: 'noticing a closed terminal',
  6: 'asking the server about a conversation no terminal shows',
  7: 'leaving a conversation the server put away untouched',
  8: 'keeping a wake for a put-away conversation until it is opened',
})

/** A behavioural failure is retried at most once a day. */
export const CODEX_ATTACH_RETRY_MS = 24 * 60 * 60_000
/** Environmental failures retry promptly, with a bounded exponential delay. */
export function codexAttachRetryMs(result: Pick<CodexAttachCanaryResult, 'step' | 'startFailures' | 'detail' | 'environmental'>): number {
  return result.step === 0 && (result.startFailures ?? 1) < 8 &&
    (result.environmental === true || /ENOSPC|EAGAIN|EMFILE|ENFILE|ENOMEM|No space left on device|spawn .* (?:ENOENT|EACCES)|timed? out/i.test(result.detail ?? ''))
    ? Math.min(5 * 60_000, 5_000 * 2 ** Math.min(6, Math.max(0, (result.startFailures ?? 1) - 1)))
    : CODEX_ATTACH_RETRY_MS
}
const TOTAL_TIMEOUT_MS = 90_000
/** Short, so the check sees the server put a conversation away in seconds. */
const UNLOAD_DELAY_SECS = 8
const WAKE_TEXT = 'Notifai check: a content-free wake.'
const NO_THREAD = '00000000-0000-0000-0000-000000000000'
const HOME_PREFIX = 'nfac-'
/** A home this old belongs to a check that never cleaned up (its hub went away mid-run). */
const STALE_HOME_MS = 10 * 60_000

export interface CodexAttachCanaryOptions {
  /** The Codex binary under test. */
  executable: string
  /** Where the throwaway home goes; default `/tmp`, short enough for a socket path. */
  root?: string
  timeoutMs?: number
  log?: (event: Record<string, unknown>) => void
}

export interface CodexAttachCanaryOutcome {
  outcome: 'passed' | 'failed'
  step?: number
  detail?: string
  environmental?: boolean
  codexVersion: string | null
  /** Processes from the throwaway home still running after cleanup (should be none). */
  leftovers: number
}

class CheckFailed extends Error {
  constructor(readonly step: number, message: string) { super(message) }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Run the checks once against `executable`. Never throws. */
export async function runCodexAttachCanary(options: CodexAttachCanaryOptions): Promise<CodexAttachCanaryOutcome> {
  const deadline = performance.now() + (options.timeoutMs ?? TOTAL_TIMEOUT_MS)
  const log = options.log ?? (() => undefined)
  let home: string | null = null
  let mock: MockModel | null = null
  const terminals: ChildProcess[] = []
  let env: NodeJS.ProcessEnv = {}
  let codexVersion: string | null = null
  let result: Omit<CodexAttachCanaryOutcome, 'leftovers' | 'codexVersion'>
  let step = 0
  try {
    const root = realpathSync(options.root ?? (process.platform === 'win32' ? '' : '/tmp'))
    await sweepStaleHomes(root)
    home = mkdtempSync(path.join(root, HOME_PREFIX))
    const codexHome = path.join(home, 'c')
    const project = path.join(home, 'p')
    for (const directory of [codexHome, project, path.join(home, 'h')]) mkdirSync(directory, { recursive: true, mode: 0o700 })
    mock = await startMockModel()
    writeFileSync(path.join(codexHome, 'config.toml'), canaryConfig(mock.port, project), { mode: 0o600 })
    env = {
      HOME: path.join(home, 'h'),
      CODEX_HOME: codexHome,
      PATH: [path.dirname(options.executable), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      NOTIFAI_CHECK_MODEL_KEY: 'notifai-check-not-a-key',
    }
    const run = async (args: string[], timeoutMs: number): Promise<string> =>
      (await execute(options.executable, args, { env, cwd: project, timeout: Math.min(timeoutMs, Math.max(1, deadline - performance.now())), maxBuffer: 1024 * 1024 })).stdout
    codexVersion = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(await run(['--version'], 10_000))?.[1] ?? null
    if (codexVersion === null) throw new CheckFailed(0, 'invalid --version output')

    // The private server. Its control socket must be named inside the
    // throwaway home and be held by the server this check started, whose
    // binary lies inside that home too: nothing else is ever connected to.
    const started = lastJson(await run(['app-server', 'daemon', 'start'], 45_000))
    const daemonPid = typeof started?.['pid'] === 'number' ? started['pid'] : null
    const reported = typeof started?.['socketPath'] === 'string' ? started['socketPath'] : null
    const socket = daemonPid === null || reported === null ? null : privateServerSocket(home, reported, daemonPid)
    if (socket === null) throw new CheckFailed(0, 'the private server\'s control socket is not inside the throwaway home')
    log({ event: 'server-started', pid: daemonPid })
    const acceptSocket = (named: string, resolved: string): boolean => named === reported && resolved === socket

    const connect = async (threadId: string): Promise<CodexControl> => {
      let stage = 'unknown'
      const control = await connectCodexControl(threadId, env, Math.min(deadline, performance.now() + 10_000), undefined, (failed) => { stage = failed },
        { allowUnloaded: true, executable: options.executable, acceptSocket })
      if (control === null) throw new Error(`no connection to the private server (${stage})`)
      return control
    }
    const withControl = async <T>(threadId: string, use: (control: CodexControl) => Promise<T>): Promise<T> => {
      const control = await connect(threadId)
      try { return await use(control) } finally { control.close() }
    }
    const loaded = (): Promise<string[]> => withControl(NO_THREAD, async (control) =>
      ((await control.call('thread/loaded/list', {})) as { data?: string[] }).data ?? [])
    const passive = (threadId: string) => withControl(threadId, (control) => passiveAttachCheck(control, codexHome, threadId, systemCodexAttachDeps))
    const waitFor = async <T>(failStep: number, what: string, probe: () => Promise<T | null>, limitMs: number): Promise<T> => {
      const until = Math.min(deadline, performance.now() + limitMs)
      let lastError = ''
      while (performance.now() < until) {
        try {
          const value = await probe()
          if (value !== null) return value
        } catch (err) { lastError = err instanceof Error ? `: ${err.message}` : '' }
        await sleep(300)
      }
      throw new CheckFailed(failStep, `timed out waiting until ${what}${lastError}`)
    }
    const terminal = async (args: string[]): Promise<WriteStream> => {
      const { child, input } = await spawnTerminal(options.executable, args, project, env, path.join(home!, `t${terminals.length}`))
      terminals.push(child)
      return input
    }
    const type = async (input: WriteStream, text: string): Promise<void> => {
      input.write(text)
      await sleep(400)
      input.write('\r')
    }

    // 1. A plain terminal starts, and one turn gives its thread T a rollout.
    step = 1
    const first = await terminal([])
    const threadId = await waitFor(1, 'the terminal loaded a conversation', async () => (await loaded())[0] ?? null, 30_000)
    await sleep(1_000)
    await type(first, 'say ok')
    await waitFor(1, 'the turn wrote its rollout', async () =>
      locateCodexRollout(codexHome, threadId, null).place === 'sessions' && codexThreadLockMtime(codexHome, threadId) !== null && mock!.requests > 0
        ? true : null, 30_000)
    log({ event: 'check', step: 1, ok: true })

    // 2. The passive check says the terminal shows T.
    step = 2
    const shown = await passive(threadId)
    if (!shown.attached) throw new CheckFailed(2, `the terminal showing the conversation was not found (${shown.reason})`)
    log({ event: 'check', step: 2, ok: true, terminal: shown.terminal })

    // 3. `/new` in that terminal: T is no longer shown.
    step = 3
    await type(first, '/new')
    const movedOn = await waitFor(3, 'the terminal moving on was seen', async () => {
      const verdict = await passive(threadId)
      return verdict.attached ? null : verdict.reason
    }, 15_000)
    if (movedOn !== 'terminal-moved-on') throw new CheckFailed(3, `the conversation read as not shown for another reason (${movedOn})`)
    log({ event: 'check', step: 3, ok: true, reason: movedOn })

    // 4. A second terminal resumes T; asking the server finds it shown (joined).
    step = 4
    await terminal(['resume', threadId])
    const resumed = await waitFor(4, 'the resumed terminal was seen', async () => {
      const verdict = await passive(threadId)
      return verdict.attached && verdict.terminal !== shown.terminal ? verdict.terminal ?? null : null
    }, 30_000)
    log({ event: 'resumed', terminal: resumed })
    const joined = await withControl(threadId, (control) => confirmBySubscribers(control, codexHome, threadId, systemCodexAttachDeps))
    if (joined !== 'joined') throw new CheckFailed(4, `asking the server about a shown conversation answered ${joined}`)
    log({ event: 'check', step: 4, ok: true })

    // 5. Every terminal closes (SIGHUP): T is no longer shown.
    step = 5
    for (const child of terminals) hangUp(child)
    const closed = await waitFor(5, 'the closed terminals were seen', async () => {
      const verdict = await passive(threadId)
      return verdict.attached ? null : verdict.reason
    }, 5_000)
    log({ event: 'check', step: 5, ok: true, reason: closed })

    // 6. Asking the server with no terminal: it reloads T (nobody subscribed).
    step = 6
    const reloaded = await withControl(threadId, (control) => confirmBySubscribers(control, codexHome, threadId, systemCodexAttachDeps))
    if (reloaded !== 'reloaded') throw new CheckFailed(6, `asking the server about a conversation no terminal shows answered ${reloaded}`)
    log({ event: 'check', step: 6, ok: true })

    // 7. Once the server puts T away, the signal never loads it again.
    step = 7
    await waitFor(7, 'the server put the conversation away', async () => (await loaded()).includes(threadId) ? null : true, (UNLOAD_DELAY_SECS + 15) * 1_000)
    const lockBefore = codexThreadLockMtime(codexHome, threadId)
    const state = await codexThreadAttachState({ threadId, env, host: { pid: daemonPid ?? 0, start: '' }, confirm: 'always' }, {
      verified: () => true,
      connect: (id, _env, deadlineAt) => connectCodexControl(id, env, deadlineAt, undefined, undefined,
        { allowUnloaded: true, executable: options.executable, acceptSocket }),
    })
    if (state.state !== 'not-loaded') throw new CheckFailed(7, `a put-away conversation read as ${state.state}`)
    if ((await loaded()).includes(threadId) || codexThreadLockMtime(codexHome, threadId) !== lockBefore) throw new CheckFailed(7, 'the conversation was loaded again')
    log({ event: 'check', step: 7, ok: true })

    // 8. A wake queued into put-away T is stored and waits: no load, no model request.
    step = 8
    const requestsBefore = mock.requests
    await run(['queue', '--thread', threadId, '--message', WAKE_TEXT], 20_000)
    await sleep(1_500)
    const queued = await withControl(threadId, async (control) =>
      ((await control.call('thread/queue/list', { threadId })) as { data?: Array<{ input?: Array<{ text?: unknown }> }> }).data ?? [])
    if (!queued.some((item) => item.input?.some((part) => part.text === WAKE_TEXT))) throw new CheckFailed(8, 'the wake was not stored')
    if ((await loaded()).includes(threadId)) throw new CheckFailed(8, 'the wake loaded the conversation')
    if (mock.requests !== requestsBefore) throw new CheckFailed(8, 'the wake ran a turn')
    log({ event: 'check', step: 8, ok: true })
    result = { outcome: 'passed' }
  } catch (err) {
    const failed = err instanceof CheckFailed ? err : new CheckFailed(step, err instanceof Error ? err.message : String(err))
    result = { outcome: 'failed', step: failed.step, detail: failed.message.slice(0, 300), environmental: environmentalCheckError(err) }
    log({ event: 'check', step: failed.step, ok: false, detail: result.detail })
  }
  const leftovers = await cleanUp(home, options.executable, env, terminals, mock)
  return { ...result, codexVersion, leftovers }
}

function canaryConfig(port: number, project: string): string {
  const toml = (value: string) => JSON.stringify(value)
  return [
    'model = "notifai-check"',
    'model_provider = "notifai-check"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'check_for_update_on_startup = false',
    'disable_paste_burst = true',
    `thread_unload_delay_secs = ${UNLOAD_DELAY_SECS}`,
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[model_providers.notifai-check]',
    'name = "notifai-check"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'env_key = "NOTIFAI_CHECK_MODEL_KEY"',
    'wire_api = "responses"',
    '',
    `[projects.${toml(project)}]`,
    'trust_level = "trusted"',
    '',
  ].join('\n')
}

function insideDirectory(file: string, directory: string): boolean {
  try {
    const resolved = path.resolve(file)
    const parent = realpathSync(path.dirname(resolved))
    return (parent + path.sep).startsWith(realpathSync(directory) + path.sep)
  } catch { return false }
}

/**
 * The resolved control socket of the private server, or null unless: the
 * socket is named inside the home (Codex links it to a per-user directory
 * under the system's temporary directory), the server's own binary lies
 * inside the home, and that server process holds the socket open.
 */
export function privateServerSocket(home: string, reported: string, serverPid: number,
  read: { executable(pid: number): string | null; unixSockets(pid: number): string[] } = { executable: processExecutablePath, unixSockets }): string | null {
  if (!insideDirectory(reported, home)) return null
  const executable = read.executable(serverPid)
  if (executable === null || !insideDirectory(executable, home)) return null
  let resolved: string
  try { resolved = canonicalSocketPath(reported) } catch { return null }
  return read.unixSockets(serverPid).includes(resolved) ? resolved : null
}

/** The paths of the Unix sockets a process has open (`lsof`), or none. */
function unixSockets(pid: number): string[] {
  if (process.platform === 'linux') {
    try {
      const inodes = new Set(readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
        try { return [/^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1] ?? ''] } catch { return [] }
      }).filter((inode) => inode !== ''))
      return readFileSync('/proc/net/unix', 'utf8').split('\n').flatMap((line) => {
        const words = line.trim().split(/\s+/)
        return words.length >= 8 && inodes.has(words[6]!) ? [words[7]!] : []
      })
    } catch { return [] }
  }
  try {
    return execFileSync('lsof', ['-a', '-p', String(pid), '-U', '-Fn'], {
      encoding: 'utf8', timeout: 5_000, env: { PATH: '/usr/sbin:/usr/bin:/bin:/sbin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').filter((line) => line.startsWith('n/')).map((line) => line.slice(1))
  } catch { return [] }
}

function lastJson(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const value = JSON.parse(line) as unknown
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    } catch { /* not JSON */ }
  }
  return null
}

/**
 * A plain `codex` terminal in a pseudo-terminal of its own (`script`), with a
 * fixed size. `script` refuses a socket or a FIFO as its stdin, so keystrokes
 * go through a FIFO that `cat` copies into an ordinary pipe. `-C` names the
 * project, so the process names the home.
 */
async function spawnTerminal(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, fifo: string):
  Promise<{ child: ChildProcess; input: WriteStream }> {
  execFileSync('mkfifo', ['-m', '600', fifo], { env: { PATH: '/usr/bin:/bin' } })
  const codex = [executable, '-C', cwd, ...args].map(shellQuote).join(' ')
  const inner = process.platform === 'darwin'
    ? `script -q /dev/null /bin/sh -c ${shellQuote('stty rows 40 cols 140 2>/dev/null; exec "$0" "$@"')} ${codex}`
    : `script -qfec ${shellQuote(`stty rows 40 cols 140 2>/dev/null; exec ${codex}`)} /dev/null`
  const child = spawn('/bin/sh', ['-c', `cat ${shellQuote(fifo)} | ${inner}`], { cwd, env, detached: true, stdio: 'ignore' })
  const input = createWriteStream(fifo)
  input.on('error', () => undefined)
  await new Promise<void>((resolve, reject) => { input.once('open', () => resolve()); child.once('exit', () => reject(new Error('the terminal did not start'))) })
  return { child, input }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Close a terminal the way closing its window does: SIGHUP to its whole group. */
function hangUp(child: ChildProcess): void {
  if (child.pid === undefined) return
  try { process.kill(-child.pid, 'SIGHUP') } catch { /* gone */ }
}

/** Processes whose command line names the throwaway home. */
async function processesFrom(home: string): Promise<number[]> {
  try {
    const { stdout } = await execute('ps', ['-axo', 'pid=,args='], { env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024 })
    return stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line)
      return match !== null && Number(match[1]) !== process.pid && match[2]!.includes(home) ? [Number(match[1])] : []
    })
  } catch { return [] }
}

/**
 * Stop the private server, then everything still running from the home (its
 * pid-update-loop survives `daemon stop`), then remove the home. Returns how
 * many processes from the home were still running at the end.
 */
export async function cleanUp(home: string | null, executable: string, env: NodeJS.ProcessEnv,
  terminals: ChildProcess[] = [], mock: { close(): Promise<void> } | null = null): Promise<number> {
  for (const child of terminals) {
    if (child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
  }
  if (home !== null && env['CODEX_HOME'] !== undefined && insideDirectory(env['CODEX_HOME'], home)) {
    await execute(executable, ['app-server', 'daemon', 'stop'], { env, timeout: 15_000 }).catch(() => undefined)
  }
  let left: number[] = []
  if (home !== null) {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      left = await processesFrom(home)
      for (const pid of left) { try { process.kill(pid, signal) } catch { /* gone */ } }
      if (left.length === 0) break
      await sleep(1_000)
    }
    left = await processesFrom(home)
  }
  await mock?.close().catch(() => undefined)
  if (home !== null) rmSync(home, { recursive: true, force: true })
  return left.length
}

/** Clean up homes an earlier check left behind (its hub exited mid-run): this user's, and old enough. */
export async function sweepStaleHomes(root: string, now = Date.now()): Promise<void> {
  let names: string[]
  try { names = readdirSync(root).filter((name) => name.startsWith(HOME_PREFIX)) } catch { return }
  for (const name of names) {
    const home = path.join(root, name)
    try {
      const stats = lstatSync(home)
      if (!stats.isDirectory() || (process.getuid !== undefined && stats.uid !== process.getuid()) || now - stats.mtimeMs < STALE_HOME_MS) continue
    } catch { continue }
    const server = path.join(home, 'c', 'packages', 'app-server-daemon', 'current', 'bin', 'codex')
    await cleanUp(home, server, { CODEX_HOME: path.join(home, 'c'), HOME: path.join(home, 'h'), PATH: '/usr/bin:/bin' })
  }
}

// -- the local mock model ---------------------------------------------------------

interface MockModel { port: number; requests: number; close(): Promise<void> }

/** A Responses API stand-in on 127.0.0.1 that answers every turn with "ok" and counts them. */
async function startMockModel(): Promise<MockModel> {
  let requests = 0
  const server: Server = createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return }
    requests += 1
    request.resume()
    request.on('end', () => {
      const base = { id: 'resp_check', object: 'response', model: 'notifai-check', output: [] as unknown[] }
      const item = { type: 'message', id: 'msg_check', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }
      const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
      const events: Array<[string, unknown]> = [
        ['response.created', { type: 'response.created', response: { ...base, status: 'in_progress' } }],
        ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
        ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_check', output_index: 0, content_index: 0, delta: 'ok' }],
        ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
        ['response.completed', { type: 'response.completed', response: { ...base, status: 'completed', output: [item], usage } }],
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' })
      for (const [name, data] of events) response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      response.end()
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  return {
    port: (server.address() as AddressInfo).port,
    get requests() { return requests },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

// -- when the hub runs it ---------------------------------------------------------

/** Whether this binary needs a run; inability to run never imposes a day-long outage. */
export function codexAttachCheckDue(result: CodexAttachCanaryResult | null, now: number): boolean {
  return result === null || (result.outcome === 'failed' && now - result.checkedAt >= codexAttachRetryMs(result))
}

function environmentalCheckError(error: unknown): boolean {
  if (error instanceof CheckFailed || error === null || typeof error !== 'object') return false
  const err = error as NodeJS.ErrnoException & { killed?: boolean }
  return ['ENOSPC', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM'].includes(String(err.code)) ||
    err.syscall?.startsWith('spawn') === true || err.killed === true ||
    /ENOSPC|EAGAIN|EMFILE|No space left on device|timed? out/i.test(err.message ?? '')
}

/**
 * Check the binary a shared server runs, once, when it has no current result,
 * and record the outcome. Null when nothing ran (already checked, or the
 * binary cannot be identified).
 */
export async function checkCodexServerBuild(env: NodeJS.ProcessEnv, host: ProcessIdentity, now: number,
  run: (options: CodexAttachCanaryOptions) => Promise<CodexAttachCanaryOutcome> = runCodexAttachCanary,
  log?: (event: Record<string, unknown>) => void): Promise<CodexAttachCanaryResult | null> {
  const binary = hostBinaryIdentity(host)
  if (binary === null || !codexAttachCheckDue(codexAttachResultFor(env, binary), now)) return null
  return checkCodexBinary(env, binary, now, run, log)
}

export async function checkCodexBinary(env: NodeJS.ProcessEnv, binary: CodexBinaryIdentity, now: number,
  run: (options: CodexAttachCanaryOptions) => Promise<CodexAttachCanaryOutcome> = runCodexAttachCanary,
  log?: (event: Record<string, unknown>) => void): Promise<CodexAttachCanaryResult> {
  const previous = codexAttachResultFor(env, binary)
  const outcome = await run({ executable: binary.path, ...(log === undefined ? {} : { log }) }).catch((error: unknown): CodexAttachCanaryOutcome => ({
    outcome: 'failed', step: 0, environmental: environmentalCheckError(error), detail: error instanceof Error ? error.message.slice(0, 240) : 'check could not start', codexVersion: null, leftovers: 0,
  }))
  // The binary changed while it ran: record nothing for either.
  const after = codexBinaryIdentity(binary.path)
  const result: CodexAttachCanaryResult = {
    binary, codexVersion: outcome.codexVersion, outcome: outcome.outcome,
    ...(outcome.step === undefined ? {} : { step: outcome.step }),
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    checkedAt: now,
    ...(outcome.environmental === undefined ? {} : { environmental: outcome.environmental }),
    ...(outcome.outcome === 'failed' && outcome.step === 0 ? { startFailures: Math.min(32, (previous?.startFailures ?? 0) + 1) } : {}),
  }
  if (after !== null && after.size === binary.size && after.mtimeMs === binary.mtimeMs) recordCodexAttachResult(env, result)
  return result
}
