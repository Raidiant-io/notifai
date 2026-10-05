import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_PEER_PROTOCOL,
  CLAUDE_POST_SEND_LIVENESS_MS,
  claudeInboxAuth,
  claudeWakeRoute,
  inspectClaudeInbox,
  observeClaudeSession,
  systemClaudeWakeAdapters,
  type ClaudeSessionDescriptor,
  type ClaudeWakeAdapters,
} from './claude-wake.js'
import { WRITE_ABORTED_REASON, WriteAbortedError } from './wake-support.js'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const STARTED_AT = 1_800_000_000_000

function descriptor(overrides: Partial<ClaudeSessionDescriptor> = {}): ClaudeSessionDescriptor {
  return {
    pid: 12345,
    sessionId: SESSION_ID,
    cwd: '/tmp/notifai-claude-wake',
    startedAt: STARTED_AT,
    procStart: 'Wed Aug 12 08:17:53 2026',
    version: '2.1.228',
    peerProtocol: CLAUDE_PEER_PROTOCOL,
    messagingSocketPath: '/tmp/cc-socks/12345.sock',
    status: 'idle',
    ...overrides,
  }
}

function adapters(options: {
  agents?: unknown[]
  descriptor?: unknown
  agentsSequence?: unknown[][]
} = {}): ClaudeWakeAdapters & {
  sent: Array<{ socketPath: string; line: string }>
  resumed: Array<{ sessionId: string; cwd: string; context: string }>
  sleeps: number[]
} {
  const current = descriptor()
  const sent: Array<{ socketPath: string; line: string }> = []
  const resumed: Array<{ sessionId: string; cwd: string; context: string }> = []
  const sleeps: number[] = []
  const sequence = [...(options.agentsSequence ?? [])]
  return {
    sent,
    resumed,
    sleeps,
    async listAgents() {
      return sequence.shift() ?? options.agents ?? [
        {
          pid: current.pid,
          sessionId: current.sessionId,
          startedAt: current.startedAt,
          status: current.status,
        },
      ]
    },
    readDescriptor() {
      return options.descriptor ?? current
    },
    async sendSocket(socketPath, line) {
      sent.push({ socketPath, line })
    },
    async resume(sessionId, cwd, context) {
      resumed.push({ sessionId, cwd, context })
    },
    async sleep(milliseconds) {
      sleeps.push(milliseconds)
    },
  }
}

const event = {
  context:
    'Notifai — question_id rollout-option, question "Which rollout option?"; the user answered "BETA".',
  answers: 1,
  remaining: 0,
  request_ids: ['req_test'],
  journal_recorded_at: STARTED_AT,
  commitDelivery: () => true,
}

describe('Claude session observation', () => {
  it('treats a validated idle owner as socket-wakeable', async () => {
    const observation = await observeClaudeSession(SESSION_ID, adapters())

    expect(observation).toMatchObject({
      state: 'live-idle',
      descriptor: { sessionId: SESSION_ID, peerProtocol: CLAUDE_PEER_PROTOCOL },
    })
  })

  it('treats a validated busy owner as queueable on the inbox socket', async () => {
    const live = descriptor({ status: 'busy' })
    const observation = await observeClaudeSession(
      SESSION_ID,
      adapters({
        agents: [
          {
            pid: live.pid,
            sessionId: live.sessionId,
            startedAt: live.startedAt,
            status: live.status,
          },
        ],
        descriptor: live,
      }),
    )

    expect(observation.state).toBe('live-busy')
  })

  it('fails closed on an unknown peer protocol', async () => {
    const observation = await observeClaudeSession(
      SESSION_ID,
      adapters({ descriptor: descriptor({ peerProtocol: CLAUDE_PEER_PROTOCOL + 1 }) }),
    )

    expect(observation).toEqual({
      state: 'unknown',
      reason: `unsupported Claude peer protocol ${CLAUDE_PEER_PROTOCOL + 1}`,
    })
  })

  it('uses first-party status when the descriptor is in a transient shell state', async () => {
    const observation = await observeClaudeSession(
      SESSION_ID,
      adapters({ descriptor: descriptor({ status: 'shell' }) }),
    )

    expect(observation.state).toBe('live-idle')
  })

  it('fails closed when the first-party probe and descriptor identity disagree', async () => {
    const observation = await observeClaudeSession(
      SESSION_ID,
      adapters({ descriptor: descriptor({ startedAt: STARTED_AT + 1 }) }),
    )

    expect(observation).toEqual({
      state: 'unknown',
      reason: 'Claude liveness probe and descriptor disagree',
    })
  })

  it('calls a session stopped only when the liveness probe returns no owner', async () => {
    await expect(observeClaudeSession(SESSION_ID, adapters({ agents: [] }))).resolves.toEqual({
      state: 'stopped',
    })
  })
})

