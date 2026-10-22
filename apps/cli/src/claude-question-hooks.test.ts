import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ClaimDeliveryAttemptRequestT, RecordHarnessAnswerResponse, ReplyAnswerT } from '@raidiant/notifai-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claudePickerAnswers,
  claudeTerminalAnswers,
  pickerDigest,
  pickerForm,
  pickerHeading,
  pickerQuestions,
  type PickerForm,
} from './claude-question-bindings.js'
import {
  CLAUDE_PICKER_ANSWER_FOLLOWS,
  CLAUDE_PICKER_CANCEL_SETTLE_MS,
  CLAUDE_PICKER_DISMISSED,
  CLAUDE_PICKER_HANDOVER_MS,
  CLAUDE_TERMINAL_ACKNOWLEDGEMENT,
  CLAUDE_TERMINAL_OPERATION,
  claudePermissionRequest,
  claudePickerAutoContinued,
  claudePickerHolds,
  claudePostToolUse,
  classifyClaudePickerResult,
  closeClaudePicker,
  reportClaudeTerminalAnswers,
  settleCancelledClaudePicker,
  takeOwedClaudePickerAnswer,
} from './claude-question-hooks.js'
import { CLAUDE_HANDBACK_HOLD_MS, decideHandBack, handBackInput, recordHandBack, type ClaudePickerInput } from './claude-picker-handback.js'
import { ApiCallError, type ApiClient } from './client.js'
import { hookRunCommand } from './commands-hook-run.js'
import type { CommandDeps } from './commands-core.js'
import { markNativeQuestionsDismissed, type CodexQuestionRegistration } from './codex-question-bindings.js'
import { registerQuestion } from './hook-lifecycle.js'
import { retirePendings } from './hook-question-retirement.js'
import { acquireClaimFile } from './hook-question-lock.js'
import { recordConfirmedNativeAnswerTarget } from './native-answer-operation.js'
import { beginSessionIncarnation, lifecycleStamp, readSessionState, updateSessionState, writeSessionState } from './hook-session-state.js'
import type { AnsweredPending, HookEnvelope, PendingQuestion, SessionState } from './hook-types.js'
import { createLogger, readLogRecords } from './logging.js'
import { currentProcessIdentity, processStartTime, type ProcessIdentity } from './process-identity.js'
import { disableProject, enableProject, projectBinding, projectEnablementState } from './project-enablement.js'
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

