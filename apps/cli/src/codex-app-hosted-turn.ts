/**
 * Running a stopped Codex app conversation's next turn in the background,
 * when no app window has it open (`wake.codex_app_background`, on by default:
 * "Yes, but if the app can be safely open that'd be even better. This should
 * also be a preference that's on by default", 2026-11-05).
 *
 * The app's router can start a turn only through a window that has the
 * conversation open (`codex-app-ipc.ts`), and opening it in a window brings
 * that window forward (the app's navigation shows and focuses it), so
 * Notifai does not open it. Instead, when no process holds the thread
 * (its writer lock is free: the app unloaded it), Notifai runs one turn in a
 * private, short-lived `codex app-server` of the app's own Codex build on
 * the app's Codex home: `thread/resume`, then `turn/start` with Notifai's
 * wake, as the User sending a message does; then `thread/unsubscribe` and
 * exit, which frees the lock again. Codex's writer lock makes a second writer
 * impossible: if the app took the thread first, the resume is refused and
 * nothing runs. The app shows the turn when the conversation is next opened.
 *
 * Every hook the User, the project, a plugin or the organisation set runs
 * as usual. Only Notifai's own hooks stand down in that server
 * (`NOTIFAI_HOSTED_TURN_PID` names it; the launcher checks it against each
 * hook's parent process), since they would read it as a second host of the
 * conversation and its exit as the conversation's end. So no Notifai hook
 * hands the input in there: the wake tells the agent to run `notifai
 * receive`, which does. Requests for approval or input from that turn are
 * declined: nobody is there to answer.
 *
 * The turn runs in a detached runner (`notifai hook codex-hosted-turn`) that
 * owns the server's stdin until the turn ends, so a hub that exits (an
 * update, a sign-out, a crash) never cuts the turn short; the runner records
 * the turn's start and end as its hooks would have.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { CODEX_CONTROL_CLIENT_INFO, codexStdioRequest } from './codex-native-control.js'
import { OWNER_MARKER } from './install-hooks.js'
import { launchSelf } from './launch-self.js'
import { retainSessionRuntime } from './runtime-build-retention.js'
import { updateSessionState } from './hook-session-state.js'
import type { SessionState } from './hook-types.js'
import { currentProcessIdentity } from './process-identity.js'
import { recordTurnStart, recordTurnStop } from './session-attendant-state.js'

/** How long an interrupted turn has to end before its server is stopped. */
export const HOSTED_TURN_GRACE_MS = 60_000

export type HostedTurn = { started: false; reason: string } | { started: true; turnId: string; done: Promise<'completed' | 'interrupted' | 'failed' | 'stopped'> }

interface Message { id?: unknown; method?: unknown; params?: { turn?: { id?: unknown; status?: unknown }; threadId?: unknown }; result?: unknown; error?: unknown }

