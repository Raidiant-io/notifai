import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ClaimDeliveryAttemptRequestT, RecordHarnessAnswerResponse, ReplyAnswerT } from '@raidiant/notifai-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  askUserQuestionInput,
  claudePickerAnswers,
  claudePickerShape,
  claudeTerminalAnswers,
  pickerDigest,
  pickerForm,
  pickerQuestions,
  type PickerForm,
} from './claude-question-bindings.js'
import {
  CLAUDE_TERMINAL_ACKNOWLEDGEMENT,
  CLAUDE_TERMINAL_OPERATION,
  claudePermissionRequest,
  claudePickerHolds,
  claudePostToolUse,
  closeClaudePicker,
  reportClaudeTerminalAnswers,
  takeOwedClaudePickerAnswer,
} from './claude-question-hooks.js'
import { ApiCallError, type ApiClient } from './client.js'
import { hookRunCommand } from './commands-hook-run.js'
import type { CommandDeps } from './commands-core.js'
import type { CodexQuestionRegistration } from './codex-question-bindings.js'
import { acquireClaimFile } from './hook-question-lock.js'
import { recordConfirmedNativeAnswerTarget } from './native-answer-operation.js'
import { beginSessionIncarnation, lifecycleStamp, readSessionState, updateSessionState, writeSessionState } from './hook-session-state.js'
import type { AnsweredPending, HookEnvelope, PendingQuestion, SessionState } from './hook-types.js'
import { createLogger, readLogRecords } from './logging.js'
import { currentProcessIdentity } from './process-identity.js'
import { enableProject, projectBinding } from './project-enablement.js'
import { attendantClaimPath, writeAttendantStatus } from './session-attendant-state.js'
import { readDeliveryJournal } from './session-delivery.js'

const SESSION = '22222222-2222-4222-8222-222222222222'
const SERVICE = { base_url: 'https://test.notifai.invalid', machine_id: 'mac_test' }

/** What an agent naturally writes: context first, then the question. */
const REWORDED = 'We are choosing where this release goes. Staging is a safe rehearsal, production reaches every user. Which environment should this deploy go to?'

function picker(questions: Array<{ question: string; labels: string[]; multiSelect?: boolean; header?: string }>) {
  return {
    questions: questions.map((entry) => ({
      question: entry.question,
      header: entry.header ?? 'Deploy',
      options: entry.labels.map((label) => ({ label, description: `Choose ${label}` })),
      multiSelect: entry.multiSelect === true,
    })),
  }
}

