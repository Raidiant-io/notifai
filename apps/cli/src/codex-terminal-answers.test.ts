import type { AnswerVersionView,RecordHarnessAnswerRequestT } from '@raidiant/notifai-protocol'
import { appendFileSync,mkdirSync,mkdtempSync,rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { type ApiClient } from './client.js'
import { CODEX_TERMINAL_RECEIPT,observeCodexTerminalAnswers,parseCodexTerminalReplies,parseCodexTextReplies,reportCodexTerminalAnswers,takeCodexTerminalConflictContext } from './codex-terminal-answers.js'
import { acknowledgeCommand } from './commands-acknowledge.js'
import type { CommandDeps } from './commands-core.js'
import { NATIVE_ANSWERS_DEPRECATION } from './commands-native-acknowledge.js'
import { registerQuestion } from './hook-lifecycle.js'
import { beginSessionIncarnation,lifecycleStamp,readSessionState,writeSessionState } from './hook-session-state.js'
import type { HookEnvelope } from './hook-types.js'
import { createLogger } from './logging.js'
import { questionsAwaitingAnswer,recordConfirmedNativeAnswerTarget } from './native-answer-operation.js'
import { currentProcessIdentity } from './process-identity.js'
import { buildProgram } from './program.js'
import { recordTurnStart } from './session-attendant-state.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const SESSION = '019ff69d-a07f-7161-ab6e-bd06b3b93c8e'
const version = (id: string, answers: RecordHarnessAnswerRequestT['answers']): AnswerVersionView => ({
  version_id: id, origin: 'harness', provenance: 'agent-reported', source: 'reply', base_version: null,
  status: 'presented', not_delivered_reason: null,
  answers: answers.map(answer => ({ question_id: answer.question_id, choice_ids: answer.choice_ids ?? [], text: answer.text ?? null })),
  text: 'answer', device_id: null, created_at: '2026-10-21T12:00:00Z', agent_acknowledgement: null,
})
const reply = (index = 0, answer = 'Staging', extra = {}) => ({
  questionItemId: JSON.stringify(['request_user_input_async', 'card_call', index]),
  question: index === 0 ? 'Where?' : 'Any notes?', answer, ...extra,
})
const envelope = (items = [reply()]) => `<send_user_message_question_reply>\n${JSON.stringify(items)}\n</send_user_message_question_reply>`

function fixture(confirmed = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-terminal-answer-')); roots.push(root)
  const process = currentProcessIdentity()!
  const env: NodeJS.ProcessEnv = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'),
    CODEX_HOME: path.join(root, 'codex'), NOTIFAI_HOOK_SOURCE_PID: String(process.pid) }
  const owner = beginSessionIncarnation(SESSION, env, { stamp: lifecycleStamp(), harnessProcess: process })
  const file = path.join(env['CODEX_HOME']!, 'sessions', 'owned.jsonl')
  mkdirSync(path.dirname(file), { recursive: true })
  const append = (type: string, payload: unknown) => appendFileSync(file, `${JSON.stringify({ type, payload })}\n`)
  append('session_meta', { id: SESSION, source: 'cli' })
  append('event_msg', { type: 'task_started', turn_id: 'turn-1' })
  recordTurnStart(SESSION, env, owner.key, 'turn-1')
  writeSessionState(SESSION, env, { harness: 'codex' })
  const service = { base_url: 'https://api.example.test', machine_id: 'machine_test' }
  const { question_id: questionId } = registerQuestion(SESSION, env, { question: 'Where?', summary: 'Where?', service_identity: service,
    questions: [{ id: 'q1', text: 'Where?', choices: [{ id: 'staging', label: 'Staging' }, { id: 'production', label: 'Production' }] },
      { id: 'q2', text: 'Any notes?' }],
  }, Date.now(), { owner_key: owner.key, turn_id: 'turn-1', service,
    card: { call_id: 'card_call', allow: true, accepted: true,
      shown: [{ title: 'Where?', labels: { staging: 'Staging', production: 'Production' } }, { title: 'Any notes?', labels: {} }] } })
  append('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'card_call',
    arguments: JSON.stringify({ questions: [{ title: 'Where?', options: ['Staging', 'Production'] }, { title: 'Any notes?' }] }) })
  append('response_item', { type: 'function_call_output', call_id: 'card_call', output: '{"accepted":true}' })
  const confirm = () => recordConfirmedNativeAnswerTarget(SESSION, env, { question_id: questionId, request_id: 'req_original',
    question: 'Where?', summary: 'Where?', service_identity: service })
  if (confirmed) confirm()
  const seen = new Map<string, number>()
  const answered = new Set<string>()
  const others: AnswerVersionView[] = []
  const client = {
    recordHarnessAnswer: vi.fn(async (_id: string, body: RecordHarnessAnswerRequestT) => {
      const replayed = seen.has(body.submission_id)
      if (!replayed) seen.set(body.submission_id, seen.size + 1)
      const seq = seen.get(body.submission_id)!
      body.answers.forEach(answer => answered.add(answer.question_id))
      return { status: replayed ? 'replayed' as const : 'recorded' as const, reply_seq: seq, complete: answered.size === 2,
        answer_version: version(`rpl_${seq}`, body.answers), other_submissions: others }
    }),
    putAgentAcknowledgement: vi.fn(async (_id: string, body: { text?: string }) => ({ status: 'recorded' as const,
      agent_acknowledgement: { text: body.text ?? CODEX_TERMINAL_RECEIPT, created_at: '2026-10-21T12:00:01Z' } })),
  }
  const spawn = vi.fn()
  const output: string[] = []
  const deps: CommandDeps = { cwd: root, env,
    store: { load: () => ({ baseUrl: service.base_url, machineId: service.machine_id, secret: 'isolated-test', machineName: 'test' }) } as CommandDeps['store'],
    spawnQuestionSettlement: spawn, clientFactory: () => client as unknown as ApiClient,
    io: { out: text => output.push(text), err: text => output.push(text), confirm: async () => false, openUrl: () => {} },
  }
  const logger = createLogger({ env })
  const hook = (prompt = envelope(), overrides: Partial<HookEnvelope> = {}): HookEnvelope => ({ session_id: SESSION, cwd: root,
    hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', transcript_path: file, prompt, ...overrides })
  const observe = (prompt = envelope(), overrides: Partial<HookEnvelope> = {}) => observeCodexTerminalAnswers(deps, hook(prompt, overrides), logger)
  const commit = (prompt = envelope()) => append('event_msg', { type: 'user_message', message: prompt })
  const ctx = { client: client as unknown as ApiClient, env, service_identity: service, log: logger }
  const report = () => reportCodexTerminalAnswers(ctx, SESSION)
  return { env, owner, file, append, questionId, service, confirm, client, others, spawn, deps, output, hook, observe, commit, ctx, report,
    state: () => readSessionState(SESSION, env), conflict: () => takeCodexTerminalConflictContext(deps, hook()) }
}

describe('Codex terminal reply envelopes', () => {
  it('parses exact call IDs and indices, choices, free text, batches and the IDE prefix', () => {
    expect(parseCodexTerminalReplies(envelope())).toEqual([{ callId: 'card_call', index: 0, question: 'Where?', answer: 'Staging' }])
    const prompt = envelope([reply(), reply(1, 'Keep the old logs.\nThen deploy.')])
    expect(parseCodexTerminalReplies(prompt)).toHaveLength(2)
    expect(parseCodexTerminalReplies(`# Context from my IDE:\nopen file\n## My request for Codex:\n${prompt}`)).toEqual(parseCodexTerminalReplies(prompt))
  })
})

describe('plain-text card answers from apps around Codex', () => {
  const open = [{ callId: 'card_a', index: 0, title: 'Where?', labels: ['Staging', 'Production'] },
    { callId: 'card_a', index: 1, title: 'Any notes?', labels: [] }, { callId: 'card_b', index: 0, title: 'Which size?', labels: ['Small', 'Large'] }]
  const one = (answer: string, question = 'Where?', callId = 'card_a', index = 0) => ({ callId, index, question, answer })

  it('reads Orca chat quotes, one or several, across cards', () => {
    expect(parseCodexTextReplies('> Where?\n\nStaging', open, 'orca')).toEqual([one('Staging')])
    expect(parseCodexTextReplies('> Which size?\n\nLarge\n\n> Where?\n\nKeep it on staging, please.\nThen tell me.', open, 'orca'))
      .toEqual([one('Large', 'Which size?', 'card_b'), one('Keep it on staging, please.\nThen tell me.')])
    // Orca puts a multi-line question on one line.
    expect(parseCodexTextReplies('> Pick one: A or B\n\nA', [{ callId: 'c', index: 0, title: 'Pick one:\nA or B', labels: ['A', 'B'] }], 'orca'))
      .toEqual([{ callId: 'c', index: 0, question: 'Pick one:\nA or B', answer: 'A' }])
  })

  it('reads T3 Code answers, one per question of a card, with or without whitespace around a question', () => {
    expect(parseCodexTextReplies('Where?\nStaging', open, 't3')).toEqual([one('Staging')])
    expect(parseCodexTextReplies('Where?\nProduction\n\nAny notes?\nNone', open, 't3'))
      .toEqual([one('Production'), one('None', 'Any notes?', 'card_a', 1)])
    const padded = [{ callId: 'p', index: 0, title: ' First? ', labels: ['Yes', 'No'] }, { callId: 'p', index: 1, title: ' Second? ', labels: [] }]
    expect(parseCodexTextReplies(' First? \nYes\n\n Second? \nLater', padded, 't3'))
      .toEqual([{ callId: 'p', index: 0, question: ' First? ', answer: 'Yes' }, { callId: 'p', index: 1, question: ' Second? ', answer: 'Later' }])
    expect(parseCodexTextReplies('First?\nYes\n\nSecond?\nLater', padded, 't3')).toHaveLength(2)
  })

  it('reads Windows line endings the same', () => {
    expect(parseCodexTextReplies('> Where?\r\n\r\nStaging\r\n', open, 'orca')).toEqual([one('Staging')])
    expect(parseCodexTextReplies('Where?\r\nStaging', open, 't3')).toEqual([one('Staging')])
  })

  it('outside the app whose shape it is, counts only an answer that is one of the card\'s choices', () => {
    expect(parseCodexTextReplies('Where?\nI am not sure what you mean, explain first', open)).toEqual([])
    expect(parseCodexTextReplies('Where?\nI am not sure what you mean, explain first', open, 'orca')).toEqual([])
    expect(parseCodexTextReplies('> Where?\n\nwhatever you think', open, 't3')).toEqual([])
    expect(parseCodexTextReplies('Where?\nStaging', open)).toEqual([one('Staging')])
    expect(parseCodexTextReplies('> Where?\n\nProduction', open)).toEqual([one('Production')])
    // A free-text question has no choices, so nothing outside its app answers it.
    expect(parseCodexTextReplies('Any notes?\nNone', open)).toEqual([])
  })

  it.each([
    ['an ordinary prompt', 'Please deploy to staging'],
    ['a prompt that only mentions the question', 'About "Where?": staging'],
    ['a quote with no answer', '> Where?\n\n'],
    ['a quote of a question no open card asks', '> Where to?\n\nStaging'],
    ['text before the quote', 'Answer:\n> Where?\n\nStaging'],
    ['a known answer beside a card Notifai does not carry', '> Where?\n\nStaging\n\n> Unknown?\n\nYes'],
  ])('leaves %s alone', (_name, prompt) => {
    expect(parseCodexTextReplies(prompt, open, 'orca')).toEqual([])
  })

  it('does not guess between two open questions with the same wording', () => {
    expect(parseCodexTextReplies('> Where?\n\nStaging', [...open, { callId: 'card_c', index: 0, title: 'Where?', labels: ['Staging'] }], 'orca')).toEqual([])
  })
})

it('records only after rollout commit, one item at a time, with a fixed receipt and idempotent replay', async () => {
  const h = fixture()
  h.observe()
  expect(h.spawn).toHaveBeenCalledOnce()
  expect(h.state().native_answer_operations).toBeUndefined()
  await h.report()
  expect(h.client.recordHarnessAnswer).not.toHaveBeenCalled()
  h.commit()
  await h.report()
  expect(h.client.recordHarnessAnswer).toHaveBeenCalledWith('req_original', { session_id: SESSION, submission_id: expect.any(String),
    answers: [{ question_id: 'q1', choice_ids: ['staging'] }] })
  expect(h.client.putAgentAcknowledgement).toHaveBeenCalledWith('req_original', { session_id: SESSION, reply_seq: 1, text: CODEX_TERMINAL_RECEIPT })
  expect(h.state().native_answer_operations?.[0]).toMatchObject({ operation_id: 'terminal:0', answer_complete: false })
  expect(questionsAwaitingAnswer(h.state())).toHaveLength(1)
  h.observe(); await h.report()
  expect(h.client.recordHarnessAnswer).toHaveBeenCalledOnce()
  const second = envelope([reply(1, 'Keep the logs.')])
  h.observe(second); h.commit(second); await h.report()
  expect(h.state().native_answer_operations).toHaveLength(2)
  expect(h.state().native_answer_operations?.[1]).toMatchObject({ operation_id: 'terminal:1', answer_complete: true,
    answers: [{ question_id: 'q2', text: 'Keep the logs.' }] })
  expect(questionsAwaitingAnswer(h.state())).toEqual([])
  expect(h.state().pending).toHaveLength(1) // A later device Answer Edit keeps its route.
})

it('confirms a committed user response item but never model, tool, hook-context or older input', async () => {
  const h = fixture()
  h.commit() // Old identical message is before the hook's observation fence.
  h.observe()
  for (const role of ['assistant', 'developer', 'tool']) h.append('response_item', { type: 'message', role,
    content: [{ type: 'input_text', text: envelope() }] })
  h.append('response_item', { type: 'function_call_output', call_id: 'other', output: envelope() })
  await h.report()
  expect(h.client.recordHarnessAnswer).not.toHaveBeenCalled()
  h.append('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: envelope() }] })
  await h.report()
  expect(h.client.recordHarnessAnswer).toHaveBeenCalledOnce()
})

it('waits for a confirmed request and preserves the same operation through a lost acknowledgement', async () => {
  const h = fixture(false); h.observe(); h.commit(); await h.report()
  const submission = h.state().native_answer_operations![0]!.submission_id
  expect(h.client.recordHarnessAnswer).not.toHaveBeenCalled()
  h.confirm()
  h.client.putAgentAcknowledgement.mockRejectedValueOnce(new Error('lost receipt'))
  await h.report(); await h.report()
  expect(h.client.recordHarnessAnswer).toHaveBeenCalledTimes(2)
  expect(h.client.recordHarnessAnswer.mock.calls.every(([, body]) => body.submission_id === submission)).toBe(true)
  expect(h.state().native_answer_operations![0]!.acknowledgement?.text).toBe(CODEX_TERMINAL_RECEIPT)
})

describe('an older skill reporting a terminal answer itself', () => {
  const report = { operationId: 'native-1', nativeAnswers: JSON.stringify([{ question_id: 'q1', choice_ids: ['staging'] }]),
    text: 'Deploying to staging.', json: true }
  const agent = (h: ReturnType<typeof fixture>) => { h.env['CODEX_THREAD_ID'] = SESSION; return h }
  const last = (h: ReturnType<typeof fixture>) => JSON.parse(h.output.filter(line => line.startsWith('{')).at(-1)!)

  it('keeps the flags accepted but out of help', () => {
    const h = fixture()
    const command = buildProgram(h.deps).commands.find(cmd => cmd.name() === 'acknowledge')!
    expect(command.options.map(option => option.long)).toEqual(expect.arrayContaining(['--native-answers', '--operation-id']))
    expect(command.helpInformation()).not.toMatch(/--native-answers|--operation-id/)
  })

  it('is an idempotent success, with a deprecation line, once Notifai recorded the answer', async () => {
    const h = agent(fixture())
    h.observe(); h.commit(); await h.report()
    expect(await acknowledgeCommand(h.deps, h.questionId, report)).toBe(0)
    expect(h.output).toContain(NATIVE_ANSWERS_DEPRECATION)
    expect(last(h)).toMatchObject({ ok: true, question_id: h.questionId, already_recorded: true })
    expect(await acknowledgeCommand(h.deps, h.questionId, report)).toBe(0)
    expect(h.client.recordHarnessAnswer).toHaveBeenCalledOnce()
    expect(h.state().native_answer_operations?.map(op => op.operation_id)).toEqual(['terminal:0'])
  })
})

it.each([
  ['Orca chat', '> Where?\n\nStaging', { ORCA_STRUCTURED_SESSION: '1' }],
  ['T3 Code', 'Where?\nStaging', { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'T3' }],
  ['an app Notifai cannot name, with one of the card\'s choices', 'Where?\nStaging', {}],
])('records a card answer typed in %s like a terminal answer', async (_app, prompt, env: Record<string, string>) => {
  const h = fixture()
  Object.assign(h.env, env)
  h.observe(prompt)
  h.commit(prompt)
  await h.report()
  expect(h.client.recordHarnessAnswer).toHaveBeenCalledWith('req_original', { session_id: SESSION, submission_id: expect.any(String),
    answers: [{ question_id: 'q1', choice_ids: ['staging'] }] })
  expect(h.client.putAgentAcknowledgement).toHaveBeenCalledWith('req_original', { session_id: SESSION, reply_seq: 1, text: CODEX_TERMINAL_RECEIPT })
})

it('records a typed free-text answer only in the app whose shape it is', async () => {
  const typed = 'Where?\nKeep it where it is for now'
  const elsewhere = fixture()
  elsewhere.observe(typed); elsewhere.commit(typed); await elsewhere.report()
  expect(elsewhere.client.recordHarnessAnswer).not.toHaveBeenCalled()
  const t3 = fixture()
  t3.env['CODEX_INTERNAL_ORIGINATOR_OVERRIDE'] = 'T3'
  t3.observe(typed); t3.commit(typed); await t3.report()
  expect(t3.client.recordHarnessAnswer).toHaveBeenCalledWith('req_original', { session_id: SESSION, submission_id: expect.any(String),
    answers: [{ question_id: 'q1', text: 'Keep it where it is for now' }] })
})

it('never takes a prompt for the answer to a question already answered from a device', async () => {
  const h = fixture()
  h.env['CODEX_INTERNAL_ORIGINATOR_OVERRIDE'] = 'T3'
  const state = h.state()
  // The device answer was delivered the ordinary way: the question left pending.
  writeSessionState(SESSION, h.env, { ...state, pending: [],
    codex_question_bindings: state.codex_question_bindings!.map(item => ({ ...item, ordinary_only: true as const })) })
  const typed = 'Where?\nI am not sure what you mean, explain first'
  h.observe(typed); h.commit(typed); await h.report()
  expect(h.client.recordHarnessAnswer).not.toHaveBeenCalled()
  expect(h.conflict()).toBeNull()
})

it('records the answer to a re-asked card although an earlier card asked the same, once that one is answered', async () => {
  const h = fixture()
  // The first card's question was answered from a device and delivered.
  const first = h.state()
  writeSessionState(SESSION, h.env, { ...first, pending: [] })
  const service = h.service
  const { question_id: again } = registerQuestion(SESSION, h.env, { question: 'Where?', summary: 'Where?', service_identity: service,
    questions: [{ id: 'q1', text: 'Where?', choices: [{ id: 'staging', label: 'Staging' }, { id: 'production', label: 'Production' }] },
      { id: 'q2', text: 'Any notes?' }],
  }, Date.now(), { owner_key: h.owner.key, turn_id: 'turn-1', service,
    card: { call_id: 'card_again', allow: true, accepted: true,
      shown: [{ title: 'Where?', labels: { staging: 'Staging', production: 'Production' } }, { title: 'Any notes?', labels: {} }] } })
  recordConfirmedNativeAnswerTarget(SESSION, h.env, { question_id: again, request_id: 'req_again',
    question: 'Where?', summary: 'Where?', service_identity: service })
  const typed = '> Where?\n\nProduction'
  h.observe(typed); h.commit(typed); await h.report()
  expect(h.client.recordHarnessAnswer).toHaveBeenCalledOnce()
  expect(h.client.recordHarnessAnswer).toHaveBeenCalledWith('req_again', { session_id: SESSION, submission_id: expect.any(String),
    answers: [{ question_id: 'q1', choice_ids: ['production'] }] })
})

it('records nothing for an ordinary prompt while a card is open', async () => {
  const h = fixture()
  for (const prompt of ['Deploy to staging', 'Where?', '> Where?']) { h.observe(prompt); h.commit(prompt) }
  await h.report()
  expect(h.client.recordHarnessAnswer).not.toHaveBeenCalled()
  expect(h.state().codex_terminal_observations ?? []).toEqual([])
})
