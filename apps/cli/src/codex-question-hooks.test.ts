import { cardShown, releaseCodexCardHandbacks } from './codex-card-handback.js'
import { registerQuestion } from './hook-lifecycle.js'
import { hasSessionInputs } from './session-inputs.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { personalProjectConfigPath } from './config.js'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from './client.js'
import type { CommandDeps } from './commands-core.js'
import { hookRunCommand } from './commands-hook-run.js'
import { admitBoundNativeAnswer } from './codex-question-bindings.js'
import { beginSessionIncarnation, lifecycleStamp, markSessionEnded, readSessionIncarnation, readSessionState, updateSessionState, writeSessionState } from './hook-session-state.js'
import { recordTurnStart } from './session-attendant-state.js'
import { fileURLToPath } from 'node:url'
import { hookAdapterPath, installHookAdapter } from './hook-adapter.js'
import { buildHookConfig, codexHookIdentityHash, codexTrustKey, findInstallations } from './install-hooks.js'
import { currentProcessIdentity } from './process-identity.js'
import { disableProject, enableProject, projectBinding, projectEnablementState } from './project-enablement.js'

const SESSION = '22222222-2222-4222-8222-222222222222'
const TURN = 'card-turn'
const CARD = { questions: [{ title: 'Which environment?', options: ['Staging', 'Production'] }] }
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** The hooks an install writes here: a source adapter on Windows names its interpreter. */
function fixtureHooks(home: string) {
  return buildHookConfig({ adapterPath: hookAdapterPath(home), harness: 'codex', ...(process.platform === 'win32' ? { nodePath: process.execPath } : {}) })
}

function setup(options: { transport?: boolean; enabled?: boolean; disabled?: boolean; signedIn?: boolean; routing?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-card-'))
  roots.push(root)
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'),
    CODEX_HOME: path.join(root, 'codex'), NOTIFAI_HOOK_SOURCE_PID: String(process.pid) }
  installHookAdapter({ execPath: process.execPath, scriptPath: fileURLToPath(new URL('../dist/main.js', import.meta.url)) }, env.HOME)
  mkdirSync(env.CODEX_HOME, { recursive: true })
  writeFileSync(path.join(env.CODEX_HOME, 'hooks.json'), JSON.stringify({ hooks: fixtureHooks(env.HOME) }))
  const installed = findInstallations(env, env.HOME).find(installation => installation.harness === 'codex')!
  writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), installed.handlers.map(handler =>
    `[hooks.state.${JSON.stringify(codexTrustKey(installed, handler))}]\ntrusted_hash = "${codexHookIdentityHash(handler)}"\n`).join('\n'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  if (options.enabled !== false) enableProject(projectBinding(root, env)!)
  if (options.disabled === true) disableProject(projectBinding(root, env)!)
  if (options.routing === false) {
    const settings = personalProjectConfigPath(root, env)
    mkdirSync(path.dirname(settings), { recursive: true })
    writeFileSync(settings, 'ask_notifications = false\n')
  }
  beginSessionIncarnation(SESSION, env, { stamp: lifecycleStamp(), harnessProcess: currentProcessIdentity()! })
  writeSessionState(SESSION, env, { harness: 'codex', last_prompt_at: Date.now() })
  const transcript = path.join(env.CODEX_HOME, 'sessions', 'owned.jsonl')
  mkdirSync(path.dirname(transcript), { recursive: true })
  writeFileSync(transcript, [
    { type: 'session_meta', payload: { id: SESSION, source: 'cli' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: TURN } },
  ].map(item => JSON.stringify(item) + '\n').join(''))
  const output: string[] = []
  const launch = vi.fn()
  const deps: CommandDeps = {
    cwd: root, env, hookAdapterHome: env.HOME,
    io: { out: line => { output.push(line) }, err: () => {}, confirm: async () => false, openUrl: () => {} },
    store: { load: () => options.signedIn === false ? null : ({ machineId: 'mac_test', secret: 'test-secret', baseUrl: 'https://test.notifai.invalid', machineName: 'test' }),
      save: () => {}, clear: () => {} } as unknown as CommandDeps['store'],
    clientFactory: () => ({ compatibility: async () => ({ server_capabilities: ['harness_answers'] }) }) as unknown as ApiClient,
    codexAnswerControl: async () => options.transport ? { namespace: env.CODEX_HOME, threadId: SESSION,
      currentTurn: async () => true, steer: async () => {}, close: () => {} } : null,
    spawnQuestionSettlement: launch,
  }
  const envelope = { session_id: SESSION, turn_id: TURN, cwd: root, transcript_path: transcript, model: 'gpt-6-sol',
    hook_event_name: 'PreToolUse', tool_name: 'request_user_input_async', tool_use_id: 'call_card', tool_input: CARD }
  return { deps, env, root, envelope, output, launch }
}

