import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, truncateSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { RecordHarnessAnswerResponse } from '@raidiant/notifai-protocol'
import { acknowledgeCommand } from './commands-acknowledge.js'
import { closeCommand } from './commands-close.js'
import { buildProgram } from './program.js'
import { EXIT, type CommandDeps } from './commands-core.js'
import type { ApiClient } from './client.js'
import { beginSessionIncarnation, lifecycleStamp, readSessionState, updateSessionState, writeSessionState } from './hook-session-state.js'
import { registerQuestion } from './hook-lifecycle.js'
import { rememberQuestionState } from './hook-question-state.js'
import { currentProcessIdentity } from './process-identity.js'
import { recordTurnStart } from './session-attendant-state.js'
import { nativeQuestionTitle } from './codex-question-bindings.js'
import { CLAUDE_PICKER_TURN, observeClaudePicker } from './claude-question-bindings.js'
import { recordConfirmedNativeAnswerTarget } from './native-answer-operation.js'
import * as retirement from './hook-question-retirement.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(confirmed = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-native-command-')); roots.push(root)
  const sessionId = '019ff69d-a07f-7161-ab6e-bd06b3b93c8e'
  const env: NodeJS.ProcessEnv = { HOME: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, CODEX_HOME: path.join(root, 'codex'), CODEX_THREAD_ID: sessionId }
  const owner = beginSessionIncarnation(sessionId, env, { stamp: lifecycleStamp(), harnessProcess: currentProcessIdentity()! })
  const file = path.join(env['CODEX_HOME']!, 'sessions', 'owned.jsonl')
  mkdirSync(path.dirname(file), { recursive: true })
  const append = (type: string, payload: unknown) => appendFileSync(file, `${JSON.stringify({ type, payload })}\n`)
  append('session_meta', { id: sessionId, source: 'cli' })
  append('event_msg', { type: 'task_started', turn_id: 'turn-1' })
  recordTurnStart(sessionId, env, owner.key, 'turn-1')
  writeSessionState(sessionId, env, { harness: 'codex',
    codex_native_turn: { key: owner.key, turn_id: 'turn-1', transcript_path: file },
    codex_tool_hook: { incarnation: owner.incarnation, fingerprint: 'controlled', root_observed: { turn_id: 'turn-1', at: 1 } },
  })
  const service = { base_url: 'https://api.example.test', machine_id: 'machine_test' }
  const questionId = registerQuestion(sessionId, env, { question: 'Where?', summary: 'Where?', service_identity: service,
    questions: [{ id: 'q1', text: 'Where?', choices: [{ id: 'staging', label: 'Staging' }, { id: 'production', label: 'Production' }] }],
  }, Date.now(), { owner_key: owner.key, turn_id: 'turn-1', service })
  const confirm = () => recordConfirmedNativeAnswerTarget(sessionId, env, { question_id: questionId, request_id: 'req_original', question: 'Where?', summary: 'Where?', service_identity: service })
  if (confirmed) confirm()
  const binding = readSessionState(sessionId, env).codex_question_bindings![0]!
  const emit = (callId = 'native_call') => {
    append('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: callId,
      arguments: JSON.stringify({ questions: [{ title: nativeQuestionTitle(binding.questions[0]!), options: ['Staging', 'Production'] }] }) })
    append('response_item', { type: 'function_call_output', call_id: callId, output: '{"accepted":true}' })
  }
  const outputs: string[] = []; const errors: string[] = []
  const text = 'Deploying to staging.'
  const reply: RecordHarnessAnswerResponse = { status: 'recorded', reply_seq: 1, complete: true, other_submissions: [],
    answer_version: { version_id: 'rpl_native', origin: 'harness', provenance: 'agent-reported', source: 'reply', base_version: null,
      status: 'presented', not_delivered_reason: null, text: 'Staging', answers: [{ question_id: 'q1', choice_ids: ['staging'], text: null }],
      device_id: null, created_at: '2026-10-03T12:00:00Z', agent_acknowledgement: null },
  }
  const client = {
    recordHarnessAnswer: vi.fn(async () => structuredClone(reply)),
    putAgentAcknowledgement: vi.fn(async () => ({ status: 'recorded' as const, agent_acknowledgement: { text, created_at: '2026-10-03T12:00:01Z' } })),
  }
  let clock = 0
  const spawn = vi.fn()
  const deps: CommandDeps = { env, cwd: root, now: () => clock, sleep: async ms => { clock += ms },
    io: { out: line => outputs.push(line), err: line => errors.push(line), confirm: async () => false, openUrl: () => {} },
    store: { load: () => ({ baseUrl: service.base_url, machineId: service.machine_id, secret: 'isolated-test', machineName: 'test' }),
      describe: () => 'isolated', save: () => {}, clear: () => {} } as unknown as CommandDeps['store'],
    clientFactory: () => client as unknown as ApiClient, spawnQuestionSettlement: spawn,
  }
  const flags = { operationId: 'native-1', nativeAnswers: JSON.stringify([{ question_id: 'q1', choice_ids: ['staging'] }]), text, json: true }
  return { env, owner, sessionId, questionId, file, binding, service, append, emit, confirm, outputs, errors, client, deps, flags, spawn, reply }
}

