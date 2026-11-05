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
 * The server runs with hooks off (they would see a second host of the
 * conversation, and its exit as the conversation's end); the wake tells the
 * agent to run `notifai receive`, which hands the input in. Requests for
 * approval or input from that turn are declined: nobody is there to answer.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { CODEX_CONTROL_CLIENT_INFO } from './codex-native-control.js'

export type HostedTurn = { started: false; reason: string } | { started: true; turnId: string; done: Promise<'completed' | 'interrupted' | 'failed' | 'stopped'> }

interface Message { id?: unknown; method?: unknown; params?: { turn?: { id?: unknown; status?: unknown }; threadId?: unknown }; result?: unknown; error?: unknown }

export async function startHostedCodexAppTurn(input: {
  threadId: string; codexHome: string; executable: string; cwd: string; text: string; env: NodeJS.ProcessEnv
  /** How long the start may take. */
  startTimeoutMs: number
  /** The longest the turn may run before it is interrupted. */
  maxTurnMs: number
  spawnServer?: (executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess
}): Promise<HostedTurn> {
  const env: NodeJS.ProcessEnv = { ...input.env, CODEX_HOME: input.codexHome }
  let child: ChildProcess
  try {
    child = (input.spawnServer ?? ((file, args, options) => spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })))(
      input.executable, ['-c', 'features.hooks=false', 'app-server'], { cwd: input.cwd, env })
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
  const timer = setTimeout(() => { void call('turn/interrupt', { threadId: input.threadId, turnId: id }, 5_000) }, input.maxTurnMs)
  timer.unref?.()
  const finished = done.then(async (status) => {
    clearTimeout(timer)
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

/** What the background server gets of the conversation's environment: enough for its tools, nothing of Notifai's. */
export function hostedTurnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {}
  for (const name of ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']) if (env[name] !== undefined) kept[name] = env[name]
  return kept
}