export async function startHostedCodexAppTurn(input: {
  threadId: string; codexHome: string; executable: string; cwd: string; text: string; env: NodeJS.ProcessEnv
  /** How long the start may take. */
  startTimeoutMs: number
  /** The longest the turn may run before it is interrupted. */
  maxTurnMs: number
  /** After the interrupt, how long the server has to end the turn before it is stopped. */
  graceMs?: number
  spawnServer?: (executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess
}): Promise<HostedTurn> {
  const env: NodeJS.ProcessEnv = { ...input.env, CODEX_HOME: input.codexHome }
  let child: ChildProcess
  try {
    // `exec` keeps the shell's pid, so the marker names exactly the server Codex runs hooks from.
    child = (input.spawnServer ?? ((file, args, options) => spawn('/bin/sh', ['-c', 'NOTIFAI_HOSTED_TURN_PID=$$; export NOTIFAI_HOSTED_TURN_PID; exec "$0" "$@"', file, ...args],
      { ...options, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })))(input.executable, ['app-server'], { cwd: input.cwd, env })
  } catch {
    return { started: false, reason: 'spawn-failed' }
  }
  let exited = false
  const waiting = new Map<number, (message: Message | null) => void>()
  const listeners = new Set<(message: Message) => void>()
  let nextId = 0
  let buffer = ''
  const stop = () => { if (!exited) { try { child.kill() } catch { /* gone */ } } }
  child.on('exit', () => { exited = true; for (const resolve of waiting.values()) resolve(null); waiting.clear() })
  child.on('error', () => { exited = true; for (const resolve of waiting.values()) resolve(null); waiting.clear() })
  child.stdin?.on('error', () => undefined)
  const write = (message: object) => { if (!exited) child.stdin?.write(`${JSON.stringify(message)}\n`) }
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    if (buffer.length > 16 * 1024 * 1024) { stop(); return }
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let message: Message
      try { message = JSON.parse(line) as Message } catch { continue }
      if (typeof message.id === 'number' && message.method === undefined) {
        waiting.get(message.id)?.(message)
        waiting.delete(message.id)
      } else if (message.id !== undefined && typeof message.method === 'string') {
        // An approval, elicitation or other request of the server: nobody is there to answer it.
        write({ id: message.id, error: { code: -32601, message: 'Notifai runs this turn in the background and cannot answer requests' } })
      } else for (const listener of listeners) listener(message)
    }
  })
  const call = (method: string, params: unknown, timeoutMs: number): Promise<Message | null> => new Promise((resolve) => {
    const id = ++nextId
    const timer = setTimeout(() => { waiting.delete(id); resolve(null) }, timeoutMs)
    waiting.set(id, (message) => { clearTimeout(timer); resolve(message) })
    write({ id, method, params })
  })
  const startedAt = Date.now()
  const left = () => Math.max(1, input.startTimeoutMs - (Date.now() - startedAt))
  const fail = (reason: string): HostedTurn => { stop(); return { started: false, reason } }
  const init = await call('initialize', { clientInfo: CODEX_CONTROL_CLIENT_INFO, capabilities: { experimentalApi: true } }, left())
  if (init === null || init.error !== undefined) return fail('initialize')
  write({ method: 'initialized', params: {} })
  // The app's lock, if it took the thread in the meantime, refuses this: never a second writer.
  const resumed = await call('thread/resume', { threadId: input.threadId }, left())
  if (resumed === null || resumed.error !== undefined) return fail('resume-refused')
  const turns = (resumed.result as { thread?: { turns?: Array<{ status?: unknown }> } } | null)?.thread?.turns
  const last = Array.isArray(turns) ? turns.at(-1)?.status : undefined
  const unsubscribe = async () => { await call('thread/unsubscribe', { threadId: input.threadId }, 3_000); stop() }
  // Only a conversation still stopped: anything else has moved on since.
  if (last !== 'interrupted') { await unsubscribe(); return { started: false, reason: `last-turn-${String(last)}` } }
  const end: { resolve?: (status: 'completed' | 'interrupted' | 'failed' | 'stopped') => void } = {}
  const done = new Promise<'completed' | 'interrupted' | 'failed' | 'stopped'>((resolve) => { end.resolve = resolve })
  let turnId: string | null = null
  listeners.add((message) => {
    if (message.method !== 'turn/completed' || turnId === null || message.params?.turn?.id !== turnId) return
    const status = message.params.turn.status
    end.resolve?.(status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed')
  })
  child.on('exit', () => end.resolve?.('stopped'))
  const start = await call('turn/start', { threadId: input.threadId, input: [{ type: 'text', text: input.text, text_elements: [] }] }, left())
  const id = (start?.result as { turn?: { id?: unknown } } | null)?.turn?.id
  if (start === null || start.error !== undefined || typeof id !== 'string') { await unsubscribe(); return { started: false, reason: 'start-refused' } }
  turnId = id
  // Past the limit the turn is interrupted; a server that does not end it then is stopped.
  let kill: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    void call('turn/interrupt', { threadId: input.threadId, turnId: id }, 5_000)
    kill = setTimeout(stop, input.graceMs ?? HOSTED_TURN_GRACE_MS)
  }, input.maxTurnMs)
  const finished = done.then(async (status) => {
    clearTimeout(timer)
    if (kill !== undefined) clearTimeout(kill)
    if (!exited) await unsubscribe()
    return status
  })
  return { started: true, turnId: id, done: finished }
}

const CODEX_APP_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'

function executable(file: string): boolean {
  try { return statSync(file).isFile() && (accessSync(file, constants.X_OK), true) } catch { return false }
}

