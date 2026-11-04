import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { ClaimDeliveryAttemptRequestT } from '@raidiant/notifai-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiCallError, type ApiClient } from './client.js'
import { acquireClaimFile } from './hook-question-lock.js'
import { beginSessionIncarnation, lifecycleStamp } from './hook-session-state.js'
import { currentProcessIdentity } from './process-identity.js'
import { attendantClaimPath, writeAttendantStatus } from './session-attendant-state.js'
import { drainSessionInputs, hasSessionInputs } from './session-inputs.js'
import { CodexControlNotSent } from './codex-native-control.js'
import type { CodexQuestionRegistration } from './codex-question-bindings.js'
import { readSessionState, writeSessionState } from './hook-session-state.js'
import type { AnsweredPending, SessionState } from './hook-types.js'
import {
  isOrcaChatSentPrompt, orcaAnswerText, orcaCardGroup, orcaChatPresentation, orcaChatSessionOf, orcaChatShowsCards, takeOrcaChatSentContext,
} from './orca-chat-answers.js'
import { orcaPayloadFingerprint, orcaRuntime, orcaUserDataPath, type OrcaRpcResult, type OrcaRuntime } from './orca-runtime.js'

const roots: string[] = []
const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const SESSION = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b'
const ORCA = 'codex_8203811a_1e0d_4338_a190_b89344f198cb'
const OWNER = 'owner-key'
const SERVICE = { base_url: 'https://api.example.test', machine_id: 'machine_test' }
const LEASE = { incarnation: 'inc-1', generation: 3 }

function card(questionId: string, callId: string, title: string, labels: Record<string, string>, turn = 'turn-1'): CodexQuestionRegistration {
  return {
    question_id: questionId, owner_key: OWNER, registration_turn_id: turn,
    transcript: { file: '', identity: 'codex-card-hook', registered_offset: 0 }, service_identity: SERVICE,
    card_call_id: callId, card_allowed: true, confirmed_request_id: `req_${questionId}`,
    questions: [{ question: { id: `${questionId}-q`, text: title, choices: Object.entries(labels).map(([id, label]) => ({ id, label })) } as never,
      card: { title, labels }, native: { turn_id: turn, call_id: callId, index: 0 }, verified: true }],
  }
}

function answer(questionId: string, choice: string[] = [], text: string | null = null): AnsweredPending {
  const reply = { reply_id: `rpl_${questionId}`, seq: 1, delivery_id: null, device_id: 'dev', device_name: 'iPhone', text: text ?? '',
    answers: [{ question_id: `${questionId}-q`, choice_ids: choice, text }], source: null, created_at: '2026-11-04T00:00:00Z' }
  return { pending: { question_id: questionId, request_id: `req_${questionId}`, collapse_key: `ck_${questionId}`, device_ids: ['dev'],
    question: '', summary: '', service_identity: SERVICE },
    reply, replies: [reply], delivery_claim: true }
}

const cardA = card('qa', 'call_a', 'Card A: which color?', { red: 'Red', blue: 'Blue' })
const cardB = card('qb', 'call_b', 'Card B: which size?', { small: 'Small', large: 'Large' })

function state(extra: Partial<SessionState> = {}): SessionState {
  return { harness: 'codex', orca_chat: { key: OWNER, session_id: ORCA }, codex_question_bindings: [cardA, cardB],
    pending: [{ question_id: 'qa', question: '', summary: '' }, { question_id: 'qb', question: '', summary: '' }], ...extra } as SessionState
}

