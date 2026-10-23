import type { RecordHarnessAnswerResponse } from '@raidiant/notifai-protocol'
import { appendFileSync,mkdirSync,mkdtempSync,rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,describe,expect,it,vi } from 'vitest'
import type { ApiClient } from './client.js'
import { readNativeQuestionSnapshot } from './codex-native-turn.js'
import { nativeQuestionTitle } from './codex-question-bindings.js'
import { acknowledgeCommand } from './commands-acknowledge.js'
import { closeCommand } from './commands-close.js'
import { EXIT,type CommandDeps } from './commands-core.js'
import { registerQuestion } from './hook-lifecycle.js'
import { inspectQuestionState } from './hook-question-state.js'
import { beginSessionIncarnation,lifecycleStamp,readSessionState,updateSessionState,writeSessionState } from './hook-session-state.js'
import { questionsAwaitingAnswer,recordConfirmedNativeAnswerTarget } from './native-answer-operation.js'
import { currentProcessIdentity } from './process-identity.js'
import { buildProgram } from './program.js'
import { recordTurnStart } from './session-attendant-state.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
// New registrations use exact cards; an installed older skill may still own
// this persisted marker shape. Exercise its compatibility path explicitly.
function rememberLegacyBinding(sessionId: string, env: NodeJS.ProcessEnv, questionId: string, ownerKey: string, file: string) {
  const snapshot = readNativeQuestionSnapshot(file, sessionId, env)!
  updateSessionState(sessionId, env, state => {
    const pending = state.pending!.find(question => question.question_id === questionId)!
    return { ...state, codex_question_bindings: [...(state.codex_question_bindings ?? []), {
      question_id: questionId, owner_key: ownerKey, registration_turn_id: snapshot.latest.id,
      transcript: { file: snapshot.file, identity: snapshot.identity, registered_offset: snapshot.size },
      service_identity: pending.service_identity!,
      questions: pending.questions!.map(question => ({ question, marker: '001' })),
    }] }
  })
}
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
  const { question_id: questionId } = registerQuestion(sessionId, env, { question: 'Where?', summary: 'Where?', service_identity: service,
    questions: [{ id: 'q1', text: 'Where?', choices: [{ id: 'staging', label: 'Staging' }, { id: 'production', label: 'Production' }] }],
  }, Date.now(), { owner_key: owner.key, turn_id: 'turn-1', service })
  rememberLegacyBinding(sessionId, env, questionId, owner.key, file)
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

it('records and acknowledges an accepted answer from an installed legacy marker registration', async () => {
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

it('recovers missing emission using the original full command rather than an unsaved identity-only retry', async () => {
  const h = fixture()
  expect(await acknowledgeCommand(h.deps, h.questionId, h.flags)).toBe(EXIT.failed)
  expect(JSON.parse(h.outputs.at(-1)!)).toMatchObject({ next: expect.stringContaining('original command') })
  expect(JSON.parse(h.outputs.at(-1)!).retry).toBeUndefined()
  h.emit()
  expect(await acknowledgeCommand(h.deps, h.questionId, h.flags)).toBe(EXIT.ok)
  expect(h.client.recordHarnessAnswer).toHaveBeenCalledOnce()
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

describe('a settled native answer', () => {
  /** The picker answer lands after ordinary submission made the question live. */
  function live() {
    const h = fixture(); h.emit()
    updateSessionState(h.sessionId, h.env, state => ({ ...state,
      pending: state.pending!.map(entry => ({ ...entry, request_id: 'req_original' })) }))
    return h
  }

  it('reads as answered while its window stays open for a device correction', async () => {
    const h = live()
    expect(inspectQuestionState(h.questionId, h.env)).toMatchObject({ question: { state: 'live' } })
    expect(await acknowledgeCommand(h.deps, h.questionId, h.flags)).toBe(EXIT.ok)
    const state = readSessionState(h.sessionId, h.env)
    expect(state.native_answer_operations?.[0]?.answer_complete).toBe(true)
    expect(state.pending?.[0]?.request_id).toBe('req_original')
    expect(inspectQuestionState(h.questionId, h.env)).toMatchObject({
      question: { state: 'answered', request_id: 'req_original' },
    })
    expect(questionsAwaitingAnswer(state)).toEqual([])
  })
})
