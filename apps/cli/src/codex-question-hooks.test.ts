import { execFileSync } from 'node:child_process'
import { appendFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach,expect,it,vi } from 'vitest'
import type { ApiClient } from './client.js'
import { prepareCommandGuidanceRead,recordCommandGuidanceRead } from './command-guidance.js'
import { askCommand } from './commands-ask.js'
import type { CommandDeps } from './commands-core.js'
import { registerQuestion } from './hook-lifecycle.js'
import { readSessionIncarnation } from './hook-session-state.js'
import { hookRunCommand } from './commands-hook-run.js'
import { personalProjectConfigPath } from './config.js'
import { recordGuidanceGiven } from './guidance-currency.js'
import { hookAdapterPath,installHookAdapter } from './hook-adapter.js'
import { beginSessionIncarnation,lifecycleStamp,readSessionState,writeSessionState } from './hook-session-state.js'
import { buildHookConfig,codexHookIdentityHash,codexStopDefinitionFingerprint,codexTrustKey,findInstallations } from './install-hooks.js'
import { currentProcessIdentity } from './process-identity.js'
import { disableProject,enableProject,projectBinding } from './project-enablement.js'
import { rootGuidanceDigest } from './session-activation.js'
import { recordTurnStart } from './session-attendant-state.js'

const SESSION = '22222222-2222-4222-8222-222222222222'
const TURN = 'card-turn'
const CARD = { questions: [{ title: 'Which environment?', options: ['Staging', 'Production'] }] }
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** The hooks an install writes here: a source adapter on Windows names its interpreter. */
function fixtureHooks(home: string) {
  return buildHookConfig({ adapterPath: hookAdapterPath(home), harness: 'codex', ...(process.platform === 'win32' ? { nodePath: process.execPath } : {}) })
}

function setup(options: { enabled?: boolean; disabled?: boolean; signedIn?: boolean; routing?: boolean; guidanceCurrent?: boolean } = {}) {
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
  if (options.guidanceCurrent !== false) recordGuidanceGiven(SESSION, env, rootGuidanceDigest(root, env))
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
    spawnQuestionSettlement: launch,
  }
  const envelope = { session_id: SESSION, turn_id: TURN, cwd: root, transcript_path: transcript, model: 'gpt-6-sol',
    hook_event_name: 'PreToolUse', tool_name: 'request_user_input_async', tool_use_id: 'call_card', tool_input: CARD }
  return { deps, env, root, envelope, output, launch }
}

it('returns one card hook document when old guidance needs refreshing', async () => {
  const h = setup({ guidanceCurrent: false })
  recordGuidanceGiven(SESSION, h.env, '0'.repeat(64))
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  expect(h.output).toHaveLength(1)
  const decision = JSON.parse(h.output.join('\n')).hookSpecificOutput
  expect(decision.hookEventName).toBe('PreToolUse')
  expect(decision.permissionDecision).toBeUndefined()
  expect(decision.additionalContext).toContain("Notifai's guidance changed")
  expect(decision.additionalContext).toContain('registers this card')
  h.output.length = 0
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  expect(h.output).toHaveLength(1)
  expect(h.output.join('')).not.toContain("Notifai's guidance changed")
})

it('queues only an accepted card and does not claim confirmed device registration', async () => {
  const h = setup()
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  expect(readSessionState(SESSION, h.env).pending ?? []).toEqual([])
  expect(h.launch).not.toHaveBeenCalled()
  h.output.length = 0
  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...h.envelope,
    hook_event_name: 'PostToolUse', tool_response: { accepted: true } }), 'codex')
  const state = readSessionState(SESSION, h.env)
  expect(state.pending).toHaveLength(1)
  expect(state.pending![0]!.questions).toEqual([{ id: expect.any(String), text: 'Which environment?',
    choices: [{ id: expect.any(String), label: 'Staging' }, { id: expect.any(String), label: 'Production' }] }])
  expect(h.output.join('')).toContain('delivery is not confirmed yet')
  expect(h.output.join('')).not.toContain('is registered')
  expect(h.launch).toHaveBeenCalledTimes(1)
})