describe('which Orca chat a hook runs in', () => {
  const base = { ORCA_STRUCTURED_SESSION: '1', ORCA_AGENT_SESSION_ID: ORCA, ORCA_USER_DATA_PATH: '/Users/x/Library/Application Support/orca' }
  it('is named by Orca\'s own environment, on this machine only', () => {
    expect(orcaChatSessionOf(base, 'darwin')).toEqual({ session_id: ORCA, user_data: base.ORCA_USER_DATA_PATH })
    expect(orcaChatSessionOf({ ...base, ORCA_ENVIRONMENT: 'ssh:dev' }, 'darwin')).toBeNull()
    expect(orcaChatSessionOf({ ...base, ORCA_REMOTE_PAIRING: '1' }, 'darwin')).toBeNull()
    expect(orcaChatSessionOf({ ...base, ORCA_STRUCTURED_SESSION: '' }, 'darwin')).toBeNull()
    expect(orcaChatSessionOf({ ...base, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'T3' }, 'darwin')).toBeNull()
    expect(orcaChatSessionOf({ ...base, ORCA_AGENT_SESSION_ID: 'bad id;rm' }, 'darwin')).toBeNull()
  })

  it('finds Orca\'s userData the way its own CLI does', () => {
    expect(orcaUserDataPath({}, 'darwin', '/Users/u')).toBe('/Users/u/Library/Application Support/orca')
    expect(orcaUserDataPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u')).toBe(path.join('C:\\Users\\u\\AppData\\Roaming', 'orca'))
    expect(orcaUserDataPath({}, 'win32')).toBeNull()
    expect(orcaUserDataPath({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/u')).toBe('/cfg/orca')
    expect(orcaUserDataPath({}, 'linux', '/home/u')).toBe('/home/u/.config/orca')
    expect(orcaUserDataPath({ ORCA_USER_DATA_PATH: 'relative' }, 'linux')).toBeNull()
  })
})

describe('a turn\'s card answers', () => {
  it('wait until every card of the turn has a device answer', () => {
    expect(orcaCardGroup(state({ waiting_answers: [answer('qa', ['blue'])] }), OWNER, SERVICE, answer('qa', ['blue']))).toBeNull()
    const both = state({ waiting_answers: [answer('qa', ['blue']), answer('qb', [], 'the larger one, please')] })
    const group = orcaCardGroup(both, OWNER, SERVICE, answer('qa', ['blue']))!
    expect(group.map((entry) => entry.registration.question_id)).toEqual(['qa', 'qb'])
    // Exactly what Orca's own card sends.
    expect(orcaAnswerText(group)).toBe('> Card A: which color?\n\nBlue\n\n> Card B: which size?\n\nthe larger one, please')
  })

  it('leave out a card of another turn, and one already handed in', () => {
    const other = card('qc', 'call_c', 'Card C?', { y: 'Yes' }, 'turn-0')
    const handed = state({ codex_question_bindings: [cardA, cardB, other], pending: [{ question_id: 'qa', question: '', summary: '' }, { question_id: 'qc', question: '', summary: '' }],
      waiting_answers: [answer('qa', ['red'])] })
    expect(orcaCardGroup(handed, OWNER, SERVICE, answer('qa', ['red']))!.map((entry) => entry.registration.question_id)).toEqual(['qa'])
  })

  it('never form for an unclaimed answer, another Machine, a dismissed card or a session that is not an Orca chat', () => {
    const unclaimed = { ...answer('qa', ['red']) }
    delete unclaimed.delivery_claim
    expect(orcaCardGroup(state({ codex_question_bindings: [cardA], waiting_answers: [unclaimed] }), OWNER, SERVICE, unclaimed)).toBeNull()
    expect(orcaCardGroup(state({ codex_question_bindings: [cardA], waiting_answers: [answer('qa', ['red'])] }), OWNER,
      { ...SERVICE, machine_id: 'other' }, answer('qa', ['red']))).toBeNull()
    expect(orcaCardGroup(state({ codex_question_bindings: [{ ...cardA, dismissed: true }], waiting_answers: [answer('qa', ['red'])] }), OWNER, SERVICE,
      answer('qa', ['red']))).toBeNull()
  })
})

/** A fake Orca runtime: capabilities, a history whose fence moves, and a send that answers as told. */
function fakeOrca(options: { capabilities?: string[]; cards?: string[]; send?: OrcaRpcResult; submissions?: string[] } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown>; timeoutMs?: number }> = []
  let fence = 4
  const runtime: OrcaRuntime = {
    call: async (method, params, timeoutMs) => {
      calls.push({ method, params: params as Record<string, unknown>, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
      if (method === 'status.get') return { ok: true, result: { capabilities: options.capabilities ?? ['agent-session.structured.v1', 'agent-session.accepted-send.v1'] } }
      if (method === 'agentSession.history') {
        return { ok: true, result: { page: { fence, submissions: (options.submissions ?? []).map((id) => ({ clientMessageId: id })),
          // As Orca 1.4.248 records them: tool-call blocks of an assistant message.
          items: (options.cards ?? ['call_a', 'call_b']).map((callId) => ({ body: { kind: 'message', role: 'assistant',
            blocks: [{ type: 'text', text: 'Card' }, { type: 'tool-call', name: 'request_user_input_async', callId }] } })) } } }
      }
      if (method === 'agentSession.send') { fence += 1; return options.send ?? { ok: true, result: { ok: true } } }
      return { ok: false, code: 'method_not_found' }
    },
  }
  return { runtime, calls }
}

function presentation(env: NodeJS.ProcessEnv, runtime: OrcaRuntime, remainingMs?: () => number) {
  return orcaChatPresentation({ sessionId: SESSION, env, lease: LEASE, ownerKey: OWNER, service: SERVICE,
    serviceCurrent: () => true, wall: () => 1_793_832_381_560, runtime, ...(remainingMs === undefined ? {} : { remainingMs }) })
}

function home() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-orca-chat-')); roots.push(root)
  const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config') }
  const answers = [answer('qa', ['blue']), answer('qb', ['large'])]
  writeSessionState(SESSION, env, state({ waiting_answers: answers }))
  return { env, answers }
}

describe('sending the answers through Orca', () => {
  it('sends one message in Orca\'s own answer format, with the fence it just read and Orca\'s fingerprint', async () => {
    const h = home()
    const orca = fakeOrca()
    const prepared = (await presentation(h.env, orca.runtime).prepareGroup!(h.answers, readSessionState(SESSION, h.env), 0))!
    expect(prepared.presentation).toMatchObject({ kind: 'orca-chat-answers', orca_session_id: ORCA,
      answers: [{ request_id: 'req_qa' }, { request_id: 'req_qb' }] })
    await prepared.write(() => true)
    const send = orca.calls.find((call) => call.method === 'agentSession.send')!.params
    const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '> Card A: which color?\n\nBlue\n\n> Card B: which size?\n\nLarge' }] }
    expect(send).toEqual({ envelope: { sessionId: ORCA, clientOperationId: expect.stringMatching(/^1793832381560-[0-9a-f]{32}$/u),
      expectedRuntimeFence: 4, payloadFingerprint: orcaPayloadFingerprint('agentSession.send', ORCA, { body }) }, body })
    // The prompt it starts gets only the acknowledgement, once; and it is never a terminal answer.
    const prompt = '> Card A: which color?\n\nBlue\n\n> Card B: which size?\n\nLarge'
    expect(isOrcaChatSentPrompt(SESSION, h.env, prompt)).toBe(true)
    const context = takeOrcaChatSentContext(SESSION, h.env, `${prompt}\n`)!
    expect(context).toContain('sent for them through Orca')
    expect(context).toContain('notifai acknowledge req_qa')
    expect(context).toContain('notifai acknowledge req_qb')
    expect(context).not.toContain('Large')
    expect(takeOrcaChatSentContext(SESSION, h.env, prompt)).toBeNull()
    expect(isOrcaChatSentPrompt(SESSION, h.env, 'something else')).toBe(false)
  })

  it('offers nothing to send without Orca\'s capabilities, so the ordinary route keeps the answers', async () => {
    const h = home()
    const orca = fakeOrca({ capabilities: ['agent-session.structured.v1'] })
    expect(await presentation(h.env, orca.runtime).prepareGroup!(h.answers, readSessionState(SESSION, h.env), 0)).toBeNull()
    expect(orca.calls.map((call) => call.method)).toEqual(['status.get'])
  })

  it.each([
    ['the chat does not show these cards', { cards: ['call_a'] }],
    ['Orca refuses the message', { send: { ok: false, code: 'agent_session_fence_stale' } as OrcaRpcResult }],
    ['the reply is lost and Orca has no record of it', { send: { ok: false, code: 'timeout' } as OrcaRpcResult }],
  ])('sends nothing, provably, when %s', async (_name, options) => {
    const h = home()
    const prepared = (await presentation(h.env, fakeOrca(options).runtime).prepareGroup!(h.answers, readSessionState(SESSION, h.env), 0))!
    await expect(prepared.write(() => true)).rejects.toBeInstanceOf(CodexControlNotSent)
    expect(readSessionState(SESSION, h.env).orca_chat_sent ?? []).toEqual([])
  })

  it('counts a lost reply as sent when Orca recorded the operation, and never resends one it cannot settle', async () => {
    const lost = (afterSend: 'recorded' | 'unreadable') => {
      const orca = fakeOrca({ send: { ok: false, code: 'timeout' } })
      const original = orca.runtime.call
      let sentId: string | null = null
      orca.runtime.call = async (method, params) => {
        if (method === 'agentSession.send') sentId = (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
        if (method === 'agentSession.history' && sentId !== null) {
          return afterSend === 'recorded' ? { ok: true, result: { page: { fence: 5, items: [], submissions: [{ clientMessageId: sentId, dispatchState: 'accepted' }] } } }
            : { ok: false, code: 'timeout' }
        }
        return original(method, params)
      }
      return orca.runtime
    }
    const recorded = home()
    const sent = (await presentation(recorded.env, lost('recorded')).prepareGroup!(recorded.answers, readSessionState(SESSION, recorded.env), 0))!
    await expect(sent.write(() => true)).resolves.toBeUndefined()
    expect(readSessionState(SESSION, recorded.env).orca_chat_sent).toHaveLength(1)
    const unsettled = home()
    const unknown = (await presentation(unsettled.env, lost('unreadable')).prepareGroup!(unsettled.answers, readSessionState(SESSION, unsettled.env), 0))!
    // Not "not sent": the journal keeps it uncertain, so nothing writes it again.
    const outcome = await unknown.write(() => true).then(() => 'resolved', (error: unknown) => error)
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome).not.toBeInstanceOf(CodexControlNotSent)
  })
})

describe('what Orca\'s chat shows', () => {
  const user = (text: string, extra: Record<string, unknown> = {}) => ({ body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }], ...extra } })
  const cardItem = (callId: string) => ({ body: { kind: 'message', role: 'assistant', blocks: [{ type: 'tool-call', name: 'request_user_input_async', callId }] } })
  const group = [{ callId: 'call_a', titles: ['Card A: which color?'] }, { callId: 'call_b', titles: ['Card B: which size?'] }]
  const page = (items: unknown[], queued: unknown[] = []) => ({ fence: 1, items, queuedMessages: queued })

  it('is exactly the group\'s cards, since the last message the User sent', () => {
    expect(orcaChatShowsCards(page([user('Ask me'), cardItem('call_a'), cardItem('call_b')]), group, new Set())).toBe(true)
    // An older card, already cleared by a later message, does not count.
    expect(orcaChatShowsCards(page([cardItem('call_x'), user('Ask me'), cardItem('call_a'), cardItem('call_b')]), group, new Set())).toBe(true)
  })

  it('refuses a span with a card Notifai has no answer for, unless that card is already handed in', () => {
    const items = [user('Ask me'), cardItem('call_a'), cardItem('call_c'), cardItem('call_b')]
    expect(orcaChatShowsCards(page(items), group, new Set())).toBe(false)
    expect(orcaChatShowsCards(page(items), group, new Set(['call_c']))).toBe(true)
  })

  it('refuses when a card of the group is gone, as after the User wrote something else', () => {
    expect(orcaChatShowsCards(page([user('Ask me'), cardItem('call_a'), cardItem('call_b'), user('never mind')]), group, new Set())).toBe(false)
  })

  it('refuses when the User already answered in Orca, sent or waiting in Orca\'s queue', () => {
    const items = [user('Ask me'), cardItem('call_a'), cardItem('call_b')]
    expect(orcaChatShowsCards(page(items, [{ messageId: 'm', body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '> Card B: which size?\n\nSmall' }] } }]),
      group, new Set())).toBe(false)
    expect(orcaChatShowsCards(page(items, [{ messageId: 'm', body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Unrelated draft' }] } }]),
      group, new Set())).toBe(true)
    // An agent's notice is not the User answering.
    expect(orcaChatShowsCards(page([...items, user('> Card A: which color?\n\nRed', { from: { kind: 'agent' } })]), group, new Set())).toBe(true)
    expect(orcaChatShowsCards(page([...items, user('> Card A: which color?\n\nRed')]), group, new Set())).toBe(false)
  })
})

