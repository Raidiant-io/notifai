import { refreshCodexInputActivity } from './codex-input-lifecycle.js'
import { NativeQueueNotSent, type QueueControl } from './codex-queue-control.js'
import { readInputWakes } from './session-input-wakes.js'
import { stageSessionMessages, readSessionMessages, sessionInputRoute, sessionInputWake, observeSessionInputWake, drainSessionInputs, wakeSessionInputs, hasSessionInputs, wakeCodexSessionInputs, reconcileSessionInputWakes } from './session-inputs.js'
import { clearAcknowledgementObligation } from './hook-acknowledgements.js'
import { receiveSessionInputs, receiveCommand } from './commands-receive.js'
import { buildProgram } from './program.js'
import { writeProjectSession } from './hook-project-sessions.js'
import type { AcceptedAnswerDelivery } from './hook-types.js'
import type { AttendanceMessage, ClaimDeliveryAttemptRequestT } from '@raidiant/notifai-protocol'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiCallError, type ApiClient } from './client.js'
import type { CommandDeps } from './commands-core.js'
import { hookAdapterPath, installHookAdapter } from './hook-adapter.js'
import { hookRunCommand } from './commands-hook-run.js'
import { codexToolHookReady } from './codex-tool-messages.js'
import { buildHookConfig, codexHookIdentityHash, codexTrustKey, findInstallations } from './install-hooks.js'
import { acquireClaimFile } from './hook-question-lock.js'
import { beginSessionIncarnation, lifecycleStamp, markSessionEnded, readSessionIncarnation, readSessionState, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import { currentProcessIdentity } from './process-identity.js'
import { enableProject, projectBinding } from './project-enablement.js'
import { attendantClaimPath, attendantStatusPath, currentCodexTurn, recordTurnEnd, recordTurnStart, readTurnActivity, turnActivityPath, writeAttendantStatus } from './session-attendant-state.js'
import { acquireDeliveryLock, readDeliveryJournal } from './session-delivery.js'
import { handOffSessionMessages } from './session-message-handoff.js'
import { localIntegrationAssessment } from './integration-health.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const SESSION = '019ff69d-a07f-7161-ab6e-bd06b3b93c8e'
const note = (id: string): AttendanceMessage => ({ message_id: id, kind: 'note', body: `Read ${id}`, created_at: new Date().toISOString(), agent_acknowledgement_text_required: true })

function installTrustedHooks(env: NodeJS.ProcessEnv): void {
  const home = env['CODEX_HOME']!
  mkdirSync(home, { recursive: true })
  writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: buildHookConfig({ adapterPath: hookAdapterPath(env['HOME']), harness: 'codex' }) }))
  const installed = findInstallations(env).find((entry) => entry.harness === 'codex')!
  writeFileSync(path.join(home, 'config.toml'), installed.handlers
    .map((handler) => `[hooks.state.${JSON.stringify(codexTrustKey(installed, handler))}]\ntrusted_hash = "${codexHookIdentityHash(handler)}"\n`).join('\n'))
}

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-tool-notes-'))
  roots.push(root)
  const owner = currentProcessIdentity()!
  const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), CODEX_HOME: path.join(root, 'codex'), NOTIFAI_HOOK_SOURCE_PID: String(owner.pid) }
  installHookAdapter({ execPath: process.execPath, scriptPath: fileURLToPath(new URL('../dist/main.js', import.meta.url)) }, root)
  installTrustedHooks(env)
  enableProject(projectBinding(root, env, undefined))
  const incarnation = beginSessionIncarnation(SESSION, env, { stamp: lifecycleStamp(), harnessProcess: owner })
  const lease = { incarnation: incarnation.incarnation, generation: 1 }
  acquireClaimFile(attendantClaimPath(SESSION, env), { incarnation: lease.incarnation }, Date.now())
  writeAttendantStatus(SESSION, env, { ...lease, phase: 'attending', activity: 'working', reason: null, accepts_messages: true, updated_at: Date.now() })
  recordTurnStart(SESSION, env, incarnation.key, 'turn-1')
  const output: string[] = []
  const claims: string[] = []
  const reports: string[] = []
  const settled = new Set<string>()
  let duringClaim = (): void => {}
  const client = {
    claimDeliveryAttempt: async (_session: string, body: ClaimDeliveryAttemptRequestT) => {
      const id = body.subject.type === 'session_message' ? body.subject.message_id : body.subject.request_id
      if (settled.has(id)) throw new ApiCallError(409, 'claim_refused', 'settled', null, { reason: 'not_claimable' })
      claims.push(id)
      duringClaim()
      return { attempt_id: `att_${id}`, claim_remaining_ms: 30_000 }
    },
    reportDeliveryAttempt: async (id: string, body: { outcome: string }) => {
      reports.push(body.outcome)
      if (body.outcome !== 'released') settled.add(id.slice(4))
      return { attempt_id: id, ...body, replayed: false }
    },
  } as unknown as ApiClient
  const deps: CommandDeps = {
    cwd: root, env, hookAdapterHome: root,
    io: { out: (s) => { output.push(s) }, err: () => {}, confirm: async () => false, openUrl: () => {} },
    store: { load: () => ({ machineId: 'mac_test', secret: 'test-secret', baseUrl: 'https://test.notifai.invalid', machineName: 'test' }), save: () => {}, clear: () => {} } as unknown as CommandDeps['store'],
    clientFactory: () => client,
  }
  const sequencer = { sessionId: SESSION, env, client, writer: owner, monotonic: () => performance.now(), wall: Date.now, sleep: async () => {} }
  return {
    deps, output, claims, reports, lease, env, incarnation, sequencer,
    stage: (messages: AttendanceMessage[]) => stageSessionMessages(SESSION, env, lease, messages),
    hook: (turn = 'turn-1') => hookRunCommand(deps, 'post-tool-use', async () => JSON.stringify({ session_id: SESSION, cwd: root, hook_event_name: 'PostToolUse', turn_id: turn }), 'codex'),
    duringClaim: (fn: () => void) => { duringClaim = fn },
  }
}