it('registers the card itself and prevents a device-unclosable card while retaining a conversation answer', async () => {
  const h = setup()
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  const state = readSessionState(SESSION, h.env)
  expect(state.pending).toHaveLength(1)
  expect(state.pending![0]!.questions).toEqual([{ id: expect.any(String), text: 'Which environment?',
    choices: [{ id: expect.any(String), label: 'Staging' }, { id: expect.any(String), label: 'Production' }] }])
  const decision = JSON.parse(h.output.join('\n')).hookSpecificOutput
  expect(decision.permissionDecision).toBe('deny')
  expect(decision.permissionDecisionReason).toContain('plain conversation')
  expect(decision.permissionDecisionReason).toContain('notifai close ' + state.pending![0]!.question_id)
  expect(decision.permissionDecisionReason).toContain('Staging')
  expect(decision.permissionDecisionReason).toContain('Production')
  const owner = readSessionIncarnation(SESSION, h.env)!
  expect(() => admitBoundNativeAnswer(state, state.pending![0]!.question_id!, owner.key,
    state.pending![0]!.service_identity!, [{ question_id: state.pending![0]!.questions![0]!.id, text: 'Staging' }])).toThrow()
  expect(h.launch).toHaveBeenCalledTimes(1)
})

it('registers the card in a Project with no record, and leaves the Project as it was', async () => {
  const h = setup({ enabled: false })
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  expect(readSessionState(SESSION, h.env).pending).toHaveLength(1)
  expect(h.launch).toHaveBeenCalledTimes(1)
  expect(projectEnablementState(projectBinding(h.root, h.env))).toBe('unset')
})

it.each(['disabled', 'signed-out', 'routing-off', 'subagent', 'wrong-process', 'untrusted', 'narrowed-post-hook'] as const)(
  'leaves a card untouched when Notifai would not route it: %s', async mode => {
    const h = setup({ disabled: mode === 'disabled', signedIn: mode !== 'signed-out', routing: mode !== 'routing-off' })
    const envelope = { ...h.envelope,
      ...(mode === 'subagent' ? { agent_id: 'child' } : {}),
    }
    if (mode === 'wrong-process') h.env.NOTIFAI_HOOK_SOURCE_PID = '1'
    if (mode === 'untrusted') writeFileSync(path.join(h.env.CODEX_HOME, 'config.toml'), '')
    if (mode === 'narrowed-post-hook') {
      const hooks = fixtureHooks(h.env.HOME)
      hooks.PostToolUse![0]!.matcher = 'request_user_input_async'
      writeFileSync(path.join(h.env.CODEX_HOME, 'hooks.json'), JSON.stringify({ hooks }))
      const installed = findInstallations(h.env, h.env.HOME).find(installation => installation.harness === 'codex')!
      writeFileSync(path.join(h.env.CODEX_HOME, 'config.toml'), installed.handlers.map(handler =>
        `[hooks.state.${JSON.stringify(codexTrustKey(installed, handler))}]\ntrusted_hash = "${codexHookIdentityHash(handler)}"\n`).join('\n'))
    }
    await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(envelope), 'codex')
    expect(h.output).toEqual([])
    expect(readSessionState(SESSION, h.env).pending ?? []).toHaveLength(0)
    expect(h.launch).not.toHaveBeenCalled()
  },
)

