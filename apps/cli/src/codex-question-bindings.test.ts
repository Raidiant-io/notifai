import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { admitBoundNativeAnswer, markCodexOrdinaryPresentation, mayRetireFromPrompt, nativeQuestionTitle, observeCodexQuestions, reserveCodexQuestion } from './codex-question-bindings.js'
import { readNativeQuestionSnapshot } from './codex-native-turn.js'
import { confirmNativeAnswerTarget, prepareNativeAnswerOperation } from './native-answer-operation.js'
import { beginSessionIncarnation, clearSessionState, lifecycleStamp, readSessionState, writeSessionState } from './hook-session-state.js'
import { pendingAnsweredByPrompt } from './hook-question-retirement.js'
import type { PendingQuestion, SessionState } from './hook-types.js'

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
  let state = reserveCodexQuestion(initial, pending, owner.key, snapshot())
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
  return { env, file, append, owner, pending, initial, snapshot, binding, emit, observe, admit,
    state: () => state, setState: (next: SessionState) => { state = next } }
}

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

it('rejects changed titles/options, quoted markers, pre-registration emissions and wrong owners', () => {
  const h = fixture()
  h.append('response_item', { type: 'message', role: 'user', content: [{ text: nativeQuestionTitle(h.binding()) }] })
  expect(h.observe().verified).toBeUndefined()
  h.emit(undefined, ['Different', 'Production'])
  expect(h.observe().verified).toBeUndefined()
  const fresh = fixture(); fresh.emit(); fresh.observe()
  const snapshot = fresh.snapshot()
  const pre = { ...snapshot, questions: snapshot.questions!.map(q => ({ ...q, offset: 0 })) }
  expect(observeCodexQuestions(fresh.state(), fresh.owner.key, pre).codex_question_bindings?.[0]?.questions[0]?.verified).toBeUndefined()
  expect(() => admitBoundNativeAnswer(fresh.state(), 'q_registered', 'foreign', service, [{ question_id: 'q1', text: 'Go' }])).toThrow('owner')
  expect(() => admitBoundNativeAnswer(fresh.state(), 'q_registered', fresh.owner.key, { ...service, machine_id: 'other' }, [{ question_id: 'q1', text: 'Go' }])).toThrow('Machine')
})

it('invalidates a late duplicate before shape filtering and never reauthorizes it', () => {
  const h = fixture(); h.emit(); expect(h.observe().verified).toBe(true)
  const once = h.snapshot()
  h.emit(undefined, ['Changed', 'Options'])
  expect(h.observe().ambiguous).toBe(true)
  expect(h.binding().verified).toBeUndefined()
  h.setState(observeCodexQuestions(h.state(), h.owner.key, once))
  expect(h.binding().ambiguous).toBe(true)
  expect(() => h.admit()).toThrow('verified native')
})

it('does not bind a sole matching form emitted in a later turn', () => {
  const h = fixture()
  h.append('event_msg', { type: 'task_complete', turn_id: 'registration' })
  h.append('event_msg', { type: 'task_started', turn_id: 'later' })
  h.emit()
  expect(h.observe().verified).toBeUndefined()
  expect(() => h.admit()).toThrow('verified native')
})

it('withdraws eligibility when full registration-turn or file identity evidence is missing', () => {
  const h = fixture(); h.emit(); h.observe()
  for (const snapshot of [null, { ...h.snapshot(), positions: new Map() }, { ...h.snapshot(), identity: 'replaced' }]) {
    const observed = observeCodexQuestions(h.state(), h.owner.key, snapshot).codex_question_bindings![0]!.questions[0]!
    expect(observed.verified).toBeUndefined()
    expect(observed.native).toEqual(h.binding().native)
  }
  h.append('response_item', { type: 'message', text: 'x'.repeat(9 * 1024 * 1024) })
  h.append('event_msg', { type: 'task_started', turn_id: 'later' })
  expect(h.snapshot().positions.has('registration')).toBe(false)
  expect(h.observe().verified).toBeUndefined()
})

it('allocates unique local markers across registrations and expands beyond three characters', () => {
  const h = fixture()
  h.setState(reserveCodexQuestion(h.state(), { ...h.pending, question_id: 'q_second' }, h.owner.key, h.snapshot()))
  const markers = h.state().codex_question_bindings!.flatMap(r => r.questions.map(q => q.marker))
  expect(new Set(markers).size).toBe(2)
  const expanded = reserveCodexQuestion({ ...h.state(), codex_question_marker_counter: 36 ** 3 - 1 }, { ...h.pending, question_id: 'q_third' }, h.owner.key, h.snapshot())
  expect(expanded.codex_question_bindings?.at(-1)?.questions[0]?.marker).toBe('1000')
  // Native tokens remain local; original app question content is unchanged.
  expect(expanded.pending?.[0]?.questions).toEqual(h.pending.questions)
})

