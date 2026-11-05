import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { hostedTurnEnv, startHostedCodexAppTurn } from './codex-app-hosted-turn.js'

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

const run = (server: ReturnType<typeof fakeServer>, maxTurnMs = 60_000) => startHostedCodexAppTurn({ threadId: THREAD, codexHome: '/Users/u/.codex',
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
    // The app's own Codex, on the app's home, with hooks off: they would read its exit as the conversation's end.
    expect(server.spawned()).toMatchObject({ args: ['-c', 'features.hooks=false', 'app-server'], env: { CODEX_HOME: '/Users/u/.codex' } })
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
    const long = fakeServer({ complete: false })
    const capped = await run(long, 20)
    if (!capped.started) throw new Error('expected a start')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(long.calls.map((call) => call.method)).toContain('turn/interrupt')
  })

  it('passes the conversation\'s environment for tools, without Notifai\'s own', () => {
    expect(hostedTurnEnv({ HOME: '/h', PATH: '/bin', NOTIFAI_HOOK_SOURCE_PID: '1', CODEX_THREAD_ID: 't', SECRET_TOKEN: 'x' })).toEqual({ HOME: '/h', PATH: '/bin' })
  })
})
