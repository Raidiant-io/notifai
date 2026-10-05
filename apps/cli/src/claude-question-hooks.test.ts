import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ClaimDeliveryAttemptRequestT, QuestionT, ReplyAnswerT } from '@raidiant/notifai-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_PICKER_TURN,
  claudePickerAnswers,
  claudePickerShape,
  claudeTerminalAnswers,
  matchClaudePicker,
  observeClaudePicker,
  reserveClaudeQuestion,
} from './claude-question-bindings.js'
import {
  claudePermissionRequest,
  claudePickerHolds,
  claudePostToolUse,
  closeClaudePicker,
  takeOwedClaudePickerAnswer,
} from './claude-question-hooks.js'
import { nativeQuestionTitle } from './codex-question-bindings.js'
import { ApiCallError, type ApiClient } from './client.js'
import { hookRunCommand } from './commands-hook-run.js'
import type { CommandDeps } from './commands-core.js'
import { acquireClaimFile } from './hook-question-lock.js'
import { beginSessionIncarnation, lifecycleStamp, readSessionState, updateSessionState } from './hook-session-state.js'
import type { AnsweredPending, HookEnvelope, SessionState } from './hook-types.js'
import { createLogger } from './logging.js'
import { currentProcessIdentity } from './process-identity.js'
import { attendantClaimPath, writeAttendantStatus } from './session-attendant-state.js'
import { readDeliveryJournal } from './session-delivery.js'

const SESSION = '22222222-2222-4222-8222-222222222222'
const SERVICE = { base_url: 'https://test.notifai.invalid', machine_id: 'mac_test' }
const ENVIRONMENT: QuestionT = {
  id: 'q1', text: 'Which environment?',
  choices: [{ id: 'staging', label: 'Staging' }, { id: 'production', label: 'Production' }],
}
const CHECKS: QuestionT = {
  id: 'q2', text: 'Which checks?', multi: true,
  choices: [{ id: 'lint', label: 'Lint' }, { id: 'tests', label: 'Tests' }, { id: 'e2e', label: 'End to end' }],
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup(questions: QuestionT[] = [ENVIRONMENT]) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-claude-picker-'))
  roots.push(root)
  const owner = currentProcessIdentity()!
  const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
  const incarnation = beginSessionIncarnation(SESSION, env, { stamp: lifecycleStamp(), harnessProcess: owner })
  const lease = { incarnation: incarnation.incarnation, generation: 1 }
  acquireClaimFile(attendantClaimPath(SESSION, env), { incarnation: lease.incarnation }, Date.now())
  writeAttendantStatus(SESSION, env, { ...lease, phase: 'attending', activity: 'working', reason: null, accepts_messages: true, updated_at: Date.now() })
  const output: string[] = []
  const claims: string[] = []
  const reports: string[] = []
  const client = {
    claimDeliveryAttempt: async (_session: string, body: ClaimDeliveryAttemptRequestT) => {
      const id = body.subject.type === 'session_message' ? body.subject.message_id : body.subject.request_id
      if (reports.length > 0) throw new ApiCallError(409, 'claim_refused', 'settled', null, { reason: 'not_claimable' })
      claims.push(id)
      return { attempt_id: `att_${id}`, claim_remaining_ms: 30_000 }
    },
    reportDeliveryAttempt: async (id: string, body: { outcome: string }) => {
      reports.push(body.outcome)
      return { attempt_id: id, ...body, replayed: false }
    },
  } as unknown as ApiClient
  const deps: CommandDeps = {
    cwd: root, env,
    io: { out: (line) => { output.push(line) }, err: () => {}, confirm: async () => false, openUrl: () => {} },
    store: { load: () => ({ machineId: SERVICE.machine_id, secret: 'test-secret', baseUrl: SERVICE.base_url, machineName: 'test' }), save: () => {}, clear: () => {} } as unknown as CommandDeps['store'],
    clientFactory: () => client,
  }
  const pending = {
    question_id: 'q_bound', question: questions[0]!.text, summary: questions[0]!.text, request_id: 'req_bound',
    collapse_key: 'bound', device_ids: ['dev_test'], service_identity: SERVICE, questions,
  }
  updateSessionState(SESSION, env, (state) => reserveClaudeQuestion(
    { ...state, harness: 'claude-code', pending: [pending] },
    pending,
    { owner_key: incarnation.key, turn_id: CLAUDE_PICKER_TURN, service: SERVICE },
  ))
  updateSessionState(SESSION, env, (state) => ({
    ...state,
    codex_question_bindings: state.codex_question_bindings!.map((item) => ({ ...item, confirmed_request_id: 'req_bound' })),
  }))
  const registration = () => readSessionState(SESSION, env).codex_question_bindings![0]!
  const toolInput = (mutate: (questions: Array<Record<string, unknown>>) => void = () => {}) => {
    const shown: Array<Record<string, unknown>> = registration().questions.map((binding) => ({
      question: nativeQuestionTitle(binding),
      header: 'Notifai',
      options: binding.question.choices!.map((choice) => ({ label: choice.label, description: `Pick ${choice.label}` })),
      multiSelect: binding.question.multi === true,
    }))
    mutate(shown)
    return { questions: shown }
  }
  const envelope = (extra: Partial<HookEnvelope> = {}): HookEnvelope => ({
    session_id: SESSION, cwd: root, tool_name: 'AskUserQuestion', tool_input: toolInput(), ...extra,
  })
  const stage = (parts: ReplyAnswerT[], text = 'Staging') => {
    const reply = {
      reply_id: 'rpl_bound', seq: 1, delivery_id: 'del_bound', device_id: 'dev_test', device_name: 'Test', text,
      answers: parts, source: null, created_at: new Date().toISOString(),
    }
    const answer = { pending, reply, replies: [reply], agent_acknowledgement_required: true, delivery_claim: true as const } as unknown as AnsweredPending
    updateSessionState(SESSION, env, (state) => ({
      ...state,
      pending: [],
      waiting_answers: [answer],
      acknowledgement_due: [{ request_id: 'req_bound', recorded_at: Date.now(), text_required: true }],
    }))
    return answer
  }
  const logger = createLogger({ env, cwd: root, cmd: 'hook permission-request' })
  const state = (): SessionState => readSessionState(SESSION, env)
  const decision = () => JSON.parse(output[0]!) as {
    hookSpecificOutput: { hookEventName: string; decision: { behavior: string; updatedInput: { questions: unknown[]; answers: Record<string, string> } } }
  }
  return { root, env, deps, output, claims, reports, incarnation, pending, registration, toolInput, envelope, stage, logger, state, decision }
}