describe('Claude inbox release floor', () => {
  it('reports an unparseable descriptor version instead of treating it as zero', () => {
    expect(
      inspectClaudeInbox({
        pid: 12345,
        platform: 'darwin',
        readDescriptor: () => descriptor({ version: '2.next.224' }),
        socketExists: () => true,
      }),
    ).toEqual({
      state: 'unavailable',
      reason: 'the Claude Code version 2.next.224 is not a recognised release number',
    })
  })
  it('accepts a Windows named pipe from 2.1.234 without looking for it on disk', () => {
    const pipe = '\\\\.\\pipe\\LOCAL\\cc-msg-0123456789abcdef0123456789abcdef'
    const inspect = (version: string) => inspectClaudeInbox({
      pid: 12345,
      platform: 'win32',
      readDescriptor: () => descriptor({ version, messagingSocketPath: pipe }),
      socketExists: () => { throw new Error('a named pipe is never examined as a file') },
    })
    expect(inspect('2.1.282')).toEqual({ state: 'ready', socketPath: pipe, version: '2.1.282' })
    expect(inspect('2.1.233')).toEqual({
      state: 'unavailable',
      reason: 'Claude Code 2.1.233 is older than 2.1.234, which is where the inbox socket starts on win32',
    })
  })
})

describe('Claude wake delivery', () => {
  it('posts one newline-terminated JSON message and stays alive for provenance', async () => {
    const wake = adapters()
    const outcome = await claudeWakeRoute({
      sessionId: SESSION_ID,
      cwd: '/tmp/notifai-claude-wake',
      sourcePid: 12345,
      adapters: wake,
    }).deliver(event)

    expect(wake.sent).toHaveLength(1)
    expect(wake.sent[0]?.socketPath).toBe('/tmp/cc-socks/12345.sock')
    expect(wake.sent[0]?.line.endsWith('\n')).toBe(true)
    expect(JSON.parse(wake.sent[0]!.line)).toEqual({
      type: 'user',
      message: { role: 'user', content: event.context },
    })
    expect(wake.sleeps).toEqual([CLAUDE_POST_SEND_LIVENESS_MS])
    expect(wake.resumed).toEqual([])
    expect(outcome.log).toEqual({
      route: 'inbox-socket',
      stage: 'delivered',
      session_state: 'live-idle',
    })
  })

  it('holds rather than sending when exact Stop-hook ownership cannot be proven', async () => {
    const wake = adapters()

    const outcome = await claudeWakeRoute({
      sessionId: SESSION_ID,
      cwd: '/tmp/notifai-claude-wake',
      sourcePid: 99999,
      adapters: wake,
    }).deliver(event)

    expect(wake.sent).toEqual([])
    expect(outcome.log).toMatchObject({
      route: 'hold-for-next-turn',
      stage: 'queued',
      reason: 'the Stop-hook process cannot prove exact Claude session ownership',
    })
  })

  it('uses the same socket path for a busy session and reports queued delivery', async () => {
    const live = descriptor({ status: 'busy' })
    const wake = adapters({
      agents: [
        {
          pid: live.pid,
          sessionId: live.sessionId,
          startedAt: live.startedAt,
          status: live.status,
        },
      ],
      descriptor: live,
    })

    const outcome = await claudeWakeRoute({
      sessionId: SESSION_ID,
      cwd: live.cwd,
      sourcePid: 12345,
      adapters: wake,
    }).deliver(event)

    expect(wake.sent).toHaveLength(1)
    expect(outcome.notes.join('\n')).toContain('busy Claude session')
    expect(outcome.log?.['session_state']).toBe('live-busy')
  })

  it('cold-resumes only after two first-party probes both prove no owner', async () => {
    const wake = adapters({ agentsSequence: [[], []] })
    const outcome = await claudeWakeRoute({
      sessionId: SESSION_ID,
      cwd: '/tmp/notifai-claude-wake',
      sourcePid: 12345,
      adapters: wake,
    }).deliver(event)

    expect(wake.sent).toEqual([])
    expect(wake.resumed).toEqual([
      {
        sessionId: SESSION_ID,
        cwd: '/tmp/notifai-claude-wake',
        context: event.context,
      },
    ])
    expect(outcome.log).toEqual({ route: 'cold-resume', stage: 'delivered' })
  })

  it('holds rather than cold-resuming without exact Stop-hook parent ownership', async () => {
    const wake = adapters({ agentsSequence: [[], []] })

    const outcome = await claudeWakeRoute({
      sessionId: SESSION_ID,
      cwd: '/tmp/notifai-claude-wake',
      sourcePid: 99999,
      adapters: wake,
    }).deliver(event)

    expect(wake.resumed).toEqual([])
    expect(outcome.log).toMatchObject({
      route: 'hold-for-next-turn',
      stage: 'queued',
      reason: 'the Stop-hook process cannot prove exact Claude session ownership',
    })
  })

  it('refuses a ghost resume when a session becomes live between probes', async () => {
    const liveAgent = {
      pid: 12345,
      sessionId: SESSION_ID,
      startedAt: STARTED_AT,
      status: 'idle',
    }
    const wake = adapters({ agentsSequence: [[], [liveAgent]] })

    const outcome = await claudeWakeRoute({
      sessionId: SESSION_ID,
      cwd: '/tmp/notifai-claude-wake',
      sourcePid: 12345,
      adapters: wake,
    }).deliver(event)

    expect(wake.resumed).toEqual([])
    expect(wake.sent).toEqual([])
    expect(outcome.log).toMatchObject({
      route: 'hold-for-next-turn',
      stage: 'queued',
    })
    expect(outcome.notes.join('\n')).toContain('became live before cold resume')
  })

  it('holds the accepted answer when state or protocol is unknown', async () => {
    const wake = adapters({
      descriptor: descriptor({ peerProtocol: CLAUDE_PEER_PROTOCOL + 1 }),
    })
    const outcome = await claudeWakeRoute({
      sessionId: SESSION_ID,
      cwd: '/tmp/notifai-claude-wake',
      sourcePid: 12345,
      adapters: wake,
    }).deliver(event)

    expect(wake.sent).toEqual([])
    expect(wake.resumed).toEqual([])
    expect(outcome.log).toEqual({
      route: 'hold-for-next-turn',
      stage: 'queued',
      reason: `unsupported Claude peer protocol ${CLAUDE_PEER_PROTOCOL + 1}`,
    })
  })

  it('does not report delivery when the socket write fails', async () => {
    const wake = adapters()
    wake.sendSocket = vi.fn(async () => {
      throw new Error('socket unavailable')
    })

    await expect(
      claudeWakeRoute({
        sessionId: SESSION_ID,
        cwd: '/tmp/notifai-claude-wake',
        sourcePid: 12345,
        adapters: wake,
      }).deliver(event),
    ).rejects.toThrow('socket unavailable')
    expect(wake.sleeps).toEqual([])
  })
})