const ENVIRONMENT = picker([{ question: REWORDED, labels: ['Staging', 'Production'] }])
const FORM = picker([
  { question: 'Which environment?', labels: ['Staging', 'Production'], header: 'Target' },
  { question: 'Which checks should run first?', labels: ['Lint', 'Tests', 'End to end'], multiSelect: true, header: 'Checks' },
])

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup(options: { signedIn?: boolean; enabled?: boolean; leased?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-claude-picker-'))
  roots.push(root)
  const owner = currentProcessIdentity()!
  const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
  const incarnation = beginSessionIncarnation(SESSION, env, { stamp: lifecycleStamp(), harnessProcess: owner })
  writeSessionState(SESSION, env, { harness: 'claude-code', last_prompt_at: 1 })
  // A Project is a repository the User enabled.
  execFileSync('git', ['init', '-q'], { cwd: root })
  if (options.enabled !== false) enableProject(projectBinding(root, env)!)
  const lease = { incarnation: incarnation.incarnation, generation: 1 }
  /** The attendant's lease exchange completes: until then nothing may be claimed. */
  const attend = () => {
    acquireClaimFile(attendantClaimPath(SESSION, env), { incarnation: lease.incarnation }, Date.now())
    writeAttendantStatus(SESSION, env, { ...lease, phase: 'attending', activity: 'working', reason: null, accepts_messages: true, updated_at: Date.now() })
  }
  if (options.leased !== false) attend()
  const output: string[] = []
  const claims: string[] = []
  const reports: string[] = []
  const reported = { harness: [] as unknown[], acknowledged: [] as unknown[] }
  const client = {
    claimDeliveryAttempt: async (_session: string, body: ClaimDeliveryAttemptRequestT) => {
      const id = body.subject.type === 'session_message' ? body.subject.message_id : body.subject.request_id
      // A request whose answer was already handed off cannot be claimed again.
      if (claims.includes(id)) throw new ApiCallError(409, 'claim_refused', 'settled', null, { reason: 'not_claimable' })
      claims.push(id)
      return { attempt_id: `att_${id}`, claim_remaining_ms: 30_000 }
    },
    reportDeliveryAttempt: async (id: string, body: { outcome: string }) => {
      reports.push(body.outcome)
      return { attempt_id: id, ...body, replayed: false }
    },
    recordHarnessAnswer: vi.fn(async (_request: string, body: { answers: ReplyAnswerT[] }) => {
      reported.harness.push(body)
      return { status: 'recorded', reply_seq: 1, complete: true, other_submissions: [],
        answer_version: { version_id: 'rpl_terminal', origin: 'harness', provenance: 'agent-reported', source: 'reply', base_version: null,
          status: 'presented', not_delivered_reason: null, text: 'Production',
          answers: body.answers.map(answer => ({ question_id: answer.question_id, choice_ids: answer.choice_ids ?? [], text: answer.text ?? null })),
          device_id: null, created_at: '2026-10-18T12:00:00Z', agent_acknowledgement: null } } as RecordHarnessAnswerResponse
    }),
    putAgentAcknowledgement: vi.fn(async (_request: string, body: { text: string }) => {
      reported.acknowledged.push(body)
      return { status: 'recorded' as const, agent_acknowledgement: { text: body.text, created_at: '2026-10-18T12:00:01Z' } }
    }),
  }
  const launches: unknown[] = []
  const deps: CommandDeps = {
    cwd: root, env,
    io: { out: (line) => { output.push(line) }, err: () => {}, confirm: async () => false, openUrl: () => {} },
    store: { load: () => options.signedIn === false ? null : ({ machineId: SERVICE.machine_id, secret: 'test-secret', baseUrl: SERVICE.base_url, machineName: 'test' }), save: () => {}, clear: () => {} } as unknown as CommandDeps['store'],
    clientFactory: () => client as unknown as ApiClient,
    spawnQuestionSettlement: (launch) => { launches.push(launch) },
  }
  const gates: Array<Record<string, unknown>> = []
  const base = createLogger({ env, cwd: root, cmd: 'hook permission-request' })
  const logger = { ...base, info: (event: Parameters<typeof base.info>[0], fields?: Record<string, unknown>) => {
    if (event === 'hook.gate') gates.push(fields ?? {})
    base.info(event, fields)
  } }
  const state = (): SessionState => readSessionState(SESSION, env)
  const envelope = (toolInput: unknown = ENVIRONMENT, extra: Partial<HookEnvelope> = {}): HookEnvelope => ({
    session_id: SESSION, cwd: root, tool_name: 'AskUserQuestion', tool_input: toolInput, ...extra,
  })
  const held = (): string => state().claude_picker!.question_id
  const registration = (questionId = held()): CodexQuestionRegistration =>
    state().codex_question_bindings!.find(item => item.question_id === questionId)!
  const pendingOf = (questionId: string): PendingQuestion | undefined => state().pending?.find(item => item.question_id === questionId)
  /** What admission writes once the service accepted the submission. */
  const confirm = (questionId = held(), requestId = `req_${questionId}`) => {
    updateSessionState(SESSION, env, current => ({ ...current, pending: (current.pending ?? []).map(entry =>
      entry.question_id === questionId ? { ...entry, request_id: requestId, collapse_key: requestId, device_ids: ['dev_test'] } : entry) }))
    recordConfirmedNativeAnswerTarget(SESSION, env, { ...pendingOf(questionId)!, request_id: requestId })
    return requestId
  }
  /** A device answer, collected by the session owner and waiting for the foreground drain. */
  const stage = (parts: ReplyAnswerT[], questionId = held(), text = 'Staging') => {
    const pending = pendingOf(questionId)!
    const reply = {
      reply_id: `rpl_${questionId}`, seq: 1, delivery_id: 'del_test', device_id: 'dev_test', device_name: 'Test', text,
      answers: parts, source: null, created_at: new Date().toISOString(),
    }
    const answer = { pending, reply, replies: [reply], agent_acknowledgement_required: true, delivery_claim: true as const } as unknown as AnsweredPending
    updateSessionState(SESSION, env, (current) => ({
      ...current,
      pending: (current.pending ?? []).filter(entry => entry.question_id !== questionId),
      waiting_answers: [...(current.waiting_answers ?? []), answer],
      acknowledgement_due: [...(current.acknowledgement_due ?? []), { request_id: pending.request_id!, recorded_at: Date.now(), text_required: true }],
    }))
    return answer
  }
  const decision = () => JSON.parse(output[0]!) as {
    hookSpecificOutput: { hookEventName: string; decision: { behavior: string; updatedInput: { questions: unknown[]; answers: Record<string, string> } } }
  }
  const context = (index = 0) =>
    (JSON.parse(output[index]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
  return { root, env, deps, output, claims, reports, reported, client, launches, gates, incarnation, logger, attend, state, envelope, held,
    registration, pendingOf, confirm, stage, decision, context }
}

describe('a Claude Code picker as a device question', () => {
  it('keeps short pickers as they are and maps every device id back to the picker', () => {
    const form = pickerForm(pickerQuestions(FORM)!) as PickerForm
    expect(form.questions).toEqual([
      { id: 'which-environment', text: 'Which environment?', choices: [{ id: 'staging', label: 'Staging' }, { id: 'production', label: 'Production' }] },
      { id: 'which-checks-should-run-first', text: 'Which checks should run first?', multi: true,
        choices: [{ id: 'lint', label: 'Lint' }, { id: 'tests', label: 'Tests' }, { id: 'end-to-end', label: 'End to end' }] },
    ])
    expect(form.summary).toBe('Target · Checks')
    expect(form.shown[1]).toEqual({ title: 'Which checks should run first?', labels: { lint: 'Lint', tests: 'Tests', 'end-to-end': 'End to end' } })
    // Option descriptions are context the agent wrote for the User: the device shows them too.
    expect(form.body).toContain('**End to end**: Choose End to end')
  })

  it('shortens text the device cannot show and keeps the whole wording in the body', () => {
    const long = `${'Context sentence about the release. '.repeat(8)}Which environment should this deploy go to?`
    const label = 'A label far longer than any device button could ever show'
    const form = pickerForm(pickerQuestions(picker([{ question: long, labels: [label, 'Production'] }]))!) as PickerForm
    expect([...form.questions[0]!.text].length).toBeLessThanOrEqual(240)
    expect(form.questions[0]!.text.endsWith('Which environment should this deploy go to?')).toBe(true)
    expect([...form.questions[0]!.choices![0]!.label].length).toBeLessThanOrEqual(40)
    expect(form.body).toContain(long.trim())
    expect(form.body).toContain(label)
    expect(form.shown[0]!.title).toBe(long)
    expect(Object.values(form.shown[0]!.labels)).toEqual([label, 'Production'])
  })

  it('refuses only what no device question can carry', () => {
    expect(pickerForm(pickerQuestions(picker([{ question: 'Same?', labels: ['A', 'A'] }]))!)).toEqual({ error: 'duplicate-option' })
    expect(pickerForm(pickerQuestions(picker([{ question: 'One?', labels: ['A'] }]))!)).toEqual({ error: 'unsupported-option-count' })
    expect(pickerForm(pickerQuestions(picker([{ question: 'Q?', labels: ['A', 'B'] }, { question: 'Q?', labels: ['C', 'D'] }]))!))
      .toEqual({ error: 'duplicate-question' })
    expect(pickerQuestions({ questions: [{ question: 'No options' }] })).toBeNull()
    expect(pickerQuestions('not a picker')).toBeNull()
  })

  it('identifies a picker by its questions, whatever order its keys arrive in', () => {
    const reordered = { questions: ENVIRONMENT.questions.map(({ question, header, options, multiSelect }) =>
      ({ multiSelect, options: options.map(({ label, description }) => ({ description, label })), header, question })) }
    expect(pickerDigest(reordered)).toBe(pickerDigest(ENVIRONMENT))
    expect(pickerDigest({ ...ENVIRONMENT, answers: { [REWORDED]: 'Staging' } })).toBe(pickerDigest(ENVIRONMENT))
    expect(pickerDigest(picker([{ question: REWORDED, labels: ['Staging', 'Canary'] }]))).not.toBe(pickerDigest(ENVIRONMENT))
  })

  it('tells ask which questions the picker asks by itself', () => {
    const choice = { id: 'q1', text: 'Where?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }
    expect(claudePickerShape([choice])).toBe(true)
    expect(claudePickerShape([{ id: 'q1', text: 'Why?' }])).toBe(false)
    expect(claudePickerShape([{ ...choice, choices: [1, 2, 3, 4, 5].map(n => ({ id: `c${n}`, label: `C${n}` })) }])).toBe(false)
    expect(askUserQuestionInput([{ ...choice, multi: true }])).toEqual({
      questions: [{ question: 'Where?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }],
    })
  })
})

describe('Claude Code picker hooks', () => {
  it('registers an agent-worded picker for the devices and returns the device answer as the picker result', async () => {
    const h = setup()
    let slept = 0
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        slept++
        if (slept > 1) return
        const registration = h.registration()
        expect(registration.questions[0]).toMatchObject({ verified: true, picker: { title: REWORDED } })
        expect(h.pendingOf(h.held())).toMatchObject({ question: REWORDED, summary: REWORDED })
        expect(h.launches).toEqual([{ envelope: { session_id: SESSION, cwd: h.root }, harness: 'claude-code', purpose: 'submission' }])
        h.confirm()
        h.stage([{ question_id: registration.questions[0]!.question.id, choice_ids: ['production'] }])
      },
    })
    expect(outcome).toBe('answered')
    expect(h.output).toHaveLength(1)
    expect(h.decision().hookSpecificOutput).toMatchObject({
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { answers: { [REWORDED]: 'Production' } } },
    })
    expect(h.decision().hookSpecificOutput.decision.updatedInput.questions).toEqual(ENVIRONMENT.questions)
    const questionId = h.state().claude_picker!.question_id
    expect(h.claims).toEqual([`req_${questionId}`])
    expect(readDeliveryJournal(SESSION, h.env).at(-1)).toMatchObject({ stage: 'written', presentation: { kind: 'claude-question' } })
    expect(h.gates.map(gate => gate['stage'])).toEqual(['picker-waiting', 'picker-answered'])

    h.output.length = 0
    claudePostToolUse(h.deps, h.envelope(ENVIRONMENT, { tool_response: { answers: { [REWORDED]: 'Production' } } }), h.logger)
    expect(h.context()).toContain(`came from the user's device, for request req_${questionId}`)
    expect(h.context()).toContain(`notifai acknowledge req_${questionId} --text`)
    expect(h.state().claude_picker).toBeUndefined()
    expect(h.state().claude_picker_presented).toBeUndefined()
  })

  it('carries a two-question multi-select picker both ways', async () => {
    const h = setup()
    const outcome = await claudePermissionRequest(h.deps, h.envelope(FORM), h.logger, {
      sleep: async () => {
        if (h.state().waiting_answers?.length) return
        h.confirm()
        h.stage([{ question_id: 'which-environment', choice_ids: ['staging'] },
          { question_id: 'which-checks-should-run-first', choice_ids: ['lint', 'end-to-end'] }])
      },
    })
    expect(outcome).toBe('answered')
    expect(h.decision().hookSpecificOutput.decision.updatedInput.answers).toEqual({
      'Which environment?': 'Staging', 'Which checks should run first?': 'Lint, End to end',
    })
    const registration = h.registration()
    expect(claudeTerminalAnswers(registration, { answers: { 'Which environment?': 'Production', 'Which checks should run first?': 'Tests, End to end' } }))
      .toEqual([{ question_id: 'which-environment', choice_ids: ['production'] },
        { question_id: 'which-checks-should-run-first', choice_ids: ['tests', 'end-to-end'] }])
    expect(claudeTerminalAnswers(registration, { answers: { 'Which environment?': 'Somewhere else', 'Which checks should run first?': 'Lint' } }))
      .toEqual([{ question_id: 'which-environment', text: 'Somewhere else' },
        { question_id: 'which-checks-should-run-first', choice_ids: ['lint'] }])
  })

  it('never lets an older open question with the same content stand in for a new picker', async () => {
    const h = setup()
    // An earlier question with exactly this content is still open and bound:
    // answered from a phone with free text, it was never closed.
    const form = pickerForm(pickerQuestions(ENVIRONMENT)!) as PickerForm
    updateSessionState(SESSION, h.env, current => ({ ...current,
      pending: [{ question_id: 'q_stale', question: REWORDED, summary: REWORDED, service_identity: SERVICE,
        request_id: 'req_stale', collapse_key: 'stale', device_ids: ['dev_test'], questions: form.questions }],
      codex_question_bindings: [{ question_id: 'q_stale', owner_key: h.incarnation.key, registration_turn_id: 'claude-code-picker',
        transcript: { file: '', identity: 'claude-code-picker', registered_offset: 0 }, service_identity: SERVICE, confirmed_request_id: 'req_stale',
        questions: form.questions.map((question, index) => ({ question, picker: form.shown[index]!, verified: true as const,
          native: { turn_id: 'claude-code-picker', call_id: 'picker', index } })) }],
    }))
    let fresh: string | undefined
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        if (fresh !== undefined) return
        fresh = h.held()
        expect(fresh).not.toBe('q_stale')
        h.confirm(fresh)
        h.stage([{ question_id: h.registration(fresh).questions[0]!.question.id, choice_ids: ['staging'] }], fresh)
      },
    })
    expect(outcome).toBe('answered')
    expect(h.decision().hookSpecificOutput.decision.updatedInput.answers).toEqual({ [REWORDED]: 'Staging' })
    expect(h.claims).toEqual([`req_${fresh}`])
    // The earlier question is no business of this picker's: it stays as it was.
    expect(h.pendingOf('q_stale')).toBeDefined()
    expect(h.registration('q_stale').terminated).toBeUndefined()
  })

  it('gives two similar pickers back to back a question each', async () => {
    const h = setup()
    const ids: string[] = []
    for (const answer of ['staging', 'production']) {
      h.output.length = 0
      expect(await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
        sleep: async () => {
          if (h.state().waiting_answers?.length) return
          ids.push(h.held())
          h.confirm()
          h.stage([{ question_id: h.registration().questions[0]!.question.id, choice_ids: [answer] }])
        },
      })).toBe('answered')
      claudePostToolUse(h.deps, h.envelope(ENVIRONMENT, { tool_response: { answers: h.decision().hookSpecificOutput.decision.updatedInput.answers } }), h.logger)
    }
    expect(new Set(ids).size).toBe(2)
    expect(h.claims).toEqual(ids.map(id => `req_${id}`))
  })

  it('records a terminal answer as the native answer, so the devices stop asking, with nothing for the agent to do', async () => {
    const h = setup()
    let questionId = ''
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        questionId = h.held()
        h.confirm()
        h.output.length = 0
        claudePostToolUse(h.deps, h.envelope(ENVIRONMENT, { tool_response: { answers: { [REWORDED]: 'Production' } } }), h.logger)
      },
    })
    expect(outcome).toBe('left-to-terminal')
    expect(h.output).toEqual([])
    expect(h.claims).toEqual([])
    const operation = h.state().native_answer_operations?.[0]
    expect(operation).toMatchObject({ question_id: questionId, operation_id: CLAUDE_TERMINAL_OPERATION, request_id: `req_${questionId}`,
      answers: [{ question_id: h.registration(questionId).questions[0]!.question.id, choice_ids: ['production'] }],
      acknowledgement_text: CLAUDE_TERMINAL_ACKNOWLEDGEMENT })
    expect(h.launches).toHaveLength(2)

    await reportClaudeTerminalAnswers({ client: h.client as unknown as ApiClient, env: h.env, log: h.logger }, SESSION)
    expect(h.client.recordHarnessAnswer).toHaveBeenCalledWith(`req_${questionId}`, expect.objectContaining({ session_id: SESSION }))
    expect(h.reported.acknowledged).toEqual([{ session_id: SESSION, reply_seq: 1, text: CLAUDE_TERMINAL_ACKNOWLEDGEMENT }])
    expect(h.state().native_answer_operations?.[0]?.acknowledgement).toBeDefined()
    await reportClaudeTerminalAnswers({ client: h.client as unknown as ApiClient, env: h.env, log: h.logger }, SESSION)
    expect(h.client.recordHarnessAnswer).toHaveBeenCalledTimes(1)
  })

  it('retires the question when the service refuses the terminal report for good, and retries anything else', async () => {
    const h = setup()
    await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        h.confirm()
        claudePostToolUse(h.deps, h.envelope(ENVIRONMENT, { tool_response: { answers: { [REWORDED]: 'Production' } } }), h.logger)
      },
    })
    const questionId = h.state().native_answer_operations![0]!.question_id
    h.client.recordHarnessAnswer.mockRejectedValueOnce(new Error('offline'))
    await reportClaudeTerminalAnswers({ client: h.client as unknown as ApiClient, env: h.env, log: h.logger }, SESSION)
    expect(h.state().native_answer_operations).toHaveLength(1)
    expect(h.pendingOf(questionId)).toBeDefined()
    h.client.recordHarnessAnswer.mockRejectedValueOnce(new ApiCallError(404, 'not_found', 'unsupported'))
    await reportClaudeTerminalAnswers({ client: h.client as unknown as ApiClient, env: h.env, log: h.logger }, SESSION)
    expect(h.state().native_answer_operations ?? []).toEqual([])
    expect(h.pendingOf(questionId)).toBeUndefined()
    expect(h.state().retiring).toEqual([expect.objectContaining({ request_id: `req_${questionId}`, state: 'answered_elsewhere' })])
  })

  it('withdraws a question the terminal answered before it ever left this machine', async () => {
    const h = setup()
    let questionId = ''
    await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        questionId = h.held()
        claudePostToolUse(h.deps, h.envelope(ENVIRONMENT, { tool_response: { answers: { [REWORDED]: 'Staging' } } }), h.logger)
      },
    })
    expect(h.pendingOf(questionId)).toBeUndefined()
    expect(h.state().native_answer_operations).toBeUndefined()
    expect(h.state().question_history).toEqual([expect.objectContaining({ question_id: questionId, state: 'withdrawn' })])
  })

  it('withdraws the device question when the picker closes without an answer: Esc, chat instead, or a denial', async () => {
    const dismissed = setup()
    let signal!: () => void
    const signalled = new Promise<void>((resolve) => { signal = resolve })
    let questionId = ''
    expect(await claudePermissionRequest(dismissed.deps, dismissed.envelope(), dismissed.logger, {
      signalled, sleep: async () => { questionId = dismissed.held(); dismissed.confirm(); signal(); await Promise.resolve() },
    })).toBe('left-to-terminal')
    expect(dismissed.state().claude_picker).toBeUndefined()
    expect(dismissed.pendingOf(questionId)).toBeUndefined()
    expect(dismissed.state().retiring).toEqual([expect.objectContaining({ request_id: `req_${questionId}`, state: 'expired' })])
    expect(dismissed.gates.at(-1)).toMatchObject({ stage: 'picker-dismissed', reason: 'retiring' })
    expect(dismissed.launches).toHaveLength(2)

    // "Chat about this" and a denial by another hook both end the turn without a tool result.
    const chatted = setup()
    const outcome = await claudePermissionRequest(chatted.deps, chatted.envelope(), chatted.logger, {
      sleep: async () => { questionId = chatted.held(); await hookRunCommand(chatted.deps, 'stop', async () => JSON.stringify({ session_id: SESSION, cwd: chatted.root, hook_event_name: 'Stop' }), 'claude-code') },
    })
    expect(outcome).toBe('left-to-terminal')
    expect(chatted.pendingOf(questionId)).toBeUndefined()
    expect(chatted.state().question_history).toEqual([expect.objectContaining({ question_id: questionId, state: 'withdrawn' })])
    expect(chatted.output).toEqual([])
  })

  it('keeps an answer already on its way when the picker closes', async () => {
    const h = setup()
    await claudePermissionRequest(h.deps, h.envelope(FORM), h.logger, {
      sleep: async () => {
        h.confirm()
        // A partial device answer the picker cannot carry goes the ordinary route.
        h.stage([{ question_id: 'which-environment', choice_ids: ['staging'] }])
      },
    })
    expect(h.output).toEqual([])
    expect(h.state().waiting_answers).toHaveLength(1)
    expect(h.gates.at(-1)).toMatchObject({ stage: 'answer-needs-ordinary-route' })
    closeClaudePicker(h.deps, SESSION, h.logger)
    expect(h.state().waiting_answers).toHaveLength(1)
  })

  it('leaves every picker in a Project the User has not enabled to the terminal', async () => {
    const h = setup({ enabled: false })
    expect(await claudePermissionRequest(h.deps, h.envelope(), h.logger)).toBe('not-bound')
    expect(h.gates).toEqual([expect.objectContaining({ stage: 'picker-terminal-only', reason: 'project-not-enabled' })])
    expect(h.state().pending).toBeUndefined()
    expect(h.launches).toEqual([])
    enableProject(projectBinding(h.root, h.env)!)
    expect(await claudePermissionRequest(h.deps, h.envelope(), h.logger, { sleep: async () => { closeClaudePicker(h.deps, SESSION, h.logger) } }))
      .toBe('left-to-terminal')
    expect(h.gates.map(gate => gate['stage'])).toContain('picker-waiting')
  })

  it('leaves the picker to the terminal, and says why, whenever it cannot reach a device', async () => {
    const signedOut = setup({ signedIn: false })
    expect(await claudePermissionRequest(signedOut.deps, signedOut.envelope(), signedOut.logger)).toBe('not-bound')
    expect(signedOut.gates).toEqual([expect.objectContaining({ stage: 'picker-terminal-only', reason: 'not-signed-in' })])

    const h = setup()
    expect(await claudePermissionRequest(h.deps, h.envelope(ENVIRONMENT, { agent_id: 'agent-1' }), h.logger)).toBe('not-bound')
    expect(await claudePermissionRequest(h.deps, h.envelope(picker([{ question: 'One?', labels: ['Only'] }])), h.logger)).toBe('not-bound')
    expect(await claudePermissionRequest(h.deps, h.envelope({ command: 'ls' }), h.logger)).toBe('not-bound')
    expect(await claudePermissionRequest(h.deps, h.envelope(ENVIRONMENT, { tool_name: 'Bash' }), h.logger)).toBe('not-bound')
    expect(h.gates.map(gate => gate['reason'])).toEqual(['subagent', 'unsupported-picker', 'not-a-picker'])
    expect(h.output).toEqual([])
    expect(h.state().pending).toBeUndefined()
    expect(h.state().claude_picker).toBeUndefined()
    expect(h.launches).toEqual([])
    const durable = readLogRecords(h.env, { event: ['hook.gate'] })
    expect(durable.records.map(record => record.data?.['reason'])).toEqual(['subagent', 'unsupported-picker', 'not-a-picker'])
  })

  it('still delivers a device answer that the terminal overtook or the picker never confirmed', async () => {
    const overtaken = setup()
    await claudePermissionRequest(overtaken.deps, overtaken.envelope(), overtaken.logger, {
      sleep: async () => { overtaken.confirm(); overtaken.stage([{ question_id: overtaken.registration().questions[0]!.question.id, choice_ids: ['staging'] }]) },
    })
    overtaken.output.length = 0
    claudePostToolUse(overtaken.deps, overtaken.envelope(ENVIRONMENT, { tool_response: { answers: { [REWORDED]: 'Production' } } }), overtaken.logger)
    expect(overtaken.context()).toContain('"Staging"')
    expect(overtaken.context()).toContain('answered in the terminal at the same moment')

    const unconfirmed = setup()
    await claudePermissionRequest(unconfirmed.deps, unconfirmed.envelope(), unconfirmed.logger, {
      sleep: async () => { unconfirmed.confirm(); unconfirmed.stage([{ question_id: unconfirmed.registration().questions[0]!.question.id, choice_ids: ['staging'] }]) },
    })
    const owed = takeOwedClaudePickerAnswer(SESSION, unconfirmed.env)
    expect(owed).toContain('"Staging"')
    expect(owed).toContain('notifai acknowledge req_')
    expect(takeOwedClaudePickerAnswer(SESSION, unconfirmed.env)).toBeNull()
  })

  it('waits for the attendant lease when the device answers before the first lease exchange', async () => {
    // A quick device answer can be collected and staged before the session's
    // attendant holds a lease. The picker stays the answer's writer: it waits
    // for the lease and claims the answer, instead of leaving it to a terminal
    // picker nobody is watching.
    const h = setup({ leased: false })
    let slept = 0
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        slept++
        if (slept === 1) {
          h.confirm()
          h.stage([{ question_id: h.registration().questions[0]!.question.id, choice_ids: ['production'] }])
        }
        if (slept === 3) h.attend()
      },
    })
    expect(outcome).toBe('answered')
    expect(slept).toBe(3)
    expect(h.decision().hookSpecificOutput.decision.updatedInput.answers).toEqual({ [REWORDED]: 'Production' })
    expect(h.claims).toEqual([`req_${h.held()}`])
    expect(h.gates.map(gate => gate['stage'])).toEqual(['picker-waiting', 'picker-answered'])
  })

  it('holds the wake only while a live handler has the sole pending answer', async () => {
    const h = setup()
    expect(claudePickerHolds(h.state())).toBe(false)
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        expect(claudePickerHolds(h.state())).toBe(false)
        h.confirm()
        const answer = h.stage([{ question_id: h.registration().questions[0]!.question.id, choice_ids: ['staging'] }])
        expect(claudePickerHolds(h.state())).toBe(true)
        const other = { ...answer, pending: { ...answer.pending, question_id: 'q_other', request_id: 'req_other' } }
        expect(claudePickerHolds({ ...h.state(), waiting_answers: [answer, other] })).toBe(false)
      },
    })
    expect(outcome).toBe('answered')
  })

  it('maps a device answer only onto its own registration', () => {
    const form = pickerForm(pickerQuestions(ENVIRONMENT)!) as PickerForm
    const registration: CodexQuestionRegistration = {
      question_id: 'q_one', owner_key: 'k', registration_turn_id: 'claude-code-picker', confirmed_request_id: 'req_one',
      transcript: { file: '', identity: 'claude-code-picker', registered_offset: 0 }, service_identity: SERVICE,
      questions: form.questions.map((question, index) => ({ question, picker: form.shown[index]!, verified: true as const })),
    }
    const reply = { reply_id: 'r', seq: 1, delivery_id: 'd', device_id: 'dev', device_name: 'D', text: 'x', source: null, created_at: '',
      answers: [{ question_id: form.questions[0]!.id, choice_ids: ['staging'] }] }
    const answer = { pending: { question_id: 'q_one', request_id: 'req_one', service_identity: SERVICE, questions: form.questions },
      reply, replies: [reply], delivery_claim: true } as unknown as AnsweredPending
    expect(claudePickerAnswers(registration, answer, SERVICE)).toEqual({ [REWORDED]: 'Staging' })
    expect(claudePickerAnswers({ ...registration, question_id: 'q_two' }, answer, SERVICE)).toBeNull()
    expect(claudePickerAnswers(registration, answer, { ...SERVICE, machine_id: 'other' })).toBeNull()
  })
})

