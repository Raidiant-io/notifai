import { execFileSync } from 'node:child_process'
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach,expect,it,vi } from 'vitest'
import type { ApiClient } from './client.js'
import { admitBoundNativeAnswer } from './codex-question-bindings.js'
import type { CommandDeps } from './commands-core.js'
import { hookRunCommand } from './commands-hook-run.js'
import { personalProjectConfigPath } from './config.js'
import { recordGuidanceGiven } from './guidance-currency.js'
import { hookAdapterPath,installHookAdapter } from './hook-adapter.js'
import { beginSessionIncarnation,lifecycleStamp,readSessionIncarnation,readSessionState,writeSessionState } from './hook-session-state.js'
import { buildHookConfig,codexHookIdentityHash,codexTrustKey,findInstallations } from './install-hooks.js'
import { currentProcessIdentity } from './process-identity.js'
import { disableProject,enableProject,projectBinding } from './project-enablement.js'
import { rootGuidanceDigest } from './session-activation.js'

const SESSION = '22222222-2222-4222-8222-222222222222'
const TURN = 'card-turn'
const CARD = { questions: [{ title: 'Which environment?', options: ['Staging', 'Production'] }] }
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** The hooks an install writes here: a source adapter on Windows names its interpreter. */
function fixtureHooks(home: string) {
  return buildHookConfig({ adapterPath: hookAdapterPath(home), harness: 'codex', ...(process.platform === 'win32' ? { nodePath: process.execPath } : {}) })
}

function setup(options: { transport?: boolean; enabled?: boolean; disabled?: boolean; signedIn?: boolean; routing?: boolean; guidanceCurrent?: boolean } = {}) {
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
    codexAnswerControl: async () => options.transport ? { namespace: env.CODEX_HOME, threadId: SESSION,
      currentTurn: async () => true, steer: async () => {}, close: () => {} } : null,
    spawnQuestionSettlement: launch,
  }
  const envelope = { session_id: SESSION, turn_id: TURN, cwd: root, transcript_path: transcript, model: 'gpt-6-sol',
    hook_event_name: 'PreToolUse', tool_name: 'request_user_input_async', tool_use_id: 'call_card', tool_input: CARD }
  return { deps, env, root, envelope, output, launch }
}

it.each([false, true])('returns one card hook document when old guidance needs refreshing (native transport: %s)', async transport => {
  const h = setup({ transport, guidanceCurrent: false })
  recordGuidanceGiven(SESSION, h.env, '0'.repeat(64))
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  expect(h.output).toHaveLength(1)
  const decision = JSON.parse(h.output.join('\n')).hookSpecificOutput
  expect(decision.hookEventName).toBe('PreToolUse')
  expect(decision.permissionDecision).toBe(transport ? undefined : 'deny')
  expect(decision.additionalContext).toContain("Notifai's guidance changed")
  expect(transport ? decision.additionalContext : decision.permissionDecisionReason).toContain(
    transport ? 'registers this card' : 'plain conversation',
  )
  h.output.length = 0
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(h.envelope), 'codex')
  expect(h.output).toHaveLength(1)
  expect(JSON.parse(h.output[0]!).hookSpecificOutput.additionalContext ?? '').not.toContain("Notifai's guidance changed")
})

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

it.each(['subagent', 'wrong-process', 'no-model'] as const)('does not take a card callback as proof: %s', async mode => {
  const h = setup()
  const envelope = mode === 'subagent' ? { ...h.envelope, agent_id: 'child' } : mode === 'no-model' ? { ...h.envelope, model: undefined } : h.envelope
  if (mode === 'wrong-process') h.env.NOTIFAI_HOOK_SOURCE_PID = '1'
  await hookRunCommand(h.deps, 'pre-tool-use', async () => JSON.stringify(envelope), 'codex')
  expect(readSessionState(SESSION, h.env).codex_card_tool).toBeUndefined()
})