it('records that this owner can call the card, under the model its callback ran with', async () => {
  const h = setup({ enabled: false })
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  expect(readSessionState(SESSION, h.env).codex_card_tool).toEqual({
    key: readSessionIncarnation(SESSION, h.env)!.key, model: 'gpt-6-sol', transcript_path: h.envelope.transcript_path })
})

it.each(['subagent', 'wrong-process', 'no-model'] as const)('does not take a card callback as proof: %s', async mode => {
  const h = setup()
  const envelope = mode === 'subagent' ? { ...h.envelope, agent_id: 'child' } : mode === 'no-model' ? { ...h.envelope, model: undefined } : h.envelope
  if (mode === 'wrong-process') h.env.NOTIFAI_HOOK_SOURCE_PID = '1'
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(envelope), 'codex')
  expect(readSessionState(SESSION, h.env).codex_card_tool).toBeUndefined()
})

it('retains the registered ordinary question and prevents its card when background startup fails', async () => {
  const h = setup()
  h.deps.spawnQuestionSettlement = () => { throw new Error('controlled launch failure') }
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  expect(readSessionState(SESSION, h.env).pending).toHaveLength(1)
  expect(JSON.parse(h.output.join('\n')).hookSpecificOutput.permissionDecision).toBe('deny')
})

it.each(['turn', 'owner', 'machine'] as const)('does not register or deny after %s authority changes during discovery', async mode => {
  const h = setup()
  h.deps.codexAnswerControl = async () => {
    const owner = readSessionIncarnation(SESSION, h.env)!
    if (mode === 'turn') recordTurnStart(SESSION, h.env, owner.key, 'newer-turn')
    if (mode === 'owner') markSessionEnded(SESSION, h.env, Date.now())
    if (mode === 'machine') h.deps.store.load = () => null
    return null
  }
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  expect(readSessionState(SESSION, h.env).pending ?? []).toHaveLength(0)
  expect(h.output).toEqual([])
  expect(h.launch).not.toHaveBeenCalled()
})

it('binds every question of an allowed card to its actual tool call without a copied marker', async () => {
  const h = setup({ transport: true })
  const input = { questions: [...CARD.questions, { title: 'Which region?', options: ['East', 'West'] }] }
  await hookRunCommand(h.deps, 'pre-tool-use',
    async () => JSON.stringify({ ...h.envelope, tool_input: input }), 'codex')
  // Successful interception adds context; no unsupported allow decision.
  expect(JSON.parse(h.output.join('\n')).hookSpecificOutput.permissionDecision).toBeUndefined()
  expect(JSON.parse(h.output.join('\n')).hookSpecificOutput.additionalContext).toContain('registers this card')
  // Devices cannot answer a card before Codex has actually accepted it.
  expect(h.launch).not.toHaveBeenCalled()
  expect(readSessionState(SESSION, h.env).pending ?? []).toHaveLength(0)
  const post = { ...h.envelope, hook_event_name: 'PostToolUse', tool_input: input, tool_response: '{"accepted":true}' }
  // A different card with the same wording has no authority over this one.
  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...post, tool_response: { accepted: false } }), 'codex')
  expect(h.launch).not.toHaveBeenCalled()
  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify(post), 'codex')
  const context = JSON.parse(h.output.at(-1)!).hookSpecificOutput.additionalContext
  expect(context).toContain('Notifai records a terminal answer itself.')
  expect(context).toContain('run it before dependent work')
  expect(context).not.toMatch(/--native-answers|--operation-id/)
  const pending = readSessionState(SESSION, h.env).pending![0]!
  expect(pending.questions).toHaveLength(2)
  expect(readSessionState(SESSION, h.env).codex_question_bindings![0]!.questions.map(q => q.native)).toEqual([
    { turn_id: TURN, call_id: 'call_card', index: 0 }, { turn_id: TURN, call_id: 'call_card', index: 1 },
  ])
  const owner = readSessionIncarnation(SESSION, h.env)!
  expect(admitBoundNativeAnswer(readSessionState(SESSION, h.env), pending.question_id!, owner.key, pending.service_identity!,
    pending.questions!.map(question => ({ question_id: question.id, choice_ids: [question.choices![0]!.id] })))).toEqual({ service: pending.service_identity })
})

