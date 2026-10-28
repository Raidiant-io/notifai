import type { AttendanceMessage,ClaimDeliveryAttemptRequestT,QuestionT,ReplyAnswerT } from '@raidiant/notifai-protocol'
import { execFileSync,spawn } from 'node:child_process'
import { appendFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { ApiCallError,createClient,type ApiClient } from './client.js'
import { codexAnswerPresentation } from './codex-answer-presentation.js'
import { readNativeQuestionSnapshot } from './codex-native-turn.js'
import { nativeQuestionTitle,observeCodexQuestions } from './codex-question-bindings.js'
import { type QueueControl } from './codex-queue-control.js'
import { codexToolHookReady } from './codex-tool-messages.js'
import type { CommandDeps } from './commands-core.js'
import { hookRunCommand } from './commands-hook-run.js'
import { receiveCommand } from './commands-receive.js'
import { recordGuidanceGiven } from './guidance-currency.js'
import { hookAdapterPath,installHookAdapter } from './hook-adapter.js'
import { writeProjectSession } from './hook-project-sessions.js'
import { acquireClaimFile } from './hook-question-lock.js'
import { beginSessionIncarnation,lifecycleStamp,markSessionEnded,readSessionIncarnation,readSessionState,sessionHasEnded,updateSessionState } from './hook-session-state.js'
import { buildHookConfig,codexHookIdentityHash,codexTrustKey,findInstallations } from './install-hooks.js'
import { currentProcessIdentity } from './process-identity.js'
import { buildProgram } from './program.js'
import { enableProject,projectBinding } from './project-enablement.js'
import { rootGuidanceDigest } from './session-activation.js'
import { attendantClaimPath,currentCodexTurn,readTurnActivity,recordTurnEnd,recordTurnStart,turnActivityPath,writeAttendantStatus } from './session-attendant-state.js'
import { readDeliveryJournal } from './session-delivery.js'
import { readInputWakes } from './session-input-wakes.js'
import { drainSessionInputs,hasSessionInputs,inputWakeBackoffMs,readSessionMessages,sessionInputWake,stageSessionMessages,wakeCodexSessionInputs,wakeSessionInputs } from './session-inputs.js'
import { handOffSessionMessages } from './session-message-handoff.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const SESSION = '019ff69d-a07f-7161-ab6e-bd06b3b93c8e'
const note = (id: string): AttendanceMessage => ({ message_id: id, kind: 'note', body: `Read ${id}`, created_at: new Date().toISOString(), agent_acknowledgement_text_required: true })

it('delivers queued input and its durable wake fault on the next tool callback after a restart', async () => {
  const h = setup()
  h.stage([note('sm_recovery')])
  await wakeSessionInputs(SESSION, h.env, async () => { throw new Error('ENOSPC') })
  // Invoke the real hook from disk-backed state, with no wake or closure state.
  await h.hook()
  expect(h.output).toHaveLength(1)
  expect(h.output[0]).toContain('Read sm_recovery')
  expect(h.output[0]).toContain('could not wake this Agent Session')
  expect(h.output[0]).toContain('notifai doctor')
  expect(readSessionState(SESSION, h.env).input_wake_fault?.recovered_at).toBeTypeOf('number')
  await h.hook()
  expect(h.output).toHaveLength(1)
})

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
  execFileSync('git', ['init', '--quiet', root])
  const owner = currentProcessIdentity()!
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), CODEX_HOME: path.join(root, 'codex'), NOTIFAI_HOOK_SOURCE_PID: String(owner.pid) }
  installHookAdapter({ execPath: process.execPath, scriptPath: fileURLToPath(new URL('../dist/main.js', import.meta.url)) }, env.HOME)
  installTrustedHooks(env)
  enableProject(projectBinding(root, env, undefined))
  const incarnation = beginSessionIncarnation(SESSION, env, { stamp: lifecycleStamp(), harnessProcess: owner })
  recordGuidanceGiven(SESSION, env, rootGuidanceDigest(root, env))
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
    cwd: root, env, hookAdapterHome: env.HOME,
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