it('keeps ordinary presentation sticky while still allowing a fresh native submission', () => {
  const h = fixture()
  h.setState(markCodexOrdinaryPresentation(h.state(), new Set(['q_registered'])))
  h.emit(); h.observe()
  expect(h.state().codex_question_bindings?.[0]?.ordinary_only).toBe(true)
  expect(h.admit()).toEqual({ service })
  writeSessionState('session', h.env, h.state())
  clearSessionState('session', h.env)
  expect(readSessionState('session', h.env).codex_question_bindings?.[0]?.ordinary_only).toBe(true)
})

it('retains a confirmed target through cleanup before the first native operation exists', () => {
  const h = fixture(); h.emit(); h.observe()
  h.setState(confirmNativeAnswerTarget(h.state(), { ...h.pending, request_id: 'req_original' }))
  writeSessionState('session', h.env, h.state())
  clearSessionState('session', h.env)
  const owner = { sessionId: 'session', key: h.owner.key, service }
  const operation = prepareNativeAnswerOperation(owner, h.env, {
    questionId: 'q_registered', operationId: 'native-1', answers: [{ question_id: 'q1', choice_ids: ['staging'] }], text: 'Deploying to staging.',
  }, (state, answers) => admitBoundNativeAnswer(observeCodexQuestions(state, owner.key, h.snapshot()), 'q_registered', owner.key, service, answers))
  expect(operation.request_id).toBe('req_original')
})

it('protects a reservation before binding without changing sibling prompt ambiguity', () => {
  const h = fixture()
  const sibling = { ...h.pending, question_id: 'q_unbound' }
  const all = [h.pending, sibling]
  expect(pendingAnsweredByPrompt('Staging', all).filter(q => mayRetireFromPrompt(h.state(), q))).toEqual([])
  expect(pendingAnsweredByPrompt('done', all).filter(q => mayRetireFromPrompt(h.state(), q))).toEqual([])
  expect(pendingAnsweredByPrompt('Staging', [h.pending]).filter(q => mayRetireFromPrompt(h.state(), q))).toEqual([])
  expect(pendingAnsweredByPrompt('Staging', [sibling]).filter(q => mayRetireFromPrompt(h.state(), q))).toEqual([sibling])
})

it('validates registered choice IDs and typed answers', () => {
  const h = fixture(); h.emit(); h.observe()
  for (const answers of [[{ question_id: 'q_other', text: 'Hello' }], [{ question_id: 'q1', choice_ids: ['unknown'] }],
    [{ question_id: 'q1', choice_ids: ['staging', 'production'] }], [{ question_id: 'q1', text: ' ' }]]) {
    expect(() => admitBoundNativeAnswer(h.state(), 'q_registered', h.owner.key, service, answers)).toThrow('registered')
  }
  expect(admitBoundNativeAnswer(h.state(), 'q_registered', h.owner.key, service, [{ question_id: 'q1', text: 'Another location' }])).toEqual({ service })
})

it('admits a partial typed or choice answer only for its bound form questions', () => {
  const h = fixture()
  const multi: PendingQuestion = { ...h.pending, question_id: 'q_multi', questions: [
    { id: 'locations', text: 'Which location?', choices: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] },
    { id: 'why', text: 'Why?' },
  ] }
  h.setState(reserveCodexQuestion(h.state(), multi, h.owner.key, h.snapshot()))
  const bindings = h.state().codex_question_bindings![1]!.questions
  h.emit(nativeQuestionTitle(bindings[0]!), ['One', 'Two'])
  h.emit(nativeQuestionTitle(bindings[1]!), null)
  h.observe()
  expect(admitBoundNativeAnswer(h.state(), 'q_multi', h.owner.key, service, [{ question_id: 'why', text: 'Because' }])).toEqual({ service })
  expect(admitBoundNativeAnswer(h.state(), 'q_multi', h.owner.key, service, [{ question_id: 'locations', choice_ids: ['one'] }])).toEqual({ service })
})

it('leaves multi-select forms on ordinary delivery because native async options are single-select', () => {
  const h = fixture()
  const multi = { ...h.pending, question_id: 'q_multi', questions: h.pending.questions!.map(question => ({ ...question, multi: true })) }
  expect(reserveCodexQuestion(h.state(), multi, h.owner.key, h.snapshot())).toBe(h.state())
  expect(mayRetireFromPrompt(h.state(), multi)).toBe(true)
})
