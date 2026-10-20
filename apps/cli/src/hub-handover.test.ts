import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sanitizeSessionId, stateDir } from './config.js'
import { beginSessionIncarnation, lifecycleStamp, markSessionEnded, updateSessionState } from './hook-session-state.js'
import { handOverOlderHub, olderHubWaits, type ActiveRuntime } from './hub-handover.js'
import { processStartTime } from './process-identity.js'
import { stageSessionMessages } from './session-inputs.js'

const CLAUDE = '11111111-2222-3333-4444-555555555555'
const CODEX = '22222222-3333-4444-5555-666666666666'
const HARNESS = { pid: process.pid, start: processStartTime(process.pid)! }
const SELF: ActiveRuntime = { build: 'b'.repeat(64), version: '13.1.0-beta.5', digest: 'new-digest' }

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function env(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), 'handover-'))
  roots.push(root)
  return { ...process.env, HOME: root, XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config') }
}

function start(sessionId: string, environment: NodeJS.ProcessEnv): string {
  return beginSessionIncarnation(sessionId, environment, { stamp: lifecycleStamp(), harnessProcess: HARNESS, clearEarlierEnd: true }).incarnation
}

/** The status a 13.1.0-beta.3 hub answers: no `runtime_build`, no `handover`. */
function olderStatus(overrides: Record<string, unknown> = {}, sessions: Record<string, unknown>[] = [
  { session_id: CLAUDE, harness: 'claude-code', phase: 'attending', reason: '', generation: 3, activity: 'idle', child: true, watching: true, accepts_messages: true },
]): Record<string, unknown> {
  return { pid: 4242, version: '13.1.0-beta.3', build: 'old-digest', ipc_version: 1, started_at: new Date().toISOString(), transport: 'batch',
    requests: 10, last_exchange_at: null, children: sessions.length, credential: 'present', recent_crashes: 0, settlements: 0, sessions,
    pending_end_reports: 0, ...overrides }
}