describe('Orca\'s record of a lost reply', () => {
  const lostReply = (dispatchState: string) => {
    const orca = fakeOrca({ send: { ok: false, code: 'timeout' } })
    const original = orca.runtime.call
    let sentId: string | null = null
    orca.runtime.call = async (method, params, timeoutMs) => {
      if (method === 'agentSession.send') sentId = (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
      if (method === 'agentSession.history' && sentId !== null) return { ok: true, result: { page: { fence: 5, items: [], submissions: [{ clientMessageId: sentId, dispatchState }] } } }
      return original(method, params, timeoutMs)
    }
    return orca.runtime
  }
  it.each([['accepted', 'sent'], ['rejected', 'not sent'], ['pending', 'unknown']])('reads a submission %s as %s', async (state, outcome) => {
    const h = home()
    const prepared = (await presentation(h.env, lostReply(state)).prepareGroup!(h.answers, readSessionState(SESSION, h.env), 0))!
    const result = await prepared.write(() => true).then(() => 'sent', (error: unknown) => error instanceof CodexControlNotSent ? 'not sent' : 'unknown')
    expect(result).toBe(outcome)
  })
})

describe('the deadline', () => {
  it('bounds every Orca call by what is left, and sends nothing without time for a lost reply', async () => {
    const h = home()
    const orca = fakeOrca()
    let left = 9_000
    const prepared = (await presentation(h.env, orca.runtime, () => left).prepareGroup!(h.answers, readSessionState(SESSION, h.env), 0))!
    await prepared.write(() => true)
    expect(orca.calls.every((call) => (call.timeoutMs ?? Infinity) <= 9_000)).toBe(true)
    const late = home()
    const slow = fakeOrca()
    left = 2_000
    const short = (await presentation(late.env, slow.runtime, () => left).prepareGroup!(late.answers, readSessionState(SESSION, late.env), 0))!
    await expect(short.write(() => true)).rejects.toBeInstanceOf(CodexControlNotSent)
    expect(slow.calls.some((call) => call.method === 'agentSession.send')).toBe(false)
  })
})

describe('a sent message once shown', () => {
  it('is the User\'s own words again: a later card asking the same question can be answered with them', async () => {
    const h = home()
    const prepared = (await presentation(h.env, fakeOrca().runtime).prepareGroup!(h.answers, readSessionState(SESSION, h.env), 0))!
    await prepared.write(() => true)
    const prompt = '> Card A: which color?\n\nBlue\n\n> Card B: which size?\n\nLarge'
    expect(isOrcaChatSentPrompt(SESSION, h.env, prompt)).toBe(true)
    expect(takeOrcaChatSentContext(SESSION, h.env, prompt)).not.toBeNull()
    expect(isOrcaChatSentPrompt(SESSION, h.env, prompt)).toBe(false)
  })
})

describe('the Orca runtime client', () => {
  function runtimeHome(reply: (request: Record<string, unknown>) => unknown, mode = 0o600) {
    const root = mkdtempSync(path.join('/tmp', 'nfo-')); roots.push(root)
    const socket = path.join(root, 'o.sock')
    const seen: Array<Record<string, unknown>> = []
    const server = createServer((connection) => {
      let buffer = ''
      connection.setEncoding('utf8')
      connection.on('data', (chunk: string) => {
        buffer += chunk
        const at = buffer.indexOf('\n')
        if (at < 0) return
        const request = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>
        seen.push(request)
        const answer = reply(request)
        if (answer === undefined) return
        connection.write(`${JSON.stringify({ _keepalive: true })}\n${JSON.stringify({ id: 'other', ok: true })}\n${JSON.stringify({ id: request['id'], ...answer as object })}\n`)
      })
    })
    servers.push(server)
    writeFileSync(path.join(root, 'orca-runtime.json'), JSON.stringify({ authToken: 'secret-token', transports: [{ kind: 'unix', endpoint: socket }] }))
    chmodSync(path.join(root, 'orca-runtime.json'), mode)
    return new Promise<{ env: NodeJS.ProcessEnv; seen: typeof seen }>((resolve) =>
      server.listen(socket, () => resolve({ env: { ORCA_USER_DATA_PATH: root }, seen })))
  }

  it.skipIf(process.platform === 'win32')('sends one authenticated line and reads only its own reply', async () => {
    const h = await runtimeHome(() => ({ ok: true, result: { capabilities: ['a'] } }))
    expect(await orcaRuntime(h.env)!.call('status.get', {})).toEqual({ ok: true, result: { capabilities: ['a'] } })
    expect(h.seen).toEqual([{ id: expect.any(String), authToken: 'secret-token', method: 'status.get', params: {} }])
  })

  it.skipIf(process.platform === 'win32')('reads refusals, silence and a readable token file as unavailable, never throwing', async () => {
    const refused = await runtimeHome(() => ({ ok: false, error: { code: 'method_not_found' } }))
    expect(await orcaRuntime(refused.env)!.call('agentSession.nope', {})).toEqual({ ok: false, code: 'method_not_found' })
    const silent = await runtimeHome(() => undefined)
    expect(await orcaRuntime(silent.env)!.call('status.get', {}, 200)).toEqual({ ok: false, code: 'timeout' })
    const open = await runtimeHome(() => ({ ok: true, result: {} }), 0o644)
    expect(await orcaRuntime(open.env)!.call('status.get', {})).toEqual({ ok: false, code: 'runtime_unavailable' })
    expect(open.seen).toEqual([])
    expect(await orcaRuntime({ ORCA_USER_DATA_PATH: '/nonexistent-orca' })!.call('status.get', {})).toEqual({ ok: false, code: 'runtime_unavailable' })
  })
})

describe('the Orca route as a presentation', () => {
  async function drained(send?: OrcaRpcResult) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-orca-drain-')); roots.push(root)
    const env: NodeJS.ProcessEnv = { HOME: root, XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config') }
    const incarnation = beginSessionIncarnation(SESSION, env, { stamp: lifecycleStamp(), harnessProcess: currentProcessIdentity()! })
    const lease = { incarnation: incarnation.incarnation, generation: 1 }
    acquireClaimFile(attendantClaimPath(SESSION, env), { incarnation: lease.incarnation }, Date.now())
    writeAttendantStatus(SESSION, env, { ...lease, phase: 'attending', activity: 'idle', reason: null, accepts_messages: true, updated_at: Date.now() })
    const answers = [answer('qa', ['blue']), answer('qb', ['large'])]
    const bindings = [cardA, cardB].map((item) => ({ ...item, owner_key: incarnation.key }))
    writeSessionState(SESSION, env, { ...state({ waiting_answers: answers, codex_question_bindings: bindings }),
      orca_chat: { key: incarnation.key, session_id: ORCA },
      pending: ['qa', 'qb'].map((id) => ({ question_id: id, question: '', summary: '', request_id: `req_${id}`, collapse_key: `ck_${id}`,
        device_ids: ['dev'], service_identity: SERVICE })),
      acknowledgement_due: answers.map((entry) => ({ request_id: entry.pending.request_id!, recorded_at: 1, text_required: true })) } as SessionState)
    const claims: string[] = []
    const client = {
      claimDeliveryAttempt: async (_session: string, body: ClaimDeliveryAttemptRequestT) => {
        const id = body.subject.type === 'session_message' ? body.subject.message_id : body.subject.request_id
        if (claims.includes(id)) throw new ApiCallError(409, 'claim_refused', 'settled', null, { reason: 'not_claimable' })
        claims.push(id)
        return { attempt_id: `att_${id}`, claim_remaining_ms: 30_000 }
      },
      reportDeliveryAttempt: async (id: string, body: { outcome: string }) => ({ attempt_id: id, ...body, replayed: false }),
    }
    const orca = fakeOrca(send === undefined ? {} : { send })
    const drain = () => drainSessionInputs({
      lease, mayWrite: () => true, nativeOnly: true, write: () => { throw new Error('an ordinary write') },
      nativeAnswers: orcaChatPresentation({ sessionId: SESSION, env, lease, ownerKey: incarnation.key, service: SERVICE,
        serviceCurrent: () => true, wall: Date.now, runtime: orca.runtime }),
      sequencer: { sessionId: SESSION, env, client: client as unknown as ApiClient, writer: currentProcessIdentity()!,
        monotonic: () => performance.now(), wall: Date.now, sleep: async () => undefined, recoveryDeadline: performance.now() + 500 },
    })
    return { env, lease, claims, orca, drain }
  }

  it('claims both answers, sends them once through Orca, and hands in nothing else', async () => {
    const h = await drained()
    expect(await h.drain()).toBe(true)
    expect(h.claims).toEqual(['req_qa', 'req_qb'])
    expect(h.orca.calls.filter((call) => call.method === 'agentSession.send')).toHaveLength(1)
    expect(hasSessionInputs(SESSION, h.env, h.lease)).toBe(false)
    expect(await h.drain()).toBe(false)
    expect(h.orca.calls.filter((call) => call.method === 'agentSession.send')).toHaveLength(1)
  })

  it('leaves both answers for the ordinary route when Orca refuses the message', async () => {
    const h = await drained({ ok: false, code: 'agent_session_fence_stale' })
    expect(await h.drain()).toBe(false)
    expect(hasSessionInputs(SESSION, h.env, h.lease)).toBe(true)
    expect(readSessionState(SESSION, h.env).orca_chat_sent ?? []).toEqual([])
  })
})