it('carries a card question longer than a device question, with its full wording in the Body', async () => {
  const h = setup()
  const long = 'I found the saved bank and exchange documents and a spreadsheet of card top-ups covering most of the year, ' +
    'but the declaration still needs a few details that only you have. ' +
    'Please send the recipient\'s full legal name, your current address, and the dates and amounts the bank wants covered.'
  expect(long.length).toBeGreaterThan(240)
  const card = { questions: [{ title: long }] }
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify({ ...h.envelope, tool_input: card }), 'codex')
  expect(h.output.join('')).not.toContain('permissionDecision')
  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...h.envelope, tool_input: card,
    hook_event_name: 'PostToolUse', tool_response: { accepted: true } }), 'codex')
  const pending = readSessionState(SESSION, h.env).pending!
  expect(pending).toHaveLength(1)
  expect([...pending[0]!.questions![0]!.text].length).toBeLessThanOrEqual(240)
  // The closing sentence is what the card asks; whole sentences only, never a leading ellipsis.
  expect(pending[0]!.questions![0]!.text).toBe('Please send the recipient\'s full legal name, your current address, and the dates and amounts the bank wants covered.')
  expect(pending[0]!.body).toContain(long)
})

it('leaves an unrepresentable self-opened card to the native harness', async () => {
  const h = setup()
  const card = { questions: [{ title: 'Which environment?', options: ['Staging', 'Staging'] }] }
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify({ ...h.envelope, tool_input: card }), 'codex')
  expect(h.output.join('')).not.toContain('permissionDecision')
  expect(readSessionState(SESSION, h.env).pending ?? []).toEqual([])
})

it.each(['subagent', 'wrong-process', 'no-model'] as const)('does not take a card callback as proof: %s', async mode => {
  const h = setup()
  const envelope = mode === 'subagent' ? { ...h.envelope, agent_id: 'child' } : mode === 'no-model' ? { ...h.envelope, model: undefined } : h.envelope
  if (mode === 'wrong-process') h.env.NOTIFAI_HOOK_SOURCE_PID = '1'
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(envelope), 'codex')
  expect(readSessionState(SESSION, h.env).codex_card_tool).toBeUndefined()
})


it.each(['compatibility', 'unsupported'] as const)(
  'keeps the native card available without claiming device registration on %s failure', async failure => {
    const h = setup()
    if (failure === 'compatibility') h.deps.clientFactory = () => ({ compatibility: async () => { throw new Error('offline') } }) as unknown as ApiClient
    if (failure === 'unsupported') h.deps.clientFactory = () => ({ compatibility: async () => ({ server_capabilities: [] }) }) as unknown as ApiClient
    await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
    await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...h.envelope,
      hook_event_name: 'PostToolUse', tool_response: { accepted: true } }), 'codex')
    expect(h.output.join('')).not.toMatch(/"permissionDecision":"deny"|is registered|on the User's devices/)
    expect(readSessionState(SESSION, h.env).pending ?? []).toEqual([])
    expect(h.launch).not.toHaveBeenCalled()
  },
)

it('registers a self-opened card on both ends whether or not a route closes it from a device', async () => {
  // No shared Codex server runs in this home: registration never looks for one.
  const h = setup()
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  expect(h.output.join('')).not.toContain('permissionDecision')
  expect(h.output.join('')).toContain('registers this card')
  h.output.length = 0
  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...h.envelope,
    hook_event_name: 'PostToolUse', tool_response: { accepted: true } }), 'codex')
  const state = readSessionState(SESSION, h.env)
  expect(state.pending).toHaveLength(1)
  expect(state.codex_question_bindings).toEqual([expect.objectContaining({ card_call_id: 'call_card', card_allowed: true,
    questions: [expect.objectContaining({ verified: true, native: { turn_id: TURN, call_id: 'call_card', index: 0 } })] })])
  expect(h.output.join('')).toContain('A device answer arrives with its own acknowledgement command')
  expect(h.output.join('')).not.toContain('arrives in the card')
  expect(h.launch).toHaveBeenCalledTimes(1)
})