it('registers one question for the same tool invocation, and for an identical card while that question is open', async () => {
  const h = setup()
  const run = (id: string) => hookRunCommand(h.deps, 'pre-tool-use',
    async () => JSON.stringify({ ...h.envelope, tool_use_id: id }), 'codex')
  await run('call_card')
  await run('call_card')
  // The duplicate guard: an identical card asked while the first is still open
  // is the same question, so the User is asked once.
  await run('call_other')
  const pending = readSessionState(SESSION, h.env).pending ?? []
  expect(pending).toHaveLength(1)
  // A card has no heading, so its title is the Agent Session name, never the card text.
  expect(pending[0]!.title).toBeDefined()
  expect(pending[0]!.title).not.toBe('Which environment?')
  expect(h.output.map(line => JSON.parse(line).hookSpecificOutput.permissionDecision)).toEqual(['deny', 'deny', 'deny'])
})

it('refuses an unsupported card in a routed session without registering it', async () => {
  const h = setup({ transport: true })
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify({ ...h.envelope,
    tool_input: { questions: [{ title: 'Control?', options: ['1', '2', '3', '4', '5', '6', '7'] }] } }), 'codex')
  expect(JSON.parse(h.output.join('\n')).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny',
    permissionDecisionReason: expect.stringContaining('Notifai cannot carry this card') })
  expect(readSessionState(SESSION, h.env).pending ?? []).toHaveLength(0)
})

function handedBack(h: ReturnType<typeof setup>) {
  const owner = readSessionIncarnation(SESSION, h.env)!
  recordTurnStart(SESSION, h.env, owner.key, TURN)
  const service = { machine_id: 'mac_test', base_url: 'https://test.notifai.invalid' }
  const questions = [{ id: 'environment', text: CARD.questions[0]!.title, choices: [
    { id: 'staging', label: 'Staging', description: 'No customer impact.' },
    { id: 'production', label: 'Production', description: 'Customers see it.' },
  ] }]
  const { question_id: id } = registerQuestion(SESSION, h.env, { question: questions[0]!.text, title: 'Deployment destination',
    summary: questions[0]!.text, body: 'Deployment evidence: ![result](media:1)', media: ['med_evidence'],
    service_identity: service, questions }, Date.now(), { owner_key: owner.key, turn_id: TURN, service, handback: cardShown(questions) })
  const pre = () => hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  const post = () => hookRunCommand(h.deps, 'post-tool-use',
    async () => JSON.stringify({ ...h.envelope, hook_event_name: 'PostToolUse', tool_response: '{"accepted":true}' }), 'codex')
  const state = () => readSessionState(SESSION, h.env)
  const answer = () => {
    const pending = { ...state().pending![0]!, request_id: 'req_early' }
    const reply = { reply_id: 'reply_early', seq: 1, delivery_id: 'delivery_test', device_id: 'device_test', device_name: 'Test',
      text: 'Production', answers: [{ question_id: 'environment', choice_ids: ['production'], text: null }], source: null,
      created_at: new Date().toISOString() }
    updateSessionState(SESSION, h.env, state => ({ ...state, pending: [], waiting_answers: [{ pending, reply, replies: [reply],
      agent_acknowledgement_required: true, delivery_claim: true }],
      acknowledgement_due: [{ request_id: 'req_early', recorded_at: Date.now(), text_required: true }],
      codex_question_bindings: state.codex_question_bindings!.map(item => ({ ...item, confirmed_request_id: 'req_early' })) }))
  }
  return { id, state, pre, post, answer }
}

