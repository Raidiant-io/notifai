/**
 * Waking a Grok session an app hosts, through that app, when no Grok leader
 * serves it: an Orca chat gets Orca mail addressed to itself, a T3 Code thread
 * gets `t3 thread send`. Both start a new turn in an idle chat or thread and
 * queue behind a working one. The wake is `sessionInputWake`: it carries no
 * User words and no approval; the session reads its input with
 * `notifai receive`, which claims exactly this session's pending input.
 *
 * Only a plain-stdio Grok process the app started for this one chat or thread
 * qualifies (`grokHostOf` role `session`). A leader hosts many sessions, and
 * Orca resolved every chat of a shared leader to the first chat's caller, so a
 * leader-owned session never falls back to host mail. The host binding is
 * checked independently of the inherited environment before the route turns
 * on and again before every wake:
 *
 * - Orca: asked as this Grok session (`ORCA_AGENT_SESSION_ID=<native id>`),
 *   Orca refuses a provider's own session id and names the chat whose current
 *   provider session it is. That chat must be the one in the environment.
 * - T3 Code: the server in `userdata/server-runtime.json` is the Grok
 *   process's parent, and T3's own record names exactly one live thread
 *   (not archived or deleted) whose active provider thread is this session.
 *
 * Verified on macOS with Orca 1.4.271 and T3 Code 0.1.5-nightly.20261029.3867
 * running Grok 1.0.92; other platforms keep presence only until verified.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { readT3GrokThread, type T3GrokThread } from './host-title-store.js'
import { processAncestry } from './process-ancestry.js'
import { pidExists } from './process-identity.js'
import { inputWakeToken, isSessionInputWake } from './session-inputs.js'

/** Where a host route has been verified. */
const VERIFIED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['darwin'])
/** Orca's session ids. */
const ORCA_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
/** T3 Code's thread ids. */
const T3_THREAD = /^[A-Za-z0-9:_%.-]{1,300}$/u
const RUN_TIMEOUT_MS = 15_000
const T3_SEND_TRIES = 3

/** The app a Grok hook says hosts its process, before anything is verified. */
export type GrokHostCandidate =
  | { kind: 'orca-chat'; chat: string; cli: string }
  | { kind: 't3-thread'; home: string; cli: string }

/** A verified route: the wake goes here. */
export type GrokHostRoute =
  | { kind: 'orca-chat'; chat: string; cli: string }
  | { kind: 't3-thread'; home: string; cli: string; thread: string }

export interface RunResult { code: number | null; stdout: string; stderr: string }