it('registers each of several cards in one turn as its own question', async () => {
  const h = setup()
  const second = { ...h.envelope, tool_use_id: 'call_card_b', tool_input: { questions: [{ title: 'Which size?', options: ['Small', 'Large'] }] } }
  for (const envelope of [h.envelope, second]) {
    await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(envelope), 'codex')
    await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...envelope,
      hook_event_name: 'PostToolUse', tool_response: { accepted: true } }), 'codex')
  }
  const state = readSessionState(SESSION, h.env)
  expect(state.pending!.map(question => question.questions![0]!.text)).toEqual(['Which environment?', 'Which size?'])
  expect(state.codex_question_bindings!.map(item => item.card_call_id)).toEqual(['call_card', 'call_card_b'])
  expect(new Set(state.codex_question_bindings!.map(item => item.question_id)).size).toBe(2)
})

it('links a card that follows an ordinary ask of the same question instead of asking twice', async () => {
  const h = setup()
  const service = { base_url: 'https://test.notifai.invalid', machine_id: 'mac_test' }
  const { question_id: asked } = registerQuestion(SESSION, h.env, { question: 'Which environment?', summary: 'Which environment?',
    service_identity: service, questions: [{ id: 'environment', text: 'Which environment?',
      choices: [{ id: 'staging', label: 'Staging' }, { id: 'production', label: 'Production' }] }] })
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  h.output.length = 0
  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...h.envelope,
    hook_event_name: 'PostToolUse', tool_response: { accepted: true } }), 'codex')
  const state = readSessionState(SESSION, h.env)
  expect(state.pending!.map(question => question.question_id)).toEqual([asked])
  expect(state.codex_question_bindings).toEqual([expect.objectContaining({ question_id: asked, card_call_id: 'call_card',
    questions: [expect.objectContaining({ verified: true, card: { title: 'Which environment?', labels: { staging: 'Staging', production: 'Production' } } })] })])
  expect(h.output.join('')).toContain(`already registered as ${asked}`)
})

it.each([
  ['はい', 'いいえ'], ['C++', 'C#'],
  ['A', 'B'].map(end => 'The same very long option label repeated until its ending ' + end),
  ['Same  label', 'Same label'], ['Go (Recommended)', 'Go'],
])('carries distinct native Codex choices without changing their answer mapping: %j', async (...options) => {
  const h = setup()
  const envelope = { ...h.envelope, tool_input: { questions: [{ title: 'Which?', options }] } }
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(envelope), 'codex')
  expect(h.output.join('')).not.toContain('"permissionDecision":"deny"')
  h.output.length = 0
  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...envelope,
    hook_event_name: 'PostToolUse', tool_response: { accepted: true } }), 'codex')
  const state = readSessionState(SESSION, h.env)
  const choices = state.pending![0]!.questions![0]!.choices!
  expect(new Set(choices.map(choice => choice.label)).size).toBe(options.length)
  expect(new Set(choices.map(choice => choice.id)).size).toBe(options.length)
  expect(Object.values(state.codex_question_bindings![0]!.questions[0]!.card!.labels)).toEqual(options)
  expect(h.output.join('')).not.toContain('is registered')
})


it('keeps an accepted card usable when the settlement process cannot launch', async () => {
  const h = setup()
  h.launch.mockImplementation(() => { throw new Error('spawn failed') })
  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...h.envelope,
    hook_event_name: 'PostToolUse', tool_response: { accepted: true } }), 'codex')
  expect(h.launch).toHaveBeenCalledTimes(1)
  expect(h.output.join('')).toContain('delivery is not confirmed yet')
  expect(h.output.join('')).not.toMatch(/permissionDecision|is registered/)
  const pending = readSessionState(SESSION, h.env).pending!
  expect(pending).toHaveLength(1)
  expect(pending[0]!.request_id).toBeUndefined()
})