it('links the exact card to registered content, preserving descriptions and media', async () => {
  const h = setup({ transport: true }); const q = handedBack(h)
  await q.pre()
  expect(q.state().codex_question_bindings![0]!.card_accept_until).toBeGreaterThan(Date.now())
  await q.post()
  expect(q.state().pending).toHaveLength(1)
  expect(q.state().pending![0]).toMatchObject({ title: 'Deployment destination', media: ['med_evidence'],
    body: 'Deployment evidence: ![result](media:1)', questions: [{ choices: [{ description: 'No customer impact.' }, { description: 'Customers see it.' }] }] })
  expect(q.state().codex_question_bindings![0]).toMatchObject({ question_id: q.id,
    questions: [{ verified: true, native: { turn_id: TURN, call_id: 'call_card', index: 0 } }] })
  expect(q.state().codex_question_bindings![0]).not.toHaveProperty('card_accept_until')
  expect(h.launch).not.toHaveBeenCalled()
})

it.each(['character', 'order', 'unsupported'] as const)('keeps one plain question when the card changes: %s', async change => {
  const h = setup({ transport: true }); const q = handedBack(h)
  const input = { questions: [{ ...CARD.questions[0]!, ...(change === 'character' ? { title: 'Which environment!' }
    : { options: change === 'order' ? ['Production', 'Staging'] : ['1', '2', '3', '4', '5', '6', '7'] }) }] }
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify({ ...h.envelope, tool_input: input }), 'codex')
  const denial = JSON.parse(h.output.at(-1)!).hookSpecificOutput
  expect(denial.permissionDecision).toBe('deny')
  expect(denial.permissionDecisionReason).toContain(`This card does not match the question registered as ${q.id}`)
  expect(denial.permissionDecisionReason).toContain('Which environment?\n- Staging\n- Production')
  expect(denial.permissionDecisionReason).not.toContain('open exactly')
  expect(q.state().pending).toHaveLength(1)
  expect(q.state().pending![0]!.media).toEqual(['med_evidence'])
  await q.pre()
  expect(JSON.parse(h.output.at(-1)!).hookSpecificOutput.permissionDecision).toBe('deny')
})

it('refuses an answered hand-back before opening the card', async () => {
  const h = setup({ transport: true }); const q = handedBack(h); q.answer()
  await q.pre()
  expect(JSON.parse(h.output.at(-1)!).hookSpecificOutput.permissionDecisionReason).toContain('already answered; it arrives as your next input')
  expect(hasSessionInputs(SESSION, h.env, null)).toBe(true)
})

it('holds an early answer until the card accepts it', async () => {
  const h = setup({ transport: true }); const q = handedBack(h)
  await q.pre(); q.answer()
  expect(hasSessionInputs(SESSION, h.env, null)).toBe(false)
  await q.post()
  expect(hasSessionInputs(SESSION, h.env, null)).toBe(true)
  expect(q.state().codex_question_bindings![0]!.questions[0]!.verified).toBe(true)
})

it.each(['post-tool-use', 'stop', 'interrupt', 'user-prompt-submit', 'timeout'])(
  'releases a held answer at %s and rejects late acceptance', async event => {
    const h = setup({ transport: true }); const q = handedBack(h)
    await q.pre(); q.answer()
    expect(hasSessionInputs(SESSION, h.env, null)).toBe(false)
    if (event === 'timeout') {
      const deadline = q.state().codex_question_bindings![0]!.card_accept_until!
      vi.spyOn(Date, 'now').mockReturnValue(deadline)
      expect(hasSessionInputs(SESSION, h.env, null)).toBe(true)
      await q.post()
      vi.restoreAllMocks()
    } else {
      releaseCodexCardHandbacks(SESSION, h.env, { ...h.envelope, tool_response: { accepted: false } }, event)
      expect(hasSessionInputs(SESSION, h.env, null)).toBe(true)
      await q.post()
    }
    expect(q.state().codex_question_bindings![0]!.ordinary_only).toBe(true)
    expect(q.state().codex_question_bindings![0]!.questions[0]!.native).toBeUndefined()
  },
)
