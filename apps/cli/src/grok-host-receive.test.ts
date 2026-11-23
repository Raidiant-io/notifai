/**
 * A Grok host wake reaches a chat or thread, not a native session: Orca
 * follows a chat's `/clear` lineage to its new session, and a stale or
 * misrouted wake can land in another session. Whatever session runs
 * `notifai receive`, it hands in only its own input, and only under the Grok
 * process the route verified for that incarnation.
 */
import type { AttendanceMessage, ClaimDeliveryAttemptRequestT } from '@raidiant/notifai-protocol'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiClient } from './client.js'
import type { CommandDeps } from './commands-core.js'
import { receiveCommand } from './commands-receive.js'
import { beginSessionIncarnation, lifecycleStamp, updateSessionState } from './hook-session-state.js'
import { acquireClaimFile } from './hook-question-lock.js'
import { processStartTime } from './process-identity.js'
import { attendantClaimPath, writeAttendantStatus } from './session-attendant-state.js'
import { hasSessionInputs, stageSessionMessages } from './session-inputs.js'

const A = '01a208b4-64fe-7873-ac87-bc1da288261d'
const B = '01a208b5-9de6-7321-84de-82ae0f98a367'
const roots: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const note = (id: string): AttendanceMessage => ({ message_id: id, kind: 'note', body: `Read ${id}`, created_at: new Date().toISOString(), agent_acknowledgement_text_required: true })

/** A live process that is not an ancestor of this one. */
function stranger(): { pid: number; start: string } {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  children.push(child)
  return { pid: child.pid!, start: processStartTime(child.pid!)! }
}

/** The Grok process this test runs under, as the attendant records it. */
const ownGrok = (): { pid: number; start: string } => ({ pid: process.ppid, start: processStartTime(process.ppid)! })

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-grok-receive-'))
  roots.push(root)
  const env: NodeJS.ProcessEnv = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
  const sessions = new Map<string, { incarnation: string; lease: { incarnation: string; generation: number } }>()
  const open = (sessionId: string, owner: { pid: number; start: string } | null) => {
    // Grok records no harness process; its attendant records the route's Grok process.
    const incarnation = beginSessionIncarnation(sessionId, env, { stamp: lifecycleStamp(), restart: true })
    const lease = { incarnation: incarnation.incarnation, generation: 1 }
    acquireClaimFile(attendantClaimPath(sessionId, env), { incarnation: lease.incarnation }, Date.now())
    writeAttendantStatus(sessionId, env, { ...lease, phase: 'attending', activity: 'idle', reason: null, accepts_messages: true, updated_at: Date.now() })
    if (owner !== null) updateSessionState(sessionId, env, (state) => ({ ...state, grok_host_owner: { incarnation: incarnation.incarnation, ...owner, route: 'orca-chat' } }))
    sessions.set(sessionId, { incarnation: incarnation.incarnation, lease })
    return lease
  }
  const output: string[] = []
  const claims: string[] = []
  const client = {
    claimDeliveryAttempt: async (_session: string, body: ClaimDeliveryAttemptRequestT) => {
      const id = body.subject.type === 'session_message' ? body.subject.message_id : body.subject.request_id
      claims.push(id)
      return { attempt_id: `att_${id}`, claim_remaining_ms: 30_000 }
    },
    reportDeliveryAttempt: async (id: string, body: { outcome: string }) => ({ attempt_id: id, ...body, replayed: false }),
  } as unknown as ApiClient
  const deps: CommandDeps = {
    cwd: root, env,
    io: { out: (s) => { output.push(s) }, err: () => {}, confirm: async () => false, openUrl: () => {} },
    store: { load: () => ({ machineId: 'mac_test', secret: 'test-secret', baseUrl: 'https://test.notifai.invalid', machineName: 'test' }), save: () => {}, clear: () => {} } as unknown as CommandDeps['store'],
    clientFactory: () => client,
  }
  const receiveAs = async (sessionId: string): Promise<string> => {
    output.length = 0
    env['GROK_SESSION_ID'] = sessionId
    await receiveCommand(deps)
    return output.join('\n')
  }
  return { env, open, output, claims, receiveAs, sessions }
}

describe('notifai receive under a Grok host route', () => {
  it('hands each session only its own input, whichever session a wake reached', async () => {
    const h = setup()
    const a = h.open(A, ownGrok())
    const b = h.open(B, ownGrok())
    stageSessionMessages(A, h.env, a, [note('sm_for_a')])
    // A wake for A that lands in B (Orca following the chat to its post-/clear session).
    expect(await h.receiveAs(B)).toContain('No user input is pending')
    expect(h.claims).toEqual([])
    expect(hasSessionInputs(A, h.env, a)).toBe(true)
    // A's own session gets it once.
    expect(await h.receiveAs(A)).toContain('Read sm_for_a')
    expect(await h.receiveAs(A)).not.toContain('Read sm_for_a')
    expect(h.claims).toEqual(['sm_for_a'])
    expect(hasSessionInputs(B, h.env, b)).toBe(false)
  })

  it('refuses a caller outside the verified Grok process, a gone process and a replaced incarnation', async () => {
    const h = setup()
    // The same native id claimed from a process the route never verified (copied environment).
    const elsewhere = h.open(A, stranger())
    stageSessionMessages(A, h.env, elsewhere, [note('sm_guarded')])
    expect(await h.receiveAs(A)).toContain('could not be handed over yet')
    expect(h.claims).toEqual([])

    // The verified Grok process exited.
    const gone = spawn('true')
    await new Promise((resolve) => gone.once('exit', resolve))
    updateSessionState(A, h.env, (state) => ({ ...state, grok_host_owner: { ...state.grok_host_owner!, pid: gone.pid!, start: 'gone' } }))
    expect(await h.receiveAs(A)).toContain('could not be handed over yet')

    // A new incarnation (Grok restarted the session): the old route record no longer counts.
    const record = h.sessions.get(A)!
    updateSessionState(A, h.env, (state) => ({ ...state, grok_host_owner: { incarnation: record.incarnation, ...ownGrok(), route: 'orca-chat' } }))
    const next = h.open(A, null)
    stageSessionMessages(A, h.env, next, [note('sm_next')])
    expect(await h.receiveAs(A)).toContain('could not be handed over yet')
    expect(h.claims).toEqual([])
  })
})