function handBack(h: ReturnType<typeof setup>, labels: Record<string, string> = { staging: 'Staging', production: 'Production' }) {
  const service = { base_url: 'https://test.notifai.invalid', machine_id: 'mac_test' }
  const owner = readSessionIncarnation(SESSION, h.env)!
  recordTurnStart(SESSION, h.env, owner.key, TURN)
  const choices = Object.entries(labels).map(([id, label]) => ({ id, label }))
  return registerQuestion(SESSION, h.env, { question: 'Which environment?', summary: 'Which environment?',
    service_identity: service, questions: [{ id: 'environment', text: 'Which environment?', choices }],
  }, Date.now(), { owner_key: owner.key, turn_id: TURN, service,
    handback: [{ title: 'Which environment?', labels }],
  }).question_id
}

it.each([false, true])('does not claim an unsubmitted ask hand-back reached devices (mismatch: %s)', async mismatch => {
  const h = setup()
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  h.output.length = 0
  const asked = handBack(h)
  const envelope = mismatch ? { ...h.envelope, tool_input: { questions: [{ title: 'Something else?' }] } } : h.envelope
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(envelope), 'codex')
  const decision = JSON.parse(h.output.join('\n')).hookSpecificOutput
  // A card that differs from the hand-back is never refused.
  expect(decision.permissionDecision).toBeUndefined()
  expect(h.output.join('')).toContain(mismatch ? 'registers this card' : 'Device delivery is not confirmed yet')
  if (!mismatch) expect(h.output.join('')).not.toContain("on the User's devices")
  expect(readSessionState(SESSION, h.env).pending!.map(question => question.question_id)).toEqual([asked])
})

it('registers a card that differs from the hand-back as its own question and names the hand-back', async () => {
  const h = setup()
  const asked = handBack(h)
  const other = { ...h.envelope, tool_input: { questions: [{ title: 'Something else?' }] } }
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(other), 'codex')
  h.output.length = 0
  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...other,
    hook_event_name: 'PostToolUse', tool_response: { accepted: true } }), 'codex')
  const state = readSessionState(SESSION, h.env)
  expect(state.pending).toHaveLength(2)
  expect(h.output.join('')).toContain(`It is not the card notifai ask handed back for ${asked}`)
  expect(h.output.join('')).toContain(`notifai close ${asked}`)
  // The hand-back stays linkable: its exact card still joins it later in the turn.
  const exact = { ...h.envelope, tool_use_id: 'call_exact' }
  h.output.length = 0
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(exact), 'codex')
  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...exact,
    hook_event_name: 'PostToolUse', tool_response: { accepted: true } }), 'codex')
  expect(readSessionState(SESSION, h.env).codex_question_bindings!.find(item => item.question_id === asked))
    .toMatchObject({ card_call_id: 'call_exact', questions: [expect.objectContaining({ verified: true })] })
  expect(readSessionState(SESSION, h.env).pending).toHaveLength(2)
})

it('links a card equal to a hand-back question even when its options are not in hand-back order', async () => {
  const h = setup()
  // A recommended choice is handed back first; a card in the ask's own order is the same question.
  const asked = handBack(h, { production: 'Production', staging: 'Staging' })
  const reordered = { ...h.envelope, tool_input: { questions: [{ title: 'Which environment?', options: ['Production', 'Staging'] }] } }
  const service = { base_url: 'https://test.notifai.invalid', machine_id: 'mac_test' }
  const state = readSessionState(SESSION, h.env)
  // The registered order is the ask's: make it differ from the handed-back card input.
  writeSessionState(SESSION, h.env, { ...state, codex_question_bindings: state.codex_question_bindings!.map(item => ({ ...item,
    questions: item.questions.map(binding => ({ ...binding, card: { title: 'Which environment?', labels: { staging: 'Staging', production: 'Production' } } })) })),
  pending: state.pending!.map(question => ({ ...question, service_identity: service, questions: [{ id: 'environment', text: 'Which environment?',
    choices: [{ id: 'production', label: 'Production' }, { id: 'staging', label: 'Staging' }] }] })) })
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(reordered), 'codex')
  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...reordered,
    hook_event_name: 'PostToolUse', tool_response: { accepted: true } }), 'codex')
  const after = readSessionState(SESSION, h.env)
  expect(after.pending!.map(question => question.question_id)).toEqual([asked])
  expect(after.codex_question_bindings).toEqual([expect.objectContaining({ question_id: asked, card_call_id: 'call_card',
    questions: [expect.objectContaining({ verified: true, card: { title: 'Which environment?', labels: { production: 'Production', staging: 'Staging' } } })] })])
  expect(after.codex_question_bindings![0]!.card_handback).toBeUndefined()
})