it('registers native eligibility atomically and the advertised CLI form records then acknowledges', async () => {
  const h = fixture(); h.emit()
  const before = readSessionState(h.sessionId, h.env)
  expect(before.pending?.[0]?.question_id).toBe(h.binding.question_id)
  const exits: number[] = []
  const program = buildProgram(h.deps, { exit: code => exits.push(code) })
  await program.parseAsync(['node', 'notifai', 'acknowledge', h.questionId, '--operation-id', h.flags.operationId,
    '--native-answers', h.flags.nativeAnswers, '--text', h.flags.text, '--json'])
  expect(exits).toEqual([EXIT.ok])
  expect(h.client.recordHarnessAnswer).toHaveBeenCalledWith('req_original', {
    session_id: h.sessionId, submission_id: expect.any(String), answers: [{ question_id: 'q1', choice_ids: ['staging'] }],
  })
  expect(h.client.putAgentAcknowledgement).toHaveBeenCalledWith('req_original', { session_id: h.sessionId, reply_seq: 1, text: h.flags.text })
  expect(h.client.recordHarnessAnswer.mock.invocationCallOrder[0]).toBeLessThan(h.client.putAgentAcknowledgement.mock.invocationCallOrder[0]!)
  expect(readSessionState(h.sessionId, h.env).pending).toEqual(before.pending)
  expect(readSessionState(h.sessionId, h.env).codex_question_bindings?.[0]?.questions[0]).toMatchObject({
    verified: true, native: { turn_id: 'turn-1', call_id: 'native_call', index: 0 },
  })
  expect(JSON.parse(h.outputs.at(-1)!).ok).toBe(true)
  expect(JSON.stringify(h.client.recordHarnessAnswer.mock.calls)).not.toContain('native_call')
})

it('persists command-discovered ambiguity even when admission fails and the duplicate later disappears', async () => {
  const h = fixture(); h.emit()
  const singleLength = statSync(h.file).size
  h.emit('duplicate_call')
  expect(await acknowledgeCommand(h.deps, h.questionId, h.flags)).toBe(EXIT.failed)
  expect(readSessionState(h.sessionId, h.env).codex_question_bindings?.[0]?.questions[0]?.ambiguous).toBe(true)
  truncateSync(h.file, singleLength)
  expect(await acknowledgeCommand(h.deps, h.questionId, h.flags)).toBe(EXIT.failed)
  expect(h.client.recordHarnessAnswer).not.toHaveBeenCalled()
})

it('recovers missing emission using the original full command rather than an unsaved identity-only retry', async () => {
  const h = fixture()
  expect(await acknowledgeCommand(h.deps, h.questionId, h.flags)).toBe(EXIT.failed)
  expect(JSON.parse(h.outputs.at(-1)!)).toMatchObject({ next: expect.stringContaining('original command') })
  expect(JSON.parse(h.outputs.at(-1)!).retry).toBeUndefined()
  h.emit()
  expect(await acknowledgeCommand(h.deps, h.questionId, h.flags)).toBe(EXIT.ok)
  expect(h.client.recordHarnessAnswer).toHaveBeenCalledOnce()
})

it('saves an early native answer before launching original submission recovery', async () => {
  const h = fixture(false); h.emit()
  h.spawn.mockImplementation(() => {
    expect(readSessionState(h.sessionId, h.env).native_answer_operations?.[0]?.answers).toEqual([{ question_id: 'q1', choice_ids: ['staging'] }])
    expect(h.client.recordHarnessAnswer).not.toHaveBeenCalled()
    h.confirm()
  })
  expect(await acknowledgeCommand(h.deps, h.questionId, h.flags)).toBe(EXIT.ok)
  expect(h.spawn).toHaveBeenCalledOnce()
  expect(h.client.recordHarnessAnswer).toHaveBeenCalledOnce()
})