/** What the route asks of the machine; tests replace it. */
export interface GrokHostSystem {
  run(command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal }): Promise<RunResult>
  executable(file: string): boolean
  /** The T3 Code server pid its data directory records, when that process runs. */
  t3ServerPid(home: string): number | null
  /** The parent of a process. */
  parentOf(pid: number): number | null
  /** T3 Code's record of the live thread whose active Grok provider thread is this native session. */
  t3Thread(home: string, sessionId: string): T3GrokThread
  pause(ms: number): Promise<void>
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function systemGrokHostSystem(env: NodeJS.ProcessEnv): GrokHostSystem {
  return {
    run: (command, args, options) => new Promise((resolve) => {
      const child = execFile(command, [...args], {
        env: options.env, timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null
        resolve({ code, stdout: `${stdout}`, stderr: `${stderr}` })
      })
      child.stdin?.end(options.input ?? '')
    }),
    executable: isExecutable,
    t3ServerPid: (home) => {
      try {
        const runtime = JSON.parse(readFileSync(path.join(home, 'userdata', 'server-runtime.json'), 'utf8')) as { pid?: unknown }
        return typeof runtime.pid === 'number' && Number.isSafeInteger(runtime.pid) && runtime.pid > 1 && pidExists(runtime.pid) ? runtime.pid : null
      } catch {
        return null
      }
    },
    parentOf: (pid) => processAncestry(pid)?.[1]?.pid ?? null,
    t3Thread: (home, sessionId) => readT3GrokThread({ ...env, T3CODE_HOME: home }, sessionId),
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

function underWsl(platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') return false
  try { return /microsoft/iu.test(readFileSync('/proc/version', 'utf8')) } catch { return false }
}

const set = (env: NodeJS.ProcessEnv, name: string): string => env[name]?.trim() ?? ''

/**
 * The app the hook's environment names, read from the Grok process's own
 * environment. An Orca chat sets `ORCA_STRUCTURED_SESSION=1` and its
 * `ORCA_AGENT_SESSION_ID` for the Grok process it starts; a chat on a paired or
 * remote Orca, and Orca's own title runs (hooks disabled), do not qualify.
 * T3 Code names its data directory and CLI.
 */
export function grokHostCandidate(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform,
  executable: (file: string) => boolean = isExecutable): GrokHostCandidate | null {
  if (!VERIFIED_PLATFORMS.has(platform) || underWsl(platform)) return null
  if (set(env, 'ORCA_STRUCTURED_SESSION') === '1') {
    const chat = set(env, 'ORCA_AGENT_SESSION_ID')
    if (!ORCA_SESSION.test(chat) || set(env, 'ORCA_ENVIRONMENT') !== '' || set(env, 'ORCA_REMOTE_PAIRING') !== '' ||
        set(env, 'ORCA_PAIRING_CODE') !== '' || set(env, 'ORCA_AGENT_HOOKS_DISABLED') === '1') return null
    const cli = set(env, 'ORCA_CLI_COMMAND')
    return path.isAbsolute(cli) && executable(cli) ? { kind: 'orca-chat', chat, cli } : null
  }
  const home = set(env, 'T3CODE_HOME')
  const cli = set(env, 'T3CODE_CLI_PATH')
  if (home !== '' && cli !== '') {
    return path.isAbsolute(home) && path.isAbsolute(cli) && executable(cli) ? { kind: 't3-thread', home, cli } : null
  }
  return null
}

/**
 * Orca's answer, asked as this Grok session: the chat whose current provider
 * session it is; `unknown` when Orca answered that it runs no such session
 * (a `/clear` or a deleted chat); null when Orca could not be asked.
 */
async function orcaChatOfNative(cli: string, env: NodeJS.ProcessEnv, sessionId: string, system: GrokHostSystem): Promise<string | 'unknown' | null> {
  const result = await system.run(cli, ['status', '--json'], { env: { ...env, ORCA_AGENT_SESSION_ID: sessionId } })
  try {
    const caller = (JSON.parse(result.stdout) as { result?: { caller?: { live?: unknown; refusal?: { code?: unknown; message?: unknown } } } })
      .result?.caller
    if (caller?.live !== false) return null
    if (caller.refusal?.code === 'session_caller_unknown') return 'unknown'
    if (caller.refusal?.code !== 'session_caller_provider_id' || typeof caller.refusal.message !== 'string') return null
    const named = [...caller.refusal.message.matchAll(/orca_session_id:([0-9a-f-]{36})/gu)].map((match) => match[1]!)
    return named.length > 0 && named.every((id) => id === named[0]) ? named[0]! : null
  } catch {
    return null
  }
}

/** Why a route is not available now, for logs and `notifai doctor`. */
export type GrokHostUnavailable =
  | 'orca-chat-binding-unverified'
  | 't3-server-not-parent'
  | 't3-thread-not-found'

/**
 * A route that is not available. `definite` when the host itself answered
 * that this Grok session is no longer the chat's or thread's (Orca names
 * another chat or no session; T3 Code's readable record names no open thread
 * for it): no wake can reach it any more. Otherwise the host could not say.
 */
export type GrokHostRefusal = { unavailable: GrokHostUnavailable; definite: boolean }

/**
 * Check the binding now. `hostPid` is the Grok process the hook ran under;
 * T3 Code must be its parent.
 */
export async function verifyGrokHostRoute(candidate: GrokHostCandidate, sessionId: string, hostPid: number,
  env: NodeJS.ProcessEnv, system: GrokHostSystem): Promise<GrokHostRoute | GrokHostRefusal> {
  if (candidate.kind === 'orca-chat') {
    const chat = await orcaChatOfNative(candidate.cli, env, sessionId, system)
    return chat === candidate.chat ? candidate : { unavailable: 'orca-chat-binding-unverified', definite: chat !== null }
  }
  const server = system.t3ServerPid(candidate.home)
  if (server === null || system.parentOf(hostPid) !== server) return { unavailable: 't3-server-not-parent', definite: false }
  const found = system.t3Thread(candidate.home, sessionId)
  if (typeof found !== 'object' || !T3_THREAD.test(found.thread)) {
    return { unavailable: 't3-thread-not-found', definite: found === 'none' || found === 'ambiguous' || typeof found === 'object' }
  }
  return { ...candidate, thread: found.thread }
}

/** How long a starting session may take to appear in its host's record. */
export const GROK_ROUTE_STARTUP_MS = 20_000
const GROK_ROUTE_STARTUP_RETRY_MS = 1_000
/** How often a running route is checked again: T3 Code's record is a local read, Orca's answer a CLI run. */
export const GROK_ROUTE_RECHECK_MS: Readonly<Record<GrokHostRoute['kind'], number>> = { 'orca-chat': 15_000, 't3-thread': 5_000 }

/**
 * A verified route for the life of one attendant. The host can take the
 * conversation away while the Grok process lives on (a T3 Code thread
 * archived, an Orca chat that moved the session): once the host definitively
 * says so, `lost()` names why and the attendant stops taking notes it could
 * no longer wake for. A host that cannot be asked loses nothing.
 */
export class GrokHostRouteWatch {
  private lostReason: GrokHostUnavailable | null = null
  private checking = false
  private checkedAt: number

  private constructor(readonly route: GrokHostRoute, private readonly verify: () => Promise<GrokHostRoute | GrokHostRefusal>,
    private readonly now: () => number) {
    this.checkedAt = now()
  }

  /**
   * Verify a starting session, retrying while its host may still be recording
   * it. The last refusal when it never verifies.
   */
  static async start(verify: () => Promise<GrokHostRoute | GrokHostRefusal>, now: () => number, sleep: (ms: number) => Promise<void>,
    startupMs = GROK_ROUTE_STARTUP_MS): Promise<GrokHostRouteWatch | GrokHostRefusal> {
    const until = now() + startupMs
    for (;;) {
      const result = await verify()
      if ('kind' in result) return new GrokHostRouteWatch(result, verify, now)
      if (now() >= until) return result
      await sleep(GROK_ROUTE_STARTUP_RETRY_MS)
    }
  }

  lost(): GrokHostUnavailable | null { return this.lostReason }

  /** Take a fresh answer, as a wake does just before it is sent: the route, or null. */
  observe(result: GrokHostRoute | GrokHostRefusal): GrokHostRoute | null {
    this.checkedAt = this.now()
    if ('kind' in result) return this.lostReason === null ? result : null
    if (result.definite) this.lostReason ??= result.unavailable
    return null
  }

  /** Check again when due; never more than one check at a time. */
  async poll(): Promise<void> {
    if (this.lostReason !== null || this.checking || this.now() - this.checkedAt < GROK_ROUTE_RECHECK_MS[this.route.kind]) return
    this.checking = true
    try { this.observe(await this.verify()) } catch { this.checkedAt = this.now() } finally { this.checking = false }
  }
}

/** `t3 thread send` met a busy database. */
function busy(detail: string): boolean {
  return /database is locked|SQLITE_BUSY|LockTimeout/iu.test(detail)
}

/**
 * Send one wake through the verified route. `written` means the host accepted
 * it, nothing more; `failed` means it may or may not have been accepted.
 */
export async function sendGrokHostWake(route: GrokHostRoute, text: string, env: NodeJS.ProcessEnv, system: GrokHostSystem,
  signal?: AbortSignal): Promise<'written' | 'failed'> {
  if (route.kind === 'orca-chat') {
    // Sent as the chat itself: the inherited ORCA_AGENT_SESSION_ID is this chat.
    const result = await system.run(route.cli, ['orchestration', 'send', '--to', `orca_session_id:${route.chat}`,
      '--subject', 'Notifai', '--body-file', '-', '--json'], { env: { ...env, ORCA_AGENT_SESSION_ID: route.chat }, input: text, ...(signal === undefined ? {} : { signal }) })
    try {
      const reply = JSON.parse(result.stdout) as { ok?: unknown; result?: { messageId?: unknown } }
      return result.code === 0 && reply.ok === true && typeof reply.result?.messageId === 'string' ? 'written' : 'failed'
    } catch {
      return 'failed'
    }
  }
  const childEnv: NodeJS.ProcessEnv = { ...env, T3CODE_HOME: route.home }
  for (let attempt = 1; attempt <= T3_SEND_TRIES; attempt += 1) {
    const result = await system.run(route.cli, ['thread', 'send', route.thread, '-'], { env: childEnv, input: text, ...(signal === undefined ? {} : { signal }) })
    if (result.code === 0) return 'written'
    if (!busy(result.stderr) || attempt === T3_SEND_TRIES || signal?.aborted === true) return 'failed'
    await system.pause(attempt * 1_000)
  }
  return 'failed'
}

/**
 * The wake a Grok prompt carries: exactly the wake (T3 Code), or Orca's mail
 * of it, whose header, subject and reply hint surround the wake's own line.
 */
export function grokPromptWake(prompt: string | undefined): string | undefined {
  if (prompt === undefined || isSessionInputWake(prompt)) return prompt
  if (!prompt.startsWith('──── From: ') || !/\nSubject: Notifai\n/u.test(prompt)) return prompt
  const line = prompt.split('\n').find((candidate) => inputWakeToken(candidate) !== null)
  return line ?? prompt
}
