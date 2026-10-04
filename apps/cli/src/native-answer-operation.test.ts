import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecordHarnessAnswerResponse } from '@raidiant/notifai-protocol'
import {
  confirmNativeAnswerTarget, recordConfirmedNativeAnswerTarget, executeNativeAnswerOperation, prepareNativeAnswerOperation, resolveNativeAnswerOperation,
  type NativeOperationOwner,
} from './native-answer-operation.js'
import {
  beginSessionIncarnation, clearSessionState, findOwningSession, lifecycleStamp,
  markSessionEnded, pruneAbandonedSessions, readSessionState, sessionStatePath,
  writeSessionState, updateSessionState,
} from './hook-session-state.js'
import { handleSessionEnd } from './hook-lifecycle.js'
import { stageAcceptedAnswers } from './hook-acknowledgements.js'
import { retiringQuestion } from './hook-question-retirement.js'
import type { HookContext, AnsweredPending } from './hook-types.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const text = 'Deploying to staging now.'
const answers = [{ question_id: 'q1', choice_ids: ['staging'] }]
const service = { base_url: 'https://api.example.test', machine_id: 'machine_a' }
async function prepareInChild(h: ReturnType<typeof setup>, crash: boolean, unresolved = false): Promise<number | null> {
  const moduleUrl = new URL('../dist/native-answer-operation.js', import.meta.url).href
  const source = `
    import { readFileSync } from 'node:fs';
    import { prepareNativeAnswerOperation } from ${JSON.stringify(moduleUrl)};
    const { owner, input, crash, unresolved } = JSON.parse(readFileSync(0, 'utf8'));
    prepareNativeAnswerOperation(owner, process.env, input, () => ({ ...(unresolved ? {} : { requestId: 'req_registered' }), service: owner.service }));
    process.exit(crash ? 73 : 0);
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: h.env, stdio: ['pipe', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', chunk => { error += String(chunk) })
    child.on('error', reject)
    child.on('exit', code => code === 0 || code === 73 ? resolve(code) : reject(new Error(error)))
    child.stdin.end(JSON.stringify({ owner: h.owner, input: h.input, crash, unresolved }))
  })
}
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-native-operation-'))
  roots.push(root)
  const env = { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root }
  const sessionId = 'native-operation-session'
  const incarnation = beginSessionIncarnation(sessionId, env, { stamp: lifecycleStamp() })
  const owner: NativeOperationOwner = { sessionId, key: incarnation.key, service }
  writeSessionState(sessionId, env, {
    harness: 'codex',
    pending: [{ question_id: 'q_registered', request_id: 'req_registered', question: 'Where?', summary: 'Where?' }],
    acknowledgement_due: [{ request_id: 'req_registered', recorded_at: 1 }],
  })
  // Controlled adapter admission; this suite tests command persistence, not
  // native-form observation or mechanical binding (owned by the adapter POC).
  const admit = vi.fn(() => ({ requestId: 'req_registered', service }))
  const input = { questionId: 'q_registered', operationId: 'native-1', answers, text }
  const prepare = () => prepareNativeAnswerOperation(owner, env, input, admit)
  const report: RecordHarnessAnswerResponse = {
    status: 'recorded', reply_seq: 7, complete: true, other_submissions: [],
    answer_version: {
      origin: 'harness', provenance: 'agent-reported', base_version: null,
      version_id: 'rpl_native', source: 'reply', status: 'presented', not_delivered_reason: null,
      answers: [{ question_id: 'q1', choice_ids: ['staging'], text: null }], text: 'Staging',
      device_id: null, created_at: '2026-10-03T12:00:00Z', agent_acknowledgement: null,
    },
  }
  const ack = { status: 'recorded' as const, agent_acknowledgement: { text, created_at: '2026-10-03T12:00:01Z' } }
  const client = {
    recordHarnessAnswer: vi.fn(async () => structuredClone(report)),
    putAgentAcknowledgement: vi.fn(async () => structuredClone(ack)),
  }
  const resume = () => ({ ...owner, key: beginSessionIncarnation(sessionId, env, { stamp: lifecycleStamp() }).key })
  return { env, owner, input, admit, prepare, report, ack, client, resume }
}

describe('durable native answer operation', () => {
  it('saves an early answer across a real crash, then resolves only after confirmed submission', async () => {
    const h = setup()
    expect(await prepareInChild(h, true, true)).toBe(73)
    const op = prepareNativeAnswerOperation(h.owner, h.env, {
      questionId: h.input.questionId, operationId: h.input.operationId,
    }, h.admit)
    expect(op.request_id).toBeUndefined()
    expect(h.admit).not.toHaveBeenCalled()
    await expect(executeNativeAnswerOperation(h.owner, h.env, op, h.client)).rejects.toThrow('not confirmed')
    expect(h.client.recordHarnessAnswer).not.toHaveBeenCalled()
    expect(() => resolveNativeAnswerOperation(h.owner, h.env, op, () => null)).toThrow('not confirmed')
    const resolved = resolveNativeAnswerOperation(h.owner, h.env, op, () => ({ requestId: 'req_registered', service }))
    expect(resolved).toEqual({ ...op, request_id: 'req_registered' })
    // The executing caller may still hold the pre-resolution snapshot.
    await executeNativeAnswerOperation(h.owner, h.env, op, h.client)
    expect(h.client.recordHarnessAnswer).toHaveBeenCalledWith('req_registered', {
      session_id: h.owner.sessionId, submission_id: op.submission_id, answers: op.answers,
    })
  })

  it('retains a positive submission receipt through end and cleanup, even after history eviction', () => {
    const h = setup()
    const op = prepareNativeAnswerOperation(h.owner, h.env, h.input, () => ({ service }))
    handleSessionEnd(h.env, { session_id: h.owner.sessionId })
    recordConfirmedNativeAnswerTarget(h.owner.sessionId, h.env, {
      question_id: op.question_id, request_id: 'req_registered', service_identity: service, question: 'Where?', summary: 'Where?',
    })
    clearSessionState(h.owner.sessionId, h.env)
    updateSessionState(h.owner.sessionId, h.env, state => ({ ...state, question_history: [] }))
    expect(readSessionState(h.owner.sessionId, h.env).native_answer_operations?.[0]).toEqual({ ...op, request_id: 'req_registered' })
    expect(readSessionState(h.owner.sessionId, h.env).pending).toBeUndefined()
  })

  it('ignores frozen-only history, including retirement through SessionEnd, before any HTTP', async () => {
    const h = setup()
    const op = prepareNativeAnswerOperation(h.owner, h.env, h.input, () => ({ service }))
    updateSessionState(h.owner.sessionId, h.env, state => ({ ...state, pending: [], retiring: [retiringQuestion({
      question_id: op.question_id, question: 'Where?', summary: 'Where?', service_identity: service,
      submission: { request_id: 'req_frozen', collapse_key: 'collapse', device_ids: ['dev_test'] } as never,
    }, 'answered_elsewhere')!] }))
    handleSessionEnd(h.env, { session_id: h.owner.sessionId })
    const resumed = h.resume()
    await expect(executeNativeAnswerOperation(resumed, h.env, op, h.client)).rejects.toThrow('not confirmed')
    expect(h.client.recordHarnessAnswer).not.toHaveBeenCalled()
  })

  it('resolves from an accepted app reply without consuming it or clearing its acknowledgement', () => {
    const h = setup()
    const op = prepareNativeAnswerOperation(h.owner, h.env, h.input, () => ({ service }))
    const answer = { pending: {
      question_id: op.question_id, request_id: 'req_registered', service_identity: service, question: 'Where?', summary: 'Where?',
    }, replies: [], reply: { text: 'Staging' } } as unknown as AnsweredPending
    stageAcceptedAnswers({ env: h.env, now: () => 2 } as HookContext, h.owner.sessionId, [answer], 0)
    const state = readSessionState(h.owner.sessionId, h.env)
    expect(state.native_answer_operations?.[0]?.request_id).toBe('req_registered')
    expect(state.accepted?.answers[0]?.reply.text).toBe('Staging')
    expect(state.acknowledgement_due).toEqual([{ request_id: 'req_registered', recorded_at: 1 }])
  })

  it('does not adopt a confirmation from another service or Approved Machine', () => {
    const h = setup()
    prepareNativeAnswerOperation(h.owner, h.env, h.input, () => ({ service }))
    const state = readSessionState(h.owner.sessionId, h.env)
    for (const service_identity of [undefined, { ...service, machine_id: 'other' }, { ...service, base_url: 'https://other.example.test' }]) {
      expect(confirmNativeAnswerTarget(state, { question_id: h.input.questionId, request_id: 'req_registered', question: 'Where?', summary: 'Where?', service_identity })).toBe(state)
    }
  })

  it('keeps the first confirmed target when concurrent recovery holds an unresolved snapshot', () => {
    const h = setup()
    const op = prepareNativeAnswerOperation(h.owner, h.env, h.input, () => ({ service }))
    const first = resolveNativeAnswerOperation(h.owner, h.env, op, () => ({ requestId: 'req_registered', service }))
    const stale = vi.fn(() => ({ requestId: 'req_replacement', service }))
    expect(resolveNativeAnswerOperation(h.owner, h.env, op, stale)).toEqual(first)
    expect(stale).not.toHaveBeenCalled()
    expect(readSessionState(h.owner.sessionId, h.env).native_answer_operations).toEqual([first])
  })

  it('refuses target resolution across ownership changes or termination', () => {
    const h = setup()
    const op = prepareNativeAnswerOperation(h.owner, h.env, h.input, () => ({ service }))
    expect(() => resolveNativeAnswerOperation(h.owner, h.env, op, () => ({ requestId: 'req_registered', service: { ...service, machine_id: 'another' } }))).toThrow('different service')
    expect(() => resolveNativeAnswerOperation({ ...h.owner, service: { ...service, machine_id: 'another' } }, h.env, op, () => null)).toThrow('Machine changed')
    markSessionEnded(h.owner.sessionId, h.env, Date.now())
    expect(() => resolveNativeAnswerOperation(h.owner, h.env, op, () => ({ requestId: 'req_registered', service }))).toThrow('incarnation changed')
    expect(readSessionState(h.owner.sessionId, h.env).native_answer_operations?.[0]?.request_id).toBeUndefined()
  })

  it('recovers a real process exit after durable preparation without inventing a new submission', async () => {
    const h = setup()
    expect(await prepareInChild(h, true)).toBe(73)
    const stored = readSessionState(h.owner.sessionId, h.env).native_answer_operations![0]!
    const resumed = prepareNativeAnswerOperation(h.owner, h.env, { questionId: stored.question_id, operationId: stored.operation_id }, h.admit)
    expect(resumed.submission_id).toBe(stored.submission_id)
    expect(h.admit).not.toHaveBeenCalled()
    await executeNativeAnswerOperation(h.owner, h.env, resumed, h.client)
  })

  it('serializes concurrent process preparations onto one durable operation', async () => {
    const h = setup()
    expect(await Promise.all([prepareInChild(h, false), prepareInChild(h, false)])).toEqual([0, 0])
    expect(readSessionState(h.owner.sessionId, h.env).native_answer_operations).toHaveLength(1)
  })

  it('reuses explicit identities, rejects changed bodies, and keeps same-text submissions separate', () => {
    const h = setup()
    const first = h.prepare()
    expect(h.prepare()).toEqual(first)
    expect(h.admit).toHaveBeenCalledTimes(1)
    expect(() => prepareNativeAnswerOperation(h.owner, h.env, { ...h.input, text: 'Different work.' }, h.admit)).toThrow('different owner or body')
    expect(() => prepareNativeAnswerOperation(h.owner, h.env, { ...h.input, answers: [{ question_id: 'q1', text: 'Different' }] }, h.admit)).toThrow('different owner or body')
    const second = prepareNativeAnswerOperation(h.owner, h.env, { ...h.input, operationId: 'native-2' }, h.admit)
    expect(second.submission_id).not.toBe(first.submission_id)
    expect(second.answers).toEqual(first.answers)
    expect(() => prepareNativeAnswerOperation(h.owner, h.env, { questionId: 'q_registered', operationId: 'missing' }, h.admit)).toThrow('identity-only')
  })

  it('fails before durable admission for invalid answers and an unbound registration', () => {
    const h = setup()
    for (const invalid of [[], [{ question_id: 'q1' }], [{ question_id: 'q1', text: ' ' }], [...answers, ...answers]]) {
      expect(() => prepareNativeAnswerOperation(h.owner, h.env, { ...h.input, answers: invalid }, h.admit)).toThrow()
    }
    expect(h.admit).not.toHaveBeenCalled()
    expect(() => prepareNativeAnswerOperation(h.owner, h.env, h.input, () => { throw new Error('unbound') })).toThrow('unbound')
    expect(readSessionState(h.owner.sessionId, h.env).native_answer_operations).toBeUndefined()
  })

  it('persists before HTTP and recovers a lost report receipt using the same service key', async () => {
    const h = setup()
    const op = h.prepare()
    h.client.recordHarnessAnswer.mockRejectedValueOnce(new Error('accepted, receipt lost'))
    await expect(executeNativeAnswerOperation(h.owner, h.env, op, h.client)).rejects.toThrow('receipt lost')
    expect(h.client.putAgentAcknowledgement).not.toHaveBeenCalled()
    const retry = prepareNativeAnswerOperation(h.owner, h.env, { questionId: op.question_id, operationId: op.operation_id }, h.admit)
    expect(retry.submission_id).toBe(op.submission_id)
    await executeNativeAnswerOperation(h.owner, h.env, retry, h.client)
    expect(h.client.recordHarnessAnswer.mock.calls[0]).toEqual(h.client.recordHarnessAnswer.mock.calls[1])
    expect(h.client.putAgentAcknowledgement).toHaveBeenCalledWith('req_registered', { session_id: h.owner.sessionId, reply_seq: 7, text })
  })

  it('recovers a lost acknowledgement receipt without clearing ordinary debt or its pending watcher', async () => {
    const h = setup()
    const before = readSessionState(h.owner.sessionId, h.env)
    const op = h.prepare()
    h.client.putAgentAcknowledgement.mockRejectedValueOnce(new Error('ack receipt lost'))
    await expect(executeNativeAnswerOperation(h.owner, h.env, op, h.client)).rejects.toThrow('ack receipt lost')
    expect(readSessionState(h.owner.sessionId, h.env).native_answer_operations?.[0]?.report).toEqual({ reply_seq: 7, reply_id: 'rpl_native' })
    await executeNativeAnswerOperation(h.owner, h.env, h.prepare(), h.client)
    await executeNativeAnswerOperation(h.owner, h.env, h.prepare(), h.client)
    expect(h.client.putAgentAcknowledgement).toHaveBeenCalledTimes(2)
    const after = readSessionState(h.owner.sessionId, h.env)
    expect(after.pending).toEqual(before.pending)
    expect(after.acknowledgement_due).toEqual(before.acknowledgement_due)
    expect(after.accepted).toBeUndefined()
    expect(after.waiting_answers).toBeUndefined()
  })

  it('settles simultaneous identical commands onto one durable report and acknowledgement identity', async () => {
    const h = setup()
    await Promise.all([executeNativeAnswerOperation(h.owner, h.env, h.prepare(), h.client), executeNativeAnswerOperation(h.owner, h.env, h.prepare(), h.client)])
    const operations = readSessionState(h.owner.sessionId, h.env).native_answer_operations!
    expect(operations).toHaveLength(1)
    expect(operations[0]?.acknowledgement).toEqual(h.ack.agent_acknowledgement)
    expect(h.client.recordHarnessAnswer.mock.calls[0]).toEqual(h.client.recordHarnessAnswer.mock.calls[1])
  })

  it('saves a late report receipt across SessionEnd but refuses the old process next phase, then resumes exactly', async () => {
    const h = setup()
    const op = h.prepare()
    h.client.recordHarnessAnswer.mockImplementationOnce(async () => {
      await Promise.resolve() // The HTTP start returned; SessionEnd races the response.
      handleSessionEnd(h.env, { session_id: h.owner.sessionId })
      return h.report
    })
    await expect(executeNativeAnswerOperation(h.owner, h.env, op, h.client)).rejects.toThrow('incarnation changed')
    expect(h.client.putAgentAcknowledgement).not.toHaveBeenCalled()
    const stored = readSessionState(h.owner.sessionId, h.env).native_answer_operations![0]!
    expect(stored.report?.reply_seq).toBe(7)
    const resumed = h.resume()
    expect(resumed.key).not.toBe(h.owner.key)
    const retry = prepareNativeAnswerOperation(resumed, h.env, { questionId: op.question_id, operationId: op.operation_id }, h.admit)
    await executeNativeAnswerOperation(resumed, h.env, retry, h.client)
    expect(h.admit).toHaveBeenCalledTimes(1)
  })

  it('merges an in-flight acknowledgement after end and keeps its completed identity on resume', async () => {
    const h = setup()
    const op = h.prepare()
    h.client.putAgentAcknowledgement.mockImplementationOnce(async () => {
      await Promise.resolve()
      handleSessionEnd(h.env, { session_id: h.owner.sessionId })
      return h.ack
    })
    await executeNativeAnswerOperation(h.owner, h.env, op, h.client)
    const resumed = h.resume()
    const retry = prepareNativeAnswerOperation(resumed, h.env, h.input, h.admit)
    expect(retry.submission_id).toBe(op.submission_id)
    await executeNativeAnswerOperation(resumed, h.env, retry, h.client)
    expect(h.client.putAgentAcknowledgement).toHaveBeenCalledTimes(1)
  })

  it('rejects another Machine or incarnation before HTTP, without adopting current credentials', async () => {
    const h = setup()
    const op = h.prepare()
    const other = { ...h.owner, service: { ...service, machine_id: 'machine_b' } }
    expect(() => prepareNativeAnswerOperation(other, h.env, h.input, h.admit)).toThrow('different owner')
    await expect(executeNativeAnswerOperation(other, h.env, op, h.client)).rejects.toThrow('Approved Machine changed')
    markSessionEnded(h.owner.sessionId, h.env, Date.now())
    h.resume()
    await expect(executeNativeAnswerOperation(h.owner, h.env, op, h.client)).rejects.toThrow('incarnation changed')
    expect(h.client.recordHarnessAnswer).not.toHaveBeenCalled()
  })

  it('preserves unfinished operations and ownership files through cleanup and age pruning', () => {
    const h = setup()
    const op = h.prepare()
    handleSessionEnd(h.env, { session_id: h.owner.sessionId })
    clearSessionState(h.owner.sessionId, h.env)
    expect(findOwningSession(op.question_id, h.env).sessionId).toBe(h.owner.sessionId)
    const directory = path.dirname(sessionStatePath(h.owner.sessionId, h.env))
    const names = readdirSync(directory)
    const old = new Date(Date.now() - 30 * 24 * 3600_000)
    for (const name of names) utimesSync(path.join(directory, name), old, old)
    expect(pruneAbandonedSessions(h.env)).toBe(0)
    expect(readdirSync(directory)).toEqual(names)
    expect(readSessionState(h.owner.sessionId, h.env).native_answer_operations?.[0]).toEqual(op)
  })

  it.each([null, {}, { text: 'wrong', created_at: '2026-10-03T12:00:01Z' }, { text, created_at: 'invalid' }])('does not confirm malformed acknowledgement %j', async bad => {
    const h = setup()
    const op = h.prepare()
    h.client.putAgentAcknowledgement.mockResolvedValueOnce({ status: 'recorded', agent_acknowledgement: bad } as typeof h.ack)
    await expect(executeNativeAnswerOperation(h.owner, h.env, op, h.client)).rejects.toThrow('receipt is incomplete')
    expect(readSessionState(h.owner.sessionId, h.env).native_answer_operations?.[0]?.acknowledgement).toBeUndefined()
    await executeNativeAnswerOperation(h.owner, h.env, h.prepare(), h.client)
    expect(h.prepare().submission_id).toBe(op.submission_id)
  })

  it('rejects a malformed or wrong-answer report before acknowledgement', async () => {
    const h = setup()
    const op = h.prepare()
    h.client.recordHarnessAnswer.mockResolvedValueOnce({ ...h.report, other_submissions: null } as unknown as RecordHarnessAnswerResponse)
    await expect(executeNativeAnswerOperation(h.owner, h.env, op, h.client)).rejects.toThrow('receipt is incomplete')
    h.client.recordHarnessAnswer.mockResolvedValueOnce({ ...h.report, answer_version: { ...h.report.answer_version, answers: [{ question_id: 'q1', choice_ids: ['production'], text: null }] } })
    await expect(executeNativeAnswerOperation(h.owner, h.env, op, h.client)).rejects.toThrow('does not confirm')
    expect(h.client.putAgentAcknowledgement).not.toHaveBeenCalled()
    await executeNativeAnswerOperation(h.owner, h.env, op, h.client)
  })
})
