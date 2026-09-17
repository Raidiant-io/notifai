import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CODEX_QUEUE_STORE_FILE,
  codexHome,
  codexQueueStorePath,
  codexWakeRoute,
  inspectCodexQueue,
  systemCodexWakeAdapters,
  type CodexWakeAdapters,
} from './codex-wake.js'

const THREAD_ID = '019ff69d-a07f-7161-ab6e-bd06b3b93c8e'

const event = {
  context:
    'Notifai — question_id rollout-option, question "Which rollout option?"; the user answered "BETA".',
  answers: 1,
  remaining: 0,
  request_ids: ['req_test'],
  journal_recorded_at: 1_800_000_000_000,
  commitDelivery: () => true,
}

const temporaries: string[] = []

afterAll(() => {
  for (const directory of temporaries) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-queue-'))
  temporaries.push(directory)
  return directory
}

interface QueuedMessage {
  threadId: string
  cwd: string
  context: string
}

function adapters(
  options: { fail?: Error } = {},
): CodexWakeAdapters & { queued: QueuedMessage[] } {
  const queued: QueuedMessage[] = []
  return {
    queued,
    async queue(threadId, cwd, context) {
      if (options.fail !== undefined) throw options.fail
      queued.push({ threadId, cwd, context })
    },
  }
}

function route(
  wake: CodexWakeAdapters,
  overrides: { threadId?: string; env?: NodeJS.ProcessEnv } = {},
): ReturnType<typeof codexWakeRoute> {
  return codexWakeRoute({
    threadId: overrides.threadId ?? THREAD_ID,
    cwd: '/tmp/notifai-codex-queue-cwd',
    env: overrides.env ?? { CODEX_HOME: '/tmp/notifai-codex-home' },
    adapters: wake,
  })
}

describe('Codex queue readiness', () => {
  it('is ready for any well-formed thread id, with no store or platform precondition', () => {
    expect(inspectCodexQueue(THREAD_ID, { CODEX_HOME: '/nowhere-at-all' })).toEqual({
      state: 'ready',
      threadId: THREAD_ID,
    })
  })

  it('refuses a session id that is not a thread id, because no inbox can be named', () => {
    const readiness = inspectCodexQueue('not-a-uuid', {})
    expect(readiness.state).toBe('unavailable')
    expect(readiness).toMatchObject({ reason: expect.stringContaining('not a thread id') })
  })

  it('refuses a missing session id rather than queueing into an unnamed thread', () => {
    expect(inspectCodexQueue(undefined, {}).state).toBe('unavailable')
  })

  it('names the queue store under CODEX_HOME without opening it', () => {
    const home = temporaryDirectory()
    expect(codexHome({ CODEX_HOME: home })).toBe(home)
    expect(codexQueueStorePath({ CODEX_HOME: home })).toBe(
      path.join(home, CODEX_QUEUE_STORE_FILE),
    )
  })
})

describe('Codex queue delivery', () => {
  it('queues the accepted answer into the thread that asked', async () => {
    const wake = adapters()
    const outcome = await route(wake).deliver(event)
    expect(wake.queued).toEqual([
      { threadId: THREAD_ID, cwd: '/tmp/notifai-codex-queue-cwd', context: event.context },
    ])
    expect(outcome.acknowledgement).toBe('delivered')
  })

  it('reports the queued stage, never a delivered one, because exit 0 is not consumption', async () => {
    const outcome = await route(adapters()).deliver(event)
    // A queue write against an exited thread succeeds identically to a live
    // one. The journal settles so the answer is never sent twice, but nothing
    // here may claim the session consumed it.
    expect(outcome.log).toMatchObject({ route: 'session-queue', stage: 'queued' })
    expect(JSON.stringify(outcome.log)).not.toContain('"stage":"delivered"')
  })

  it('is the only delivery the route can make: there is no resume path to double up with', () => {
    // `codex exec resume <id> "<prompt>"` drains the pending queue *and* runs
    // the prompt, so an adapter offering both would deliver one answer twice.
    // The guarantee is structural: the adapter surface exposes queueing alone.
    expect(Object.keys(systemCodexWakeAdapters({ CODEX_HOME: '/tmp' }))).toEqual(['queue'])
    expect(route(adapters()).kind).toBe('session-queue')
  })

  it('journals the answer when the session id cannot name a thread', async () => {
    const wake = adapters()
    const outcome = await route(wake, { threadId: 'codex-session-7' }).deliver(event)
    expect(wake.queued).toEqual([])
    expect(outcome.acknowledgement).toBe('held')
  })

  it('journals the answer when queueing fails, instead of reporting it delivered', async () => {
    const wake = adapters({ fail: new Error('no rollout found for thread id') })
    const outcome = await route(wake).deliver(event)
    expect(outcome.acknowledgement).toBe('held')
    expect(JSON.stringify(outcome)).toContain('no rollout found for thread id')
  })

  it('never queues an answer the SessionEnd fence declined to commit', async () => {
    const wake = adapters()
    const outcome = await route(wake).deliver({ ...event, commitDelivery: () => false })
    expect(wake.queued).toEqual([])
    expect(outcome.acknowledgement).toBe('held')
  })

  it('commits before writing, so a crash mid-queue cannot silently drop the answer', async () => {
    const order: string[] = []
    const wake: CodexWakeAdapters = {
      async queue() {
        order.push('queue')
      },
    }
    await route(wake).deliver({
      ...event,
      commitDelivery: () => {
        order.push('commit')
        return true
      },
    })
    expect(order).toEqual(['commit', 'queue'])
  })
})
