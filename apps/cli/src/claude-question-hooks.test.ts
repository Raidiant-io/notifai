import type { ClaimDeliveryAttemptRequestT,RecordHarnessAnswerResponse,ReplyAnswerT } from '@raidiant/notifai-protocol'
import { execFileSync } from 'node:child_process'
import { mkdtempSync,rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { handBackInput,recordHandBack,type ClaudePickerInput } from './claude-picker-handback.js'
import {
claudePickerAnswers,
claudeTerminalAnswers,
pickerForm,
pickerHeading,
pickerQuestions,
pickerRefusal,
type PickerForm
} from './claude-question-bindings.js'
import {
CLAUDE_PICKER_ANSWER_FOLLOWS,
CLAUDE_PICKER_DISMISSED,
CLAUDE_TERMINAL_ACKNOWLEDGEMENT,
CLAUDE_TERMINAL_OPERATION,
claudePermissionRequest,
claudePickerAutoContinued,
claudePickerHolds,
claudePostToolUse,
closeClaudePicker,
reportClaudeTerminalAnswers,
settleCancelledClaudePicker,
takeOwedClaudePickerAnswer
} from './claude-question-hooks.js'
import { ApiCallError,type ApiClient } from './client.js'
import { markNativeQuestionsDismissed,type CodexQuestionRegistration } from './codex-question-bindings.js'
import type { CommandDeps } from './commands-core.js'
import { hookRunCommand } from './commands-hook-run.js'
import { registerQuestion } from './hook-lifecycle.js'
import { acquireClaimFile } from './hook-question-lock.js'
import { retirePendings } from './hook-question-retirement.js'
import { beginSessionIncarnation,lifecycleStamp,readSessionState,updateSessionState,writeSessionState } from './hook-session-state.js'
import type { AnsweredPending,HookEnvelope,PendingQuestion,SessionState } from './hook-types.js'
import { createLogger,readLogRecords } from './logging.js'
import { recordConfirmedNativeAnswerTarget } from './native-answer-operation.js'
import { currentProcessIdentity,type ProcessIdentity } from './process-identity.js'
import { disableProject,enableProject,projectBinding,projectEnablementState } from './project-enablement.js'
import { attendantClaimPath,writeAttendantStatus } from './session-attendant-state.js'
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

/** A picker from a host that enables Claude Code's extended schema: a heading, text and number questions, a helper line, previews. */
const DECK = {
  title: 'Deck plan',
  questions: [
    { question: 'What should the deck be called?', header: 'Name', kind: 'text', placeholder: 'Q3 review', options: [], multiSelect: false },
    { question: 'How many slides?', header: 'Length', kind: 'number', description: 'One slide per section.',
      min: 5, max: 20, step: 5, defaultValue: 10, unit: 'slides', options: [], multiSelect: false },
    { question: 'Which layout?', header: 'Layout', kind: 'choice', multiSelect: false,
      options: [{ label: 'Wide', preview: '<wide mockup>' }, { label: 'Classic', description: 'Four by three.', preview: '<classic mockup>' }] },
  ],
}
const FORM = picker([
  { question: 'Which environment?', labels: ['Staging', 'Production'], header: 'Target' },
  { question: 'Which checks should run first?', labels: ['Lint', 'Tests', 'End to end'], multiSelect: true, header: 'Checks' },
])

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })


function setup(options: { signedIn?: boolean; enabled?: boolean; leased?: boolean; host?: ProcessIdentity; hookSource?: number } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-claude-picker-'))
  roots.push(root)
  const owner = options.host ?? currentProcessIdentity()!
  const env: NodeJS.ProcessEnv = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'),
    ...(options.hookSource === undefined ? {} : { NOTIFAI_HOOK_SOURCE_PID: String(options.hookSource) }) }
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
  const stage = (parts: ReplyAnswerT[], questionId = held(), text = 'Staging') => stageReplies([parts], { questionId, text })
  /** Several replies to one question, in the order the device sent them. */
  const stageReplies = (replyParts: ReplyAnswerT[][], options: { questionId?: string; text?: string; claimed?: boolean } = {}) => {
    const questionId = options.questionId ?? held()
    const pending = pendingOf(questionId)!
    const replies = replyParts.map((parts, index) => ({
      reply_id: `rpl_${questionId}_${index + 1}`, seq: index + 1, delivery_id: 'del_test', device_id: 'dev_test', device_name: 'Test',
      text: options.text ?? 'Staging', answers: parts, source: null, created_at: new Date().toISOString(),
    }))
    const answer = { pending, reply: replies[0]!, replies, agent_acknowledgement_required: true,
      ...(options.claimed === false ? {} : { delivery_claim: true as const }) } as unknown as AnsweredPending
    updateSessionState(SESSION, env, (current) => ({
      ...current,
      pending: (current.pending ?? []).filter(entry => entry.question_id !== questionId),
      waiting_answers: [...(current.waiting_answers ?? []), answer],
      acknowledgement_due: [...(current.acknowledgement_due ?? []), { request_id: pending.request_id!, recorded_at: Date.now(), text_required: true }],
    }))
    return answer
  }
  const decision = () => JSON.parse(output[0]!) as {
    hookSpecificOutput: { hookEventName: string; decision: { behavior: string; message?: string; updatedInput: { questions: unknown[]; answers: Record<string, string> } } }
  }
  const context = (index = 0) =>
    (JSON.parse(output[index]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
  return { root, env, deps, output, claims, reports, reported, client, launches, gates, incarnation, logger, attend, state, envelope, held,
    registration, pendingOf, confirm, stage, stageReplies, decision, context }
}

describe('a Claude Code picker as a device question', () => {
  it('keeps short pickers as they are and maps every device id back to the picker', () => {
    const form = pickerForm(pickerQuestions(FORM)!) as PickerForm
    const described = (id: string, label: string) => ({ id, label, description: `Choose ${label}` })
    expect(form.questions).toEqual([
      { id: 'which-environment', text: 'Which environment?', choices: [described('staging', 'Staging'), described('production', 'Production')] },
      { id: 'which-checks-should-run-first', text: 'Which checks should run first?', multi: true,
        choices: [described('lint', 'Lint'), described('tests', 'Tests'), described('end-to-end', 'End to end')] },
    ])
    // The Summary is the first question; the headers name the whole set as its title.
    expect(form.summary).toBe('Which environment?')
    expect(form.title).toBe('Target · Checks')
    expect(pickerHeading({ ...FORM, title: ' Release checks ' })).toBe('Release checks')
    expect(pickerHeading(FORM)).toBeUndefined()
    expect(form.shown[1]).toEqual({ title: 'Which checks should run first?', labels: { lint: 'Lint', tests: 'Tests', 'end-to-end': 'End to end' } })
    // Option descriptions ride on their choices, so nothing needed a Body.
    expect(form.body).toBeUndefined()
  })

  it('refuses only what no device question can carry', () => {
    expect(pickerForm(pickerQuestions(picker([{ question: 'Same?', labels: ['A', 'A'] }]))!)).toEqual({ error: 'duplicate-option' })
    expect(pickerForm(pickerQuestions(picker([{ question: 'One?', labels: ['A'] }]))!)).toEqual({ error: 'unsupported-option-count' })
    expect(pickerForm(pickerQuestions(picker([{ question: 'Q?', labels: ['A', 'B'] }, { question: 'Q?', labels: ['C', 'D'] }]))!))
      .toEqual({ error: 'duplicate-question' })
    // A missing kind is a choice, and a choice needs its options.
    expect(pickerForm(pickerQuestions({ questions: [{ question: 'No options' }] })!)).toEqual({ error: 'unsupported-option-count' })
    expect(pickerForm(pickerQuestions({ questions: [{ question: 'Name?', kind: 'text', options: [{ label: 'A' }, { label: 'B' }] }] })!))
      .toEqual({ error: 'unsupported-option-count' })
    // A kind a later Claude Code adds is not guessed at.
    expect(pickerForm(pickerQuestions({ questions: [{ question: 'When?', kind: 'date' }] })!)).toEqual({ error: 'unsupported-question-kind' })
    expect(pickerQuestions({ questions: [{ question: 'Q?', options: 'A, B' }] })).toBeNull()
    expect(pickerQuestions('not a picker')).toBeNull()
    // The refusal names what to fix, so the agent can open the picker again.
    expect(pickerRefusal('duplicate-option')).toBe("Notifai cannot carry this picker to the User's devices: two options of one question read the same on a device. Fix that and open the picker again.")
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
        // The picker's header is its title; its question is the Summary, never the title.
        expect(h.pendingOf(h.held())).toMatchObject({ question: REWORDED, summary: REWORDED, title: 'Deploy' })
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

  it('carries a text and number picker from a host with the extended schema both ways, titled by its heading', async () => {
    const h = setup()
    const outcome = await claudePermissionRequest(h.deps, h.envelope(DECK), h.logger, {
      sleep: async () => {
        if (h.state().waiting_answers?.length) return
        expect(h.pendingOf(h.held())).toMatchObject({
          title: 'Deck plan', summary: 'What should the deck be called?',
          body: '**How many slides?**\n\nOne slide per section.\n\nA number from 5 to 20 slides, in steps of 5.',
          questions: [{ id: 'what-should-the-deck-be-called' }, { id: 'how-many-slides' }, { id: 'which-layout' }],
        })
        expect(h.pendingOf(h.held())!.questions!.slice(0, 2).map((question) => question.choices)).toEqual([undefined, undefined])
        h.confirm()
        h.stage([{ question_id: 'what-should-the-deck-be-called', text: 'Q3 review' },
          { question_id: 'how-many-slides', text: '15' }, { question_id: 'which-layout', choice_ids: ['wide'] }], h.held(), 'Q3 review')
      },
    })
    expect(outcome).toBe('answered')
    // The typed answers return as the picker's own values; its input goes back exactly as Claude Code sent it.
    const decided = h.decision().hookSpecificOutput.decision.updatedInput
    expect(decided.answers).toEqual({ 'What should the deck be called?': 'Q3 review', 'How many slides?': '15', 'Which layout?': 'Wide' })
    expect({ ...decided, answers: undefined }).toEqual({ ...DECK, answers: undefined })
    const registered = readLogRecords(h.env, { event: ['ask.registered'] }).records.at(-1)!.data
    expect(registered).toMatchObject({ origin: 'picker', kinds: ['text', 'number', 'choice'], has_body: true })

    // In the terminal the slider and the text box answer with strings too.
    expect(claudeTerminalAnswers(h.registration(), { answers: { 'What should the deck be called?': 'Board deck', 'How many slides?': '10', 'Which layout?': 'Classic' } }))
      .toEqual([{ question_id: 'what-should-the-deck-be-called', text: 'Board deck' },
        { question_id: 'how-many-slides', text: '10' }, { question_id: 'which-layout', choice_ids: ['classic'] }])
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

  it('keeps the question open when Claude Code continued the picker while the User was away', async () => {
    const h = setup()
    let signal!: () => void
    const signalled = new Promise<void>((resolve) => { signal = resolve })
    let questionId = ''
    await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      signalled, sleep: async () => { questionId = h.held(); h.confirm(); signal(); await Promise.resolve() },
    })
    // Claude Code auto-continued with "any answers selected so far": not an answer.
    claudePostToolUse(h.deps, h.envelope(ENVIRONMENT, { tool_response: { answers: { [REWORDED]: 'Staging' }, afkTimeoutMs: 60_000 } }), h.logger)
    expect(h.context()).toBe(claudePickerAutoContinued(questionId))
    expect(h.context()).toContain('stays open on their devices')
    expect(h.context()).not.toMatch(/dismiss/i)
    expect(h.state().claude_picker_cancelled).toBeUndefined()
    expect(h.pendingOf(questionId)).toBeDefined()
    expect(h.state().native_answer_operations).toBeUndefined()
    expect(h.state().retiring ?? []).toEqual([])
    expect(h.gates.at(-1)).toMatchObject({ stage: 'picker-auto-continued', reason: 'question-stays-open' })
    // Nothing is left for the owner to withdraw.
    await settleCancelledClaudePicker({ env: h.env, sleep: async () => { throw new Error('settled already') } }, SESSION)
    expect(h.pendingOf(questionId)).toBeDefined()
    // The device answer that comes later takes the ordinary route: no picker holds it.
    expect(claudePickerHolds(h.state())).toBe(false)
    // Claude Code 2.1.308 sends the waiting handler no signal on an auto-continue:
    // the result reaches a picker still held, and the handler then lets go without withdrawing.
    const held = setup()
    const outcome = await claudePermissionRequest(held.deps, held.envelope(), held.logger, {
      sleep: async () => {
        if (questionId !== '' && held.state().claude_picker === undefined) return
        questionId = held.held()
        held.confirm()
        claudePostToolUse(held.deps, held.envelope(ENVIRONMENT, { tool_response: { ...ENVIRONMENT, answers: {}, annotations: {}, afkTimeoutMs: 5_000 } }), held.logger)
      },
    })
    expect(outcome).toBe('left-to-terminal')
    expect(held.context()).toBe(claudePickerAutoContinued(questionId))
    expect(held.pendingOf(questionId)).toBeDefined()
    expect(held.state().retiring ?? []).toEqual([])
    expect(held.gates.at(-1)).toMatchObject({ hook: 'permission-request', stage: 'picker-resolved-elsewhere' })
  })

  it('closes the picker for an answer only the ordinary route may deliver, and keeps that answer queued', async () => {
    const h = setup()
    let questionId = ''
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        questionId = h.held()
        h.confirm()
        h.stageReplies([[{ question_id: h.registration().questions[0]!.question.id, choice_ids: ['staging'] }]], { claimed: false })
      },
    })
    expect(outcome).toBe('closed')
    expect(h.output).toHaveLength(1)
    // The picker closes without an error: Claude Code reports that the User did not answer it there.
    expect(h.decision().hookSpecificOutput).toEqual({
      hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...ENVIRONMENT, answers: {} } },
    })
    expect(CLAUDE_PICKER_ANSWER_FOLLOWS).toBe('Notifai — the user answered this question on their device instead. That answer could not come back through the picker, ' +
      'so it reaches you as your next message. End your turn now and act on the answer when it arrives.')
    expect(h.gates.at(-1)).toMatchObject({ stage: 'answer-needs-ordinary-route', reason: 'answer-follows' })
    // Nothing was written for the answer itself: the ordinary route owns it, once.
    expect(h.claims).toEqual([])
    expect(h.state().claude_picker).toBeUndefined()
    expect(h.state().waiting_answers?.map(answer => answer.pending.question_id)).toEqual([questionId])
    expect(h.state().acknowledgement_due?.map(entry => entry.request_id)).toEqual([`req_${questionId}`])
    expect(h.state().retiring ?? []).toEqual([])
    // The tool result's PostToolUse says why, once.
    h.output.length = 0
    claudePostToolUse(h.deps, h.envelope(ENVIRONMENT, { tool_response: { answers: {} } }), h.logger)
    expect(h.context()).toBe(CLAUDE_PICKER_ANSWER_FOLLOWS)
    expect(h.state().claude_picker_closed).toBeUndefined()
    expect(h.state().native_answer_operations).toBeUndefined()
    // A later turn boundary has no picker to withdraw and leaves the answer alone.
    closeClaudePicker(h.deps, SESSION, h.logger)
    expect(h.state().waiting_answers).toHaveLength(1)
  })

  it('closes the picker and says so when the User dismisses its question on a device', async () => {
    const h = setup()
    let questionId = ''
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        if (questionId !== '') return
        questionId = h.held()
        h.confirm()
        // What the question's owner does when the service closed its window early with no reply.
        const pending = h.pendingOf(questionId)!
        updateSessionState(SESSION, h.env, state => markNativeQuestionsDismissed(state, new Set([questionId])))
        await retirePendings({ env: h.env } as never, h.envelope(), SESSION, [pending], 'expired')
      },
    })
    expect(outcome).toBe('closed')
    expect(h.output).toHaveLength(1)
    expect(h.decision().hookSpecificOutput).toEqual({
      hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...ENVIRONMENT, answers: {} } },
    })
    expect(CLAUDE_PICKER_DISMISSED).toBe('Notifai — this question has expired, so it will not be answered. Carry on without an answer to it.')
    expect(h.gates.at(-1)).toMatchObject({ stage: 'question-expired', reason: 'expired' })
    expect(h.state().claude_picker).toBeUndefined()
    expect(h.state().retiring).toEqual([expect.objectContaining({ request_id: `req_${questionId}`, state: 'expired' })])
    // Should PostToolUse never run, the next prompt carries why, once.
    expect(takeOwedClaudePickerAnswer(SESSION, h.env)).toBe(CLAUDE_PICKER_DISMISSED)
    expect(takeOwedClaudePickerAnswer(SESSION, h.env)).toBeNull()

    // A window that simply ran out is not a dismissal: the terminal can still answer.
    const expired = setup()
    expect(await claudePermissionRequest(expired.deps, expired.envelope(), expired.logger, {
      sleep: async () => {
        expired.confirm()
        await retirePendings({ env: expired.env } as never, expired.envelope(), SESSION, [expired.pendingOf(expired.held())!], 'expired')
      },
    })).toBe('left-to-terminal')
    expect(expired.output).toEqual([])
    expect(expired.gates.at(-1)).toMatchObject({ stage: 'question-settled' })
  })

  it('links a picker in a Project with no record, and leaves it to the terminal only in a disabled one', async () => {
    const unset = setup({ enabled: false })
    expect(await claudePermissionRequest(unset.deps, unset.envelope(), unset.logger,
      { sleep: async () => { closeClaudePicker(unset.deps, SESSION, unset.logger) } })).toBe('left-to-terminal')
    expect(unset.gates.map(gate => gate['stage'])).toContain('picker-waiting')
    // A harness's own form is no request for Notifai: the Project stays as it was.
    expect(projectEnablementState(projectBinding(unset.root, unset.env))).toBe('unset')

    const h = setup()
    disableProject(projectBinding(h.root, h.env)!)
    expect(await claudePermissionRequest(h.deps, h.envelope(), h.logger)).toBe('not-bound')
    expect(h.gates).toEqual([expect.objectContaining({ stage: 'picker-terminal-only', reason: 'project-disabled' })])
    expect(h.state().pending).toBeUndefined()
    expect(h.launches).toEqual([])
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

describe('the picker `ask --wait` hands back', () => {
  const QUESTION = {
    id: 'which-environment', text: REWORDED,
    choices: [{ id: 'staging', label: 'Staging', description: 'A safe rehearsal.' }, { id: 'production', label: 'Production', recommended: true }],
  }
  /** What `ask --wait` does on Claude Code: register at once, then hand back the picker that asks it. */
  function handBack(h: ReturnType<typeof setup>): { questionId: string; input: ClaudePickerInput } {
    const asked = registerQuestion(SESSION, h.env, { question: REWORDED, title: 'Deploy target', summary: REWORDED, body: 'Why it matters.',
      service_identity: SERVICE, questions: [QUESTION] })
    h.confirm(asked.question_id)
    updateSessionState(SESSION, h.env, state => recordHandBack(state, asked.question_id, Date.now()))
    return { questionId: asked.question_id, input: handBackInput(h.pendingOf(asked.question_id)!)! }
  }
  const denial = (h: ReturnType<typeof setup>) => h.decision().hookSpecificOutput.decision

  it('binds the picker to the registration `ask` made and returns the device answer as the picker result', async () => {
    const h = setup()
    const { questionId, input } = handBack(h)
    const outcome = await claudePermissionRequest(h.deps, h.envelope(input), h.logger, {
      sleep: async () => {
        if (h.state().waiting_answers?.length) return
        expect(h.held()).toBe(questionId)
        h.stage([{ question_id: QUESTION.id, choice_ids: ['production'] }], questionId)
      },
    })
    expect(outcome).toBe('answered')
    expect(denial(h)).toMatchObject({ behavior: 'allow', updatedInput: { answers: { [REWORDED]: 'Production (Recommended)' } } })
    expect(h.gates.map(gate => gate['stage'])).toEqual(['picker-handback-linked', 'picker-waiting', 'picker-answered'])
    // Nothing new was registered: the picker carries the question `ask` made, Body and title included.
    expect(h.state().codex_question_bindings!.map(item => item.question_id)).toEqual([questionId])
    expect(h.state().claude_handbacks).toBeUndefined()
    // The marked label the User may pick in the terminal is the recommended choice.
    expect(claudeTerminalAnswers(h.registration(questionId), { answers: { [REWORDED]: 'Production (Recommended)' } }))
      .toEqual([{ question_id: QUESTION.id, choice_ids: ['production'] }])
  })

  it('refuses a reworded picker that names the hand-back, and leaves the registration as it was', async () => {
    const h = setup()
    const { questionId, input } = handBack(h)
    const reworded = { ...input, questions: [{ ...input.questions[0]!, question: 'Where should this deploy go?' }] }
    expect(await claudePermissionRequest(h.deps, h.envelope(reworded), h.logger)).toBe('refused')
    expect(h.output).toHaveLength(1)
    expect(denial(h)).toEqual({ behavior: 'deny', message: `This is not the question \`notifai ask\` handed back (\`${questionId}\`). ` +
      `To ask that one, open exactly this input: ${JSON.stringify(input)}. For a different question, run \`notifai ask\` for it. ` +
      `If you no longer need \`${questionId}\`, run \`notifai close ${questionId}\`.` })
    expect(h.gates).toEqual([expect.objectContaining({ stage: 'picker-refused', reason: 'handback-mismatch', question_ids: [questionId] })])
    expect(h.pendingOf(questionId)).toBeDefined()
    expect(h.state().codex_question_bindings).toBeUndefined()
    expect(h.state().claude_picker).toBeUndefined()
    expect(h.state().claude_handbacks?.map(entry => entry.question_id)).toEqual([questionId])
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
})


it.each([
  ['A', 'B'].map(end => 'The same very long option label repeated until its ending ' + end),
  ['Same  label', 'Same label'], ['Go (Recommended)', 'Go'],
])('keeps distinct Claude labels through shortening and normalization: %j', async (...labels) => {
  const input = picker([{ question: 'Which?', labels }])
  const built = pickerForm(pickerQuestions(input)!)
  expect(built).not.toHaveProperty('error')
  if ('error' in built) return
  const choices = built.questions[0]!.choices!
  expect(new Set(choices.map(choice => choice.label)).size).toBe(labels.length)
  expect(choices.every(choice => [...choice.label].length <= 40)).toBe(true)
  expect(Object.values(built.shown[0]!.labels)).toEqual(labels)
  const h = setup()
  const outcome = await claudePermissionRequest(h.deps, h.envelope(input), h.logger, {
    sleep: async () => {
      if (h.state().waiting_answers?.length) return
      h.confirm()
      h.stage([{ question_id: built.questions[0]!.id, choice_ids: [choices[1]!.id] }])
    },
  })
  expect(outcome).toBe('answered')
  expect(h.decision().hookSpecificOutput.decision).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which?': labels[1] } } })
})
