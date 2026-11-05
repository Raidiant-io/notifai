import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexControlNotSent } from './codex-native-control.js'
import type { CommandDeps } from './commands-core.js'
import { beginSessionIncarnation, lifecycleStamp, readSessionState, writeSessionState } from './hook-session-state.js'
import type { AnsweredPending, SessionState } from './hook-types.js'
import {
  orcaBlockingPlan, orcaBlockingPostToolUse, orcaBlockingPresentation, orcaBlockingRequests, parseOrcaPromptItemId,
  reconcileOrcaBlocking, takeOrcaBlockingTypedAck, type OrcaBlockingRegistration,
} from './orca-blocking-questions.js'
import { orcaPayloadFingerprint, type OrcaRpcResult, type OrcaRuntime } from './orca-runtime.js'
import { currentProcessIdentity } from './process-identity.js'
import { enableProject, projectBinding } from './project-enablement.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const THREAD = '01a1ab13-ffe0-7aa0-bc84-b5e319a9aa5b'
const ORCA = 'codex_e0c051e3_64dc_499b_969b_46619624348e'
const CALL = 'call_28fec65658a541e6bb9df9a56fbc677c'
const SERVICE = { base_url: 'https://api.example.test', machine_id: 'machine_test' }
const item = (question: string) => `orca:codex-prompt%3A${THREAD}%3A${CALL}%3A${question}`
/** As Orca 1.4.248 shows a two-question `request_user_input` (live, 2026-11-05). */
const pendingItem = (id: string, question: string, labels: string[], state = 'pending', revision = 1) => ({
  itemId: item(id), revision,
  body: { kind: 'question', question, options: labels.map((label) => ({ id: `${id}:${label}`, label })),
    resolution: { state, selectedOptionId: null, resolvedBy: null, resolvedAt: null } },
})
const page = (items: unknown[], actionable = items.map((entry) => (entry as { itemId: string }).itemId)) =>
  ({ fence: 2, items, actionablePromptIds: actionable, submissions: [] })

describe('Orca\'s question items', () => {
  it('name their Codex thread, call and question; another thread\'s or a digested id names nothing', () => {
    expect(parseOrcaPromptItemId(item('color'), THREAD)).toEqual({ callId: CALL, codexQuestionId: 'color' })
    expect(parseOrcaPromptItemId(item('color'), '00000000-0000-0000-0000-000000000000')).toBeNull()
    expect(parseOrcaPromptItemId('orca:codex-prompt%3Asha256-abcdef', THREAD)).toBeNull()
  })

  it('group a request\'s pending items, leaving answered and other threads\' items out', () => {
    const requests = orcaBlockingRequests(page([pendingItem('color', 'Which color?', ['Red', 'Blue']), pendingItem('size', 'Which size?', ['Small', 'Large']),
      pendingItem('done', 'Done?', ['Yes', 'No'], 'resolved')]), THREAD)
    expect(requests).toEqual([{ callId: CALL, items: [
      expect.objectContaining({ itemId: item('color'), codexQuestionId: 'color', question: 'Which color?', options: [{ id: 'color:Red', label: 'Red' }, { id: 'color:Blue', label: 'Blue' }] }),
      expect.objectContaining({ itemId: item('size'), codexQuestionId: 'size' }),
    ] }])
    expect(orcaBlockingRequests(page([pendingItem('color', 'Which color?', ['Red', 'Blue'])], []), THREAD)).toEqual([])
  })
})

