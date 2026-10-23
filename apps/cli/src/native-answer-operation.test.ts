import type { RecordHarnessAnswerResponse } from '@raidiant/notifai-protocol'
import { spawn } from 'node:child_process'
import { mkdtempSync,rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { handleSessionEnd } from './hook-lifecycle.js'
import {
beginSessionIncarnation,clearSessionState,
lifecycleStamp,
readSessionState,
updateSessionState,
writeSessionState
} from './hook-session-state.js'
import {
confirmNativeAnswerTarget,
executeNativeAnswerOperation,prepareNativeAnswerOperation,
recordConfirmedNativeAnswerTarget,
resolveNativeAnswerOperation,
type NativeOperationOwner,
} from './native-answer-operation.js'

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

  it('does not adopt a confirmation from another service or Approved Machine', () => {
    const h = setup()
    prepareNativeAnswerOperation(h.owner, h.env, h.input, () => ({ service }))
    const state = readSessionState(h.owner.sessionId, h.env)
    for (const service_identity of [undefined, { ...service, machine_id: 'other' }, { ...service, base_url: 'https://other.example.test' }]) {
      expect(confirmNativeAnswerTarget(state, { question_id: h.input.questionId, request_id: 'req_registered', question: 'Where?', summary: 'Where?', service_identity })).toBe(state)
    }
  })
})