it('leaves unavailable submission unresolved and resumes the identical operation after confirmation', async () => {
  const h = fixture(false); h.emit()
  expect(await acknowledgeCommand(h.deps, h.questionId, h.flags)).toBe(EXIT.failed)
  const saved = readSessionState(h.sessionId, h.env).native_answer_operations![0]!
  expect(saved.request_id).toBeUndefined()
  expect(h.client.recordHarnessAnswer).not.toHaveBeenCalled()
  h.confirm()
  expect(await acknowledgeCommand(h.deps, h.questionId, { operationId: 'native-1', json: true })).toBe(EXIT.ok)
  expect(readSessionState(h.sessionId, h.env).native_answer_operations?.[0]?.submission_id).toBe(saved.submission_id)
})

it('retries lost acknowledgement responses and reports an already acknowledged operation without redoing it', async () => {
  const h = fixture(); h.emit()
  h.client.putAgentAcknowledgement.mockRejectedValueOnce(new Error('receipt lost'))
  expect(await acknowledgeCommand(h.deps, h.questionId, h.flags)).toBe(EXIT.failed)
  expect(await acknowledgeCommand(h.deps, h.questionId, { operationId: 'native-1', json: true })).toBe(EXIT.ok)
  expect(await acknowledgeCommand(h.deps, h.questionId, { operationId: 'native-1', json: true })).toBe(EXIT.ok)
  expect(h.client.putAgentAcknowledgement).toHaveBeenCalledTimes(2)
  expect(JSON.parse(h.outputs.at(-1)!).already_acknowledged).toBe(true)
  expect(h.client.recordHarnessAnswer.mock.calls[0]).toEqual(h.client.recordHarnessAnswer.mock.calls[2])
})

it.each(['missing-emission', 'wrong-session', 'contested', 'wrong-machine', 'closed'])('refuses unqualified native reporting before HTTP: %s', async scenario => {
  const h = fixture()
  if (scenario !== 'missing-emission') h.emit()
  if (scenario === 'wrong-session') h.env['CODEX_THREAD_ID'] = 'another'
  if (scenario === 'contested') h.env['CLAUDECODE'] = '1'
  if (scenario === 'wrong-machine') h.deps.store.load = () => ({ baseUrl: h.service.base_url, machineId: 'other', secret: 'isolated-test', machineName: 'other' })
  if (scenario === 'closed') expect(await closeCommand(h.deps, h.questionId, { json: true })).toBe(EXIT.ok)
  expect(await acknowledgeCommand(h.deps, h.questionId, h.flags)).not.toBe(EXIT.ok)
  expect(h.client.recordHarnessAnswer).not.toHaveBeenCalled()
  expect(h.client.putAgentAcknowledgement).not.toHaveBeenCalled()
  expect(JSON.parse(h.outputs.at(-1)!).retry).toBeUndefined()
})

it('records a later native answer after natural app-window retirement', async () => {
  const h = fixture(); h.emit()
  updateSessionState(h.sessionId, h.env, state => ({ ...rememberQuestionState(state, state.pending![0]!, 'retired'), pending: [] }))
  expect(await acknowledgeCommand(h.deps, h.questionId, h.flags)).toBe(EXIT.ok)
  expect(h.client.recordHarnessAnswer).toHaveBeenCalledOnce()
  expect(readSessionState(h.sessionId, h.env).pending).toEqual([])
})

it('revokes a native registration added between close-pending discovery and actual retirement', async () => {
  const h = fixture(); h.emit()
  let added: string | undefined
  const retire = retirement.retireQueuedQuestions
  vi.spyOn(retirement, 'retireQueuedQuestions').mockImplementationOnce((...args) => {
    added = registerQuestion(h.sessionId, h.env, { question: 'Later?', summary: 'Later?', service_identity: h.service,
      questions: [{ id: 'q1', text: 'Later?' }] }, Date.now(), { owner_key: h.owner.key, turn_id: 'turn-1', service: h.service })
    return retire(...args)
  })
  expect(await closeCommand(h.deps, undefined, { pending: true, json: true })).toBe(EXIT.ok)
  expect(added).toBeDefined()
  const state = readSessionState(h.sessionId, h.env)
  expect(state.pending ?? []).toEqual([])
  expect(state.codex_question_bindings?.find(binding => binding.question_id === added)?.terminated).toBe(true)
})

