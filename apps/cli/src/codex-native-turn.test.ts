import type fs from 'node:fs'
import { appendFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,expect,it,vi } from 'vitest'
import { readNativeQuestionSnapshot,readNativeTurnSnapshot,recoverNativeTurnSnapshot } from './codex-native-turn.js'
import { beginSessionIncarnation,lifecycleStamp } from './hook-session-state.js'
import { currentProcessIdentity } from './process-identity.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, readSync: vi.fn(actual.readSync) }
})

const roots: string[] = []
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
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
    { offset: expect.any(Number), turn_id: 'one', call_id: 'call_one', index: 0, ...questions[0], accepted: true },
    { offset: expect.any(Number), turn_id: 'one', call_id: 'call_one', index: 1, ...questions[1], accepted: true },
    { offset: expect.any(Number), turn_id: 'two', call_id: 'call_two', index: 0, title: '[nf:002] Free text?', accepted: false },
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

it('recovers an existing long transcript during an explicit update and stops when its owner changes', async () => {
  const f = fixture()
  f.event('task_started', 'long-turn')
  const output = `${JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1024) } })}\n`.repeat(8200)
  appendFileSync(f.file, output)
  expect((await recoverNativeTurnSnapshot(f.file, 'root', f.env, () => true))?.latest.id).toBe('long-turn')
  expect(await recoverNativeTurnSnapshot(f.file, 'root', f.env, () => false)).toBeNull()
  appendFileSync(f.file, '{"type":"event_msg"')
  expect(await recoverNativeTurnSnapshot(f.file, 'root', f.env, () => true)).toBeNull()
})