function registration(): OrcaBlockingRegistration {
  return { question_id: 'q_block', owner_key: 'owner', orca_session_id: ORCA, call_id: CALL, service_identity: SERVICE,
    items: [{ item_id: item('color'), codex_question_id: 'color', question_id: 'which-color', title: 'Which color?', options: { red: 'color:Red', blue: 'color:Blue' } },
      { item_id: item('size'), codex_question_id: 'size', question_id: 'which-size', title: 'Which size?', options: { small: 'size:Small', large: 'size:Large' } }] }
}
function answer(parts: Array<{ question_id: string; choice_ids?: string[]; text?: string | null }>): AnsweredPending {
  const reply = { reply_id: 'rpl_1', seq: 1, delivery_id: null, device_id: 'dev', device_name: 'iPhone', text: '',
    answers: parts.map((part) => ({ question_id: part.question_id, choice_ids: part.choice_ids ?? [], text: part.text ?? null })), source: null, created_at: '2026-11-05T00:00:00Z' }
  return { pending: { question_id: 'q_block', request_id: 'req_block', collapse_key: 'ck', device_ids: ['dev'], question: '', summary: '', service_identity: SERVICE },
    reply, replies: [reply], delivery_claim: true }
}

describe('a device answer, as Orca takes it', () => {
  it('picks each choice in its own item and sends typed text as the User\'s message', () => {
    expect(orcaBlockingPlan(registration(), answer([{ question_id: 'which-color', choice_ids: ['blue'] }, { question_id: 'which-size', text: 'the biggest you have' }])))
      .toEqual({ picks: [{ item: registration().items[0], option: 'color:Blue' }], typed: [{ item: registration().items[1], text: 'the biggest you have' }] })
    expect(orcaBlockingPlan(registration(), answer([{ question_id: 'elsewhere', choice_ids: ['blue'] }]))).toBeNull()
  })
})

/** A fake Orca: capabilities, history with these items, and answers as told. */
function fakeOrca(options: { capabilities?: string[]; items?: unknown[]; respond?: (itemId: string) => OrcaRpcResult; send?: OrcaRpcResult } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const items = options.items ?? [pendingItem('color', 'Which color?', ['Red', 'Blue']), pendingItem('size', 'Which size?', ['Small', 'Large'])]
  const runtime: OrcaRuntime = { call: async (method, params) => {
    calls.push({ method, params: params as Record<string, unknown> })
    if (method === 'status.get') return { ok: true, result: { capabilities: options.capabilities ?? ['agent-session.structured.v1', 'agent-session.question-answers.v1', 'agent-session.accepted-send.v1'] } }
    if (method === 'agentSession.history') return { ok: true, result: { page: page(items) } }
    if (method === 'agentSession.respondToQuestion') return options.respond?.((params as { itemId: string }).itemId) ?? { ok: true, result: { ok: true } }
    if (method === 'agentSession.send') return options.send ?? { ok: true, result: { ok: true } }
    return { ok: false, code: 'method_not_found' }
  } }
  return { runtime, calls }
}