/** Exercise the HTTP client's real abort budget instead of bypassing it. */
function delayedInputClient(h: ReturnType<typeof setup>, claimDelayMs: number, reportDelayMs = 0) {
  h.deps.clientFactory = createClient
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body))
    const claim = String(url).endsWith('/delivery-attempts')
    const delay = claim ? claimDelayMs : reportDelayMs
    if (delay > 0) await new Promise<void>((resolve, reject) => {
      const signal = init!.signal!
      const abort = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delay)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    if (claim) return Response.json(await h.sequencer.client.claimDeliveryAttempt(SESSION, body))
    expect(String(url)).toMatch(/\/delivery-attempts\/att_[^/]+\/report$/)
    return Response.json(await h.sequencer.client.reportDeliveryAttempt(String(url).split('/').at(-2)!, body))
  })
}

function reserveBinding(h: ReturnType<typeof setup>, questions: QuestionT[] = [{ id: 'q1', text: 'Continue?' }]) {
  const file = path.join(h.env.CODEX_HOME, 'sessions', 'binding.jsonl')
  mkdirSync(path.dirname(file), { recursive: true })
  const append = (type: string, payload: unknown) => appendFileSync(file, `${JSON.stringify({ type, payload })}\n`)
  append('session_meta', { id: SESSION, source: 'cli' })
  append('event_msg', { type: 'task_started', turn_id: 'turn-1' })
  const pending = { question_id: 'q_bound', question: 'Continue?', summary: 'Continue?', request_id: 'req_bound', collapse_key: 'bound', device_ids: ['dev_test'],
    service_identity: { base_url: 'https://test.notifai.invalid', machine_id: 'mac_test' }, questions }
  updateSessionState(SESSION, h.env, state => ({ ...state, harness: 'codex', codex_question_bindings: [{
    question_id: pending.question_id, owner_key: h.incarnation.key, registration_turn_id: 'turn-1', service_identity: pending.service_identity,
    transcript: { file: readNativeQuestionSnapshot(file, SESSION, h.env)!.file, identity: readNativeQuestionSnapshot(file, SESSION, h.env)!.identity, registered_offset: readNativeQuestionSnapshot(file, SESSION, h.env)!.size },
    questions: questions.map((question, index) => ({ question, marker: `00${index + 1}` })),
  }] }))
  let emissions = 0
  const emit = () => {
    const callId = emissions++ === 0 ? 'bound_call' : `bound_call_${emissions}`
    const bindings = readSessionState(SESSION, h.env).codex_question_bindings![0]!.questions
    append('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: callId, arguments: JSON.stringify({ questions: bindings.map(binding => ({ title: nativeQuestionTitle(binding), options: binding.question.choices?.map(choice => choice.label) })) }) })
    append('response_item', { type: 'function_call_output', call_id: callId, output: '{"accepted":true}' })
  }
  const hook = () => hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ session_id: SESSION,
    cwd: h.deps.cwd, hook_event_name: 'PostToolUse', turn_id: 'turn-1', transcript_path: file }), 'codex')
  const reply = { reply_id: 'rpl_bound', seq: 1, delivery_id: 'del_bound', device_id: 'dev_test', device_name: 'Test', text: 'Continue',
    answers: [{ question_id: 'q1', choice_ids: [], text: 'Continue' }], source: null, created_at: new Date().toISOString() }
  const answer = { pending, reply, replies: [reply], agent_acknowledgement_required: true, delivery_claim: true as const }
  return { emit, hook, answer, file }
}