describe('claimed writes at the boundary', () => {
  it('commits a cold resume as a subprocess write and reports the child’s process group', async () => {
    const wake = adapters({ agentsSequence: [[], []] })
    wake.resume = async (_sessionId, _cwd, _context, onSpawn) => {
      onSpawn?.(4747)
    }
    const commits: Array<string | undefined> = []
    const groups: number[] = []
    const outcome = await claudeWakeRoute({
      sessionId: SESSION_ID,
      cwd: '/tmp/notifai-claude-wake',
      sourcePid: 12345,
      adapters: wake,
    }).deliver({
      ...event,
      commitDelivery: (writer?: 'subprocess') => {
        commits.push(writer)
        return true
      },
      writerGroup: (pgid) => groups.push(pgid),
    })
    expect(commits).toEqual(['subprocess'])
    expect(groups).toEqual([4747])
    expect(outcome.acknowledgement).toBe('delivered')
  })

  it('holds, as aborted, a write its guard stopped at the socket', async () => {
    const wake = adapters()
    wake.sendSocket = async (_path, _line, guard) => {
      expect(guard?.writable()).toBe(false)
      throw new WriteAbortedError('the claim lapsed before the first byte')
    }
    const outcome = await claudeWakeRoute({
      sessionId: SESSION_ID,
      cwd: '/tmp/notifai-claude-wake',
      sourcePid: 12345,
      adapters: wake,
    }).deliver({ ...event, writeGuard: { writable: () => false, remainingMs: () => 0 } })
    expect(outcome).toMatchObject({ acknowledgement: 'held', log: { reason: WRITE_ABORTED_REASON } })
    expect(wake.sleeps).toEqual([])
  })

  it('sends no byte over a real inbox socket once the guard says the claim lapsed', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'nf-sock-'))
    const socketPath = path.join(directory, 'inbox.sock')
    const received: string[] = []
    const server = createServer((socket) => {
      socket.on('data', (chunk) => received.push(chunk.toString()))
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      const system = systemClaudeWakeAdapters({})
      await expect(
        system.sendSocket(socketPath, 'late\n', { writable: () => false, remainingMs: () => 5_000 }),
      ).rejects.toBeInstanceOf(WriteAbortedError)
      await system.sendSocket(socketPath, 'in time\n', { writable: () => true, remainingMs: () => 5_000 })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(received.join('')).toBe('in time\n')
    } finally {
      server.close()
    }
  })

  it('abandons a connection still pending at the write boundary', async () => {
    const system = systemClaudeWakeAdapters({})
    // Nothing listens here: the connection neither succeeds nor matters, and the
    // boundary has already passed, so the write is abandoned as aborted.
    const missing = path.join(mkdtempSync(path.join(os.tmpdir(), 'nf-sock-')), 'none.sock')
    await expect(
      system.sendSocket(missing, 'late\n', { writable: () => true, remainingMs: () => 0 }),
    ).rejects.toBeInstanceOf(Error)
  })
})

