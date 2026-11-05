import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { hostedTurnEnv, notifaiHooksStandDown, runHostedCodexAppTurn, startHostedCodexAppTurn } from './codex-app-hosted-turn.js'

const THREAD = '01a1abbc-72db-7b31-8454-c857da5388e4'

/**
 * A private `codex app-server` as the app's Codex 0.166 answered in a
 * sandbox home (2026-11-05): resume, then a turn that completes, or a refusal.
 */
function fakeServer(options: { resume?: 'ok' | 'refused'; lastTurn?: string; request?: boolean; complete?: boolean } = {}) {
  const calls: Array<{ method: string; params: unknown }> = []
  const replies: unknown[] = []
  let spawned: { executable: string; args: string[]; env: NodeJS.ProcessEnv } | null = null
  let killed = false
  const spawnServer = (executable: string, args: string[], spawnOptions: { cwd: string; env: NodeJS.ProcessEnv }) => {
    spawned = { executable, args, env: spawnOptions.env }
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin, stdout, kill: () => { killed = true; setImmediate(() => child.emit('exit', 0)); return true } })
    const send = (message: object) => stdout.write(`${JSON.stringify(message)}\n`)
    let buffer = ''
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk: string) => {
      buffer += chunk
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, at)) as { id?: number; method?: string; params?: unknown; error?: unknown }
        buffer = buffer.slice(at + 1)
        if (message.method === undefined) { replies.push(message); continue }
        calls.push({ method: message.method, params: message.params })
        if (message.id === undefined) continue
        if (message.method === 'initialize') send({ id: message.id, result: { codexHome: '/h' } })
        else if (message.method === 'thread/resume') {
          send(options.resume === 'refused' ? { id: message.id, error: { message: 'thread already has an active writer' } }
            : { id: message.id, result: { thread: { id: THREAD, turns: [{ status: 'completed' }, { status: options.lastTurn ?? 'interrupted' }] } } })
        } else if (message.method === 'turn/start') {
          send({ id: message.id, result: { turn: { id: 'turn_hosted', status: 'inProgress' } } })
          if (options.request === true) send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: THREAD } })
          if (options.complete !== false) setTimeout(() => send({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: 'turn_hosted', status: 'completed' } } }), 5)
        } else send({ id: message.id, result: {} })
      }
    })
    return child as unknown as ChildProcess
  }
  return { spawnServer, calls, replies, spawned: () => spawned, killed: () => killed }
}

const run = (server: ReturnType<typeof fakeServer>, maxTurnMs = 60_000, graceMs?: number) => startHostedCodexAppTurn({ ...(graceMs === undefined ? {} : { graceMs }), threadId: THREAD, codexHome: '/Users/u/.codex',
  executable: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', cwd: '/p', text: 'WAKE',
  env: { HOME: '/Users/u', PATH: '/usr/bin' }, startTimeoutMs: 5_000, maxTurnMs, spawnServer: server.spawnServer })