/**
 * The Codex build the Codex app runs: the executable of the server that
 * hosted the conversation, when it is a `codex` inside an app bundle, else
 * the app's own bundled one. Null when neither is there (macOS only).
 */
export function codexAppCodexOf(serverPid: number, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'darwin') return null
  try {
    const file = execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(serverPid)], { encoding: 'utf8', timeout: 2_000 }).trim()
    if (/\.app\/Contents\/.+\/codex$/u.test(file) && executable(file)) return file
  } catch { /* gone */ }
  return executable(CODEX_APP_CODEX) ? CODEX_APP_CODEX : null
}

/** Markers a hook or a Notifai command sets for itself, which describe that call and no other. */
const CALL_MARKERS = ['NOTIFAI_HOOK_SOURCE_PID', 'NOTIFAI_NATIVE_ENTRY', 'NOTIFAI_NATIVE_ROUTE', 'NOTIFAI_NATIVE_RETRY', 'NOTIFAI_HOSTED_TURN_PID',
  'CODEX_THREAD_ID', 'CODEX_TURN_ID', 'CODEX_SESSION_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE']

/**
 * What the background server gets: the conversation's own environment, as
 * its agent's tools need it (agent sockets, tokens, toolchains, proxies,
 * Notifai's own credential store), less the markers of one hook or command.
 */
export function hostedTurnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = { ...env }
  for (const name of Object.keys(kept)) {
    if (CALL_MARKERS.includes(name) || name.startsWith('NOTIFAI_INTERNAL_') || name.startsWith('CODEX_HOOK_')) delete kept[name]
  }
  return kept
}

/** Private hand-off to the detached runner of a background turn. */
export const HOSTED_TURN_INPUT_ENV = 'NOTIFAI_INTERNAL_HOSTED_TURN_INPUT'

export interface HostedTurnRequest {
  session_id: string
  owner_key: string
  /** The stopped turn this wakes. */
  turn: string
  codex_home: string
  executable: string
  cwd: string
  text: string
  max_turn_ms: number
}

export function parseHostedTurnRequest(raw: string | undefined): HostedTurnRequest | null {
  try {
    const value = JSON.parse(raw ?? '') as Partial<HostedTurnRequest>
    const strings = ['session_id', 'owner_key', 'turn', 'codex_home', 'executable', 'cwd', 'text'] as const
    if (strings.some((key) => typeof value[key] !== 'string' || value[key] === '') || typeof value.max_turn_ms !== 'number') return null
    return value as HostedTurnRequest
  } catch {
    return null
  }
}

/**
 * The detached runner (`notifai hook codex-hosted-turn`): run the turn, and
 * record what happened in the stopped turn's wake record and the session's
 * turn record, as the hub and the turn's hooks would. It lives until the
 * turn ends, whatever becomes of the hub.
 */
export async function runHostedCodexAppTurn(request: HostedTurnRequest, env: NodeJS.ProcessEnv, seams: {
  start?: typeof startHostedCodexAppTurn
  log?: (stage: string, data?: Record<string, unknown>) => void
} = {}): Promise<'completed' | 'interrupted' | 'failed' | 'stopped' | 'not-started'> {
  const self = currentProcessIdentity()
  const mark = (change: (wake: NonNullable<SessionState['interrupt_wake']>) => NonNullable<SessionState['interrupt_wake']>) =>
    updateSessionState(request.session_id, env, (state) => {
      const wake = state.interrupt_wake
      return wake?.key !== request.owner_key || wake.turn !== request.turn ? state : { ...state, interrupt_wake: change(wake) }
    })
  mark((wake) => ({ ...wake, hosted: { ...(wake.hosted ?? {}), ...(self === null ? {} : { runner: self }) } }))
  const hosted = await (seams.start ?? startHostedCodexAppTurn)({ threadId: request.session_id, codexHome: request.codex_home,
    executable: request.executable, cwd: request.cwd, text: request.text, env: hostedTurnEnv(env), startTimeoutMs: 30_000, maxTurnMs: request.max_turn_ms })
  if (!hosted.started) {
    mark((wake) => ({ ...wake, outcome: 'unavailable', hosted: { ...(wake.hosted ?? {}), ended: true } }))
    seams.log?.('background-not-started', { reason: hosted.reason })
    return 'not-started'
  }
  try { recordTurnStart(request.session_id, env, request.owner_key, hosted.turnId) } catch { /* Activity is a hint. */ }
  mark((wake) => ({ ...wake, outcome: 'started', hosted: { ...(wake.hosted ?? {}), ...(self === null ? {} : { runner: self }), turn: hosted.turnId } }))
  seams.log?.('background-started', { turn: hosted.turnId })
  const status = await hosted.done
  try { recordTurnStop(request.session_id, env, request.owner_key, hosted.turnId) } catch { /* Activity is a hint. */ }
  mark((wake) => ({ ...wake, hosted: { ...(wake.hosted ?? {}), ended: true } }))
  seams.log?.(`background-${status}`, { turn: hosted.turnId })
  return status
}