function nativeDelivery(questions?: QuestionT[], parts?: ReplyAnswerT[]) {
  const h = setup(); const binding = reserveBinding(h, questions)
  if (parts !== undefined) binding.answer.reply.answers = parts
  binding.emit()
  updateSessionState(SESSION, h.env, state => ({
    ...observeCodexQuestions(state, h.incarnation.key, readNativeQuestionSnapshot(binding.file, SESSION, h.env)),
    waiting_answers: [binding.answer],
    acknowledgement_due: [{ request_id: 'req_bound', recorded_at: Date.now(), text_required: true }],
  }))
  updateSessionState(SESSION, h.env, state => ({ ...state, codex_question_bindings: state.codex_question_bindings!.map(item =>
    ({ ...item, confirmed_request_id: 'req_bound' })) }))
  const native: string[] = []
  let closed = 0
  let available = true
  let allowed = true
  let serviceCurrent = true
  let duringPrepare = () => {}
  let duringWrite = () => {}
  const adapter = codexAnswerPresentation({ sessionId: SESSION, env: h.env, lease: h.lease,
    ownerKey: h.incarnation.key, turnId: 'turn-1', transcriptPath: binding.file,
    service: binding.answer.pending.service_identity, deadline: performance.now() + 10_000,
    mayWrite: () => allowed, serviceCurrent: () => serviceCurrent,
    connect: async () => available ? { namespace: h.env.CODEX_HOME, threadId: SESSION,
      currentTurn: async () => { duringPrepare(); return true },
      steer: async (_turn, text) => {
        expect(readDeliveryJournal(SESSION, h.env).at(-1)?.stage).toBe('writing')
        expect(readDeliveryJournal(SESSION, h.env).at(-1)?.presentation?.replies).toEqual([{ reply_id: 'rpl_bound', seq: 1 }])
        duringWrite(); native.push(text)
      }, close: () => { closed++ } } : null,
  })
  const drain = () => drainSessionInputs({ sequencer: h.sequencer, lease: h.lease, mayWrite: () => allowed,
    nativeAnswers: adapter, write: text => h.output.push(text) })
  return { ...h, ...binding, native, drain, adapter, closed: () => closed,
    changeMachine: () => { serviceCurrent = false }, unavailable: () => { available = false }, loseOwner: () => { allowed = false },
    duringPrepare: (fn: () => void) => { duringPrepare = fn }, duringWrite: (fn: () => void) => { duringWrite = fn } }
}

