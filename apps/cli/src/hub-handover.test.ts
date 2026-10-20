import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
  it('may hand over only when its status and this machine show nothing waiting', () => {
    const e = env()
    const incarnation = start(CLAUDE, e)
    expect(olderHubWaits(e, olderStatus())).toEqual([])
    // A question waiter it runs, an end report it owes.
    expect(olderHubWaits(e, olderStatus({ settlements: 1 }))).toEqual(['question-waiting'])
    expect(olderHubWaits(e, olderStatus({ pending_end_reports: 1 }))).toEqual(['session-ending'])
    // A question recorded on this machine for a live session.
    updateSessionState(CLAUDE, e, (state) => ({ ...state, pending: [{ question: 'Deploy?', summary: 'Deploy?', request_id: 'req_wait' } as never] }))
    expect(olderHubWaits(e, olderStatus())).toEqual(['question-waiting'])
    updateSessionState(CLAUDE, e, (state) => ({ ...state, pending: [] }))
    // A Note staged for the lease it holds, not yet handed in.
    stageSessionMessages(CLAUDE, e, { incarnation, generation: 3 }, [{ message_id: 'sm_wait', kind: 'note', body: 'Later',
      created_at: new Date().toISOString(), agent_acknowledgement_text_required: true }])
    expect(olderHubWaits(e, olderStatus())).toEqual(['session-input-pending'])
  })

  it('waits for an end it may still be reporting, and for Codex conversations only it holds', () => {
    const e = env()
    start(CLAUDE, e)
    start(CODEX, e)
    const codex = (fields: Record<string, unknown>) => ({ session_id: CODEX, harness: 'codex', phase: 'attending', reason: '', generation: 1,
      activity: 'idle', child: true, watching: true, accepts_messages: true, ...fields })
    expect(olderHubWaits(e, olderStatus({}, [codex({})]))).toEqual([])
    expect(olderHubWaits(e, olderStatus({}, [codex({ phase: 'uncertain', reason: 'dormant-open', child: false })]))).toEqual(['session-dormant'])
    // A Codex child gone: the end may still be under classification.
    expect(olderHubWaits(e, olderStatus({}, [codex({ phase: 'uncertain', reason: 'session-child-disconnected', child: false })]))).toEqual(['session-dormant'])
    markSessionEnded(CLAUDE, e, Date.now())
    expect(olderHubWaits(e, olderStatus())).toEqual(['session-ending'])
  })

  it('waits when its status cannot show that nothing waits', () => {
    const e = env()
    expect(olderHubWaits(e, olderStatus({ settlements: undefined }))).toEqual(['hub-unverifiable'])
    expect(olderHubWaits(e, olderStatus({ sessions: 'x' }))).toEqual(['hub-unverifiable'])
    // A session with no local record of its start.
    expect(olderHubWaits(e, olderStatus())).toEqual(['hub-unverifiable'])
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
    for (const reads of [[olderStatus({ settlements: 1 })], [olderStatus(), olderStatus({ settlements: 1 })]]) {
      const sent: string[] = []
      const request = async (_env: NodeJS.ProcessEnv, message: Record<string, unknown>) => {
        sent.push(String(message['type']))
        return message['type'] === 'stop' ? { type: 'ack' } : { type: 'status', status: reads.shift() }
      }
      const outcome = await handOverOlderHub(e, { self: SELF, request, sleep: async () => undefined, start: () => { throw new Error('no successor') } })
      expect(outcome).toEqual({ outcome: 'waiting', hub_version: '13.1.0-beta.3', waiting_for: ['question-waiting'] })
      expect(sent).not.toContain('stop')
    }
  })

  it('leaves a hub that hands itself over, or runs this build, alone', async () => {
    const e = env()
    for (const status of [olderStatus({ runtime_build: 'a'.repeat(64), handover: null }), olderStatus({ version: SELF.version, build: SELF.digest })]) {
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
})