describe('Claude Code picker hook entry points', () => {
  const stdin = (payload: unknown) => async () => JSON.stringify(payload)

  it('answers a picker from the device, confirms it, and withdraws a picker the turn left behind', async () => {
    const h = setup()
    const event = { session_id: SESSION, cwd: h.root, tool_name: 'AskUserQuestion', tool_input: ENVIRONMENT }
    const answered = (async () => {
      for (let attempt = 0; attempt < 200 && h.state().claude_picker === undefined; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
      h.confirm()
      h.stage([{ question_id: h.registration().questions[0]!.question.id, choice_ids: ['staging'] }])
    })()
    expect(await hookRunCommand(h.deps, 'permission-request', stdin({ ...event, hook_event_name: 'PermissionRequest' }), 'claude-code')).toBe(0)
    await answered
    expect(h.decision().hookSpecificOutput.decision.updatedInput.answers).toEqual({ [REWORDED]: 'Staging' })

    h.output.length = 0
    expect(await hookRunCommand(h.deps, 'post-tool-use', stdin({
      ...event, hook_event_name: 'PostToolUse', tool_response: { answers: { [REWORDED]: 'Staging' } },
    }), 'claude-code')).toBe(0)
    expect(h.output.join('\n')).toContain('notifai acknowledge req_')

    updateSessionState(SESSION, h.env, (state) => ({
      ...state, pending: [...(state.pending ?? []), { question_id: 'q_left', question: 'Left?', summary: 'Left?', service_identity: SERVICE }],
      claude_picker: { question_id: 'q_left', digest: 'x', opened_at: 1, waiter: currentProcessIdentity()! },
    }))
    expect(await hookRunCommand(h.deps, 'stop', stdin({ session_id: SESSION, cwd: h.root, hook_event_name: 'Stop' }), 'claude-code')).toBe(0)
    expect(h.state().claude_picker).toBeUndefined()
    expect(h.pendingOf('q_left')).toBeUndefined()
  })

  it('writes nothing on any harness but Claude Code, or for another tool', async () => {
    const h = setup()
    const event = { session_id: SESSION, cwd: h.root, hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion' }
    await hookRunCommand(h.deps, 'permission-request', stdin({ ...event, tool_input: ENVIRONMENT }), 'codex')
    await hookRunCommand(h.deps, 'permission-request', stdin({ ...event, tool_name: 'Bash', tool_input: { command: 'ls' } }), 'claude-code')
    expect(h.output).toEqual([])
    expect(h.state().pending).toBeUndefined()
  })

  it('carries an unconfirmed device answer on the next prompt', async () => {
    const h = setup()
    await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => { h.confirm(); h.stage([{ question_id: h.registration().questions[0]!.question.id, choice_ids: ['staging'] }]) },
    })
    h.output.length = 0
    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({
      session_id: SESSION, cwd: h.root, hook_event_name: 'UserPromptSubmit', prompt: 'what happened?',
    }), 'claude-code')
    const context = h.output.join('\n')
    expect(context).toContain('Staging')
    expect(context).toContain('notifai acknowledge req_')
    expect(h.state().claude_picker_presented).toBeUndefined()
  })
})
