import { describe, expect, it } from 'vitest'
import type { CodexControl, CodexControlMethod } from './codex-native-control.js'
import { codexThreadOnSharedServer, removeQueuedCodexWake, startPausedCodexWake } from './codex-paused-wake.js'
import { queuedMessageId } from './codex-wake.js'

const THREAD = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b'

/** A shared server with one queue; `start` and `delete` answer as Codex does. */
function server(options: { queued?: string[]; startResult?: 'started' | 'refused'; deleteThrows?: boolean } = {}) {
  const queue = [...(options.queued ?? [])]
  const calls: Array<{ method: CodexControlMethod; params: Record<string, unknown> }> = []
  let closed = 0
  const control: CodexControl = {
    namespace: '/codex', threadId: THREAD, loaded: true,
    call: async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> })
      const id = (params as { queuedSubmissionId?: string }).queuedSubmissionId
      if (method === 'thread/queue/list') return { data: queue.map((item) => ({ id: item })), nextCursor: null }
      if (method === 'thread/queue/start') {
        if (!queue.includes(id!)) throw new Error('Native queue RPC refused; acceptance not established')
        if (options.startResult === 'refused') throw new Error('Native queue RPC refused; acceptance not established')
        queue.splice(queue.indexOf(id!), 1)
        return { turn: { id: 'turn-wake', status: 'inProgress' } }
      }
      if (method === 'thread/queue/delete') {
        if (options.deleteThrows === true) throw new Error('Native queue RPC refused; acceptance not established')
        const at = queue.indexOf(id!)
        if (at >= 0) queue.splice(at, 1)
        return { deleted: at >= 0 }
      }
      throw new Error(`unexpected ${method}`)
    },
    close: () => { closed += 1 },
  }
  return { queue, calls, control, closed: () => closed }
}

const soon = () => performance.now() + 1_000

describe('starting a wake behind an interrupt', () => {
  it('starts exactly its own queued item and leaves the User\'s', async () => {
    const s = server({ queued: ['user_1', 'qs_1'] })
    expect(await startPausedCodexWake(THREAD, {}, 'qs_1', soon(), { connect: async () => s.control })).toBe('started')
    expect(s.calls[0]).toEqual({ method: 'thread/queue/start', params: { threadId: THREAD, queuedSubmissionId: 'qs_1' } })
    expect(s.queue).toEqual(['user_1'])
    expect(s.closed()).toBe(1)
  })

  it('counts an item no longer queued as woken, and one Codex kept (a turn runs) as refused', async () => {
    expect(await startPausedCodexWake(THREAD, {}, 'qs_1', soon(), { connect: async () => server({ queued: [] }).control })).toBe('gone')
    expect(await startPausedCodexWake(THREAD, {}, 'qs_1', soon(), { connect: async () => server({ queued: ['qs_1'], startResult: 'refused' }).control })).toBe('refused')
  })

  it('reports no route where no shared server has the thread, without trying anything else', async () => {
    expect(await startPausedCodexWake(THREAD, {}, 'qs_1', soon(), { connect: async () => null })).toBe('unreachable')
    expect(await codexThreadOnSharedServer(THREAD, {}, soon(), { connect: async () => null })).toBe(false)
    const s = server()
    expect(await codexThreadOnSharedServer(THREAD, {}, soon(), { connect: async () => s.control })).toBe(true)
    expect(s.calls).toEqual([])
  })
})

describe('removing a wake the input no longer needs', () => {
  it('removes through the shared server when one runs for the home, even with the thread loaded elsewhere', async () => {
    const s = server({ queued: ['qs_1', 'user_1'] })
    let allowUnloaded: boolean | undefined
    const stdio = async () => { throw new Error('must not start a second server') }
    expect(await removeQueuedCodexWake(THREAD, {}, '/tmp', 'qs_1', soon(), {
      connect: async (_thread, _env, _deadline, _now, _unavailable, options) => { allowUnloaded = options?.allowUnloaded; return s.control }, stdio,
    })).toBe('deleted')
    expect(allowUnloaded).toBe(true)
    expect(s.queue).toEqual(['user_1'])
    expect(await removeQueuedCodexWake(THREAD, {}, '/tmp', 'qs_1', soon(), { connect: async () => s.control, stdio })).toBe('gone')
  })

  it('removes through a private server only where no shared server runs, with one queue request', async () => {
    const requests: Array<{ method: string; params: unknown }> = []
    const stdio = async (_env: NodeJS.ProcessEnv, _cwd: string, method: string, params: unknown) => { requests.push({ method, params }); return { deleted: true } }
    expect(await removeQueuedCodexWake(THREAD, {}, '/tmp', 'qs_1', soon(), {
      connect: async (_thread, _env, _deadline, _now, unavailable) => { unavailable?.('discovery'); return null }, stdio,
    })).toBe('deleted')
    expect(requests).toEqual([{ method: 'thread/queue/delete', params: { threadId: THREAD, queuedSubmissionId: 'qs_1' } }])
  })

  it.each(['endpoint', 'connection', 'namespace'])('never writes through another server when the shared one fails at %s', async (stage) => {
    let used = false
    expect(await removeQueuedCodexWake(THREAD, {}, '/tmp', 'qs_1', soon(), {
      connect: async (_thread, _env, _deadline, _now, unavailable) => { unavailable?.(stage); return null },
      stdio: async () => { used = true; return { deleted: true } },
    })).toBe('failed')
    expect(used).toBe(false)
  })

  it('fails softly when Codex cannot be asked at all (no `codex` on PATH, a refusal)', async () => {
    expect(await removeQueuedCodexWake(THREAD, {}, '/tmp', 'qs_1', soon(), {
      connect: async (_thread, _env, _deadline, _now, unavailable) => { unavailable?.('discovery'); return null },
      stdio: async () => null,
    })).toBe('failed')
    expect(await removeQueuedCodexWake(THREAD, {}, '/tmp', 'qs_1', soon(), { connect: async () => server({ deleteThrows: true }).control })).toBe('failed')
  })
})

describe('the queued id `codex queue` prints', () => {
  it('is read only for the exact thread', () => {
    expect(queuedMessageId(`Queued message 019a-qs for thread ${THREAD}.\n`, THREAD)).toBe('019a-qs')
    expect(queuedMessageId(`Warning: x\r\nQueued message qs_2 for thread ${THREAD}.\r\n`, THREAD)).toBe('qs_2')
    expect(queuedMessageId(`Queued message qs_3 for thread 00000000-0000-0000-0000-000000000000.\n`, THREAD)).toBeUndefined()
    expect(queuedMessageId('', THREAD)).toBeUndefined()
  })
})
