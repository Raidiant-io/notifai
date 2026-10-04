import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { admitQueuedQuestion, replaceFrozenSubmission } from './hook-question-state.js'
import { readSessionState, writeSessionState } from './hook-session-state.js'
import type { PendingQuestion, PendingSubmissionIntent } from './hook-types.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const identity = { base_url: 'https://api.example.test', machine_id: 'machine_a' }
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-question-owner-'))
  roots.push(root)
  const env = { XDG_STATE_HOME: root }
  const intent = { request_id: 'req_reserved', service_identity: identity } as PendingSubmissionIntent
  const entry: PendingQuestion = { question_id: 'q_one', question: 'Continue?', summary: 'Continue?', service_identity: identity, submission: intent }
  writeSessionState('owner', env, { pending: [entry] })
  return { env, intent, entry }
}

it.each([
  undefined,
  { ...identity, machine_id: 'machine_b' },
  { ...identity, base_url: 'https://other.example.test' },
])('preserves the frozen question without starting HTTP for another client: %j', service => {
  const h = fixture()
  const submit = vi.fn(async () => 'submitted')
  expect(admitQueuedQuestion('owner', h.env, h.entry, h.intent, 10, submit, service)).toBeNull()
  expect(submit).not.toHaveBeenCalled()
  expect(readSessionState('owner', h.env).pending?.[0]?.submission?.admitted_at).toBeUndefined()
})

it('checks the fresh registration inside admission, not the earlier caller snapshot', () => {
  const h = fixture()
  writeSessionState('owner', h.env, { pending: [{ ...h.entry, service_identity: { ...identity, machine_id: 'machine_b' } }] })
  const submit = vi.fn(async () => 'submitted')
  expect(admitQueuedQuestion('owner', h.env, h.entry, h.intent, 10, submit, identity)).toBeNull()
  expect(submit).not.toHaveBeenCalled()
})

it('starts the exact original client after durably recording admission', async () => {
  const h = fixture()
  const submit = vi.fn(async () => {
    expect(readSessionState('owner', h.env).pending?.[0]?.submission?.admitted_at).toBe(10)
    return 'submitted'
  })
  expect(await admitQueuedQuestion('owner', h.env, h.entry, h.intent, 10, submit, identity)).toBe('submitted')
  expect(submit).toHaveBeenCalledOnce()
})

it('replaces only the exact rejected intent and refuses a racing native obligation', () => {
  const h = fixture()
  const replacement = { ...h.intent, request_id: 'req_replacement' }
  expect(replaceFrozenSubmission('owner', h.env, h.entry, { ...h.intent, request_id: 'req_other' }, replacement)).toBe(false)
  const state = readSessionState('owner', h.env)
  writeSessionState('owner', h.env, { ...state, native_answer_operations: [{
    question_id: 'q_one', operation_id: 'one', submission_id: 'opaque', service_identity: identity,
    answers: [{ question_id: 'q1', text: 'Yes' }], acknowledgement_text: 'Continuing.',
  }] })
  expect(replaceFrozenSubmission('owner', h.env, h.entry, h.intent, replacement)).toBe(false)
  expect(readSessionState('owner', h.env).pending?.[0]?.submission).toEqual(h.intent)
  writeSessionState('owner', h.env, state)
  expect(replaceFrozenSubmission('owner', h.env, h.entry, h.intent, replacement)).toBe(true)
  expect(readSessionState('owner', h.env).pending?.[0]?.submission).toEqual(replacement)
})
