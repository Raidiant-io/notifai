import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  codexAttachResultFor,
  codexBinaryIdentity,
  codexThreadAttachState,
  parseNetstatListener,
  parseProcessStart,
  parseSsListener,
  recordCodexAttachResult,
  type CodexAttachDeps,
  type CodexAttachInput,
} from './codex-attach-signal.js'
import type { CodexControl } from './codex-native-control.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const T = '01a15894-7ee3-7a72-aa96-46ebffe18e86'
const NEWER = '01a15899-b757-74f1-859d-85a9e1e084eb'
const HOST = { pid: 4242, start: 'Tue Oct 20 09:00:00 2026' }
const LOADED_AT = Date.UTC(2026, 9, 20, 9, 12, 45)

/**
 * A shared server as the checks see it: which threads are loaded, the
 * terminal origin each was bound to, and what a `thread/resume` does.
 */
function server(options: {
  loaded?: boolean
  origins?: Record<string, string | null>
  others?: string[]
  status?: string
  resume?: 'join' | 'reload' | 'error'
  fail?: string
} = {}) {
  const calls: string[] = []
  const locks: Record<string, number> = { [T]: LOADED_AT, [NEWER]: LOADED_AT + 60_000 }
  let unsubscribed = 0
  const control: CodexControl = {
    namespace: '/home/u/.codex',
    threadId: T,
    loaded: options.loaded ?? true,
    call: async (method, params) => {
      calls.push(method)
      if (method === options.fail) throw new Error('refused')
      const thread = (params as { threadId?: string }).threadId ?? ''
      switch (method) {
        case 'mcpServerStatus/list': {
          const origin = (options.origins ?? { [T]: 'http://127.0.0.1:60097' })[thread] ?? null
          return { data: origin === null ? [] : [{ name: 'codex_tui', httpOrigin: origin }] }
        }
        case 'thread/loaded/list': return { data: [T, ...(options.others ?? [])], nextCursor: null }
        case 'thread/read': return { thread: { status: { type: options.status ?? 'idle' } } }
        case 'thread/resume':
          if (options.resume === 'error') throw new Error('resume failed')
          if (options.resume === 'reload') locks[T] = LOADED_AT + 5_000
          return { thread: { id: T } }
        case 'thread/unsubscribe': unsubscribed += 1; return { status: 'unsubscribed' }
        default: throw new Error(`unexpected ${method}`)
      }
    },
    close: () => undefined,
  }
  return { control, calls, locks, unsubscribed: () => unsubscribed }
}

function deps(fake: ReturnType<typeof server>, overrides: Partial<CodexAttachDeps> = {}): Partial<CodexAttachDeps> {
  return {
    verified: () => true,
    connect: async () => fake.control,
    listener: () => ({ pid: 9001, startedAtMs: LOADED_AT - 30_000 }),
    lockMtime: (_home, threadId) => fake.locks[threadId] ?? null,
    now: () => 0,
    ...overrides,
  }
}

const input = (confirm: CodexAttachInput['confirm'], beforeConfirm?: () => void): CodexAttachInput =>
  ({ threadId: T, env: {}, host: HOST, confirm, ...(beforeConfirm === undefined ? {} : { beforeConfirm }) })

describe('whether a terminal shows a conversation on Codex\'s shared server', () => {
  it('asks nothing before Codex\'s behaviour was checked for the server\'s binary', async () => {
    const fake = server()
    let connected = false
    const state = await codexThreadAttachState(input('always'), deps(fake, { verified: () => false, connect: async () => { connected = true; return fake.control } }))
    expect(state).toEqual({ state: 'unknown', confirmed: false, reason: 'codex-build-unverified' })
    expect(connected).toBe(false)
  })

  it('cannot tell without a connection to the thread\'s own server', async () => {
    expect(await codexThreadAttachState(input('always'), deps(server(), { connect: async () => null })))
      .toMatchObject({ state: 'unknown', confirmed: false })
  })

  it('never sends the confirming request to a thread the server put away: it would load it', async () => {
    const fake = server({ loaded: false })
    expect(await codexThreadAttachState(input('always'), deps(fake))).toMatchObject({ state: 'not-loaded', confirmed: false })
    expect(fake.calls).toEqual([])
  })

  it.each([
    ['no terminal loaded it', { origins: { [T]: null } }, {}, 'no-terminal-loaded-it'],
    ['its terminal is gone', {}, { listener: () => null }, 'terminal-gone'],
    ['another process took the port after the load', {}, { listener: () => ({ pid: 9002, startedAtMs: LOADED_AT + 10_000 }) }, 'listener-newer-than-load'],
    ['its terminal moved on to a newer conversation', { others: [NEWER], origins: { [T]: 'http://127.0.0.1:60097', [NEWER]: 'http://127.0.0.1:60097' } }, {}, 'terminal-moved-on'],
  ] as const)('reads it as not shown when %s, and asks nothing before a wake', async (_name, shape, overrides, reason) => {
    const fake = server(shape)
    expect(await codexThreadAttachState(input('attached'), deps(fake, overrides))).toEqual({ state: 'closed', confirmed: false, reason })
    expect(fake.calls).not.toContain('thread/resume')
  })

  it('reads it as shown while its terminal lives and another terminal shows a different conversation', async () => {
    const fake = server({ others: [NEWER], origins: { [T]: 'http://127.0.0.1:60097', [NEWER]: 'http://127.0.0.1:60123' } })
    expect(await codexThreadAttachState(input('never'), deps(fake))).toEqual({ state: 'attached', confirmed: false, reason: 'terminal-live' })
  })

  it.each([
    ['joins: a client is subscribed', 'join' as const, { state: 'attached', confirmed: true, reason: 'terminal-live+joined' }],
    ['reloads: nobody was subscribed', 'reload' as const, { state: 'closed', confirmed: true, reason: 'terminal-live+reloaded' }],
  ])('before a wake, confirms by asking the server, which %s', async (_name, resume, expected) => {
    const fake = server({ resume })
    const order: string[] = []
    const state = await codexThreadAttachState(input('attached', () => order.push(`marked after ${fake.calls.length} calls`)), deps(fake))
    expect(state).toEqual(expected)
    // The marker comes right before the request that may reload the thread, and Notifai always unsubscribes.
    expect(fake.calls.slice(-3)).toEqual(['thread/read', 'thread/resume', 'thread/unsubscribe'])
    expect(order).toEqual([`marked after ${fake.calls.length - 2} calls`])
    expect(fake.unsubscribed()).toBe(1)
  })

  it('before expiring questions, confirms a terminal that only joined the conversation still shows it', async () => {
    const fake = server({ resume: 'join' })
    expect(await codexThreadAttachState(input('closed'), deps(fake, { listener: () => null })))
      .toEqual({ state: 'attached', confirmed: true, reason: 'terminal-gone+joined' })
  })

  it.each([
    ['the thread is running a turn', { status: 'active' }],
    ['the confirming request fails', { resume: 'error' as const }],
    ['the server refuses a request', { fail: 'mcpServerStatus/list' }],
  ])('cannot tell when %s', async (_name, shape) => {
    const fake = server(shape)
    const state = await codexThreadAttachState(input('always'), deps(fake))
    expect(state).toMatchObject({ state: 'unknown', confirmed: false })
  })
})

