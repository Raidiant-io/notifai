import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { nativeTranscriptOwned, readNativeQuestionSnapshot, readNativeTurnSnapshot } from './codex-native-turn.js'
import { beginSessionIncarnation, lifecycleStamp } from './hook-session-state.js'
import { currentCodexTurn, readTurnActivity, reconcileNativeTurn, recordTurnEnd, recordTurnStart } from './session-attendant-state.js'
import { acquireClaimFile, readClaimFile, releaseClaimFile, requestClaimHandoff } from './hook-question-lock.js'
import { currentProcessIdentity } from './process-identity.js'
import { codexInputObserver, refreshCodexInputActivity } from './codex-input-lifecycle.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(withOwner = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-native-turn-')); roots.push(root)
  const env = { CODEX_HOME: path.join(root, 'codex'), XDG_STATE_HOME: path.join(root, 'state') }
  const file = path.join(env.CODEX_HOME, 'sessions', 'sample.jsonl')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: 'root', source: 'cli' } })}\n`)
  const key = beginSessionIncarnation('root', env, { stamp: lifecycleStamp(), ...(withOwner ? { harnessProcess: currentProcessIdentity()! } : {}) }).key
  const event = (type: string, turn_id: string) => appendFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type, turn_id } })}\n`)
  const snapshot = () => readNativeTurnSnapshot(file, 'root', env)!
  return { root, env, file, key, event, snapshot }
}

it('observes only accepted native calls with their exact turn/call/question tuple', () => {
  const f = fixture()
  f.event('task_started', 'one')
  const append = (payload: unknown) => appendFileSync(f.file, `${JSON.stringify({ type: 'response_item', payload })}\n`)
  const questions = [{ title: '[nf:001] Deploy where?', options: ['Staging', 'Production'] }, { title: 'Deploy where?', options: ['Staging', 'Production'] }]
  append({ type: 'message', role: 'user', content: [{ text: JSON.stringify({ name: 'request_user_input_async', questions }) }] })
  append({ type: 'function_call', name: 'request_user_input_async', call_id: 'call_one', arguments: JSON.stringify({ questions }) })
  expect(readNativeQuestionSnapshot(f.file, 'root', f.env)?.questions?.every(q => !q.accepted)).toBe(true)
  append({ type: 'function_call_output', call_id: 'call_one', output: '{"accepted":true}' })
  f.event('task_complete', 'one')
  f.event('task_started', 'two')
  append({ type: 'message', role: 'user', content: [{ text: '<send_user_message_question_reply>app answer</send_user_message_question_reply>' }] })
  append({ type: 'function_call', name: 'request_user_input_async', call_id: 'call_two', arguments: JSON.stringify({ questions: [{ title: '[nf:002] Free text?' }] }) })
  append({ type: 'function_call_output', call_id: 'call_two', output: '{"accepted":false}' })
  expect(readNativeQuestionSnapshot(f.file, 'root', f.env)?.questions).toEqual([
    { turn_id: 'one', call_id: 'call_one', index: 0, ...questions[0], accepted: true },
    { turn_id: 'one', call_id: 'call_one', index: 1, ...questions[1], accepted: true },
    { turn_id: 'two', call_id: 'call_two', index: 0, title: '[nf:002] Free text?', accepted: false },
  ])
  expect(readNativeTurnSnapshot(f.file, 'root', f.env)?.questions).toBeUndefined()
})

it('rejects malformed question/acceptance evidence without breaking the activity-only reader', () => {
  const f = fixture()
  f.event('task_started', 'one')
  appendFileSync(f.file, `${JSON.stringify({ type: 'response_item', payload: {
    type: 'function_call', name: 'request_user_input_async', call_id: 'call_one', arguments: '{bad',
  } })}\n`)
  expect(readNativeQuestionSnapshot(f.file, 'root', f.env)).toBeNull()
  expect(readNativeTurnSnapshot(f.file, 'root', f.env)?.latest.id).toBe('one')
})

it('keeps duplicate native emissions visible so the binder cannot silently pick one', () => {
  const f = fixture()
  f.event('task_started', 'one')
  for (const call of ['first', 'second']) {
    for (const payload of [
      { type: 'function_call', name: 'request_user_input_async', call_id: call, arguments: JSON.stringify({ questions: [{ title: '[nf:001] Same?' }] }) },
      { type: 'function_call_output', call_id: call, output: '{"accepted":true}' },
    ]) appendFileSync(f.file, `${JSON.stringify({ type: 'response_item', payload })}\n`)
  }
  expect(readNativeQuestionSnapshot(f.file, 'root', f.env)?.questions?.filter(q => q.accepted)).toHaveLength(2)
})