describe('an earlier hub on another build', () => {
  const claim = (e: NodeJS.ProcessEnv, sessionId: string, holder: Record<string, unknown>): void => {
    const file = path.join(stateDir(e), 'sessions', `${sanitizeSessionId(sessionId)}.claim`)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ at: Date.now(), token: 't', ...holder })}\n`)
  }

  it('is replaced whatever its sessions wait for, because the next hub takes all of it over', () => {
    const e = env()
    const incarnation = start(CLAUDE, e)
    // A question waits, an answer owner runs, an end report is owed, a Note is staged, a session has ended.
    updateSessionState(CLAUDE, e, (state) => ({ ...state, pending: [{ question: 'Deploy?', summary: 'Deploy?', request_id: 'req_wait' } as never] }))
    stageSessionMessages(CLAUDE, e, { incarnation, generation: 3 }, [{ message_id: 'sm_wait', kind: 'note', body: 'Later',
      created_at: new Date().toISOString(), agent_acknowledgement_text_required: true }])
    // Its answer owner for an attended session: that session's child re-registers and the next hub runs it again.
    claim(e, CLAUDE, { pid: 4242, pending_question_ids: ['q'] })
    expect(olderHubWaits(e, olderStatus({ settlements: 1, pending_end_reports: 1 }))).toEqual([])
    markSessionEnded(CLAUDE, e, Date.now())
    expect(olderHubWaits(e, olderStatus())).toEqual([])
  })

  it('waits only for what the next hub could not take over from it', () => {
    const e = env()
    start(CLAUDE, e)
    claim(e, CLAUDE, { pid: 4242 })
    // An answer it is handing to its agent: stopping it now could repeat the answer.
    updateSessionState(CLAUDE, e, (state) => ({ ...state, accepted: { recorded_at: Date.now(), remaining: 1, answers: [] } }))
    expect(olderHubWaits(e, olderStatus())).toEqual(['answer-delivering'])
    updateSessionState(CLAUDE, e, ({ accepted: _accepted, ...state }) => state)
    // A wake it is writing into a session right now; once queued, it is the harness's.
    const wake = { incarnation: 'inc', token: 'tok', writer: { pid: 4242, start: 'x' } }
    updateSessionState(CLAUDE, e, (state) => ({ ...state, input_wake: { ...wake, queued: false } }))
    expect(olderHubWaits(e, olderStatus())).toEqual(['wake-writing'])
    updateSessionState(CLAUDE, e, (state) => ({ ...state, input_wake: { ...wake, queued: true } }))
    expect(olderHubWaits(e, olderStatus())).toEqual([])
    const attempt = { token: 'tok', ownerKey: 'k', incarnation: 'inc', generation: 3, namespace: 'n', inputIds: ['i'], text: 'w',
      writer: { pid: 4242, start: 'x' }, detached: false }
    updateSessionState(CLAUDE, e, (state) => ({ ...state, input_wake_attempts: [{ ...attempt, phase: 'sending' as const }] }))
    expect(olderHubWaits(e, olderStatus())).toEqual(['wake-writing'])
    updateSessionState(CLAUDE, e, (state) => ({ ...state, input_wake_attempts: [{ ...attempt, phase: 'accepted' as const }] }))
    expect(olderHubWaits(e, olderStatus())).toEqual([])
    // An answer owner for a session it does not attend: no file names that session.
    claim(e, 'unattended-session', { pid: 4242 })
    expect(olderHubWaits(e, olderStatus())).toEqual(['question-unattended'])
    // Another process's claims are not its own.
    claim(e, 'unattended-session', { pid: 4243 })
    expect(olderHubWaits(e, olderStatus())).toEqual([])
  })

  it('never waits for a conversation without a child: the next hub adopts it from its status, or leaves it lapsed', () => {
    const e = env()
    start(CODEX, e)
    const codex = (fields: Record<string, unknown>) => ({ session_id: CODEX, harness: 'codex', phase: 'attending', reason: '', generation: 1,
      activity: 'idle', child: true, watching: true, accepts_messages: true, ...fields })
    expect(olderHubWaits(e, olderStatus({}, [codex({})]))).toEqual([])
    // Stopped, or with its end undecided, and no rollout on record: nothing holds the handover back.
    expect(olderHubWaits(e, olderStatus({}, [codex({ phase: 'exited', reason: 'stopped', child: false })]))).toEqual([])
    expect(olderHubWaits(e, olderStatus({}, [codex({ phase: 'uncertain', reason: 'session-child-disconnected', child: false })]))).toEqual([])
  })

  it('waits when its status cannot show what it holds', () => {
    const e = env()
    expect(olderHubWaits(e, olderStatus({ settlements: undefined }))).toEqual(['hub-unverifiable'])
    expect(olderHubWaits(e, olderStatus({ sessions: 'x' }))).toEqual(['hub-unverifiable'])
    expect(olderHubWaits(e, olderStatus({ pid: undefined }))).toEqual(['hub-unverifiable'])
    start(CLAUDE, e)
    expect(olderHubWaits(e, olderStatus({ ipc_version: 0 }))).toEqual(['session-child-incompatible'])
  })

  it('sends stop only after two clear reads, then starts the active build\'s hub', async () => {
    const e = env()
    start(CLAUDE, e)
    const sent: Record<string, unknown>[] = []
    const reads: Record<string, unknown>[] = [olderStatus(), olderStatus()]
    let started = 0
    const request = async (_env: NodeJS.ProcessEnv, message: Record<string, unknown>) => {
      sent.push(message)
      return message['type'] === 'stop' ? { type: 'ack' } : { type: 'status', status: reads.shift() ?? olderStatus() }
    }
    const outcome = await handOverOlderHub(e, { self: SELF, request, sleep: async () => undefined, start: () => { started += 1 } })
    expect(outcome).toEqual({ outcome: 'handed-over', hub_version: '13.1.0-beta.3', successor: true })
    expect(sent.map((message) => message['type'])).toEqual(['status', 'status', 'stop'])
    expect(sent[2]).toEqual({ type: 'stop', reason: 'build-superseded' })
    expect(started).toBe(1)
  })

  it('never sends stop while either read shows work waiting', async () => {
    const e = env()
    start(CLAUDE, e)
    for (const reads of [[olderStatus({ ipc_version: 0 })], [olderStatus(), olderStatus({ ipc_version: 0 })]]) {
      const sent: string[] = []
      const request = async (_env: NodeJS.ProcessEnv, message: Record<string, unknown>) => {
        sent.push(String(message['type']))
        return message['type'] === 'stop' ? { type: 'ack' } : { type: 'status', status: reads.shift() }
      }
      const outcome = await handOverOlderHub(e, { self: SELF, request, sleep: async () => undefined, start: () => { throw new Error('no successor') } })
      expect(outcome).toEqual({ outcome: 'waiting', hub_version: '13.1.0-beta.3', waiting_for: ['session-child-incompatible'] })
      expect(sent).not.toContain('stop')
    }
  })

  it('leaves a hub that hands itself over seamlessly, or runs this build, alone', async () => {
    const e = env()
    for (const status of [olderStatus({ runtime_build: 'a'.repeat(64), seamless_handover: true, handover: null }), olderStatus({ version: SELF.version, build: SELF.digest })]) {
      const sent: string[] = []
      const request = async (_env: NodeJS.ProcessEnv, message: Record<string, unknown>) => {
        sent.push(String(message['type']))
        return { type: 'status', status }
      }
      const outcome = await handOverOlderHub(e, { self: SELF, request, sleep: async () => undefined })
      expect(['self-managed', 'current']).toContain(outcome.outcome)
      expect(sent).toEqual(['status'])
    }
    expect(await handOverOlderHub(e, { self: null })).toEqual({ outcome: 'not-active-build' })
  })

  it('replaces a hub that hands itself over only once nothing waits (13.1.0-beta.5) like any earlier hub', async () => {
    const e = env()
    start(CLAUDE, e)
    const status = olderStatus({ version: '13.1.0-beta.5', runtime_build: 'a'.repeat(64), handover: { active_build: SELF.build, waiting_for: ['question-waiting'] } })
    const sent: string[] = []
    const request = async (_env: NodeJS.ProcessEnv, message: Record<string, unknown>) => {
      sent.push(String(message['type']))
      return message['type'] === 'stop' ? { type: 'ack' } : { type: 'status', status }
    }
    const outcome = await handOverOlderHub(e, { self: SELF, request, sleep: async () => undefined, start: () => undefined })
    expect(outcome).toMatchObject({ outcome: 'handed-over', hub_version: '13.1.0-beta.5' })
    expect(sent).toEqual(['status', 'status', 'stop'])
  })
})
