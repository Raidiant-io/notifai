import { describe,expect,it } from 'vitest'
import {
CLAUDE_PEER_PROTOCOL,
CLAUDE_POST_SEND_LIVENESS_MS,
claudeWakeRoute,
inspectClaudeInbox,
observeClaudeSession,
type ClaudeSessionDescriptor,
type ClaudeWakeAdapters
} from './claude-wake.js'
import { WRITE_ABORTED_REASON,WriteAbortedError } from './wake-support.js'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const STARTED_AT = 1_800_000_000_000
/** These cases describe the POSIX socket; the Windows pipe has its own below. */
const POSIX = 'darwin' as const

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
} = {}): ClaudeWakeAdapters & {
  sent: Array<{ socketPath: string; line: string }>
  sleeps: number[]
  readonly probes: number
} {
  const current = descriptor()
  const sent: Array<{ socketPath: string; line: string }> = []
  const sleeps: number[] = []
  let probes = 0
  return {
    sent,
    sleeps,
    get probes() {
      return probes
    },
    async listAgents() {
      probes++
      return options.agents ?? [
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
      settling: false,
    })
  })
})

describe('Claude wake delivery', () => {
  it('posts one newline-terminated JSON message and stays alive for provenance', async () => {
    const wake = adapters()
    const outcome = await claudeWakeRoute({ platform: POSIX,
      sessionId: SESSION_ID,
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
    expect(outcome.log).toEqual({
      route: 'inbox-socket',
      stage: 'delivered',
      session_state: 'live-idle',
    })
  })

  it('holds rather than sending when exact Stop-hook ownership cannot be proven', async () => {
    const wake = adapters()

    const outcome = await claudeWakeRoute({ platform: POSIX,
      sessionId: SESSION_ID,
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
})

describe('claimed writes at the boundary', () => {
  it('holds, as aborted, a write its guard stopped at the socket', async () => {
    const wake = adapters()
    wake.sendSocket = async (_path, _line, guard) => {
      expect(guard?.writable()).toBe(false)
      throw new WriteAbortedError('the claim lapsed before the first byte')
    }
    const outcome = await claudeWakeRoute({ platform: POSIX,
      sessionId: SESSION_ID,
      sourcePid: 12345,
      adapters: wake,
    }).deliver({ ...event, writeGuard: { writable: () => false, remainingMs: () => 0 } })
    expect(outcome).toMatchObject({ acknowledgement: 'held', log: { reason: WRITE_ABORTED_REASON } })
    expect(wake.sleeps).toEqual([])
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
    const route = claudeWakeRoute({ platform: POSIX,
      sessionId: SESSION_ID, sourcePid: 12345, adapters: fake,
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
    const route = claudeWakeRoute({ platform: POSIX,
      sessionId: SESSION_ID, sourcePid: 12345, adapters: fake,
      env: { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/99999.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'token-b' },
    })
    await route.deliver(event() as never)
    expect(lines(fake.sent[0]!.line)).toEqual([{ type: 'user', message: { role: 'user', content: 'wake' } }])
  })
})