describe('Codex tool-boundary Session Messages', () => {
  it('keeps a blocked Stop turn writable until actual native completion', async () => {
    const h = setup()
    const transcript = path.join(h.env.CODEX_HOME, 'sessions', 'owned.jsonl')
    mkdirSync(path.dirname(transcript), { recursive: true })
    writeFileSync(transcript, [
      { type: 'session_meta', payload: { id: SESSION, source: 'cli' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    await h.hook()
    await hookRunCommand(h.deps, 'attend', async () => JSON.stringify({
      session_id: SESSION, cwd: h.deps.cwd, hook_event_name: 'Stop',
      turn_id: 'turn-1', transcript_path: transcript, stop_hook_active: true,
    }), 'codex')
    expect(currentCodexTurn(SESSION, h.env, h.incarnation.key)).toBe('turn-1')
    h.stage([note('sm_after_stop')])
    await h.hook()
    expect(h.claims).toEqual(['sm_after_stop'])
    expect(h.output).toHaveLength(1)
    expect(h.output[0]).toContain('sm_after_stop')
  })

  it('rejects historical observation without root ownership or current-turn evidence', async () => {
    const h = setup()
    await h.hook()
    const proof = readSessionState(SESSION, h.env).codex_tool_hook!
    updateSessionState(SESSION, h.env, state => ({ ...state, codex_tool_hook: {
      incarnation: proof.incarnation, fingerprint: proof.fingerprint,
    } }))
    expect(codexToolHookReady(h.deps, SESSION)).toBe(false)
    await h.hook()
    expect(codexToolHookReady(h.deps, SESSION)).toBe(true)
    recordTurnStart(SESSION, h.env, h.incarnation.key, 'turn-2')
    expect(codexToolHookReady(h.deps, SESSION)).toBe(false)
    await h.hook('turn-2')
    expect(codexToolHookReady(h.deps, SESSION)).toBe(true)
  })

  it.each([
    ['post-tool-use', 'PostToolUse'],
    ['user-prompt-submit', 'UserPromptSubmit'],
    ['attend', 'UserPromptSubmit'],
    ['attend', 'Stop'],
    ['attend', 'Interrupt'],
    ['session-start', 'SessionStart'],
    ['session-end', 'SessionEnd'],
    ['stop', 'Stop'],
  ])('ignores child %s/%s callbacks carrying the parent session id', async (event, hookEvent) => {
    const h = setup()
    h.stage([note('sm_parent_only')])
    const before = readSessionState(SESSION, h.env)
    const beforeTurns = readFileSync(turnActivityPath(SESSION, h.env), 'utf8')
    h.deps.store.load = () => { throw new Error('child must not read parent credentials') }
    const exit = await hookRunCommand(h.deps, event!, async () => JSON.stringify({
      session_id: SESSION, cwd: h.deps.cwd, hook_event_name: hookEvent,
      turn_id: 'child-turn', agent_id: 'child-thread', agent_type: 'worker',
    }), 'codex')
    expect(exit).toBe(0)
    expect(h.claims).toEqual([])
    expect(h.output).toEqual([])
    expect(readSessionState(SESSION, h.env)).toEqual(before)
    expect(readSessionIncarnation(SESSION, h.env)).toEqual(h.incarnation)
    expect(sessionHasEnded(SESSION, h.env)).toBe(false)
    expect(readFileSync(turnActivityPath(SESSION, h.env), 'utf8')).toBe(beforeTurns)
    expect(currentCodexTurn(SESSION, h.env, h.incarnation.key)).toBe('turn-1')
    expect(codexToolHookReady(h.deps, SESSION)).toBe(false)
    recordTurnEnd(SESSION, h.env, 'turn-1')
    expect(readTurnActivity(SESSION, h.env, h.incarnation.key)).toBe('idle')
    expect(readSessionMessages(SESSION, h.env, h.lease)).toHaveLength(1)
  })

  it('keeps SubagentStart worker guidance without activating or consuming parent input', async () => {
    const h = setup()
    h.stage([note('sm_parent_only')])
    const before = readSessionState(SESSION, h.env)
    await hookRunCommand(h.deps, 'subagent-start', async () => JSON.stringify({
      session_id: SESSION, cwd: h.deps.cwd, hook_event_name: 'SubagentStart',
      turn_id: 'turn-1', agent_id: 'child-thread', agent_type: 'worker',
    }), 'codex')
    expect(h.claims).toEqual([])
    expect(h.output).toHaveLength(1)
    expect(h.output[0]).toContain('Notifai worker context')
    expect(h.output[0]).not.toContain('You own Notification Requests')
    expect(readSessionState(SESSION, h.env)).toEqual(before)
    expect(readSessionIncarnation(SESSION, h.env)).toEqual(h.incarnation)
    expect(currentCodexTurn(SESSION, h.env, h.incarnation.key)).toBe('turn-1')
    expect(readSessionMessages(SESSION, h.env, h.lease)).toHaveLength(1)
  })

  it.each([{ agent_id: 'child-thread' }, { agent_type: 'worker' }])(
    'fences partial child identity %j even when its turn id matches the parent', async (identity) => {
      const h = setup()
      h.stage([note('sm_parent_only')])
      await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({
        session_id: SESSION, cwd: h.deps.cwd, hook_event_name: 'PostToolUse', turn_id: 'turn-1', ...identity,
      }), 'codex')
      expect(h.claims).toEqual([])
      expect(h.output).toEqual([])
      expect(codexToolHookReady(h.deps, SESSION)).toBe(false)
      expect(readSessionMessages(SESSION, h.env, h.lease)).toHaveLength(1)
    },
  )

  it('executes the advertised wake command and drains only the exact harness session', async () => {
    const h = setup()
    h.env['CODEX_THREAD_ID'] = SESSION
    h.stage([note('sm_current')])
    stageSessionMessages('another-session', h.env, h.lease, [note('sm_other')])
    const command = sessionInputWake().match(/`notifai ([^`]+)`/)?.[1]
    expect(command).toBeDefined()
    let exitCode: number | undefined
    const program = buildProgram(h.deps, { exit: (code) => { exitCode = code } })
    await program.parseAsync(['node', 'notifai', ...command!.split(' ')])
    expect(exitCode).toBe(0)
    expect(h.claims).toEqual(['sm_current'])
    expect(h.output.join('\n')).toContain('Read sm_current')
    expect(h.output.join('\n')).not.toContain('sm_other')
    expect(readSessionMessages('another-session', h.env, h.lease)).toHaveLength(1)
  })

  it('presents a bounded prefix when claims are slow and leaves later notes in order', async () => {
    const h = setup()
    let clock = 0
    h.stage([note('sm_first'), note('sm_second')])
    h.duringClaim(() => { clock += 800 })
    const input = { sequencer: { ...h.sequencer, monotonic: () => clock }, lease: h.lease,
      mayWrite: () => true, write: (text: string) => h.output.push(text) }
    await drainSessionInputs(input)
    expect(h.claims).toEqual(['sm_first'])
    expect(h.output[0]).not.toContain('sm_second')
    await drainSessionInputs(input)
    expect(h.claims).toEqual(['sm_first', 'sm_second'])
    expect(h.output[1]).toContain('sm_second')
  })


  it('drains more than twenty mixed inputs in order and never wakes for acknowledgement debt', async () => {
    const h = setup()
    const reply = { reply_id: 'rpl_many', seq: 1, delivery_id: 'del_many', device_id: 'dev_test', device_name: 'Test',
      text: 'Continue', answers: [{ question_id: 'q_many', choice_ids: [], text: 'Continue' }],
      source: null, created_at: new Date().toISOString() }
    updateSessionState(SESSION, h.env, state => ({ ...state,
      waiting_answers: [{ pending: { question: 'Continue?', question_id: 'q_many', request_id: 'req_many', collapse_key: 'many', device_ids: ['dev_test'] },
        reply, replies: [reply], agent_acknowledgement_required: true, delivery_claim: true }],
      acknowledgement_due: [{ request_id: 'req_many', recorded_at: Date.now(), text_required: true }],
    }))
    const ids = Array.from({ length: 24 }, (_, i) => 'sm_batch_' + i)
    h.stage(ids.map(note))
    await h.hook()
    expect(h.claims).toEqual(['req_many', ...ids.slice(0, 19)])
    expect(hasSessionInputs(SESSION, h.env, h.lease)).toBe(true)
    recordTurnEnd(SESSION, h.env, 'turn-1')
    // Remaining suffix remains eligible at completion, then the wake's prompt
    // boundary consumes it through the same delivery sequencer.
    await hookRunCommand(h.deps, 'user-prompt-submit', async () => JSON.stringify({
      session_id: SESSION, cwd: h.deps.cwd, hook_event_name: 'UserPromptSubmit', turn_id: 'wake',
    }), 'codex')
    expect(h.claims).toEqual(['req_many', ...ids])
    expect(h.output).toHaveLength(2)
    expect(hasSessionInputs(SESSION, h.env, h.lease)).toBe(false)
    expect(readSessionState(SESSION, h.env).acknowledgement_due).toHaveLength(1)
    expect(readSessionState(SESSION, h.env).message_acknowledgement_due).toHaveLength(24)
    await h.hook('wake')
    expect(h.output).toHaveLength(2)
  })

  it('reports queued input instead of an empty inbox when an earlier answer blocks a claim', async () => {
    const h = setup()
    h.env['CODEX_THREAD_ID'] = SESSION
    h.stage([note('sm_blocked')])
    h.duringClaim(() => { throw new ApiCallError(409, 'claim_refused', 'Earlier answer pending', null, { reason: 'awaiting_earlier_answer' }) })
    expect(await receiveCommand(h.deps)).toBe(0)
    expect(h.output.join('\n')).toContain('User input is pending')
    expect(h.output.join('\n')).not.toContain('No user input')
    expect(readSessionMessages(SESSION, h.env, h.lease)).toHaveLength(1)
    h.duringClaim(() => {})
    await receiveCommand(h.deps)
    expect(h.output.join('\n')).toContain('Read sm_blocked')
    await receiveCommand(h.deps)
    expect(h.output.at(-1)).toContain('No user input is pending')
  })

  it('retries a failed wake without losing input and coalesces the successful wake', async () => {
    const h = setup()
    h.stage([note('sm_waiting')])
    await expect(wakeSessionInputs(SESSION, h.env, async () => { throw new Error('queue unavailable') })).rejects.toThrow('queue unavailable')
    expect(readSessionState(SESSION, h.env).input_wake).toBeUndefined()
    let wakes = 0
    const send = async () => { wakes += 1; return true }
    await wakeSessionInputs(SESSION, h.env, send)
    await wakeSessionInputs(SESSION, h.env, send)
    expect(wakes).toBe(1)
    expect(readSessionMessages(SESSION, h.env, h.lease)).toHaveLength(1)
  })

  it('refuses a receive command without exact identity before loading credentials', async () => {
    const h = setup()
    delete h.env['CODEX_THREAD_ID']
    h.deps.store.load = () => { throw new Error('must not load credentials') }
    expect(await receiveCommand(h.deps)).not.toBe(0)
    expect(h.output).toEqual([])
  })

  it('does not let a matching worktree pointer consume another agent session input', async () => {
    const h = setup()
    delete h.env['CODEX_THREAD_ID']
    writeProjectSession(h.deps.cwd, h.env, SESSION, Date.now(), 'codex')
    h.stage([note('sm_private')])
    h.deps.store.load = () => { throw new Error('must not load credentials') }
    expect(await receiveCommand(h.deps)).not.toBe(0)
    expect(readSessionMessages(SESSION, h.env, h.lease)).toHaveLength(1)
    expect(h.output).toEqual([])
  })

  it.each([false, true])('reconciles an unfenced answer without an attendant lease (acknowledged=%s)', async (acknowledged) => {
    const h = setup()
    const reply = { reply_id: 'rpl_old', seq: 1, delivery_id: 'del_old', device_id: 'dev_old', device_name: 'Test',
      text: 'Original answer', answers: [], source: null, created_at: new Date().toISOString() }
    updateSessionState(SESSION, h.env, (state) => ({ ...state,
      waiting_answers: [{ pending: { question: 'Proceed?', request_id: 'req_old', collapse_key: 'old', device_ids: ['dev_old'] }, reply, replies: [reply], agent_acknowledgement_required: true }],
      acknowledgement_due: [{ request_id: 'req_old', recorded_at: Date.now(), text_required: true }],
    }))
    h.sequencer.client.agentAcknowledgement = async () => ({ request_id: 'req_old',
      agent_acknowledgement: acknowledged ? { text: 'Already applied', created_at: new Date().toISOString() } : null,
    })
    await drainSessionInputs({ sequencer: h.sequencer, lease: null, mayWrite: () => true, write: (text) => h.output.push(text) })
    await drainSessionInputs({ sequencer: h.sequencer, lease: null, mayWrite: () => true, write: (text) => h.output.push(text) })
    expect(h.output).toHaveLength(acknowledged ? 0 : 1)
    expect(h.claims).toEqual([])
    expect(readSessionState(SESSION, h.env).waiting_answers ?? []).toEqual([])
  })


  it.each(['live', 'missing', 'dead', 'superseded', 'producer'] as const)('delegates answer wakes only to its live resident: %s', async (mode) => {
    const h = setup()
    if (mode === 'missing') rmSync(attendantClaimPath(SESSION, h.env))
    if (mode === 'dead') {
      const file = attendantClaimPath(SESSION, h.env)
      const claim = JSON.parse(readFileSync(file, 'utf8'))
      writeFileSync(file, JSON.stringify({ ...claim, pid: 2_147_483_647 }))
    }
    if (mode === 'superseded') {
      const file = attendantStatusPath(SESSION, h.env)
      const status = JSON.parse(readFileSync(file, 'utf8'))
      writeFileSync(file, JSON.stringify({ ...status, incarnation: 'previous-incarnation' }))
    }
    const reply = { reply_id: 'rpl_wait', seq: 1, delivery_id: 'del_wait', device_id: 'dev_test', device_name: 'Test',
      text: 'Continue', answers: [{ question_id: 'q_wait', choice_ids: [], text: 'Continue' }],
      source: null, created_at: new Date().toISOString() }
    const accepted: AcceptedAnswerDelivery = { recorded_at: Date.now(), remaining: 0, answers: [{
      pending: { question: 'Continue?', question_id: 'q_wait', request_id: 'req_wait', collapse_key: 'wait', device_ids: ['dev_test'] },
      reply, replies: [reply], agent_acknowledgement_required: true, delivery_claim: true,
    }] }
    updateSessionState(SESSION, h.env, state => ({ ...state, accepted,
      acknowledgement_due: [{ request_id: 'req_wait', recorded_at: accepted.recorded_at, text_required: true }] }))
    const queued: string[] = []
    const route = sessionInputRoute(SESSION, h.env, { kind: 'session-queue', deliver: async event => {
      expect(event.commitDelivery()).toBe(true)
      queued.push(event.context)
      return { acknowledgement: 'delivered' }
    } }, undefined, mode === 'producer' ? 'producer' : 'attendant')
    await route.defer!(accepted)
    expect(queued).toEqual(mode === 'live' ? [] : [sessionInputWake()])
    expect(readSessionState(SESSION, h.env).waiting_answers).toHaveLength(1)
    expect(h.claims).toEqual([])
  })

  it.each(['session-queue', 'inbox-socket'] as const)('drains notes and answers together; an old %s wake cannot repeat an acknowledged answer', async (kind) => {
    const h = setup()
    const reply = { reply_id: 'rpl_answer', seq: 1, delivery_id: 'del_answer', device_id: 'dev_answer', device_name: 'Test',
      text: 'I already sent you a chat message', answers: [{ question_id: 'q_answer', choice_ids: [], text: 'I already sent you a chat message' }],
      source: null, created_at: new Date().toISOString() }
    const accepted: AcceptedAnswerDelivery = { recorded_at: Date.now(), remaining: 0, answers: [{
      pending: { question: 'Has the setup finished?', summary: 'Has the setup finished?', question_id: 'q_answer', request_id: 'req_answer', collapse_key: 'answer', device_ids: ['dev_answer'] },
      reply, replies: [reply], agent_acknowledgement_required: true, delivery_claim: true,
    }] }
    updateSessionState(SESSION, h.env, (state) => ({ ...state, accepted,
      acknowledgement_due: [{ request_id: 'req_answer', recorded_at: accepted.recorded_at, text_required: true }] }))
    const queued: string[] = []
    const route = sessionInputRoute(SESSION, h.env, { kind, deliver: async (event) => {
      expect(event.commitDelivery()).toBe(true)
      queued.push(event.context)
      return { acknowledgement: 'delivered' }
    } })
    await route.defer!(accepted)
    await route.defer!(accepted)
    expect(queued).toEqual([sessionInputWake()])
    expect(queued[0]).not.toContain(reply.text)
    expect(readSessionState(SESSION, h.env).accepted).toBeUndefined()
    expect(h.claims).toEqual([])
    h.stage([note('sm_first'), note('sm_second')])
    await Promise.all([h.hook(), h.hook()])
    expect(h.output).toHaveLength(1)
    expect(h.output[0]).toContain(reply.text)
    expect(h.output[0]).toContain('sm_first')
    expect(h.output[0]).toContain('sm_second')
    expect(h.claims).toEqual(['req_answer', 'sm_first', 'sm_second'])
    for (const id of h.claims) clearAcknowledgementObligation(SESSION, h.env, id)
    observeSessionInputWake(SESSION, h.env, queued[0])
    await receiveSessionInputs(h.deps, SESSION, (text) => h.output.push(text))
    await h.hook()
    expect(h.output).toHaveLength(1)
    expect(readSessionState(SESSION, h.env).waiting_answers ?? []).toEqual([])
  })

  it('requires live observation plus trusted tool and prompt hooks before holding busy Notes', async () => {
    const h = setup()
    const codexHome = path.join(h.deps.cwd, 'codex')
    h.deps.env['CODEX_HOME'] = codexHome
    expect(codexToolHookReady(h.deps, SESSION)).toBe(false)
    await h.hook()
    expect(codexToolHookReady(h.deps, SESSION)).toBe(true)
    const installed = findInstallations(h.env).find((entry) => entry.harness === 'codex')!
    const handler = installed.handlers.find((entry) => entry.event === 'PostToolUse')!
    const key = codexTrustKey(installed, handler)
    const trust = `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "${codexHookIdentityHash(handler)}"\n`
    // Trusting only the tool handler cannot prove the turn markers run.
    writeFileSync(path.join(codexHome, 'config.toml'), trust)
    expect(codexToolHookReady(h.deps, SESSION)).toBe(false)
    installTrustedHooks(h.env)
    expect(codexToolHookReady(h.deps, SESSION)).toBe(true)
    writeFileSync(path.join(codexHome, 'config.toml'), `${trust}enabled = false\n`)
    expect(codexToolHookReady(h.deps, SESSION)).toBe(false)
    rmSync(path.join(codexHome, 'hooks.json'))
    expect(codexToolHookReady(h.deps, SESSION)).toBe(false)
  })

  it('delivers ordered Notes inside the active turn, once each, with acknowledgement debt', async () => {
    const h = setup()
    h.stage([note('sm_first'), note('sm_second')])
    await h.hook()
    expect(h.output).toHaveLength(1)
    expect(JSON.parse(h.output[0]!)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: expect.stringContaining('sm_first') } })
    expect(h.output[0]).toContain('sm_second')
    await h.hook()
    await h.hook()
    expect(h.output).toHaveLength(1)
    expect(h.claims).toEqual(['sm_first', 'sm_second'])
    expect(h.reports).toEqual(['handed_off', 'handed_off'])
    expect(readSessionState(SESSION, h.env).message_acknowledgement_due).toEqual([
      { message_id: 'sm_first', text_required: true, recorded_at: expect.any(Number) },
      { message_id: 'sm_second', text_required: true, recorded_at: expect.any(Number) },
    ])
  })

  it('observes an automatic continuation at its first tool boundary without a prompt', async () => {
    const h = setup()
    await h.hook()
    recordTurnEnd(SESSION, h.env, 'turn-1')
    h.stage([note('sm_goal')])
    await h.hook('goal-turn-2')
    expect(h.output).toHaveLength(1)
    expect(h.output[0]).toContain('sm_goal')
    expect(readTurnActivity(SESSION, h.env, h.incarnation.key)).toBe('working')
    // Neither an old callback nor a delayed Stop can reopen/end the wrong turn.
    h.stage([note('sm_next')])
    await h.hook('turn-1')
    recordTurnEnd(SESSION, h.env, 'turn-1')
    expect(h.output).toHaveLength(1)
    await h.hook('goal-turn-2')
    expect(h.output[1]).toContain('sm_next')
  })

  it('observes a new tool turn before the previous asynchronous Stop arrives', async () => {
    const h = setup()
    h.stage([note('sm_continuation')])
    await h.hook('goal-turn-2')
    recordTurnEnd(SESSION, h.env, 'turn-1')
    expect(h.output[0]).toContain('sm_continuation')
    expect(readTurnActivity(SESSION, h.env, h.incarnation.key)).toBe('working')
    recordTurnEnd(SESSION, h.env, 'goal-turn-2')
    h.stage([note('sm_interrupted')])
    await h.hook('goal-turn-2')
    expect(h.output).toHaveLength(1)
    expect(readTurnActivity(SESSION, h.env, h.incarnation.key)).toBe('idle')
  })

  it('does no authenticated work when no message is staged', async () => {
    const h = setup()
    expect(localIntegrationAssessment(h.deps, 'codex').faults).toEqual([])
    h.deps.store.load = () => { throw new Error('must not read credentials') }
    await h.hook()
    expect(h.claims).toEqual([])
    expect(h.output).toEqual([])
  })

  it('reports unresolved native approval once without authenticated work or a staged message', async () => {
    const h = setup()
    h.deps.store.load = () => { throw new Error('must not read credentials') }
    writeFileSync(path.join(h.env.CODEX_HOME, 'config.toml'), '')
    await h.hook()
    await h.hook()
    expect(h.claims).toEqual([])
    expect(h.output).toHaveLength(1)
    expect(JSON.parse(h.output[0]!)).toMatchObject({ hookSpecificOutput: {
      hookEventName: 'PostToolUse', additionalContext: expect.stringContaining('native-approval-pending'),
    } })
  })

  it('rejects stale turns, foreign owners, generations, and ended sessions', async () => {
    const h = setup()
    h.stage([note('sm_stale')])
    recordTurnEnd(SESSION, h.env, 'old-turn')
    await h.hook('old-turn')
    h.deps.env['NOTIFAI_HOOK_SOURCE_PID'] = '1'
    await h.hook()
    h.deps.env['NOTIFAI_HOOK_SOURCE_PID'] = String(process.pid)
    expect(readSessionMessages(SESSION, h.env, { ...h.lease, generation: 2 })).toEqual([])
    markSessionEnded(SESSION, h.env, Date.now())
    await h.hook()
    expect(h.claims).toEqual([])
    expect(h.output).toEqual([])
  })

  it('releases a claim if an interruption occurs during the network claim', async () => {
    const h = setup()
    h.stage([note('sm_interrupt')])
    h.duringClaim(() => recordTurnEnd(SESSION, h.env, 'turn-1'))
    await h.hook()
    expect(h.output).toEqual([])
    expect(h.reports).toEqual(['released'])
    expect(readSessionState(SESSION, h.env).message_acknowledgement_due ?? []).toEqual([])
  })

  it('skips a busy delivery lock promptly without claiming or writing', async () => {
    const h = setup()
    h.stage([note('sm_busy')])
    const lock = await acquireDeliveryLock(h.sequencer, 0)
    try { await h.hook() } finally { lock?.release() }
    expect(h.claims).toEqual([])
    expect(h.output).toEqual([])
    await h.hook()
    expect(h.output).toHaveLength(1)
  })

  it('never replays an ambiguous stdout write through a later hook or queue writer', async () => {
    const h = setup()
    const message = note('sm_failed')
    h.stage([message])
    h.deps.io.out = () => { throw new Error('broken pipe') }
    await h.hook()
    await h.hook()
    let queued = false
    await handOffSessionMessages([message], { mayWrite: () => true, generation: () => 1, incarnation: () => h.lease.incarnation }, {
      sequencer: h.sequencer,
      write: async () => { queued = true; return { status: 'written', route: 'session-queue' } },
    })
    expect(queued).toBe(false)
    expect(h.claims).toEqual(['sm_failed'])
    expect(h.reports).toEqual(['unconfirmed'])
    expect(readDeliveryJournal(SESSION, h.env)[0]?.stage).toBe('failed')
  })
})


function ownedWakeHarness() {
  const h = setup()
  const transcript = path.join(h.env.CODEX_HOME, 'sessions', 'owned-wake.jsonl')
  mkdirSync(path.dirname(transcript), { recursive: true })
  const lifecycle = (ended: boolean) => {
    writeFileSync(transcript, [
      { type: 'session_meta', payload: { id: SESSION, source: 'cli' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      ...(ended ? [{ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }] : []),
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    updateSessionState(SESSION, h.env, state => ({ ...state,
      codex_native_turn: { key: h.incarnation.key, turn_id: 'turn-1', transcript_path: transcript, observed_at: Date.now() } }))
  }
  lifecycle(true)
  const queue = new Map<string, { token: string; text: string }>()
  let adds = 0
  const control: QueueControl = { namespace: h.env.CODEX_HOME, threadId: SESSION,
    add: async (token, text) => { const id = 'owned-' + ++adds; queue.set(id, { token, text }); return id },
    find: async (token, text) => {
      const match = [...queue].find(([, v]) => v.token === token && v.text === text)
      return match === undefined ? 'absent' : { id: match[0] }
    },
    remove: async id => queue.delete(id), close: () => {},
  }
  const schedule = (backend: QueueControl | null = control, options: { mayWrite?: () => boolean; mayWake?: () => boolean } = {}) => wakeCodexSessionInputs({ sessionId: SESSION, env: h.env,
    lease: h.lease, mayWrite: options.mayWrite ?? (() => true), mayWake: options.mayWake ?? (() => true), connect: async () => backend })
  return { ...h, control, queue, transcript, lifecycle, schedule, adds: () => adds,
    wakes: () => readInputWakes({ sessionId: SESSION, env: h.env }) }
}

it('wires exact wake ownership through actual foreground drain bookkeeping', async () => {
  const h = ownedWakeHarness(); h.stage([note('sm_owned')])
  expect(await h.schedule()).toBe(true)
  const wake = h.wakes()[0]!
  expect(h.adds()).toBe(1)
  expect(wake.text).not.toContain('Read sm_owned')
  const delivered = await drainSessionInputs({ sequencer: h.sequencer, lease: h.lease, mayWrite: () => true,
    write: text => h.output.push(text) })
  expect(delivered).toBe(true)
  expect(h.output).toHaveLength(1)
  expect(h.claims).toEqual(['sm_owned'])
  expect(h.wakes()[0]?.detached).toBe(true)
  h.queue.set('unrelated', { token: 'human', text: 'human prompt' })
  await reconcileSessionInputWakes(SESSION, h.env, async () => h.control)
  expect(h.wakes()[0]?.phase).toBe('cancelled')
  expect([...h.queue.keys()]).toEqual(['unrelated'])
  expect(await h.schedule()).toBe(true)
  expect(h.adds()).toBe(1)
})

it('native working evidence overrides stale outside permission and blocks queueing', async () => {
  const h = ownedWakeHarness(); h.stage([note('sm_busy')]); h.lifecycle(false)
  expect(await h.schedule()).toBe(true)
  expect(h.adds()).toBe(0)
})

it('falls back only before owned native admission and does not replay uncertain writes', async () => {
  const h = ownedWakeHarness(); h.stage([note('sm_fallback')])
  expect(await h.schedule(null)).toBe(false)
  expect(await h.schedule({ ...h.control, add: async () => { throw new Error('uncertain receipt') } })).toBe(true)
  expect(h.wakes()[0]?.phase).toBe('unknown')
  expect(await h.schedule(null)).toBe(true)
  expect(h.adds()).toBe(0)
})

it('unknown pending cache cannot detach or replace an existing wake', async () => {
  const h = ownedWakeHarness(); h.stage([note('sm_cache')]); await h.schedule()
  // Use the canonical state root located by the existing path helper.
  const file = path.join(path.dirname(attendantStatusPath(SESSION, h.env)), SESSION + '.inputs.json')
  writeFileSync(file, '{broken')
  expect(await h.schedule()).toBe(true)
  await reconcileSessionInputWakes(SESSION, h.env, async () => h.control)
  expect(h.wakes()[0]?.detached).toBe(false)
  expect(h.adds()).toBe(1)
})

it('observes only the exact owned token and preserves a later wake', async () => {
  const h = ownedWakeHarness(); h.stage([note('sm_a')]); await h.schedule()
  const a = h.wakes()[0]!
  observeSessionInputWake(SESSION, h.env, a.text)
  h.stage([note('sm_a'), note('sm_b')]); await h.schedule()
  const b = h.wakes().find(v => v.token !== a.token)!
  observeSessionInputWake(SESSION, h.env, a.text)
  expect(h.wakes().find(v => v.token === b.token)?.phase).toBe('accepted')
})


it('does not bypass detached uncertainty through the generic fallback', async () => {
  const h = ownedWakeHarness(); h.stage([note('sm_a')])
  await h.schedule({ ...h.control, add: async () => { throw new Error('uncertain') } })
  h.stage([note('sm_a'), note('sm_b')])
  await h.schedule({ ...h.control, add: async () => { throw new NativeQueueNotSent('not sent') } })
  expect(h.wakes().some(a => a.phase === 'unknown' && a.detached)).toBe(true)
  expect(await h.schedule(null)).toBe(true)
})

it('coalesces behind the existing generic wake when optional control becomes available', async () => {
  const h = ownedWakeHarness(); h.stage([note('sm_transition')])
  expect(await h.schedule(null)).toBe(false)
  let genericAdds = 0
  await wakeSessionInputs(SESSION, h.env, async () => { genericAdds++; return true })
  expect(await h.schedule()).toBe(true)
  expect(genericAdds + h.adds()).toBe(1)
})

it.each(['replacement', 'regression'] as const)('rejects transcript %s after the outside observer allowed admission', async change => {
  const h = ownedWakeHarness(); h.stage([note('sm_continuity')])
  expect(refreshCodexInputActivity(SESSION, h.env, h.incarnation.key, h.transcript)).toBe('idle')
  await h.schedule(h.control, { mayWake: () => {
    if (change === 'replacement') {
      writeFileSync(h.transcript + '.next', readFileSync(h.transcript))
      renameSync(h.transcript + '.next', h.transcript)
    } else {
      const file = turnActivityPath(SESSION, h.env)
      const record = JSON.parse(readFileSync(file, 'utf8'))
      writeFileSync(file, JSON.stringify({ ...record, native: { ...record.native, offset: record.native.offset + 1000 } }))
    }
    return true
  } })
  expect(h.adds()).toBe(0)
})

it('rechecks in-process authorization after an awaited recovery lookup', async () => {
  const h = ownedWakeHarness(); h.stage([note('sm_lease')])
  await h.schedule({ ...h.control, add: async () => { throw new Error('uncertain') } })
  await h.schedule() // establish the native uncertainty baseline
  appendFileSync(h.transcript, [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  let authorized = true
  await h.schedule({ ...h.control, find: async () => { authorized = false; return 'absent' } }, { mayWrite: () => authorized })
  expect(h.adds()).toBe(0)
  expect(h.wakes().some(a => a.phase === 'cancelled')).toBe(true)
})