it('links a hand-back released earlier in the turn when its exact card opens', async () => {
  const h = setup()
  const asked = handBack(h)
  const state = readSessionState(SESSION, h.env)
  writeSessionState(SESSION, h.env, { ...state, codex_question_bindings: state.codex_question_bindings!.map(item => ({ ...item, ordinary_only: true as const })) })
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  expect(h.output.join('')).not.toContain('permissionDecision')
  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...h.envelope,
    hook_event_name: 'PostToolUse', tool_response: { accepted: true } }), 'codex')
  const binding = readSessionState(SESSION, h.env).codex_question_bindings![0]!
  expect(binding).toMatchObject({ question_id: asked, card_call_id: 'call_card', questions: [expect.objectContaining({ verified: true })] })
  expect(binding.ordinary_only).toBeUndefined()
  expect(readSessionState(SESSION, h.env).pending).toHaveLength(1)
})

it('refuses only the exact card of a hand-back that was already answered', async () => {
  const h = setup()
  const asked = handBack(h)
  const state = readSessionState(SESSION, h.env)
  writeSessionState(SESSION, h.env, { ...state, pending: [] })
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  const decision = JSON.parse(h.output.join('\n')).hookSpecificOutput
  expect(decision.permissionDecision).toBe('deny')
  expect(decision.permissionDecisionReason).toContain(`${asked} was already answered`)
})

it('hands back the card from ask without a route that closes it, and links that card to the same question', async () => {
  const h = setup()
  ;(h.env as NodeJS.ProcessEnv)['CODEX_THREAD_ID'] = SESSION
  appendFileSync(h.envelope.transcript_path, JSON.stringify({ type: 'turn_context', payload: { turn_id: TURN, model: 'gpt-6-sol' } }) + '\n')
  // A tool callback and an earlier card callback in this turn prove the hooks and the card tool.
  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...h.envelope, hook_event_name: 'PostToolUse',
    tool_name: 'shell', tool_use_id: 'call_shell', tool_input: { command: ['true'] }, tool_response: 'ok' }), 'codex')
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify({ ...h.envelope, tool_use_id: 'call_probe',
    tool_input: { questions: [{ title: 'Unrelated?' }] } }), 'codex')
  h.output.length = 0
  expect(recordCommandGuidanceRead(h.deps, prepareCommandGuidanceRead(h.deps))).toBe(true)
  const codexInstalls = findInstallations(h.env, h.env.HOME).filter(installation => installation.harness === 'codex')
  writeSessionState(SESSION, h.env, { ...readSessionState(SESSION, h.env),
    codex_stop_definition_fingerprint: codexStopDefinitionFingerprint(codexInstalls, h.env)! })
  h.output.length = 0
  const code = await askCommand(h.deps, 'Which environment?', { title: 'Deploy target', choice: ['Staging', 'Production'], json: true })
  expect(code).toBe(0)
  const result = JSON.parse(h.output.filter(line => line.trimStart().startsWith('{')).join('\n'))
  expect(result.native_question_unavailable).toBeUndefined()
  expect(result.open_form).toEqual({ tool: 'request_user_input_async', input: CARD })
  h.output.length = 0
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  expect(h.output.join('')).not.toContain('permissionDecision')
  await hookRunCommand(h.deps, 'post-tool-use', async () => JSON.stringify({ ...h.envelope,
    hook_event_name: 'PostToolUse', tool_response: { accepted: true } }), 'codex')
  const state = readSessionState(SESSION, h.env)
  expect(state.pending!.map(question => question.question_id)).toEqual([result.question_id])
  expect(state.codex_question_bindings!.find(item => item.question_id === result.question_id))
    .toMatchObject({ card_call_id: 'call_card', questions: [expect.objectContaining({ verified: true })] })
})
