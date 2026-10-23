import { appendFileSync,mkdirSync,mkdtempSync,rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,expect,it } from 'vitest'
import { readNativeQuestionSnapshot } from './codex-native-turn.js'
import { admitBoundNativeAnswer,currentCodexQuestionContext,nativeQuestionTitle,observeCodexQuestions } from './codex-question-bindings.js'
import { beginSessionIncarnation,lifecycleStamp } from './hook-session-state.js'
import type { PendingQuestion,SessionState } from './hook-types.js'
import { currentProcessIdentity } from './process-identity.js'
import { recordTurnStart } from './session-attendant-state.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const service = { base_url: 'https://api.example.test', machine_id: 'machine_test' }
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-binding-')); roots.push(root)
  const env = { CODEX_HOME: path.join(root, 'codex'), XDG_STATE_HOME: path.join(root, 'state') }
  const file = path.join(env.CODEX_HOME, 'sessions', 'owned.jsonl')
  mkdirSync(path.dirname(file), { recursive: true })
  const append = (type: string, payload: unknown) => appendFileSync(file, `${JSON.stringify({ type, payload })}\n`)
  append('session_meta', { id: 'session', source: 'cli' })
  append('event_msg', { type: 'task_started', turn_id: 'registration' })
  const owner = beginSessionIncarnation('session', env, { stamp: lifecycleStamp() })
  const pending: PendingQuestion = { question_id: 'q_registered', question: 'Where?', summary: 'Where?', service_identity: service,
    questions: [{ id: 'q1', text: 'Where?', choices: [{ id: 'staging', label: 'Staging' }, { id: 'production', label: 'Production' }] }],
  }
  const snapshot = () => readNativeQuestionSnapshot(file, 'session', env)!
  const initial = { harness: 'codex', pending: [pending] } as SessionState
  const legacy = (state: SessionState, pending: PendingQuestion, markers: string[]): SessionState => ({ ...state,
    codex_question_bindings: [...(state.codex_question_bindings ?? []), { question_id: pending.question_id!, owner_key: owner.key,
      registration_turn_id: 'registration', service_identity: service,
      transcript: { file: snapshot().file, identity: snapshot().identity, registered_offset: snapshot().size },
      questions: pending.questions!.map((question, index) => ({ question, marker: markers[index]! })) }] })
  let state = legacy(initial, pending, ['001'])
  const binding = () => state.codex_question_bindings![0]!.questions[0]!
  let calls = 0
  const emit = (title = nativeQuestionTitle(binding()), options: string[] | null = ['Staging', 'Production'], accepted: boolean | null = true) => {
    const call_id = `call_${++calls}`
    append('response_item', { type: 'function_call', name: 'request_user_input_async', call_id,
      arguments: JSON.stringify({ questions: [{ title, ...(options === null ? {} : { options }) }] }) })
    if (accepted !== null) append('response_item', { type: 'function_call_output', call_id, output: JSON.stringify({ accepted }) })
    return call_id
  }
  const observe = () => { state = observeCodexQuestions(state, owner.key, snapshot()); return binding() }
  const admit = (answers = [{ question_id: 'q1', choice_ids: ['staging'] }]) => admitBoundNativeAnswer(state, pending.question_id!, owner.key, service, answers)
  return { env, file, append, owner, pending, initial, snapshot, binding, emit, observe, admit, legacy,
    state: () => state, setState: (next: SessionState) => { state = next } }
}

it('keeps current hand-back eligibility after an unrelated denied card', () => {
  const harness = fixture()
  const owner = beginSessionIncarnation('session', harness.env, {
    stamp: lifecycleStamp(), harnessProcess: currentProcessIdentity()!,
  })
  recordTurnStart('session', harness.env, owner.key, 'registration')
  harness.append('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'denied-card',
    arguments: JSON.stringify({ questions: [{ title: 'A mismatched question?', options: ['One', 'Two'] }] }) })
  harness.append('response_item', { type: 'function_call_output', call_id: 'denied-card', output: 'Blocked by hook: use the registered plain question.' })
  const state: SessionState = { ...harness.initial,
    codex_native_turn: { key: owner.key, turn_id: 'registration', transcript_path: harness.file },
    codex_tool_hook: { incarnation: owner.incarnation, fingerprint: 'trusted', root_observed: { turn_id: 'registration', at: Date.now() } },
  }
  expect(currentCodexQuestionContext(state, 'session', harness.env)?.snapshot.latest.id).toBe('registration')
})

it('automatically associates one accepted marked emission, preserving identical unmarked controls', () => {
  const h = fixture()
  h.emit('Where?')
  expect(h.observe().verified).toBeUndefined()
  const call = h.emit()
  expect(h.observe().native).toEqual({ turn_id: 'registration', call_id: call, index: 0 })
  expect(h.binding().verified).toBe(true)
  expect(h.admit()).toEqual({ service })
  expect(h.snapshot().questions).toHaveLength(2)
})

it.each([false, null])('does not bind a question without a successful acceptance receipt: %s', accepted => {
  const h = fixture(); h.emit(undefined, undefined, accepted)
  expect(h.observe().verified).toBeUndefined()
  expect(() => h.admit()).toThrow('verified native')
})