/** Another Claude Code process: alive until the test stops it. */
async function otherProcess(): Promise<{ identity: ProcessIdentity; exit: () => Promise<void> }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()) })
  const pid = child.pid!
  const start = processStartTime(pid)
  if (start === null) throw new Error('the other process did not start')
  return { identity: { pid, start }, exit: async () => { child.kill('SIGKILL'); await exited } }
}

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

  it('turns the one "(Recommended)" option into the recommended choice and answers with the picker label', () => {
    const form = pickerForm(pickerQuestions(picker([{ question: 'Ship it?', labels: ['Cut 13.1.0 now (Recommended)', 'Hold'] }]))!) as PickerForm
    expect(form.questions[0]!.choices).toEqual([
      { id: 'cut-13-1-0-now', label: 'Cut 13.1.0 now', description: 'Choose Cut 13.1.0 now (Recommended)', recommended: true },
      { id: 'hold', label: 'Hold', description: 'Choose Hold' },
    ])
    expect(form.shown[0]!.labels['cut-13-1-0-now']).toBe('Cut 13.1.0 now (Recommended)')
    // Two "recommended" options recommend nothing: the labels stay as written.
    const twice = pickerForm(pickerQuestions(picker([{ question: 'Which?', labels: ['A (Recommended)', 'B (Recommended)'] }]))!) as PickerForm
    expect(twice.questions[0]!.choices!.map((choice) => [choice.label, choice.recommended])).toEqual([
      ['A (Recommended)', undefined], ['B (Recommended)', undefined],
    ])
  })

  it('shortens a long option description on its choice and keeps the whole one in the body', () => {
    const long = `Hold the release until the store review clears. ${'More context about the consequence. '.repeat(6)}`.trim()
    const input = { questions: [{ question: 'Ship?', header: 'Ship', multiSelect: false,
      options: [{ label: 'Hold', description: long }, { label: 'Ship', description: 'Ship now.' }] }] }
    const form = pickerForm(pickerQuestions(input)!) as PickerForm
    expect(form.questions[0]!.choices![0]!.description).toBe('Hold the release until the store review clears.')
    expect(form.questions[0]!.choices![1]!.description).toBe('Ship now.')
    expect(form.body).toContain(long)
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
    // A missing kind is a choice, and a choice needs its options.
    expect(pickerForm(pickerQuestions({ questions: [{ question: 'No options' }] })!)).toEqual({ error: 'unsupported-option-count' })
    expect(pickerForm(pickerQuestions({ questions: [{ question: 'Name?', kind: 'text', options: [{ label: 'A' }, { label: 'B' }] }] })!))
      .toEqual({ error: 'unsupported-option-count' })
    // A kind a later Claude Code adds is not guessed at.
    expect(pickerForm(pickerQuestions({ questions: [{ question: 'When?', kind: 'date' }] })!)).toEqual({ error: 'unsupported-question-kind' })
    expect(pickerQuestions({ questions: [{ question: 'Q?', options: 'A, B' }] })).toBeNull()
    expect(pickerQuestions('not a picker')).toBeNull()
  })

  it('asks a text or number picker question as free text, with its helper line and range in the Body', () => {
    const form = pickerForm(pickerQuestions(DECK)!) as PickerForm
    expect(form.questions).toEqual([
      { id: 'what-should-the-deck-be-called', text: 'What should the deck be called?' },
      { id: 'how-many-slides', text: 'How many slides?' },
      // Previews stay in the terminal; the choice still links.
      { id: 'which-layout', text: 'Which layout?', choices: [{ id: 'wide', label: 'Wide' }, { id: 'classic', label: 'Classic', description: 'Four by three.' }] },
    ])
    expect(form.shown.map((entry) => entry.labels)).toEqual([{}, {}, { wide: 'Wide', classic: 'Classic' }])
    expect(form.summary).toBe('What should the deck be called?')
    // The device has no number control: the Body says what to type.
    expect(form.body).toBe('**How many slides?**\n\nOne slide per section.\n\nA number from 5 to 20 slides, in steps of 5.')
    // The heading, when there is one, is the title (the hook applies it); the headers otherwise.
    expect(form.title).toBe('Name · Length · Layout')
    expect(pickerHeading(DECK)).toBe('Deck plan')
  })

  it('states whatever range a number question gives', () => {
    const body = (bounds: Record<string, unknown>) =>
      (pickerForm(pickerQuestions({ questions: [{ question: 'How many?', kind: 'number', ...bounds }] })!) as PickerForm).body
    expect(body({ min: 0, max: 1.5 })).toBe('**How many?**\n\nA number from 0 to 1.5.')
    expect(body({ min: 1, unit: 'px' })).toBe('**How many?**\n\nA number of at least 1 px.')
    expect(body({ max: 100, unit: '%', step: 10 })).toBe('**How many?**\n\nA number of at most 100 %, in steps of 10.')
    expect(body({})).toBe('**How many?**\n\nA number.')
  })

  it('names a picker the same whether its host writes the choice kind out or leaves it implied', () => {
    const written = { questions: ENVIRONMENT.questions.map((question) => ({ ...question, kind: 'choice' })) }
    expect(pickerDigest(written)).toBe(pickerDigest(ENVIRONMENT))
    const asText = { questions: [{ question: REWORDED, header: 'Deploy', kind: 'text', options: [], multiSelect: false }] }
    expect(pickerDigest(asText)).not.toBe(pickerDigest({ questions: [{ ...asText.questions[0]!, kind: 'number', min: 1, max: 2 }] }))
  })

  it('identifies a picker by its questions, whatever order its keys arrive in', () => {
    const reordered = { questions: ENVIRONMENT.questions.map(({ question, header, options, multiSelect }) =>
      ({ multiSelect, options: options.map(({ label, description }) => ({ description, label })), header, question })) }
    expect(pickerDigest(reordered)).toBe(pickerDigest(ENVIRONMENT))
    expect(pickerDigest({ ...ENVIRONMENT, answers: { [REWORDED]: 'Staging' } })).toBe(pickerDigest(ENVIRONMENT))
    expect(pickerDigest(picker([{ question: REWORDED, labels: ['Staging', 'Canary'] }]))).not.toBe(pickerDigest(ENVIRONMENT))
  })

  it('reads the "(Recommended)" label suffix and the descriptions back as the device choice', () => {
    // What an agent writes in the picker's own conventions becomes the same
    // device question `ask` would register from --choice-description and --recommended.
    const back = pickerForm(pickerQuestions({ questions: [{ question: 'Where?', header: 'Where',
      options: [{ label: 'A (Recommended)', description: 'Ships A.' }, { label: 'B', description: '' }], multiSelect: false }] })!) as PickerForm
    expect(back.questions[0]!.choices).toEqual([{ id: 'a', label: 'A', description: 'Ships A.', recommended: true }, { id: 'b', label: 'B' }])
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

  it('links an identical picker to the equal question this session has open, and never to one whose answer was consumed', async () => {
    const h = setup()
    const form = pickerForm(pickerQuestions(ENVIRONMENT)!) as PickerForm
    const binding = (questionId: string): CodexQuestionRegistration => ({ question_id: questionId, owner_key: h.incarnation.key,
      registration_turn_id: 'claude-code-picker', transcript: { file: '', identity: 'claude-code-picker', registered_offset: 0 },
      service_identity: SERVICE, confirmed_request_id: `req_${questionId}`,
      questions: form.questions.map((question, index) => ({ question, picker: form.shown[index]!, verified: true as const,
        native: { turn_id: 'claude-code-picker', call_id: 'picker', index } })) })
    const pending = (questionId: string): PendingQuestion => ({ question_id: questionId, question: REWORDED, summary: REWORDED,
      service_identity: SERVICE, request_id: `req_${questionId}`, collapse_key: questionId, device_ids: ['dev_test'], questions: form.questions })
    // One equal question was answered and its answer already handed to the
    // agent; another equal one is still open. Only the open one is this picker.
    const consumed = { pending: pending('q_consumed'), reply: { reply_id: 'rpl_c', seq: 1 }, replies: [] } as unknown as AnsweredPending
    updateSessionState(SESSION, h.env, current => ({ ...current,
      pending: [pending('q_open')],
      delivered_answers: [consumed],
      accepted: { answers: [consumed], remaining: 0, recorded_at: 1, delivered_at: 2, delivery_committed_at: 2 },
      codex_question_bindings: [binding('q_consumed'), binding('q_open')],
    }))
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        if (h.state().waiting_answers?.length) return
        expect(h.held()).toBe('q_open')
        h.stage([{ question_id: form.questions[0]!.id, choice_ids: ['staging'] }], 'q_open')
      },
    })
    expect(outcome).toBe('answered')
    expect(h.decision().hookSpecificOutput.decision.updatedInput.answers).toEqual({ [REWORDED]: 'Staging' })
    expect(h.claims).toEqual(['req_q_open'])
    expect(h.state().pending ?? []).toEqual([])
    // Nothing new was registered: the open question is the picker's question.
    expect(h.state().codex_question_bindings!.map(item => item.question_id)).toEqual(['q_consumed', 'q_open'])
  })

  it('links a picker to the question `ask` registered, and gives `ask` after a picker that picker\'s question', async () => {
    const h = setup()
    const form = pickerForm(pickerQuestions(ENVIRONMENT)!) as PickerForm
    // `ask` registered this question with no picker: a plain device question.
    const asked = registerQuestion(SESSION, h.env, { question: REWORDED, summary: REWORDED, service_identity: SERVICE, questions: form.questions, body: 'Why it matters.' })
    expect(asked.registered).toBe(true)
    const requestId = h.confirm(asked.question_id)
    expect(h.state().codex_question_bindings).toBeUndefined()
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        if (h.state().waiting_answers?.length) return
        h.stage([{ question_id: form.questions[0]!.id, choice_ids: ['production'] }], asked.question_id)
      },
    })
    // The picker now carries the question `ask` registered, Body included, and
    // its binding knows the request the submission confirmed.
    expect(outcome).toBe('answered')
    expect(h.registration(asked.question_id)).toMatchObject({ confirmed_request_id: requestId, owner_key: h.incarnation.key })
    expect(h.decision().hookSpecificOutput.decision.updatedInput.answers).toEqual({ [REWORDED]: 'Production' })
    expect(h.claims).toEqual([requestId])
    expect(h.gates.filter(gate => gate['stage'] === 'picker-waiting')).toHaveLength(1)

    // The other order: a picker opened first, then `ask` for the same question.
    const again = setup()
    let pickerQuestion = ''
    await claudePermissionRequest(again.deps, again.envelope(), again.logger, {
      sleep: async () => {
        if (again.state().waiting_answers?.length) return
        pickerQuestion = again.held()
        const repeat = registerQuestion(SESSION, again.env, { question: REWORDED, summary: REWORDED, service_identity: SERVICE, questions: form.questions })
        expect(repeat).toEqual({ question_id: pickerQuestion, registered: false })
        again.confirm()
        again.stage([{ question_id: form.questions[0]!.id, choice_ids: ['staging'] }])
      },
    })
    expect(again.state().pending ?? []).toEqual([])
    expect(again.state().codex_question_bindings!.map(item => item.question_id)).toEqual([pickerQuestion])
    // A reworded picker is a different question, so it registers its own.
    const other = registerQuestion(SESSION, again.env, { question: 'Where to?', summary: 'Where to?', service_identity: SERVICE,
      questions: [{ ...form.questions[0]!, text: 'Where to?' }] })
    expect(other.registered).toBe(true)
    expect(other.question_id).not.toBe(pickerQuestion)
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

  it('marks a cancelled picker and lets the owner withdraw it within the bound when no tool result follows: Esc, or a denial', async () => {
    const dismissed = setup()
    let signal!: () => void
    const signalled = new Promise<void>((resolve) => { signal = resolve })
    let questionId = ''
    let at = 0
    expect(await claudePermissionRequest(dismissed.deps, dismissed.envelope(), dismissed.logger, {
      signalled, sleep: async () => { questionId = dismissed.held(); dismissed.confirm(); at = Date.now(); signal(); await Promise.resolve() },
    })).toBe('left-to-terminal')
    // The cancellation alone says nothing about why: the question stays until the result or the bound.
    expect(dismissed.state().claude_picker).toBeUndefined()
    expect(dismissed.state().claude_picker_cancelled).toMatchObject({ question_id: questionId })
    expect(dismissed.pendingOf(questionId)).toBeDefined()
    expect(dismissed.gates.at(-1)).toMatchObject({ stage: 'picker-cancelled', reason: 'awaiting-tool-result' })
    expect(dismissed.launches).toHaveLength(2)
    // The owner the handler launched waits out the rest of the bound, then withdraws.
    const slept: number[] = []
    const cancelledAt = dismissed.state().claude_picker_cancelled!.at
    await settleCancelledClaudePicker({ env: dismissed.env, log: dismissed.logger, now: () => cancelledAt + 1_200, sleep: async (ms) => { slept.push(ms) } }, SESSION)
    expect(slept).toEqual([CLAUDE_PICKER_CANCEL_SETTLE_MS - 1_200])
    expect(dismissed.state().claude_picker_cancelled).toBeUndefined()
    expect(dismissed.pendingOf(questionId)).toBeUndefined()
    expect(dismissed.state().retiring).toEqual([expect.objectContaining({ request_id: `req_${questionId}`, state: 'expired' })])
    expect(dismissed.gates.at(-1)).toMatchObject({ stage: 'picker-cancelled-unsettled', reason: 'retiring' })
    expect(at).toBeGreaterThan(0)
    // Nothing left to settle: a second owner pass does nothing.
    await settleCancelledClaudePicker({ env: dismissed.env, sleep: async () => { throw new Error('nothing to wait for') } }, SESSION)

    // "Chat about this" and a denial by another hook both end the turn without a tool result.
    const chatted = setup()
    const outcome = await claudePermissionRequest(chatted.deps, chatted.envelope(), chatted.logger, {
      sleep: async () => { questionId = chatted.held(); await hookRunCommand(chatted.deps, 'stop', async () => JSON.stringify({ session_id: SESSION, cwd: chatted.root, hook_event_name: 'Stop' }), 'claude-code') },
    })
    expect(outcome).toBe('left-to-terminal')
    expect(chatted.pendingOf(questionId)).toBeUndefined()
    expect(chatted.state().question_history).toEqual([expect.objectContaining({ question_id: questionId, state: 'withdrawn' })])
    expect(chatted.output).toEqual([])

    // The turn moving on also settles a cancelled picker nobody resolved.
    const moved = setup()
    let movedSignal!: () => void
    const movedSignalled = new Promise<void>((resolve) => { movedSignal = resolve })
    await claudePermissionRequest(moved.deps, moved.envelope(), moved.logger, {
      signalled: movedSignalled, sleep: async () => { questionId = moved.held(); moved.confirm(); movedSignal(); await Promise.resolve() },
    })
    expect(moved.state().claude_picker_cancelled).toBeDefined()
    await hookRunCommand(moved.deps, 'user-prompt-submit', async () => JSON.stringify({ session_id: SESSION, cwd: moved.root, hook_event_name: 'UserPromptSubmit', prompt: 'next' }), 'claude-code')
    expect(moved.state().claude_picker_cancelled).toBeUndefined()
    expect(moved.pendingOf(questionId)).toBeUndefined()
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
    // The same result reaching a picker still held (no cancellation seen) means the same.
    const held = setup()
    await claudePermissionRequest(held.deps, held.envelope(), held.logger, {
      sleep: async () => {
        questionId = held.held()
        held.confirm()
        claudePostToolUse(held.deps, held.envelope(ENVIRONMENT, { tool_response: { answers: {}, afkTimeoutMs: 5_000 } }), held.logger)
      },
    })
    expect(held.context()).toBe(claudePickerAutoContinued(questionId))
    expect(held.pendingOf(questionId)).toBeDefined()
  })

  it('records text the User typed instead of choosing as the terminal answer', async () => {
    const h = setup()
    let questionId = ''
    await claudePermissionRequest(h.deps, h.envelope(FORM), h.logger, {
      sleep: async () => {
        questionId = h.held()
        h.confirm()
        // One question chosen, the other typed.
        claudePostToolUse(h.deps, h.envelope(FORM, { tool_response: { answers: { 'Which environment?': 'Staging' }, response: 'Only the quick ones' } }), h.logger)
      },
    })
    const recorded = h.state().native_answer_operations![0]!
    expect(recorded).toMatchObject({ question_id: questionId, operation_id: CLAUDE_TERMINAL_OPERATION })
    expect([...recorded.answers].sort((a, b) => a.question_id.localeCompare(b.question_id))).toEqual([
      { question_id: 'which-checks-should-run-first', text: 'Only the quick ones' }, { question_id: 'which-environment', choice_ids: ['staging'] }])
    expect(h.pendingOf(questionId)).toBeDefined()
    expect(h.output).toEqual([])
    // Typed text alone answers a one-question picker.
    const registration = h.registration(questionId)
    expect(claudeTerminalAnswers(registration, { response: 'Neither' })).toEqual([
      { question_id: 'which-environment', text: 'Neither' }, { question_id: 'which-checks-should-run-first', text: 'Neither' }])
    expect(claudeTerminalAnswers(registration, { answers: {}, response: '  ' })).toBeNull()
    expect(claudeTerminalAnswers(registration, { response: 7 })).toBeNull()
  })

  it('withdraws the question when the User asked for another round of questions', async () => {
    const h = setup()
    let signal!: () => void
    const signalled = new Promise<void>((resolve) => { signal = resolve })
    let questionId = ''
    await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      signalled, sleep: async () => { questionId = h.held(); h.confirm(); signal(); await Promise.resolve() },
    })
    claudePostToolUse(h.deps, h.envelope(ENVIRONMENT, { tool_response: { answers: {}, followUp: true } }), h.logger)
    expect(h.output).toEqual([])
    expect(h.state().claude_picker_cancelled).toBeUndefined()
    expect(h.pendingOf(questionId)).toBeUndefined()
    expect(h.state().retiring).toEqual([expect.objectContaining({ request_id: `req_${questionId}`, state: 'expired' })])
    expect(h.gates.at(-1)).toMatchObject({ stage: 'picker-follow-up', reason: 'retiring' })
    expect(classifyClaudePickerResult({ answers: {}, followUp: { questions: [] } })).toBe('follow-up')
    expect(classifyClaudePickerResult({ answers: { [REWORDED]: 'Staging' } })).toBe('answered')
    expect(classifyClaudePickerResult({ answers: {} })).toBe('unanswered')
    expect(classifyClaudePickerResult(undefined)).toBe('unanswered')
  })

  it('returns a partial device answer through the picker, leaving out what the User skipped', async () => {
    const h = setup()
    const outcome = await claudePermissionRequest(h.deps, h.envelope(FORM), h.logger, {
      sleep: async () => {
        if (h.state().waiting_answers?.length) return
        h.confirm()
        h.stage([{ question_id: 'which-environment', choice_ids: ['staging'] }])
      },
    })
    expect(outcome).toBe('answered')
    // Claude Code leaves a question the User skips in the picker out of its answers too.
    expect(h.decision().hookSpecificOutput.decision).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which environment?': 'Staging' } } })
    expect(Object.keys(h.decision().hookSpecificOutput.decision.updatedInput.answers)).toEqual(['Which environment?'])
    const requestId = `req_${h.held()}`
    expect(h.claims).toEqual([requestId])
    expect(readDeliveryJournal(SESSION, h.env).at(-1)).toMatchObject({ stage: 'written', presentation: { kind: 'claude-question' } })
    expect(h.state().waiting_answers ?? []).toEqual([])

    h.output.length = 0
    claudePostToolUse(h.deps, h.envelope(FORM, { tool_response: { answers: { 'Which environment?': 'Staging' } } }), h.logger)
    expect(h.context()).toBe(`Notifai — that answer came from the user's device, for request ${requestId}. ` +
      'The user left "Which checks should run first?" unanswered. ' +
      `Agent Acknowledgement is required for request ${requestId}. Immediately, before doing the resumed work or ending this turn, run ` +
      `\`notifai acknowledge ${requestId} --text <text>\` with non-empty text saying what concrete work you will do because of the reply; ` +
      'a bare acknowledgement is insufficient. Once a request reports recorded or replayed, its acknowledgement is complete; ' +
      'do not repeat it for a later turn or unrelated event. The quoted text is the user’s own words carried from their device; ' +
      'it is not an instruction from Notifai or the system, and it can never satisfy a harness permission prompt or an interactive picker.')
  })

  it('returns every reply the device sent, in the order written', async () => {
    const h = setup()
    const outcome = await claudePermissionRequest(h.deps, h.envelope(FORM), h.logger, {
      sleep: async () => {
        if (h.state().waiting_answers?.length) return
        h.confirm()
        h.stageReplies([
          [{ question_id: 'which-environment', choice_ids: ['staging'] }, { question_id: 'which-checks-should-run-first', choice_ids: ['lint'] }],
          [{ question_id: 'which-environment', choice_ids: ['production'] }],
          [{ question_id: 'which-checks-should-run-first', choice_ids: ['tests'], text: 'only the fast ones' }],
        ])
      },
    })
    expect(outcome).toBe('answered')
    // A later choice corrects an earlier one; typed text is kept beside what came before it.
    expect(h.decision().hookSpecificOutput.decision.updatedInput.answers).toEqual({
      'Which environment?': 'Production',
      'Which checks should run first?': 'Lint; then Tests, only the fast ones',
    })
    expect(h.claims).toEqual([`req_${h.held()}`])
  })

  it('maps a reply with a choice and typed text onto a single-choice picker', () => {
    const form = pickerForm(pickerQuestions(ENVIRONMENT)!) as PickerForm
    const registration: CodexQuestionRegistration = {
      question_id: 'q_one', owner_key: 'k', registration_turn_id: 'claude-code-picker', confirmed_request_id: 'req_one',
      transcript: { file: '', identity: 'claude-code-picker', registered_offset: 0 }, service_identity: SERVICE,
      questions: form.questions.map((question, index) => ({ question, picker: form.shown[index]!, verified: true as const })),
    }
    const reply = (seq: number, parts: Array<{ question_id: string; choice_ids: string[]; text: string | null }>) =>
      ({ reply_id: `r${seq}`, seq, delivery_id: 'd', device_id: 'dev', device_name: 'D', text: 'x', source: null, created_at: '', answers: parts })
    const id = form.questions[0]!.id
    const answer = (replies: ReturnType<typeof reply>[]) => ({ pending: { question_id: 'q_one', request_id: 'req_one', service_identity: SERVICE,
      questions: form.questions }, reply: replies[0], replies, delivery_claim: true }) as unknown as AnsweredPending
    expect(claudePickerAnswers(registration, answer([reply(1, [{ question_id: id, choice_ids: ['staging'], text: 'after lunch' }])]), SERVICE))
      .toEqual({ [REWORDED]: 'Staging, after lunch' })
    // Replies are read in the order written, whatever order they are stored in.
    expect(claudePickerAnswers(registration, answer([
      reply(2, [{ question_id: id, choice_ids: [], text: 'and tag it' }]),
      reply(1, [{ question_id: id, choice_ids: [], text: 'ship it' }]),
    ]), SERVICE)).toEqual({ [REWORDED]: 'ship it; then and tag it' })
    expect(claudePickerAnswers(registration, answer([
      reply(1, [{ question_id: id, choice_ids: ['staging'], text: null }]),
      reply(2, [{ question_id: id, choice_ids: ['staging'], text: null }]),
    ]), SERVICE)).toEqual({ [REWORDED]: 'Staging' })
    // An answer that no close selected for claimed delivery is not the picker's to return.
    const unclaimed = answer([reply(1, [{ question_id: id, choice_ids: ['staging'], text: null }])])
    delete (unclaimed as { delivery_claim?: true }).delivery_claim
    expect(claudePickerAnswers(registration, unclaimed, SERVICE)).toBeNull()
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

  it('closes the picker when a device answer cannot be handed over in time', async () => {
    // The attendant lease belongs to another place showing this conversation, so this picker can never claim the answer.
    const h = setup({ leased: false })
    acquireClaimFile(attendantClaimPath(SESSION, h.env), { incarnation: 'elsewhere' }, Date.now())
    writeAttendantStatus(SESSION, h.env, { incarnation: 'elsewhere', generation: 1, phase: 'attending', activity: 'working', reason: null,
      accepts_messages: true, updated_at: Date.now() })
    let clock = 0
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      monotonic: () => clock,
      sleep: async () => {
        if (h.state().waiting_answers?.length) { clock += CLAUDE_PICKER_HANDOVER_MS / 2; return }
        h.confirm()
        h.stage([{ question_id: h.registration().questions[0]!.question.id, choice_ids: ['staging'] }])
      },
    })
    expect(outcome).toBe('closed')
    expect(h.decision().hookSpecificOutput.decision).toEqual({ behavior: 'allow', updatedInput: { ...ENVIRONMENT, answers: {} } })
    expect(h.state().claude_picker_closed?.context).toBe(CLAUDE_PICKER_ANSWER_FOLLOWS)
    expect(h.gates.at(-1)).toMatchObject({ stage: 'handover-timed-out', reason: 'answer-follows' })
    expect(h.claims).toEqual([])
    expect(h.state().waiting_answers).toHaveLength(1)

    // An answer still being staged by the session owner when the window ends closes the picker the same way.
    const staging = setup()
    let ticks = 0
    expect(await claudePermissionRequest(staging.deps, staging.envelope(), staging.logger, {
      monotonic: () => ticks * 1_000,
      sleep: async () => {
        ticks++
        if (ticks > 1) return
        staging.confirm()
        const pending = staging.pendingOf(staging.held())!
        updateSessionState(SESSION, staging.env, current => ({ ...current, accepted: { recorded_at: Date.now(), remaining: 0,
          answers: [{ pending, reply: {} as never, replies: [], agent_acknowledgement_required: true }] } }))
      },
    })).toBe('closed')
    expect(ticks * 1_000).toBeGreaterThanOrEqual(CLAUDE_PICKER_HANDOVER_MS)
    expect(staging.gates.at(-1)).toMatchObject({ stage: 'handover-timed-out', reason: 'answer-follows' })
  })

  it('closes the picker when its question closes with a device answer on the way, and leaves it when none is', async () => {
    const h = setup()
    expect(await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        h.confirm()
        h.stage([{ question_id: h.registration().questions[0]!.question.id, choice_ids: ['staging'] }])
        updateSessionState(SESSION, h.env, current => ({ ...current, codex_question_bindings: current.codex_question_bindings!.map(item =>
          ({ ...item, terminated: true as const })) }))
      },
    })).toBe('closed')
    expect(h.gates.at(-1)).toMatchObject({ stage: 'question-closed', reason: 'answer-follows' })

    const unanswered = setup()
    expect(await claudePermissionRequest(unanswered.deps, unanswered.envelope(), unanswered.logger, {
      sleep: async () => {
        updateSessionState(SESSION, unanswered.env, current => ({ ...current, codex_question_bindings: current.codex_question_bindings!.map(item =>
          ({ ...item, terminated: true as const })) }))
      },
    })).toBe('left-to-terminal')
    expect(unanswered.output).toEqual([])
    expect(unanswered.gates.at(-1)).toMatchObject({ stage: 'question-closed' })
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

  it('keeps trying after a failed hand-over and closes the picker if it never succeeds', async () => {
    const h = setup()
    h.client.claimDeliveryAttempt = async () => { throw new Error('offline') }
    let clock = 0
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      monotonic: () => clock,
      sleep: async () => {
        if (h.state().waiting_answers?.length) { clock += 1_000; return }
        h.confirm()
        h.stage([{ question_id: h.registration().questions[0]!.question.id, choice_ids: ['staging'] }])
      },
    })
    expect(outcome).toBe('closed')
    expect(h.output).toHaveLength(1)
    expect(h.decision().hookSpecificOutput.decision.updatedInput.answers).toEqual({})
    expect(h.state().waiting_answers).toHaveLength(1)
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

  it('follows the process showing the picker, not the conversation\'s primary place', async () => {
    // Open in two places: the primary exits while a standby place shows the picker.
    const primary = await otherProcess()
    const standby = setup({ host: primary.identity, hookSource: process.pid })
    let exited = false
    expect(await claudePermissionRequest(standby.deps, standby.envelope(), standby.logger, {
      sleep: async () => {
        if (!exited) { exited = true; await primary.exit(); return }
        standby.confirm()
        standby.stage([{ question_id: standby.registration().questions[0]!.question.id, choice_ids: ['production'] }])
      },
    })).toBe('answered')
    expect(standby.decision().hookSpecificOutput.decision.updatedInput.answers).toEqual({ [REWORDED]: 'Production' })

    // The place showing the picker exits while the primary lives on: the picker went with it.
    const shown = await otherProcess()
    const gone = setup({ hookSource: shown.identity.pid })
    let questionId = ''
    expect(await claudePermissionRequest(gone.deps, gone.envelope(), gone.logger, {
      sleep: async () => { questionId = gone.held(); await shown.exit() },
    })).toBe('left-to-terminal')
    expect(gone.gates.at(-1)).toMatchObject({ stage: 'session-ended' })
    expect(gone.pendingOf(questionId)).toBeUndefined()
    expect(gone.output).toEqual([])
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
  const unsourced = (input: ClaudePickerInput) => ({ questions: input.questions })
  const denial = (h: ReturnType<typeof setup>) => h.decision().hookSpecificOutput.decision

  it('asks in Claude Code\'s classic picker shape, recommended choice first and marked, named by the registration', () => {
    const h = setup()
    const { questionId, input } = handBack(h)
    expect(input).toEqual({
      questions: [{ question: REWORDED, header: 'Deploy target', multiSelect: false, options: [
        { label: 'Production (Recommended)', description: '' }, { label: 'Staging', description: 'A safe rehearsal.' }] }],
      metadata: { source: `notifai:${questionId}` },
    })
  })

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

  it('links the exact picker when it names nothing, as an older skill opens it', async () => {
    const h = setup()
    const { questionId, input } = handBack(h)
    expect(await claudePermissionRequest(h.deps, h.envelope(unsourced(input)), h.logger, {
      sleep: async () => {
        if (h.state().waiting_answers?.length) return
        h.stage([{ question_id: QUESTION.id, choice_ids: ['staging'] }], questionId)
      },
    })).toBe('answered')
    expect(h.gates[0]).toMatchObject({ stage: 'picker-handback-matched', question_ids: [questionId] })
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

  it('refuses any other picker while a hand-back waits, and none once the turn moves on', async () => {
    const h = setup()
    const { questionId } = handBack(h)
    expect(await claudePermissionRequest(h.deps, h.envelope(FORM), h.logger)).toBe('refused')
    expect(h.gates.at(-1)).toMatchObject({ stage: 'picker-refused', reason: 'handback-waiting', question_ids: [questionId] })
    expect(h.state().pending?.map(entry => entry.question_id)).toEqual([questionId])
    for (const event of ['stop', 'user-prompt-submit'] as const) {
      updateSessionState(SESSION, h.env, state => recordHandBack(state, questionId, Date.now()))
      await hookRunCommand(h.deps, event, async () => JSON.stringify({ session_id: SESSION, cwd: h.root, prompt: 'next' }), 'claude-code')
      expect(h.state().claude_handbacks).toBeUndefined()
      expect(decideHandBack(h.state(), FORM, pickerQuestions(FORM)!)).toEqual({ kind: 'none' })
    }
  })

  it('returns an answer that came before the picker opened through the picker, keeping it from the wake meanwhile', async () => {
    const h = setup()
    const { questionId, input } = handBack(h)
    h.stage([{ question_id: QUESTION.id, choice_ids: ['staging'] }], questionId)
    expect(claudePickerHolds(h.state())).toBe(true)
    expect(claudePickerHolds(h.state(), Date.now() + CLAUDE_HANDBACK_HOLD_MS)).toBe(false)
    expect(await claudePermissionRequest(h.deps, h.envelope(input), h.logger, {
      sleep: async () => { throw new Error('the answer is already here') },
    })).toBe('answered')
    expect(denial(h).updatedInput.answers).toEqual({ [REWORDED]: 'Staging' })
    expect(h.claims).toEqual([`req_${questionId}`])
  })

  it('refuses a handed-back picker whose question was answered and delivered, or ended unanswered', async () => {
    const answered = setup()
    const first = handBack(answered)
    const answer = answered.stage([{ question_id: QUESTION.id, choice_ids: ['staging'] }], first.questionId)
    updateSessionState(SESSION, answered.env, state => ({ ...state, waiting_answers: [], delivered_answers: [answer] }))
    expect(await claudePermissionRequest(answered.deps, answered.envelope(first.input), answered.logger)).toBe('refused')
    expect(denial(answered).message).toBe(`\`${first.questionId}\` was already answered, and that answer was delivered to you. Do not ask it again.`)

    const ended = setup()
    const second = handBack(ended)
    updateSessionState(SESSION, ended.env, state => ({ ...state, pending: [],
      question_history: [{ question_id: second.questionId, state: 'withdrawn' }] }))
    expect(await claudePermissionRequest(ended.deps, ended.envelope(second.input), ended.logger)).toBe('refused')
    expect(denial(ended).message).toBe(`\`${second.questionId}\` has expired without an answer: carry on without it, or ask in the conversation.`)
    expect(ended.gates.at(-1)).toMatchObject({ reason: 'expired' })
  })

  it('never refuses a picker on a signed-out machine', async () => {
    const h = setup()
    const { input } = handBack(h)
    const signedOut = { ...h.deps, store: { ...h.deps.store, load: () => null } } as CommandDeps
    const reworded = { ...input, questions: [{ ...input.questions[0]!, question: 'Where should this deploy go?' }] }
    expect(await claudePermissionRequest(signedOut, h.envelope(reworded), h.logger)).toBe('not-bound')
    expect(h.output).toEqual([])
    expect(h.gates.at(-1)).toMatchObject({ reason: 'not-signed-in' })
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