it('does not associate a tail-only old call with a newer fully observed turn', () => {
  const f = fixture()
  f.event('task_started', 'outside-tail')
  appendFileSync(f.file, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', text: 'x'.repeat(9 * 1024 * 1024) } })}\n`)
  const call = (id: string) => {
    for (const payload of [
      { type: 'function_call', name: 'request_user_input_async', call_id: id, arguments: JSON.stringify({ questions: [{ title: '[nf:001] Same?' }] }) },
      { type: 'function_call_output', call_id: id, output: '{"accepted":true}' },
    ]) appendFileSync(f.file, `${JSON.stringify({ type: 'response_item', payload })}\n`)
  }
  call('old')
  f.event('task_started', 'inside-tail')
  call('new')
  expect(readNativeQuestionSnapshot(f.file, 'root', f.env)?.questions).toEqual([
    { turn_id: 'inside-tail', call_id: 'new', index: 0, title: '[nf:001] Same?', accepted: true },
  ])
})

it.each(['completed', 'aborted', 'empty-call-id', 'reused-call-id'])('rejects impossible native question emission: %s', scenario => {
  const f = fixture()
  f.event('task_started', 'one')
  if (scenario === 'completed') f.event('task_complete', 'one')
  if (scenario === 'aborted') f.event('turn_aborted', 'one')
  const payload = { type: 'function_call', name: 'request_user_input_async',
    call_id: scenario === 'empty-call-id' ? '' : 'one',
    arguments: JSON.stringify({ questions: [{ title: '[nf:001] Same?' }] }),
  }
  appendFileSync(f.file, `${JSON.stringify({ type: 'response_item', payload })}\n`)
  if (scenario === 'reused-call-id') appendFileSync(f.file, `${JSON.stringify({ type: 'response_item', payload })}\n`)
  expect(readNativeQuestionSnapshot(f.file, 'root', f.env)).toBeNull()
})

it('refreshes actual completion without a subsequent hook and distinguishes an abort', () => {
  const f = fixture(true)
  recordTurnStart('root', f.env, f.key, 'one')
  f.event('task_started', 'one')
  expect(refreshCodexInputActivity('root', f.env, f.key, f.file)).toBe('working')
  expect(refreshCodexInputActivity('root', f.env, 'superseded', f.file)).toBe('unknown')
  f.event('task_complete', 'one')
  expect(refreshCodexInputActivity('root', f.env, f.key)).toBe('idle')
  f.event('task_started', 'two')
  expect(refreshCodexInputActivity('root', f.env, f.key)).toBe('working')
  f.event('turn_aborted', 'two')
  expect(refreshCodexInputActivity('root', f.env, f.key)).toBe('aborted')
})

it('does not turn missing owner or a partial native record into idle', () => {
  const unowned = fixture(); unowned.event('task_started', 'one')
  expect(refreshCodexInputActivity('root', unowned.env, unowned.key, unowned.file)).toBe('unknown')
  const f = fixture(true); recordTurnStart('root', f.env, f.key, 'one'); f.event('task_started', 'one')
  expect(refreshCodexInputActivity('root', f.env, f.key, f.file)).toBe('working')
  appendFileSync(f.file, '{"type":"event_msg"')
  expect(refreshCodexInputActivity('root', f.env, f.key)).toBe('unknown')
  expect(currentCodexTurn('root', f.env, f.key)).toBe('one')
})

it('recovers an async-only start and closes exactly that native turn', () => {
  const f = fixture()
  recordTurnStart('root', f.env, f.key, 'previous'); recordTurnEnd('root', f.env, 'previous')
  f.event('task_started', 'current')
  expect(reconcileNativeTurn('root', f.env, f.key, 'current', f.snapshot(), () => true)).toBe(true)
  expect(readTurnActivity('root', f.env, f.key)).toBe('working')
  f.event('task_complete', 'current')
  reconcileNativeTurn('root', f.env, f.key, 'current', f.snapshot(), () => true)
  expect(readTurnActivity('root', f.env, f.key)).toBe('idle')
})

it('rejects an unseen older callback and a stale snapshot racing a synchronous newer start', () => {
  const f = fixture()
  recordTurnStart('root', f.env, f.key, 'previous'); recordTurnEnd('root', f.env, 'previous')
  f.event('task_started', 'old-unseen')
  const oldSnapshot = f.snapshot()
  f.event('task_complete', 'old-unseen'); f.event('task_started', 'new')
  expect(reconcileNativeTurn('root', f.env, f.key, 'old-unseen', f.snapshot(), () => true)).toBe(false)
  recordTurnStart('root', f.env, f.key, 'new')
  expect(reconcileNativeTurn('root', f.env, f.key, 'old-unseen', oldSnapshot, () => true)).toBe(false)
  expect(currentCodexTurn('root', f.env, f.key)).toBe('new')
  reconcileNativeTurn('root', f.env, f.key, 'new', f.snapshot(), () => true)
  recordTurnEnd('root', f.env, 'new')
  expect(reconcileNativeTurn('root', f.env, f.key, 'old-unseen', oldSnapshot, () => true)).toBe(false)
  expect(readTurnActivity('root', f.env, f.key)).toBe('idle')
})

it('does not reactivate ended work or create a replacement incarnation during re-arm', () => {
  const f = fixture(); f.event('task_started', 'one')
  expect(reconcileNativeTurn('root', f.env, f.key, 'one', f.snapshot(), () => true)).toBe(false)
  expect(reconcileNativeTurn('root', f.env, f.key, 'one', f.snapshot(), () => false, true)).toBe(false)
  expect(reconcileNativeTurn('root', f.env, f.key, 'one', f.snapshot(), () => true, true)).toBe(true)
  recordTurnEnd('root', f.env, 'one')
  expect(reconcileNativeTurn('root', f.env, f.key, 'one', f.snapshot(), () => true)).toBe(false)
  expect(reconcileNativeTurn('root', f.env, 'other-incarnation', 'one', f.snapshot(), () => true)).toBe(false)
})

it('confirms an already-ended native turn as Idle during update recovery', () => {
  const f = fixture()
  recordTurnStart('root', f.env, f.key, 'previous'); recordTurnEnd('root', f.env, 'previous')
  f.event('task_started', 'latest'); f.event('task_complete', 'latest')
  recordTurnEnd('root', f.env, 'latest')
  expect(reconcileNativeTurn('root', f.env, f.key, 'latest', f.snapshot(), () => true)).toBe(true)
  expect(readTurnActivity('root', f.env, f.key)).toBe('idle')
})

it('rejects wrong roots, child transcripts, symlinks and partial native records', () => {
  const f = fixture(); f.event('task_started', 'one')
  expect(readNativeTurnSnapshot(f.file, 'another-root', f.env)).toBeNull()
  expect(nativeTranscriptOwned(f.file, 'another-root', f.env)).toBe(false)
  const link = path.join(path.dirname(f.file), 'linked.jsonl'); symlinkSync(f.file, link)
  expect(readNativeTurnSnapshot(link, 'root', f.env)).toBeNull()
  expect(nativeTranscriptOwned(link, 'root', f.env)).toBe(false)
  appendFileSync(f.file, '{"type":"event_msg"')
  expect(f.snapshot()).toBeNull()
  writeFileSync(f.file, `${JSON.stringify({ type: 'session_meta', payload: { id: 'root', source: { subagent: {} } } })}\n`)
  f.event('task_started', 'one')
  expect(f.snapshot()).toBeNull()
  expect(nativeTranscriptOwned(f.file, 'root', f.env)).toBe(false)
})

it('never guesses a current start when a large conversation record exceeds the bounded tail', () => {
  const f = fixture(); f.event('task_started', 'one')
  appendFileSync(f.file, `${JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(9 * 1024 * 1024) } })}\n`)
  expect(f.snapshot()).toBeNull()
  expect(nativeTranscriptOwned(f.file, 'root', f.env)).toBe(true)
})

it('fences the exact old writer without releasing its live process claim to a concurrent successor', () => {
  const f = fixture(); const claim = path.join(f.root, 'owner.claim')
  const token = acquireClaimFile(claim, { incarnation: 'inc_example' })!
  expect(requestClaimHandoff(claim, token, 'inc_other')).toBe(false)
  expect(readClaimFile(claim)?.['token']).toBe(token)
  expect(requestClaimHandoff(claim, token, 'inc_example')).toBe(true)
  expect(readClaimFile(claim)).toMatchObject({ handoff: true, pid: process.pid, incarnation: 'inc_example' })
  expect(readClaimFile(claim)?.['token']).not.toBe(token)
  // This is exactly the old attendant's claimHeld predicate: it must cancel.
  expect(readClaimFile(claim)?.['token'] === token).toBe(false)
  releaseClaimFile(claim, token)
  expect(readClaimFile(claim)).not.toBeNull()
  expect(acquireClaimFile(claim, { incarnation: 'inc_example' })).toBeNull()
})

it('grants fallback only for a continuous read gap, resetting even on an empty-inbox probe', () => {
  const f = fixture(true)
  recordTurnStart('root', f.env, f.key, 'busy')
  f.event('task_started', 'busy')
  let now = 0
  const observer = codexInputObserver('root', f.env, f.key, () => now, f.file)
  expect(observer.observe()).toBe('working')
  const gap = () => appendFileSync(f.file, '{"type":"event_msg"')
  const recover = () => appendFileSync(f.file, ',"payload":{"type":"unrelated"}}\n')
  gap()
  expect(observer.mayWake()).toBe(false)
  now = 5_999
  expect(observer.mayWake()).toBe(false)
  recover()
  // A foreground hook drained the input. The ordinary presence probe is the
  // only caller now, and must still reset the scheduling grace interval.
  expect(observer.observe()).toBe('working')
  now = 10_000
  gap()
  expect(observer.mayWake()).toBe(false)
  now = 15_999
  expect(observer.mayWake()).toBe(false)
  now = 16_000
  expect(observer.mayWake()).toBe(true)
  recover()
  expect(observer.mayWake()).toBe(false)
  f.event('task_complete', 'busy')
  expect(observer.mayWake()).toBe(true)
  f.event('task_started', 'new-prompt')
  expect(observer.mayWake()).toBe(false)
})