describe('Claude inbox token', () => {
  const event = () => ({
    context: 'wake', answers: 0, remaining: 0, request_ids: [], journal_recorded_at: 1,
    commitDelivery: () => true,
  })
  const lines = (line: string) => line.trimEnd().split('\n').map((entry) => JSON.parse(entry) as Record<string, unknown>)

  it('opens the connection with the session token Claude Code exported for this exact socket', async () => {
    const fake = adapters()
    const route = claudeWakeRoute({
      sessionId: SESSION_ID, cwd: '/tmp', sourcePid: 12345, adapters: fake,
      env: { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/12345.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'token-a', CLAUDE_CODE_SESSION_ID: SESSION_ID },
    })
    await route.deliver(event() as never)
    expect(lines(fake.sent[0]!.line)).toEqual([
      { type: 'auth', token: 'token-a' },
      { type: 'user', message: { role: 'user', content: 'wake' } },
    ])
  })

  it('never offers a token to a socket it was not issued with', async () => {
    const fake = adapters()
    const route = claudeWakeRoute({
      sessionId: SESSION_ID, cwd: '/tmp', sourcePid: 12345, adapters: fake,
      env: { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/99999.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'token-b' },
    })
    await route.deliver(event() as never)
    expect(lines(fake.sent[0]!.line)).toEqual([{ type: 'user', message: { role: 'user', content: 'wake' } }])
  })

  it('refuses a Windows write without the token, before the delivery is committed', async () => {
    const fake = adapters()
    let committed = 0
    const route = claudeWakeRoute({ sessionId: SESSION_ID, cwd: '/tmp', sourcePid: 12345, adapters: fake, env: {}, platform: 'win32' })
    const outcome = await route.deliver({ ...event(), commitDelivery: () => { committed++; return true } } as never)
    // Claude Code on Windows closes a connection that does not open with the
    // token; nothing is written and the answer stays for the next turn.
    expect(fake.sent).toEqual([])
    expect(committed).toBe(0)
    expect(JSON.stringify(outcome.log)).toContain('holds no inbox token')
  })

  it('writes to a Windows named pipe when the token names it', async () => {
    const pipe = '\\\\.\\pipe\\LOCAL\\cc-msg-0123456789abcdef0123456789abcdef'
    const fake = adapters({ descriptor: descriptor({ messagingSocketPath: pipe }) })
    const route = claudeWakeRoute({
      sessionId: SESSION_ID, cwd: '/tmp', sourcePid: 12345, adapters: fake, platform: 'win32',
      env: { CLAUDE_CODE_MESSAGING_SOCKET: pipe, CLAUDE_CODE_MESSAGING_TOKEN: 'token-w' },
    })
    await route.deliver(event() as never)
    expect(fake.sent[0]?.socketPath).toBe(pipe)
    expect(lines(fake.sent[0]!.line)[0]).toEqual({ type: 'auth', token: 'token-w' })
  })

  it('reads credentials only when both were exported for this session', () => {
    const exported = { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s.sock', CLAUDE_CODE_MESSAGING_TOKEN: 't' }
    expect(claudeInboxAuth(exported, SESSION_ID)).toEqual({ socketPath: '/tmp/s.sock', token: 't' })
    expect(claudeInboxAuth({ ...exported, CLAUDE_CODE_SESSION_ID: SESSION_ID }, SESSION_ID)).not.toBeNull()
    expect(claudeInboxAuth({ ...exported, CLAUDE_CODE_SESSION_ID: 'another-session' }, SESSION_ID)).toBeNull()
    expect(claudeInboxAuth({ CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s.sock' }, SESSION_ID)).toBeNull()
    expect(claudeInboxAuth({ CLAUDE_CODE_MESSAGING_TOKEN: 't' }, SESSION_ID)).toBeNull()
  })

  it('writes the user line alone when Claude Code exported no token', async () => {
    const fake = adapters()
    const route = claudeWakeRoute({ sessionId: SESSION_ID, cwd: '/tmp', sourcePid: 12345, adapters: fake, env: {} })
    await route.deliver(event() as never)
    expect(lines(fake.sent[0]!.line)).toEqual([{ type: 'user', message: { role: 'user', content: 'wake' } }])
    expect(fake.sleeps).toEqual([CLAUDE_POST_SEND_LIVENESS_MS])
  })
})