it('refuses a Machine switch between native report and authored acknowledgement', async () => {
  const h = fixture(); h.emit()
  h.client.recordHarnessAnswer.mockImplementationOnce(async () => {
    h.deps.store.load = () => ({ baseUrl: h.service.base_url, machineId: 'other', secret: 'isolated-test', machineName: 'other' })
    return h.reply
  })
  expect(await acknowledgeCommand(h.deps, h.questionId, h.flags)).toBe(EXIT.failed)
  expect(h.client.putAgentAcknowledgement).not.toHaveBeenCalled()
  expect(readSessionState(h.sessionId, h.env).native_answer_operations?.[0]?.report?.reply_seq).toBe(1)
})

it('rejects new identity-only operations and native options on ordinary request acknowledgements', async () => {
  const h = fixture(); h.emit()
  expect(await acknowledgeCommand(h.deps, h.questionId, { operationId: 'unknown', json: true })).toBe(EXIT.failed)
  expect(await acknowledgeCommand(h.deps, 'req_original', h.flags)).toBe(EXIT.usage)
  expect(h.client.recordHarnessAnswer).not.toHaveBeenCalled()
})

it('records a terminal answer to a Claude Code picker through the same report and acknowledgement', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-native-claude-')); roots.push(root)
  const sessionId = '33333333-3333-4333-8333-333333333333'
  const env: NodeJS.ProcessEnv = { HOME: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: sessionId }
  const owner = beginSessionIncarnation(sessionId, env, { stamp: lifecycleStamp(), harnessProcess: currentProcessIdentity()! })
  writeSessionState(sessionId, env, { harness: 'claude-code' })
  const service = { base_url: 'https://api.example.test', machine_id: 'machine_test' }
  const questions = [{ id: 'q1', text: 'Where?', choices: [{ id: 'staging', label: 'Staging' }, { id: 'production', label: 'Production' }] }]
  const questionId = registerQuestion(sessionId, env, { question: 'Where?', summary: 'Where?', service_identity: service, questions },
    Date.now(), { owner_key: owner.key, turn_id: CLAUDE_PICKER_TURN, service })
  recordConfirmedNativeAnswerTarget(sessionId, env, { question_id: questionId, request_id: 'req_original', question: 'Where?', summary: 'Where?', service_identity: service })
  const text = 'Deploying to staging.'
  const client = {
    recordHarnessAnswer: vi.fn(async () => ({ status: 'recorded', reply_seq: 1, complete: true, other_submissions: [],
      answer_version: { version_id: 'rpl_native', origin: 'harness', provenance: 'agent-reported', source: 'reply', base_version: null,
        status: 'presented', not_delivered_reason: null, text: 'Staging', answers: [{ question_id: 'q1', choice_ids: ['staging'], text: null }],
        device_id: null, created_at: '2026-10-05T12:00:00Z', agent_acknowledgement: null } }) as RecordHarnessAnswerResponse),
    putAgentAcknowledgement: vi.fn(async () => ({ status: 'recorded' as const, agent_acknowledgement: { text, created_at: '2026-10-05T12:00:01Z' } })),
  }
  const outputs: string[] = []
  const deps: CommandDeps = { env, cwd: root, now: () => 1, sleep: async () => {},
    io: { out: line => outputs.push(line), err: () => {}, confirm: async () => false, openUrl: () => {} },
    store: { load: () => ({ baseUrl: service.base_url, machineId: service.machine_id, secret: 'isolated-test', machineName: 'test' }),
      describe: () => 'isolated', save: () => {}, clear: () => {} } as unknown as CommandDeps['store'],
    clientFactory: () => client as unknown as ApiClient, spawnQuestionSettlement: vi.fn(),
  }
  const flags = { operationId: 'native-1', nativeAnswers: JSON.stringify([{ question_id: 'q1', choice_ids: ['staging'] }]), text, json: true }

  // Before Claude Code has shown the picker nothing proves the User saw it.
  expect(await acknowledgeCommand(deps, questionId, flags)).toBe(EXIT.failed)
  expect(client.recordHarnessAnswer).not.toHaveBeenCalled()

  updateSessionState(sessionId, env, state => observeClaudePicker(state, questionId, 'toolu_1'))
  outputs.length = 0
  expect(await acknowledgeCommand(deps, questionId, flags)).toBe(EXIT.ok)
  expect(client.recordHarnessAnswer).toHaveBeenCalledTimes(1)
  expect(client.putAgentAcknowledgement).toHaveBeenCalledTimes(1)
  expect(JSON.parse(outputs.join('\n'))).toMatchObject({ ok: true, question_id: questionId, request_id: 'req_original' })
})
