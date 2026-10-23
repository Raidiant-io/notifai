import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
import { sanitizeSessionId,stateDir } from './config.js'
import { beginSessionIncarnation,lifecycleStamp,markSessionEnded,updateSessionState } from './hook-session-state.js'
import { olderHubWaits } from './hub-handover.js'
import { processStartTime } from './process-identity.js'
import { stageSessionMessages } from './session-inputs.js'

const CLAUDE = '11111111-2222-3333-4444-555555555555'
const CODEX = '22222222-3333-4444-5555-666666666666'
const HARNESS = { pid: process.pid, start: processStartTime(process.pid)! }

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
})
