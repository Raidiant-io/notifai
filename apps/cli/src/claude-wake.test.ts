import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_PEER_PROTOCOL,
  CLAUDE_POST_SEND_LIVENESS_MS,
  claudeWakeRoute,
  observeClaudeSession,
  type ClaudeSessionDescriptor,
  type ClaudeWakeAdapters,
} from './claude-wake.js'

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