describe('Claude Code picker bindings', () => {
  it('links only what the picker can show exactly as registered', () => {
    expect(claudePickerShape([ENVIRONMENT])).toBe(true)
    expect(claudePickerShape([ENVIRONMENT, CHECKS])).toBe(true)
    expect(claudePickerShape([{ id: 'q1', text: 'Anything to add?' }])).toBe(false)
    expect(claudePickerShape([{ ...ENVIRONMENT, choices: [1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, label: `Choice ${n}` })) }])).toBe(false)
    expect(claudePickerShape([1, 2, 3, 4, 5].map((n) => ({ ...ENVIRONMENT, id: `q${n}`, text: `Question ${n}?` })))).toBe(false)
    expect(claudePickerShape(undefined)).toBe(false)
  })

  it('reserves nothing without its own admission', () => {
    const h = setup()
    const other = { ...h.pending, question_id: 'q_other', request_id: 'req_other' }
    const before = h.state()
    expect(reserveClaudeQuestion(before, other, undefined)).toBe(before)
    expect(reserveClaudeQuestion(before, other, { owner_key: h.incarnation.key, turn_id: 'turn-1', service: SERVICE })).toBe(before)
    expect(reserveClaudeQuestion({ ...before, harness: 'codex' }, other, { owner_key: h.incarnation.key, turn_id: CLAUDE_PICKER_TURN, service: SERVICE })).toEqual({ ...before, harness: 'codex' })
    expect(reserveClaudeQuestion(before, { ...other, questions: [{ id: 'q1', text: 'Free text?' }] }, { owner_key: h.incarnation.key, turn_id: CLAUDE_PICKER_TURN, service: SERVICE })).toBe(before)
  })

  it('binds a picker only when it shows exactly the registered questions', () => {
    const h = setup([ENVIRONMENT, CHECKS])
    const key = h.incarnation.key
    expect(matchClaudePicker(h.state(), key, h.toolInput())?.question_id).toBe('q_bound')
    expect(matchClaudePicker(h.state(), 'another-owner', h.toolInput())).toBeNull()
    expect(matchClaudePicker(h.state(), key, h.toolInput((q) => { q[0]!['question'] = 'Which environment?' }))).toBeNull()
    expect(matchClaudePicker(h.state(), key, h.toolInput((q) => { q.pop() }))).toBeNull()
    expect(matchClaudePicker(h.state(), key, h.toolInput((q) => { q.push({ question: 'Anything else?', options: [{ label: 'Yes' }, { label: 'No' }] }) }))).toBeNull()
    expect(matchClaudePicker(h.state(), key, h.toolInput((q) => { q[1]!['multiSelect'] = false }))).toBeNull()
    expect(matchClaudePicker(h.state(), key, h.toolInput((q) => { (q[0]!['options'] as Array<{ label: string }>)[0]!.label = 'Stage' }))).toBeNull()
    expect(matchClaudePicker(h.state(), key, { questions: 'no' })).toBeNull()
    expect(matchClaudePicker(h.state(), key, undefined)).toBeNull()
  })

  it('maps an app answer to the picker and a terminal answer back to registered ids', () => {
    const h = setup([ENVIRONMENT, CHECKS])
    updateSessionState(SESSION, h.env, (state) => observeClaudePicker(state, 'q_bound', 'toolu_1'))
    const [environment, checks] = h.registration().questions
    const answer = h.stage([
      { question_id: 'q1', choice_ids: [], text: 'Canary first' },
      { question_id: 'q2', choice_ids: ['lint', 'e2e'] },
    ])
    expect(claudePickerAnswers(h.registration(), answer, SERVICE)).toEqual({
      [nativeQuestionTitle(environment!)]: 'Canary first',
      [nativeQuestionTitle(checks!)]: 'Lint, End to end',
    })
    expect(claudePickerAnswers(h.registration(), h.stage([{ question_id: 'q1', choice_ids: ['staging'] }]), SERVICE)).toBeNull()
    expect(claudePickerAnswers(h.registration(), h.stage([{ question_id: 'q1', choice_ids: ['nope'] }, { question_id: 'q2', choice_ids: ['lint'] }]), SERVICE)).toBeNull()
    expect(claudePickerAnswers(h.registration(), answer, { ...SERVICE, machine_id: 'another' })).toBeNull()

    expect(claudeTerminalAnswers(h.registration(), { answers: {
      [nativeQuestionTitle(environment!)]: 'Production',
      [nativeQuestionTitle(checks!)]: 'Lint, Tests',
    } })).toEqual([
      { question_id: 'q1', choice_ids: ['production'] },
      { question_id: 'q2', choice_ids: ['lint', 'tests'] },
    ])
    expect(claudeTerminalAnswers(h.registration(), { answers: {
      [nativeQuestionTitle(environment!)]: 'Neither, wait',
      [nativeQuestionTitle(checks!)]: 'Lint',
    } })).toEqual([
      { question_id: 'q1', text: 'Neither, wait' },
      { question_id: 'q2', choice_ids: ['lint'] },
    ])
    expect(claudeTerminalAnswers(h.registration(), { answers: { [nativeQuestionTitle(environment!)]: 'Production' } })).toBeNull()
  })
})