function home(extra: Partial<SessionState> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-orca-blocking-')); roots.push(root)
  const env: NodeJS.ProcessEnv = { HOME: root, XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config') }
  writeSessionState(THREAD, env, { harness: 'codex', orca_chat: { key: 'owner', session_id: ORCA }, orca_blocking: [registration()], ...extra } as SessionState)
  return { env, root }
}
const presentation = (env: NodeJS.ProcessEnv, runtime: OrcaRuntime) => orcaBlockingPresentation({ sessionId: THREAD, env,
  lease: { incarnation: 'inc', generation: 1 }, ownerKey: 'owner', service: SERVICE, serviceCurrent: () => true, wall: () => 1_793_872_000_000, runtime })

describe('returning a device answer through Orca', () => {
  it('answers each picked item once with Orca\'s own question id, revision, fence and fingerprint', async () => {
    const h = home()
    const orca = fakeOrca()
    const device = answer([{ question_id: 'which-color', choice_ids: ['blue'] }, { question_id: 'which-size', choice_ids: ['large'] }])
    const prepared = (await presentation(h.env, orca.runtime).prepareGroup!([device], readSessionState(THREAD, h.env), 0))!
    await prepared.write(() => true)
    const responses = orca.calls.filter((call) => call.method === 'agentSession.respondToQuestion').map((call) => call.params)
    expect(responses).toHaveLength(2)
    const fields = { itemId: item('color'), expectedRevision: 1, answers: [{ questionId: 'q1', optionIds: ['color:Blue'] }] }
    expect(responses[0]).toEqual({ ...fields, envelope: { sessionId: ORCA, clientOperationId: expect.stringMatching(/^1793872000000-[0-9a-f]{32}$/u),
      expectedRuntimeFence: 2, payloadFingerprint: orcaPayloadFingerprint('agentSession.respondTo:question', ORCA, fields) } })
    expect(orca.calls.some((call) => call.method === 'agentSession.send')).toBe(false)
    // The tool result carries the choices; the next hook adds only the acknowledgement, once.
    const deps = { env: { ...h.env, NOTIFAI_HOOK_SOURCE_PID: String(process.pid) }, cwd: h.root } as unknown as CommandDeps
    const owner = beginSessionIncarnation(THREAD, deps.env, { stamp: lifecycleStamp(), harnessProcess: currentProcessIdentity()! })
    writeSessionState(THREAD, deps.env, { ...readSessionState(THREAD, deps.env), orca_blocking: readSessionState(THREAD, deps.env).orca_blocking!.map((entry) => ({ ...entry, owner_key: owner.key })) })
    const post = orcaBlockingPostToolUse(deps, { session_id: THREAD, tool_name: 'request_user_input', tool_use_id: CALL })
    expect(post.carried).toBe(true)
    expect(post.context).toContain('in the tool result')
    expect(post.context).toContain('notifai acknowledge req_block')
    expect(orcaBlockingPostToolUse(deps, { session_id: THREAD, tool_name: 'request_user_input', tool_use_id: CALL }).context).toBeNull()
  })

  it('sends a typed answer as the User\'s message quoting its question, as typing in Orca does, and acknowledges it once', async () => {
    const h = home()
    const orca = fakeOrca()
    const device = answer([{ question_id: 'which-color', text: 'teal, please' }])
    const prepared = (await presentation(h.env, orca.runtime).prepareGroup!([device], readSessionState(THREAD, h.env), 0))!
    await prepared.write(() => true)
    const send = orca.calls.find((call) => call.method === 'agentSession.send')!.params as { body: { blocks: Array<{ text: string }> } }
    expect(send.body.blocks[0]!.text).toBe('> Which color?\n\nteal, please')
    expect(orca.calls.some((call) => call.method === 'agentSession.respondToQuestion')).toBe(false)
    // Codex hands it in with `UserPromptSubmit` once the pausing question is answered (live, Codex 0.166 in Orca 1.4.248).
    const first = takeOrcaBlockingTypedAck(THREAD, h.env, '> Which color?\n\nteal, please\n')
    expect(first.typed).toBe(true)
    expect(first.context).toContain('what they typed arrives as their message')
    expect(takeOrcaBlockingTypedAck(THREAD, h.env, '> Which color?\n\nteal, please')).toEqual({ typed: false, context: null })
    expect(takeOrcaBlockingTypedAck(THREAD, h.env, 'something else')).toEqual({ typed: false, context: null })
  })

  it('keeps an answer the User gave in Orca first, retries a stale revision once, and sends nothing Orca took none of', async () => {
    const resolved = home()
    let first = true
    const orca = fakeOrca({ respond: (itemId) => itemId === item('color')
      ? { ok: true, result: { ok: false, refusal: { code: 'agent_session_already_resolved' } } }
      : first ? (first = false, { ok: true, result: { ok: false, refusal: { code: 'agent_session_item_revision_stale' } } }) : { ok: true, result: { ok: true } } })
    const both = answer([{ question_id: 'which-color', choice_ids: ['red'] }, { question_id: 'which-size', choice_ids: ['small'] }])
    await (await presentation(resolved.env, orca.runtime).prepareGroup!([both], readSessionState(THREAD, resolved.env), 0))!.write(() => true)
    expect(orca.calls.filter((call) => call.method === 'agentSession.respondToQuestion').map((call) => (call.params as { itemId: string }).itemId))
      .toEqual([item('color'), item('size'), item('size')])
    const none = home()
    const taken = fakeOrca({ respond: () => ({ ok: true, result: { ok: false, refusal: { code: 'agent_session_already_resolved' } } }) })
    const prepared = (await presentation(none.env, taken.runtime).prepareGroup!([both], readSessionState(THREAD, none.env), 0))!
    await expect(prepared.write(() => true)).rejects.toBeInstanceOf(CodexControlNotSent)
    expect(readSessionState(THREAD, none.env).orca_blocking![0]!.presented).toBeUndefined()
  })

  it('leaves out a typed part whose question the User already answered in Orca (first reply wins)', async () => {
    const h = home()
    const orca = fakeOrca({ items: [pendingItem('color', 'Which color?', ['Red', 'Blue'], 'resolved', 2), pendingItem('size', 'Which size?', ['Small', 'Large'])] })
    const device = answer([{ question_id: 'which-color', text: 'teal' }, { question_id: 'which-size', choice_ids: ['large'] }])
    await (await presentation(h.env, orca.runtime).prepareGroup!([device], readSessionState(THREAD, h.env), 0))!.write(() => true)
    expect(orca.calls.some((call) => call.method === 'agentSession.send')).toBe(false)
    expect(orca.calls.filter((call) => call.method === 'agentSession.respondToQuestion').map((call) => (call.params as { itemId: string }).itemId)).toEqual([item('size')])
    // Answered in Orca throughout: nothing goes, and the ordinary route keeps the device answer.
    const all = home()
    const resolved = fakeOrca({ items: [pendingItem('color', 'Which color?', ['Red', 'Blue'], 'resolved', 2)] })
    const typedOnly = (await presentation(all.env, resolved.runtime).prepareGroup!([answer([{ question_id: 'which-color', text: 'teal' }])], readSessionState(THREAD, all.env), 0))!
    await expect(typedOnly.write(() => true)).rejects.toBeInstanceOf(CodexControlNotSent)
    expect(resolved.calls.some((call) => call.method === 'agentSession.send')).toBe(false)
  })

  it('sends a choice Orca\'s item refused as the User\'s message, so the whole device answer reaches the agent once', async () => {
    const h = home()
    const orca = fakeOrca({ respond: (itemId) => itemId === item('size')
      ? { ok: true, result: { ok: false, refusal: { code: 'agent_session_operation_invalid' } } } : { ok: true, result: { ok: true } } })
    const device = answer([{ question_id: 'which-color', choice_ids: ['blue'] }, { question_id: 'which-size', choice_ids: ['large'] }])
    await (await presentation(h.env, orca.runtime).prepareGroup!([device], readSessionState(THREAD, h.env), 0))!.write(() => true)
    const sends = orca.calls.filter((call) => call.method === 'agentSession.send').map((call) => (call.params as { body: { blocks: Array<{ text: string }> } }).body.blocks[0]!.text)
    expect(sends).toEqual(['> Which size?\n\nLarge'])
    const ack = readSessionState(THREAD, h.env).orca_blocking![0]!.ack!
    expect(ack.context).toContain('their choice is in the tool result; what they typed arrives as their message')
    expect(takeOrcaBlockingTypedAck(THREAD, h.env, '> Which size?\n\nLarge').typed).toBe(true)
    // A lost reply may have been taken: it is never sent again as a message.
    const lost = home()
    const timeout = fakeOrca({ respond: (itemId) => itemId === item('size') ? { ok: false, code: 'timeout' } : { ok: true, result: { ok: true } } })
    await (await presentation(lost.env, timeout.runtime).prepareGroup!([device], readSessionState(THREAD, lost.env), 0))!.write(() => true)
    expect(timeout.calls.some((call) => call.method === 'agentSession.send')).toBe(false)
  })

  it('offers nothing without Orca\'s question answers, and nothing for another chat\'s items', async () => {
    const h = home()
    const device = answer([{ question_id: 'which-color', choice_ids: ['blue'] }])
    expect(await presentation(h.env, fakeOrca({ capabilities: ['agent-session.structured.v1'] }).runtime).prepareGroup!([device], readSessionState(THREAD, h.env), 0)).toBeNull()
    const gone = (await presentation(h.env, fakeOrca({ items: [] }).runtime).prepareGroup!([device], readSessionState(THREAD, h.env), 0))!
    await expect(gone.write(() => true)).rejects.toBeInstanceOf(CodexControlNotSent)
  })
})

describe('the User answering in Orca', () => {
  it('closes the device question; the agent gets no "not carried" notice', () => {
    const h = home()
    const deps = { env: { ...h.env, NOTIFAI_HOOK_SOURCE_PID: String(process.pid) }, cwd: h.root, spawnQuestionSettlement: vi.fn() } as unknown as CommandDeps
    const owner = beginSessionIncarnation(THREAD, deps.env, { stamp: lifecycleStamp(), harnessProcess: currentProcessIdentity()! })
    writeSessionState(THREAD, deps.env, { ...readSessionState(THREAD, deps.env),
      pending: [{ question_id: 'q_block', question: '', summary: '', request_id: 'req_block', collapse_key: 'ck', device_ids: ['dev'], service_identity: SERVICE }],
      orca_blocking: [{ ...registration(), owner_key: owner.key }] })
    expect(orcaBlockingPostToolUse(deps, { session_id: THREAD, tool_name: 'request_user_input', tool_use_id: CALL })).toEqual({ carried: true, context: null })
    const state = readSessionState(THREAD, deps.env)
    expect(state.orca_blocking![0]!.ended).toBe(true)
    expect(state.pending ?? []).toEqual([])
    expect(state.retiring?.map((entry) => entry.request_id)).toEqual(['req_block'])
    // Any other tool, or a call Notifai never mirrored, is not this route's.
    expect(orcaBlockingPostToolUse(deps, { session_id: THREAD, tool_name: 'request_user_input', tool_use_id: 'call_other' }).carried).toBe(false)
  })
})

describe('looking at an Orca chat', () => {
  function project() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-orca-blocking-reg-')); roots.push(root)
    const env: NodeJS.ProcessEnv = { HOME: path.join(root, 'home'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config') }
    mkdirSync(env['HOME']!, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: root })
    enableProject(projectBinding(root, env)!)
    const owner = beginSessionIncarnation(THREAD, env, { stamp: lifecycleStamp(), harnessProcess: currentProcessIdentity()! }).key
    writeSessionState(THREAD, env, { ...readSessionState(THREAD, env), harness: 'codex', orca_chat: { key: owner, session_id: ORCA } })
    const transcript = path.join(root, 'rollout.jsonl')
    writeFileSync(transcript, `${JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: CALL,
      arguments: JSON.stringify({ questions: [{ id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
        { id: 'size', header: 'Size', question: 'Which size?', options: [{ label: 'Small', description: '' }, { label: 'Large', description: '' }] }] }) } })}\n`)
    const launch = vi.fn()
    const deps = { env, cwd: root, io: { out: () => {}, err: () => {}, confirm: async () => false, openUrl: () => {} },
      store: { load: () => ({ machineId: SERVICE.machine_id, secret: 's', baseUrl: SERVICE.base_url, machineName: 'm' }) },
      spawnQuestionSettlement: launch } as unknown as CommandDeps
    return { env, root, transcript, launch, deps, owner }
  }

  it('registers one device question per pausing request, with its headers and option descriptions, once', async () => {
    const h = project()
    const skip = new Set<string>()
    const run = (items?: unknown[]) => reconcileOrcaBlocking(h.deps, { sessionId: THREAD, env: h.env, cwd: h.root, ownerKey: h.owner, transcriptPath: h.transcript,
      runtime: fakeOrca(items === undefined ? {} : { items }).runtime, now: Date.now(), skip })
    const first = await run()
    expect(first.registered).toHaveLength(1)
    const state = readSessionState(THREAD, h.env)
    expect(state.pending![0]!.questions).toEqual([
      expect.objectContaining({ text: 'Which color?', title: 'Color', choices: [expect.objectContaining({ label: 'Red', description: 'warm' }), expect.objectContaining({ label: 'Blue', description: 'cool' })] }),
      expect.objectContaining({ text: 'Which size?', title: 'Size' }),
    ])
    expect(state.orca_blocking![0]!.items.map((entry) => Object.values(entry.options))).toEqual([['color:Red', 'color:Blue'], ['size:Small', 'size:Large']])
    expect(h.launch).toHaveBeenCalledTimes(1)
    expect((await run()).registered).toEqual([])
  })

  it('asks once per request even when its record was lost after registering, and asks Orca\'s capabilities only every few minutes', async () => {
    const h = project()
    const cache: { capabilities?: { at: number; ok: boolean } } = {}
    const orca = fakeOrca()
    const run = (now: number) => reconcileOrcaBlocking(h.deps, { sessionId: THREAD, env: h.env, cwd: h.root, ownerKey: h.owner, transcriptPath: h.transcript,
      runtime: orca.runtime, now, skip: new Set(), capabilities: cache })
    const first = await run(1_000)
    // A crash between the question's registration and the Orca record.
    const state = readSessionState(THREAD, h.env)
    writeSessionState(THREAD, h.env, { ...state, orca_blocking: [] })
    const again = await run(2_000)
    expect(again.registered).toEqual(first.registered)
    expect(readSessionState(THREAD, h.env).pending).toHaveLength(1)
    expect(orca.calls.filter((call) => call.method === 'status.get')).toHaveLength(1)
    // Only the tail of the chat is read.
    expect(orca.calls.find((call) => call.method === 'agentSession.history')!.params).toMatchObject({ limit: 30 })
    await run(1_000 + 300_000)
    expect(orca.calls.filter((call) => call.method === 'status.get')).toHaveLength(2)
  })

  it('withdraws, without a new alert, a question whose request left Orca unanswered', async () => {
    const h = project()
    const skip = new Set<string>()
    const at = (now: number, items?: unknown[]) => reconcileOrcaBlocking(h.deps, { sessionId: THREAD, env: h.env, cwd: h.root, ownerKey: h.owner,
      transcriptPath: h.transcript, runtime: fakeOrca(items === undefined ? {} : { items }).runtime, now, skip })
    await at(1_000)
    const pending = readSessionState(THREAD, h.env).pending![0]!
    writeSessionState(THREAD, h.env, { ...readSessionState(THREAD, h.env), pending: [{ ...pending, request_id: 'req_x', collapse_key: 'ck', device_ids: ['dev'] }] })
    expect((await at(2_000, [])).withdrawn).toEqual([])
    expect((await at(10_000, [])).withdrawn).toEqual([])
    expect((await at(20_000, [])).withdrawn).toEqual([pending.question_id])
    expect(readSessionState(THREAD, h.env).orca_blocking![0]!.ended).toBe(true)
  })

  it('leaves a request it cannot carry to Orca alone, and asks nothing of an Orca without question answers', async () => {
    const h = project()
    const skip = new Set<string>()
    const one = await reconcileOrcaBlocking(h.deps, { sessionId: THREAD, env: h.env, cwd: h.root, ownerKey: h.owner, runtime: fakeOrca({
      items: [pendingItem('pick', 'Pick?', ['Only'])] }).runtime, now: 1, skip })
    expect(one.registered).toEqual([])
    expect(skip.has(CALL)).toBe(true)
    const old = fakeOrca({ capabilities: ['agent-session.structured.v1'] })
    expect((await reconcileOrcaBlocking(h.deps, { sessionId: THREAD, env: h.env, cwd: h.root, ownerKey: h.owner, runtime: old.runtime, now: 1, skip: new Set() })).registered).toEqual([])
    expect(old.calls.map((call) => call.method)).toEqual(['status.get'])
  })
})