describe('a stopped Codex app conversation\'s turn in the background', () => {
  it('resumes the stopped thread, starts the wake as the User sending it does, waits for the turn, then lets the thread go', async () => {
    const server = fakeServer()
    const hosted = await run(server)
    expect(hosted).toMatchObject({ started: true, turnId: 'turn_hosted' })
    if (!hosted.started) return
    expect(await hosted.done).toBe('completed')
    expect(server.calls.map((call) => call.method)).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start', 'thread/unsubscribe'])
    expect(server.calls[3]!.params).toEqual({ threadId: THREAD, input: [{ type: 'text', text: 'WAKE', text_elements: [] }] })
    // The app's own Codex, on the app's home, with every hook on: only Notifai's stand down, by the server's own marker.
    expect(server.spawned()).toMatchObject({ args: ['app-server'], env: { CODEX_HOME: '/Users/u/.codex' } })
    expect(server.spawned()!.args).not.toContain('features.hooks=false')
    expect(server.killed()).toBe(true)
  })

  it('never becomes a second writer, and leaves a conversation that moved on since the stop', async () => {
    const held = fakeServer({ resume: 'refused' })
    expect(await run(held)).toEqual({ started: false, reason: 'resume-refused' })
    expect(held.calls.some((call) => call.method === 'turn/start')).toBe(false)
    const moved = fakeServer({ lastTurn: 'completed' })
    expect(await run(moved)).toEqual({ started: false, reason: 'last-turn-completed' })
    expect(moved.calls.map((call) => call.method)).toContain('thread/unsubscribe')
    expect(moved.calls.some((call) => call.method === 'turn/start')).toBe(false)
  })

  it('declines what nobody is there to answer, and interrupts a turn that runs past its limit', async () => {
    const asking = fakeServer({ request: true })
    const hosted = await run(asking)
    if (!hosted.started) throw new Error('expected a start')
    await hosted.done
    expect(asking.replies).toContainEqual(expect.objectContaining({ id: 900, error: expect.objectContaining({ code: -32601 }) }))
    // A server that ends nothing after the interrupt is stopped once the grace runs out.
    const long = fakeServer({ complete: false })
    const capped = await run(long, 20, 30)
    if (!capped.started) throw new Error('expected a start')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(long.calls.map((call) => call.method)).toContain('turn/interrupt')
    expect(long.killed()).toBe(false)
    expect(await capped.done).toBe('stopped')
    expect(long.killed()).toBe(true)
  })

  it('passes the conversation\'s environment for its tools, less the markers of one hook or command', () => {
    const env = { HOME: '/h', PATH: '/bin', SSH_AUTH_SOCK: '/s', GH_TOKEN: 'g', HTTPS_PROXY: 'p', XDG_CONFIG_HOME: '/x', NOTIFAI_CREDENTIALS: 'file',
      NOTIFAI_HOOK_SOURCE_PID: '1', NOTIFAI_NATIVE_ENTRY: 'launcher-v1', NOTIFAI_INTERNAL_HOSTED_TURN_INPUT: '{}', CODEX_THREAD_ID: 't' }
    expect(hostedTurnEnv(env)).toEqual({ HOME: '/h', PATH: '/bin', SSH_AUTH_SOCK: '/s', GH_TOKEN: 'g', HTTPS_PROXY: 'p', XDG_CONFIG_HOME: '/x', NOTIFAI_CREDENTIALS: 'file' })
  })

  it('runs only where every Notifai hook knows to stand down there', async () => {
    const hooks = (commands: string[]) => async () => ({ data: [{ cwd: '/p', hooks: commands.map((command) => ({ command })) }] })
    const notifai = "'/Users/u/.notifai/bin/notifai' hook user-prompt-submit --owner notifai --harness codex"
    const check = (commands: string[], versions: Record<string, number | null>) => notifaiHooksStandDown({ executable: '/c', codexHome: '/h', cwd: '/p',
      env: { PATH: '/usr/bin' }, list: hooks(commands), launcherVersion: (program) => versions[program] ?? null })
    expect(await check([notifai, '/usr/local/bin/guard --strict'], { '/Users/u/.notifai/bin/notifai': 2 })).toBe(true)
    // An older launcher would let Notifai's hooks read the server as a second host.
    expect(await check([notifai], { '/Users/u/.notifai/bin/notifai': 1 })).toBe(false)
    expect(await check([notifai], {})).toBe(false)
    expect(await notifaiHooksStandDown({ executable: '/c', codexHome: '/h', cwd: '/p', env: {}, list: async () => null })).toBe(false)
  })

  it('has its detached runner record the turn\'s start and end, as its hooks would', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const { readSessionState, writeSessionState } = await import('./hook-session-state.js')
    const { codexInterruptedTurn, recordTurnInterrupt, recordTurnStart, observedCodexTurnActivity } = await import('./session-attendant-state.js')
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hosted-runner-'))
    try {
      const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state') }
      writeSessionState(THREAD, env, { harness: 'codex', interrupt_wake: { key: 'owner', turn: 'turn-stopped', route: 'codex-app', at: 1, outcome: 'trying' } })
      recordTurnStart(THREAD, env, 'owner', 'turn-stopped')
      recordTurnInterrupt(THREAD, env, 'turn-stopped')
      let finish: (status: 'completed') => void = () => undefined
      const done = new Promise<'completed'>((resolve) => { finish = resolve })
      const running = runHostedCodexAppTurn({ session_id: THREAD, owner_key: 'owner', turn: 'turn-stopped', codex_home: '/h', executable: '/c', cwd: '/p', text: 'WAKE', max_turn_ms: 1_000 },
        env, { start: async () => ({ started: true, turnId: 'turn-hosted', done }) })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(readSessionState(THREAD, env).interrupt_wake).toMatchObject({ outcome: 'started', hosted: { turn: 'turn-hosted' } })
      expect(codexInterruptedTurn(THREAD, env, 'owner')).toBeNull()
      expect(observedCodexTurnActivity(THREAD, env, 'owner')).toBe('working')
      finish('completed')
      expect(await running).toBe('completed')
      expect(observedCodexTurnActivity(THREAD, env, 'owner')).toBe('idle')
      expect(readSessionState(THREAD, env).interrupt_wake?.hosted).toMatchObject({ ended: true })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