/** The first word of a hook command line: the program, quoted or not. */
function commandProgram(command: string): string | null {
  const trimmed = command.trim()
  const quoted = /^'((?:[^']|'\\'')*)'/u.exec(trimmed) ?? /^"((?:[^"\\]|\\.)*)"/u.exec(trimmed)
  if (quoted !== null) return quoted[1]!.replace(/'\\''/gu, "'")
  const word = /^(\S+)/u.exec(trimmed)
  return word === null ? null : word[1]!
}

function onPath(program: string, env: NodeJS.ProcessEnv): string | null {
  if (program.includes('/')) return program
  for (const directory of (env['PATH'] ?? '').split(':')) {
    if (directory !== '' && executable(`${directory}/${program}`)) return `${directory}/${program}`
  }
  return null
}

/**
 * Whether every Notifai hook that would run in the background server stands
 * down there: each comes from a Notifai launcher that knows
 * `NOTIFAI_HOSTED_TURN_PID` (launcher version 2 or later). Read from the
 * hooks Codex itself would run for the conversation's folder, in every layer.
 * False when that cannot be told.
 */
export async function notifaiHooksStandDown(input: { executable: string; codexHome: string; cwd: string; env: NodeJS.ProcessEnv
  list?: (env: NodeJS.ProcessEnv, cwd: string) => Promise<unknown>; launcherVersion?: (program: string) => number | null }): Promise<boolean> {
  const env: NodeJS.ProcessEnv = { ...input.env, CODEX_HOME: input.codexHome }
  const listed = await (input.list ?? ((listEnv, cwd) => codexStdioRequest(listEnv, cwd, 'hooks/list', { cwds: [cwd] }, 10_000, input.executable)))(env, input.cwd)
  const entries = (listed as { data?: Array<{ hooks?: Array<{ command?: unknown }> }> } | null)?.data
  if (!Array.isArray(entries)) return false
  const programs = new Set<string>()
  for (const entry of entries) for (const hook of entry.hooks ?? []) {
    if (typeof hook.command !== 'string' || !hook.command.includes(OWNER_MARKER)) continue
    const program = commandProgram(hook.command)
    const resolved = program === null ? null : onPath(program, env)
    if (resolved === null) return false
    programs.add(resolved)
  }
  const version = input.launcherVersion ?? ((program: string) => {
    try {
      const printed = execFileSync(program, ['--internal-launcher-version'], { encoding: 'utf8', timeout: 3_000, env: { PATH: env['PATH'] ?? '', HOME: env['HOME'] ?? '' } }).trim()
      return /^\d+$/u.test(printed) ? Number(printed) : null
    } catch { return null }
  })
  for (const program of programs) if ((version(program) ?? 0) < 2) return false
  return true
}

/** Start the detached runner of a background turn, from this exact build. */
export function launchHostedTurn(request: HostedTurnRequest, env: NodeJS.ProcessEnv): Promise<void> {
  launchSelf(['hook', 'codex-hosted-turn', '--owner', 'notifai', '--harness', 'codex'], {
    cwd: request.cwd,
    env: { ...env, [HOSTED_TURN_INPUT_ENV]: JSON.stringify(request) },
    retain(reference) { if (reference !== null) retainSessionRuntime(request.session_id, env, reference) },
  })
  return Promise.resolve()
}
