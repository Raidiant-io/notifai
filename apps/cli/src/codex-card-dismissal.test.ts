import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CodexAnswerControl } from './codex-answer-control.js'
import {
  CODEX_CARD_DISMISSED,
  CODEX_CARD_DISMISSED_ANSWER,
  closeDismissedCodexCards,
  dismissalEnvelope,
} from './codex-card-dismissal.js'
import type { CodexQuestionRegistration } from './codex-question-bindings.js'
import { readSessionState, updateSessionState } from './hook-session-state.js'
import { bootstrapLogger } from './logging.js'

const SESSION = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b'

function registration(extra: Partial<CodexQuestionRegistration> = {}): CodexQuestionRegistration {
  return {
    question_id: 'q_1', owner_key: 'owner', registration_turn_id: 'turn-1',
    transcript: { file: '/tmp/rollout.jsonl', identity: 'x', registered_offset: 0 },
    service_identity: { base_url: 'https://example.test', machine_id: 'm' },
    card_call_id: 'call_1', card_allowed: true, confirmed_request_id: 'req_1', dismissed: true,
    questions: [{ question: { id: 'a', text: 'Ship it?', choices: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }] } as never,
      card: { title: 'Ship it?', labels: { y: 'Yes', n: 'No' } }, native: { turn_id: 'turn-1', call_id: 'call_1', index: 0 }, verified: true }],
    ...extra,
  }
}

function rig(registrations: CodexQuestionRegistration[], control: Partial<CodexAnswerControl> | null = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-card-dismissal-'))
  const env: NodeJS.ProcessEnv = { HOME: root, XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config') }
  updateSessionState(SESSION, env, () => ({ harness: 'codex', codex_question_bindings: registrations }))
  const steered: { turn: string; text: string }[] = []
  let connects = 0
  const connect = async () => {
    connects += 1
    if (control === null) return null
    return { namespace: 'ns', threadId: SESSION, currentTurn: async () => true,
      steer: async (turn: string, text: string) => { steered.push({ turn, text }) }, close: () => undefined, ...control } as CodexAnswerControl
  }
  const run = () => closeDismissedCodexCards({ sessionId: SESSION, env, ownerKey: 'owner', turnId: 'turn-1', deadline: performance.now() + 2_000,
    mayWrite: () => true, logger: bootstrapLogger({ env }), connect })
  const settled = () => readSessionState(SESSION, env).codex_question_bindings!.map((item) => item.terminated === true)
  return { run, steered, settled, connects: () => connects }
}

describe('a dismissed Codex card', () => {
  it('closes once through its own turn, saying the User dismissed it and carrying no answer', async () => {
    const r = rig([registration()])
    expect(await r.run()).toBe(1)
    expect(r.steered).toHaveLength(1)
    expect(r.steered[0]!.turn).toBe('turn-1')
    expect(r.steered[0]!.text).toBe(dismissalEnvelope(registration()))
    const body = JSON.parse(r.steered[0]!.text.split('\n')[1]!) as Record<string, unknown>[]
    expect(body).toEqual([{ questionItemId: '["request_user_input_async","call_1",0]', question: 'Ship it?', answer: CODEX_CARD_DISMISSED_ANSWER,
      notifai: { origin: 'companion', question_id: 'q_1', expired: true, instruction: CODEX_CARD_DISMISSED } }])
    expect(CODEX_CARD_DISMISSED).toBe('Notifai — this question has expired, so it will not be answered. Carry on without an answer to it.')
    expect(r.settled()).toEqual([true])
    // Settled: never sent again.
    expect(await r.run()).toBe(0)
    expect(r.steered).toHaveLength(1)
  })

  it('leaves every other card alone, without connecting', async () => {
    const cases: [string, Partial<CodexQuestionRegistration>][] = [
      ['not dismissed', { dismissed: undefined }],
      ['another turn', { registration_turn_id: 'turn-0' }],
      ['another owner', { owner_key: 'other' }],
      ['already settled', { terminated: true }],
      ['presented ordinarily', { ordinary_only: true }],
      ['no card', { card_call_id: undefined }],
      ['a card prevented before display', { card_allowed: undefined }],
      ['an unverified binding', { questions: [{ ...registration().questions[0]!, verified: undefined }] }],
    ]
    for (const [name, extra] of cases) {
      const r = rig([registration(extra)])
      expect(await r.run(), name).toBe(0)
      expect(r.connects(), name).toBe(0)
    }
  })

  it('stays open, unsettled, where its owning server cannot be reached or its turn has ended', async () => {
    const unreachable = rig([registration()], null)
    expect(await unreachable.run()).toBe(0)
    expect(unreachable.settled()).toEqual([false])
    const ended = rig([registration()], { currentTurn: async () => false })
    expect(await ended.run()).toBe(0)
    expect(ended.steered).toEqual([])
    expect(ended.settled()).toEqual([false])
  })

  it('a lost receipt is not sent again', async () => {
    const r = rig([registration()], { steer: async () => { throw new Error('receipt unknown') } })
    expect(await r.run()).toBe(0)
    expect(r.settled()).toEqual([true])
  })
})