describe('Claude Code picker hooks', () => {
  it('returns a staged app answer as the picker result and keeps it owed until the tool confirms', async () => {
    const h = setup()
    h.stage([{ question_id: 'q1', choice_ids: ['staging'] }])
    expect(await claudePermissionRequest(h.deps, h.envelope(), h.logger)).toBe('answered')

    const title = nativeQuestionTitle(h.registration().questions[0]!)
    expect(h.output).toHaveLength(1)
    expect(h.decision().hookSpecificOutput).toMatchObject({
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { answers: { [title]: 'Staging' } } },
    })
    expect(h.decision().hookSpecificOutput.decision.updatedInput.questions).toEqual(h.toolInput().questions)
    expect(h.claims).toEqual(['req_bound'])
    expect(h.reports).toEqual(['handed_off'])
    expect(readDeliveryJournal(SESSION, h.env).at(-1)).toMatchObject({ stage: 'written', presentation: { kind: 'claude-question', request_id: 'req_bound' } })
    expect(h.state().waiting_answers).toEqual([])
    expect(h.state().claude_picker_presented).toMatchObject({ request_id: 'req_bound', answers: { [title]: 'Staging' } })

    h.output.length = 0
    claudePostToolUse(h.deps, h.envelope({ tool_response: { answers: { [title]: 'Staging' } } }), h.logger)
    const context = (JSON.parse(h.output[0]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
    expect(context).toContain("came from the user's device, for request req_bound")
    expect(context).toContain('notifai acknowledge req_bound --text')
    expect(context).not.toContain('--native-answers')
    expect(h.state().claude_picker_presented).toBeUndefined()
    expect(h.state().claude_picker).toBeUndefined()
  })

  it('waits while the picker is open and answers as soon as the app answer is staged', async () => {
    const h = setup()
    let slept = 0
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        slept++
        expect(h.state().claude_picker).toMatchObject({ question_id: 'q_bound' })
        expect(h.output).toEqual([])
        if (slept === 2) h.stage([{ question_id: 'q1', choice_ids: ['production'] }], 'Production')
      },
    })
    expect(outcome).toBe('answered')
    expect(slept).toBe(2)
    expect(Object.values(h.decision().hookSpecificOutput.decision.updatedInput.answers)).toEqual(['Production'])
  })

  it('keeps waiting while an accepted answer is between the pending list and the staged inputs', async () => {
    const h = setup()
    let slept = 0
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        slept++
        if (slept === 1) {
          // What acceptance writes first: the question leaves `pending`, the answer sits in `accepted`.
          const answer = h.stage([{ question_id: 'q1', choice_ids: ['staging'] }])
          updateSessionState(SESSION, h.env, (state) => ({
            ...state, waiting_answers: [], accepted: { answers: [answer], remaining: 0, recorded_at: Date.now() },
          }))
        }
        if (slept === 3) {
          updateSessionState(SESSION, h.env, (state) => {
            const next = { ...state, waiting_answers: state.accepted!.answers }
            delete next.accepted
            return next
          })
        }
      },
    })
    expect(outcome).toBe('answered')
    expect(slept).toBe(3)
    expect(Object.values(h.decision().hookSpecificOutput.decision.updatedInput.answers)).toEqual(['Staging'])
  })

  it('leaves an unregistered picker alone', async () => {
    const h = setup()
    h.stage([{ question_id: 'q1', choice_ids: ['staging'] }])
    const unrelated = { questions: [{ question: 'Which environment?', options: [{ label: 'Staging' }, { label: 'Production' }] }] }
    expect(await claudePermissionRequest(h.deps, h.envelope({ tool_input: unrelated }), h.logger)).toBe('not-bound')
    expect(await claudePermissionRequest(h.deps, h.envelope({ tool_name: 'Bash' }), h.logger)).toBe('not-bound')
    expect(await claudePermissionRequest(h.deps, h.envelope({ agent_id: 'agent-1' }), h.logger)).toBe('not-bound')
    expect(h.output).toEqual([])
    expect(h.claims).toEqual([])
    expect(h.state().claude_picker).toBeUndefined()
    expect(h.state().waiting_answers).toHaveLength(1)
  })

  it('stops without a word when the terminal answers first, and tells the agent how to report that answer', async () => {
    const h = setup()
    const title = nativeQuestionTitle(h.registration().questions[0]!)
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        claudePostToolUse(h.deps, h.envelope({ tool_response: { answers: { [title]: 'Production' } } }), h.logger)
      },
    })
    expect(outcome).toBe('left-to-terminal')
    expect(h.claims).toEqual([])
    expect(h.output).toHaveLength(1)
    const context = (JSON.parse(h.output[0]!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput
    expect(context.hookEventName).toBe('PostToolUse')
    expect(context.additionalContext).toContain(
      `notifai acknowledge q_bound --operation-id native-1 --native-answers '[{"question_id":"q1","choice_ids":["production"]}]' --text <text>`,
    )
    expect(h.state().claude_picker).toBeUndefined()
  })

  it('never puts typed terminal text into the command it prints', async () => {
    const h = setup()
    const title = nativeQuestionTitle(h.registration().questions[0]!)
    claudePostToolUse(h.deps, h.envelope({ tool_response: { answers: { [title]: "x'; rm -rf ~ #" } } }), h.logger)
    const context = (JSON.parse(h.output[0]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
    expect(context).toContain(`--native-answers '<actual answers JSON>'`)
    expect(context).not.toContain('rm -rf')
  })

  it('releases the picker when Claude Code signals a dismissal, the turn moves on, or the question is retired', async () => {
    const dismissed = setup()
    let signal!: () => void
    const signalled = new Promise<void>((resolve) => { signal = resolve })
    expect(await claudePermissionRequest(dismissed.deps, dismissed.envelope(), dismissed.logger, {
      signalled, sleep: async () => { signal(); await Promise.resolve() },
    })).toBe('left-to-terminal')
    expect(dismissed.state().claude_picker).toBeUndefined()

    const moved = setup()
    expect(await claudePermissionRequest(moved.deps, moved.envelope(), moved.logger, {
      sleep: async () => { closeClaudePicker(SESSION, moved.env) },
    })).toBe('left-to-terminal')

    const retired = setup()
    expect(await claudePermissionRequest(retired.deps, retired.envelope(), retired.logger, {
      sleep: async () => { updateSessionState(SESSION, retired.env, (state) => ({ ...state, pending: [] })) },
    })).toBe('left-to-terminal')
    expect(retired.state().claude_picker).toBeUndefined()
    for (const h of [dismissed, moved, retired]) expect(h.output).toEqual([])
  })

  it('hands an answer the picker cannot carry to the ordinary route at once', async () => {
    const h = setup([ENVIRONMENT, CHECKS])
    h.stage([{ question_id: 'q1', choice_ids: ['staging'] }])
    expect(await claudePermissionRequest(h.deps, h.envelope(), h.logger)).toBe('left-to-terminal')
    expect(h.output).toEqual([])
    expect(h.claims).toEqual([])
    expect(h.state().waiting_answers).toHaveLength(1)
    expect(h.state().claude_picker).toBeUndefined()
  })

  it('still delivers a device answer that the terminal overtook or the picker never confirmed', async () => {
    const overtaken = setup()
    overtaken.stage([{ question_id: 'q1', choice_ids: ['staging'] }])
    await claudePermissionRequest(overtaken.deps, overtaken.envelope(), overtaken.logger)
    const title = nativeQuestionTitle(overtaken.registration().questions[0]!)
    overtaken.output.length = 0
    claudePostToolUse(overtaken.deps, overtaken.envelope({ tool_response: { answers: { [title]: 'Production' } } }), overtaken.logger)
    const beside = (JSON.parse(overtaken.output[0]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
    expect(beside).toContain('"Staging"')
    expect(beside).toContain('notifai acknowledge req_bound --text')
    expect(beside).toContain('answered in the terminal at the same moment')
    expect(overtaken.state().claude_picker_presented).toBeUndefined()

    const unconfirmed = setup()
    unconfirmed.stage([{ question_id: 'q1', choice_ids: ['staging'] }])
    await claudePermissionRequest(unconfirmed.deps, unconfirmed.envelope(), unconfirmed.logger)
    const owed = takeOwedClaudePickerAnswer(SESSION, unconfirmed.env)
    expect(owed).toContain('"Staging"')
    expect(owed).toContain('notifai acknowledge req_bound --text')
    expect(takeOwedClaudePickerAnswer(SESSION, unconfirmed.env)).toBeNull()
  })

  it('holds the wake only while a live handler has the sole pending answer', async () => {
    const h = setup()
    expect(claudePickerHolds(h.state())).toBe(false)
    const outcome = await claudePermissionRequest(h.deps, h.envelope(), h.logger, {
      sleep: async () => {
        expect(claudePickerHolds(h.state())).toBe(false)
        const answer = h.stage([{ question_id: 'q1', choice_ids: ['staging'] }])
        expect(claudePickerHolds(h.state())).toBe(true)
        const other = { ...answer, pending: { ...answer.pending, question_id: 'q_other', request_id: 'req_other' } }
        expect(claudePickerHolds({ ...h.state(), waiting_answers: [answer, other] })).toBe(false)
      },
    })
    expect(outcome).toBe('answered')
    expect(claudePickerHolds(h.state())).toBe(false)
  })
})

describe('Claude Code picker hook entry points', () => {
  const stdin = (payload: unknown) => async () => JSON.stringify(payload)

  it('answers a bound picker, confirms it, and stops a waiting handler when the turn moves on', async () => {
    const h = setup()
    h.stage([{ question_id: 'q1', choice_ids: ['staging'] }])
    const title = nativeQuestionTitle(h.registration().questions[0]!)
    const event = { session_id: SESSION, cwd: h.root, tool_name: 'AskUserQuestion', tool_input: h.toolInput() }

    expect(await hookRunCommand(h.deps, 'permission-request', stdin({ ...event, hook_event_name: 'PermissionRequest' }), 'claude-code')).toBe(0)
    expect(h.decision().hookSpecificOutput.decision.updatedInput.answers).toEqual({ [title]: 'Staging' })

    h.output.length = 0
    expect(await hookRunCommand(h.deps, 'post-tool-use', stdin({
      ...event, hook_event_name: 'PostToolUse', tool_response: { answers: { [title]: 'Staging' } },
    }), 'claude-code')).toBe(0)
    expect(h.output.join('\n')).toContain('notifai acknowledge req_bound --text')

    updateSessionState(SESSION, h.env, (state) => ({
      ...state, claude_picker: { question_id: 'q_bound', opened_at: 1, waiter: currentProcessIdentity()! },
    }))
    expect(await hookRunCommand(h.deps, 'stop', stdin({ session_id: SESSION, cwd: h.root, hook_event_name: 'Stop' }), 'claude-code')).toBe(0)
    expect(h.state().claude_picker).toBeUndefined()
  })

  it('writes nothing for a picker it did not register, on any harness but Claude Code, or for another tool', async () => {
    const h = setup()
    h.stage([{ question_id: 'q1', choice_ids: ['staging'] }])
    const event = { session_id: SESSION, cwd: h.root, hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion' }
    await hookRunCommand(h.deps, 'permission-request', stdin({ ...event, tool_input: { questions: [{ question: 'Unrelated?', options: [{ label: 'Yes' }, { label: 'No' }] }] } }), 'claude-code')
    await hookRunCommand(h.deps, 'permission-request', stdin({ ...event, tool_input: h.toolInput() }), 'codex')
    await hookRunCommand(h.deps, 'permission-request', stdin({ ...event, tool_name: 'Bash', tool_input: { command: 'ls' } }), 'claude-code')
    expect(h.output).toEqual([])
    expect(h.claims).toEqual([])
    expect(h.state().waiting_answers).toHaveLength(1)
  })

  it('carries an unconfirmed device answer on the next prompt', async () => {
    const h = setup()
    h.stage([{ question_id: 'q1', choice_ids: ['staging'] }])
    await claudePermissionRequest(h.deps, h.envelope(), h.logger)
    h.output.length = 0
    await hookRunCommand(h.deps, 'user-prompt-submit', stdin({
      session_id: SESSION, cwd: h.root, hook_event_name: 'UserPromptSubmit', prompt: 'what happened?',
    }), 'claude-code')
    const context = h.output.join('\n')
    expect(context).toContain('Staging')
    expect(context).toContain('notifai acknowledge req_bound --text')
    expect(h.state().claude_picker_presented).toBeUndefined()
  })
})