describe('reading the process table', () => {
  it('finds the codex process listening on a terminal\'s port (macOS netstat)', () => {
    const output = [
      'Active Internet connections (including servers)',
      'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)      rhiwat  shiwat    pid   epid state  options           gencnt    flags   flags1 usscnt rtncnt fltrs',
      'tcp4       0      0  127.0.0.1.60097        *.*                    LISTEN       131072  131072  82290      0 00100 00000006 0000000000a1b2c3 00000000 00000800      1      0 000001 codex:82290',
      'tcp4       0      0  127.0.0.1.60098        *.*                    LISTEN       131072  131072  77777      0 00100 00000006 0000000000a1b2c4 00000000 00000800      1      0 000001 node:77777',
      'tcp4       0      0  127.0.0.1.60097        127.0.0.1.51000        ESTABLISHED  131072  131072  81569      0 00102 00000000 0000000000a1b2c5 00000000 00000800      1      0 000001 codex:81569',
    ].join('\n')
    expect(parseNetstatListener(output, 60097)).toBe(82290)
    expect(parseNetstatListener(output, 60098)).toBeNull()
    expect(parseNetstatListener(output, 60099)).toBeNull()
  })

  it('finds it on Linux (ss)', () => {
    expect(parseSsListener('LISTEN 0 128 127.0.0.1:60097 0.0.0.0:* users:(("codex",pid=8123,fd=21))')).toBe(8123)
    expect(parseSsListener('LISTEN 0 128 127.0.0.1:60097 0.0.0.0:* users:(("python3",pid=8124,fd=3))')).toBeNull()
  })

  it('reads a process start under UTC', () => {
    expect(parseProcessStart('Tue Oct 20 09:12:45 2026')).toBe(LOADED_AT)
    expect(parseProcessStart('Tue Oct  6 09:12:45 2026')).toBe(Date.UTC(2026, 9, 6, 9, 12, 45))
    expect(parseProcessStart('yesterday')).toBeNull()
  })
})

describe('the behaviour check\'s results, per Codex binary', () => {
  it('keeps a result for exactly one binary: an update (new size or time) has none until it is checked', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-attach-results-'))
    roots.push(root)
    const env = { XDG_STATE_HOME: path.join(root, 'state') }
    const binary = path.join(root, 'codex')
    writeFileSync(binary, 'v1')
    const before = codexBinaryIdentity(binary)!
    recordCodexAttachResult(env, { binary: before, codexVersion: '0.163.0', outcome: 'passed', checkedAt: 1 })
    expect(codexAttachResultFor(env, before)?.outcome).toBe('passed')

    writeFileSync(binary, 'v2 is longer')
    utimesSync(binary, new Date(), new Date(Date.now() + 5_000))
    const after = codexBinaryIdentity(binary)!
    expect(codexAttachResultFor(env, after)).toBeNull()
    recordCodexAttachResult(env, { binary: after, codexVersion: '0.164.0', outcome: 'failed', step: 2, checkedAt: 2 })
    expect(codexAttachResultFor(env, after)).toMatchObject({ outcome: 'failed', step: 2 })
    // The earlier binary keeps its own result.
    expect(codexAttachResultFor(env, before)?.outcome).toBe('passed')
  })
})
