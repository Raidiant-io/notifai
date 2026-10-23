import { mkdtempSync,rmSync,utimesSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
import {
codexAttachResultFor,
codexBinaryIdentity,
codexThreadAttachState,
parseNetstatListener,
recordCodexAttachResult,
type CodexAttachDeps,
type CodexAttachInput
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