describe('exact native answer presentation', () => {
  it('journals the exact presentation before native bytes and retains acknowledgement debt', async () => {
    const h = nativeDelivery()
    expect(await h.drain()).toBe(true)
    expect(h.output).toEqual([])
    expect(h.native).toHaveLength(1)
    const payload = JSON.parse(h.native[0]!.split('\n')[1]!)
    expect(payload[0].questionItemId).toBe('["request_user_input_async","bound_call",0]')
    expect(payload[0].answer).toBe('Continue')
    expect(payload[0].notifai.origin).toBe('companion')
    expect(payload[0].notifai.instruction).toContain('notifai acknowledge req_bound')
    expect(payload[0].notifai.instruction).toContain("This answer came from the User's device.")
    expect(payload[0].notifai.instruction).not.toMatch(/--native-answers|--operation-id/)
    const journal = readDeliveryJournal(SESSION, h.env)[0]!
    expect(journal.presentation).toMatchObject({ kind: 'codex-answer', owner_key: h.incarnation.key,
      incarnation: h.lease.incarnation, generation: 1, expected_turn_id: 'turn-1',
      questions: [{ question_id: 'q1', turn_id: 'turn-1', call_id: 'bound_call', index: 0 }] })
    expect(journal.stage).toBe('written')
    expect(journal.presentation?.envelope_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(readSessionState(SESSION, h.env).acknowledgement_due).toHaveLength(1)
    expect(readSessionState(SESSION, h.env).codex_question_bindings?.[0]?.ordinary_only).toBeUndefined()
    expect(await h.drain()).toBe(false)
    expect(h.native).toHaveLength(1)
    expect(h.closed()).toBe(1)
  })

  it('claims ordinary prefix, native answer, then suffix in separate ordered handoffs', async () => {
    const h = nativeDelivery()
    const first = { ...h.answer, pending: { ...h.answer.pending, question_id: 'q_first', request_id: 'req_first' } }
    updateSessionState(SESSION, h.env, state => ({ ...state, waiting_answers: [first, h.answer],
      acknowledgement_due: [...state.acknowledgement_due!, { request_id: 'req_first', recorded_at: Date.now(), text_required: true }] }))
    h.stage([note('sm_suffix')])
    await h.drain()
    expect(h.claims).toEqual(['req_first']); expect(h.native).toEqual([])
    expect(h.output).toHaveLength(1); expect(h.output[0]).not.toContain('sm_suffix')
    await h.drain()
    expect(h.claims).toEqual(['req_first', 'req_bound']); expect(h.native).toHaveLength(1)
    expect(h.output).toHaveLength(1)
    await h.drain()
    expect(h.claims).toEqual(['req_first', 'req_bound', 'sm_suffix']); expect(h.output).toHaveLength(2)
  })

  it('never echoes or restores an uncertain native write', async () => {
    const h = nativeDelivery(); h.duringWrite(() => { throw new Error('lost native receipt') })
    await expect(h.drain()).rejects.toThrow('lost native receipt')
    expect(await h.drain()).toBe(false)
    expect(h.output).toEqual([])
    expect(readDeliveryJournal(SESSION, h.env)[0]?.stage).toBe('failed')
    expect(readSessionState(SESSION, h.env).waiting_answers).toEqual([])
    expect(readSessionState(SESSION, h.env).acknowledgement_due).toHaveLength(1)
    expect(h.closed()).toBe(1)
  })

  it('loses native authority on a duplicate marker during preparation and preserves sticky ambiguity', async () => {
    const h = nativeDelivery(); h.duringPrepare(h.emit)
    expect(await h.drain()).toBe(false)
    expect(h.output).toEqual([]); expect(h.native).toEqual([])
    expect(readSessionState(SESSION, h.env).codex_question_bindings?.[0]?.questions[0]?.ambiguous).toBe(true)
    expect(readSessionState(SESSION, h.env).waiting_answers).toHaveLength(1)
    expect(await h.drain()).toBe(true)
    expect(h.output).toHaveLength(1)
  })

  it('restores without native bytes if the approved Machine changes after preparation', async () => {
    const h = nativeDelivery(); h.duringPrepare(h.changeMachine)
    expect(await h.drain()).toBe(false)
    expect(h.native).toEqual([]); expect(h.output).toEqual([])
    expect(readDeliveryJournal(SESSION, h.env)[0]?.stage).toBe('released')
    expect(readSessionState(SESSION, h.env).waiting_answers).toHaveLength(1)
  })

  it('targets only the answered part of a mixed choice and typed form', async () => {
    const h = nativeDelivery([{ id: 'q1', text: 'First?' }, { id: 'q2', text: 'Second?',
      choices: [{ id: 'green', label: 'Green' }, { id: 'blue', label: 'Blue' }] }],
    [{ question_id: 'q2', choice_ids: ['green'], text: 'with extra detail' }])
    await h.drain()
    const payload = JSON.parse(h.native[0]!.split('\n')[1]!)
    expect(payload).toHaveLength(1)
    expect(payload[0].questionItemId).toBe('["request_user_input_async","bound_call",1]')
    expect(payload[0].answer).toBe('Green\nwith extra detail')
    expect(readDeliveryJournal(SESSION, h.env)[0]?.presentation?.questions).toEqual([
      { question_id: 'q2', turn_id: 'turn-1', call_id: 'bound_call', index: 1 },
    ])
  })
})

describe('Codex tool-boundary Session Messages', () => {

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

  it('retains a Note after a foreground transport timeout and presents it once after recovery', async () => {
    const h = setup()
    h.env['CODEX_THREAD_ID'] = SESSION
    h.stage([note('sm_retry')])
    const fetch = delayedInputClient(h, 0)
    fetch.mockRejectedValueOnce(new DOMException('Connection timed out', 'TimeoutError'))
      .mockRejectedValueOnce(new DOMException('Connection timed out', 'TimeoutError'))
    await receiveCommand(h.deps)
    expect(h.output.join('\n')).toContain('User input is pending')
    expect(h.output.join('\n')).not.toContain('Read sm_retry')
    expect(hasSessionInputs(SESSION, h.env, h.lease)).toBe(true)
    await receiveCommand(h.deps)
    await receiveCommand(h.deps)
    expect(h.output.filter(text => text.includes('Read sm_retry'))).toHaveLength(1)
    expect(h.claims).toEqual(['sm_retry'])
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

describe('wakes after a drain that hands nothing in', () => {
  // A service error or outage: every claim fails, so a shown wake hands nothing in.
  const failing = (h: ReturnType<typeof setup>) => vi.spyOn(h.sequencer.client, 'claimDeliveryAttempt')
    .mockRejectedValue(new ApiCallError(503, 'service_unavailable', 'outage'))
  const harness = () => {
    const h = setup()
    let now = Date.now()
    h.deps.now = () => now
    const wakes: string[] = []
    return { ...h, wakes, advance: (ms: number) => { now += ms },
      wake: () => wakeSessionInputs(SESSION, h.env, async text => { wakes.push(text); return 'written' as const }, undefined, { unique: true, now: () => now }),
      // The agent is shown the latest wake; its prompt hook drains.
      shown: () => hookRunCommand(h.deps, 'user-prompt-submit', async () => JSON.stringify({
        session_id: SESSION, cwd: h.deps.cwd, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2', prompt: wakes.at(-1) }), 'codex') }
  }

  it('never wakes again at once, backs off up to a cap, and wakes promptly once input is handed in', async () => {
    const h = harness()
    h.stage([note('sm_stuck')])
    const outage = failing(h)
    await h.wake()
    expect(h.wakes).toHaveLength(1)
    const backoffs = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]
    expect(backoffs.map((_, i) => inputWakeBackoffMs(i + 1))).toEqual(backoffs)
    for (const [i, backoff] of backoffs.entries()) {
      await h.shown()
      expect(readSessionState(SESSION, h.env).input_wake_unanswered?.count).toBe(i + 1)
      // The hub's next boundary, right after the failed drain, writes nothing.
      await h.wake()
      expect(h.wakes).toHaveLength(i + 1)
      h.advance(backoff - 1)
      await h.wake()
      expect(h.wakes).toHaveLength(i + 1)
      h.advance(1)
      await h.wake()
      expect(h.wakes).toHaveLength(i + 2)
    }
    expect(h.output.join('\n')).not.toContain('Read sm_stuck')

    outage.mockRestore()
    await h.shown()
    expect(h.output.join('\n')).toContain('Read sm_stuck')
    expect(readSessionState(SESSION, h.env).input_wake_unanswered).toBeUndefined()
    // Input handed in resets the backoff: what waits next is woken for at once.
    stageSessionMessages(SESSION, h.env, h.lease, [note('sm_stuck'), note('sm_after')])
    await h.wake()
    expect(h.wakes).toHaveLength(backoffs.length + 2)
  })
})

describe('Codex empty wakes', () => {
  const prompt = (h: ReturnType<typeof setup>, text: string) => hookRunCommand(h.deps, 'user-prompt-submit', async () => JSON.stringify({
    session_id: SESSION, cwd: h.deps.cwd, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2', prompt: text }), 'codex')
  const blocked = (output: string[]) => output.some((line) => {
    try { return (JSON.parse(line) as { decision?: string }).decision === 'block' } catch { return false }
  })

  it('blocks a wake with nothing waiting, tokened or not, so no turn runs', async () => {
    for (const wake of [sessionInputWake(), sessionInputWake('1a55ec5f-0fd4-4158-b1e2-6efe6b2256cf')]) {
      const h = setup()
      h.deps.store.load = () => { throw new Error('an empty wake reads no credential') }
      await prompt(h, wake)
      expect(h.output).toHaveLength(1)
      expect(JSON.parse(h.output[0]!)).toEqual({ decision: 'block', reason: expect.stringContaining('nothing is waiting') })
      expect(h.claims).toEqual([])
    }
  })

  it('blocks a wake that reaches a `codex exec` run of a thread hosted elsewhere, and hands that run nothing', async () => {
    const h = setup()
    h.stage([note('sm_elsewhere')])
    // A scripted run (`codex exec resume <id>`) opened the thread whose host was another process.
    const run = spawn('/bin/sleep', ['60'], { argv0: 'codex exec', stdio: 'ignore' })
    try {
      await new Promise((resolve) => setTimeout(resolve, 100))
      h.env['NOTIFAI_HOOK_SOURCE_PID'] = String(run.pid)
      await prompt(h, sessionInputWake())
      expect(h.claims).toEqual([])
      expect(h.output).toHaveLength(1)
      expect(JSON.parse(h.output[0]!)).toEqual({ decision: 'block',
        reason: "Notifai: this conversation's answers are waiting where it was last open, so this run won't pick them up." })
    } finally {
      run.kill('SIGKILL')
    }
  })

  it('never blocks the User\'s own prompt, even with nothing waiting', async () => {
    const h = setup()
    await prompt(h, 'Notifai wake, please carry on')
    await prompt(h, `${sessionInputWake()} And also fix the build.`)
    expect(blocked(h.output)).toBe(false)
  })
})


it('records a card terminal answer through UserPromptSubmit and the detached submission hook, then returns conflict context once', async () => {
  const h = setup()
  const binding = reserveBinding(h)
  binding.emit()
  await binding.hook()
  updateSessionState(SESSION, h.env, state => ({ ...state, codex_question_bindings: state.codex_question_bindings!.map(item =>
    ({ ...item, confirmed_request_id: 'req_bound' })) }))
  const registered = readSessionState(SESSION, h.env).codex_question_bindings![0]!
  const prompt = '<send_user_message_question_reply>\n' + JSON.stringify([{
    questionItemId: '["request_user_input_async","bound_call",0]',
    question: nativeQuestionTitle(registered.questions[0]!), answer: 'Proceed carefully',
  }]) + '\n</send_user_message_question_reply>'
  const spawn = vi.fn()
  h.deps.spawnQuestionSettlement = spawn
  const report = vi.fn(async () => ({ status: 'recorded', reply_seq: 1, complete: true,
    answer_version: { version_id: 'rpl_terminal', origin: 'harness', provenance: 'agent-reported', source: 'reply',
      status: 'presented', base_version: null, answers: [{ question_id: 'q1', choice_ids: [], text: 'Proceed carefully' }] },
    other_submissions: [{ version_id: 'rpl_device', origin: 'companion', answers: [{ question_id: 'q1', choice_ids: [], text: 'Wait' }] }],
  }))
  const acknowledge = vi.fn(async () => ({ status: 'recorded',
    agent_acknowledgement: { text: 'Answered in the agent session.', created_at: new Date().toISOString() } }))
  Object.assign(h.sequencer.client, { recordHarnessAnswer: report, putAgentAcknowledgement: acknowledge })
  await hookRunCommand(h.deps, 'user-prompt-submit', async () => JSON.stringify({ session_id: SESSION, cwd: h.deps.cwd,
    hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', transcript_path: binding.file, prompt }), 'codex')
  expect(readSessionState(SESSION, h.env).codex_terminal_observations).toHaveLength(1)
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ harness: 'codex', purpose: 'submission' }))
  expect(report).not.toHaveBeenCalled()
  appendFileSync(binding.file, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: prompt } }) + '\n')
  await hookRunCommand(h.deps, 'question-submission', async () => JSON.stringify({ session_id: SESSION, cwd: h.deps.cwd }), 'codex')
  expect(report).toHaveBeenCalledOnce()
  expect(acknowledge).toHaveBeenCalledWith('req_bound', { session_id: SESSION, reply_seq: 1, text: 'Answered in the agent session.' })
  h.output.length = 0
  await binding.hook()
  expect(h.output).toHaveLength(1)
  expect(JSON.parse(h.output[0]!).hookSpecificOutput.additionalContext).toContain('conflicting answers')
  expect(h.output[0]).toContain('Proceed carefully')
  expect(h.output[0]).toContain('Wait')
  h.output.length = 0
  await binding.hook()
  expect(h.output).toEqual([])
  updateSessionState(SESSION, h.env, state => ({ ...state, codex_terminal_conflicts: [
    ...(state.codex_terminal_conflicts ?? []), { id: 'later-conflict', context: 'Preserve both answers and ask which governs.' },
  ] }))
  await hookRunCommand(h.deps, 'stop', async () => JSON.stringify({ session_id: SESSION, cwd: h.deps.cwd,
    hook_event_name: 'Stop', turn_id: 'turn-1', transcript_path: binding.file }), 'codex')
  expect(h.output).toHaveLength(1)
  expect(JSON.parse(h.output[0]!)).toMatchObject({ decision: 'block', reason: 'Preserve both answers and ask which governs.' })
})
