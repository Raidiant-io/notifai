/**
 * Hook ingress, run for real: the launcher compiled from `launcher/main.c` in a
 * managed installation layout, offering hooks to an in-process hub, and a
 * stand-in runtime that records whenever the launcher starts it instead.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ApiClient } from './client.js'
import type { CommandDeps } from './commands-core.js'
import { SHIPPED_GUIDANCE } from './guidance-content.js'
import { readSessionState, updateSessionState } from './hook-session-state.js'
import type { SessionState } from './hook-types.js'
import { encodeFrame, ensurePrivateDirectory, FrameDecoder, hubSocketPath } from './hub-ipc.js'
import { INGRESS_EVENTS, ingressRefusal, parseIngressRequest, stateQuiet, type IngressRequest } from './hub-ingress.js'
import { Hub } from './hub.js'
import { nullLogger } from './logging.js'
import { enableProject, projectBinding } from './project-enablement.js'
import { sessionActivationOutput } from './session-activation.js'

const supported = (process.platform === 'darwin' || process.platform === 'linux') && spawnSync('cc', ['--version']).status === 0
const SESSION = '44444444-5555-6666-7777-888888888888'
const CODEX_SESSION = '55555555-6666-7777-8888-999999999999'
const BUILD = 'b'.repeat(64)

let compiled = ''
let compiledDir = ''
beforeAll(() => {
  if (!supported) return
  compiledDir = mkdtempSync(path.join('/tmp', 'b11-launcher-'))
  compiled = path.join(compiledDir, 'notifai')
  const source = fileURLToPath(new URL('../launcher/main.c', import.meta.url))
  execFileSync('cc', ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-D_XOPEN_SOURCE=700',
    ...(process.platform === 'darwin' ? ['-D_DARWIN_C_SOURCE', '-mmacosx-version-min=13.0'] : []),
    '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', compiled], { stdio: 'inherit' })
}, 120_000)
afterAll(() => { if (compiledDir !== '') rmSync(compiledDir, { recursive: true, force: true }) })

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

interface Lab { root: string; install: string; launcher: string; runtimeLog: string; project: string; env: NodeJS.ProcessEnv }

/** A managed installation (`bin/notifai`, `active.json`, `versions/<build>/notifai-runtime`) in a throwaway home. */
function lab(): Lab {
  const root = mkdtempSync(path.join('/tmp', 'b11-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const install = path.join(home, '.notifai')
  const version = path.join(install, 'versions', BUILD)
  for (const directory of [home, install, path.join(install, 'bin'), path.join(install, 'versions'), version]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  const launcher = path.join(install, 'bin', 'notifai')
  copyFileSync(compiled, launcher)
  chmodSync(launcher, 0o700)
  writeFileSync(path.join(install, 'active.json'), `{"schema":1,"active":"${BUILD}","previous":null,"generation":1}\n`, { mode: 0o600 })
  // The stand-in runtime: keeps the exact stdin it received and says it ran.
  const runtimeLog = path.join(root, 'runtime')
  mkdirSync(runtimeLog)
  writeFileSync(path.join(version, 'notifai-runtime'),
    `#!/bin/sh\ncat > "${runtimeLog}/stdin.$$"\necho "$@" > "${runtimeLog}/args.$$"\nprintf '{"runtime":true}\\n'\n`, { mode: 0o700 })
  const project = path.join(root, 'project')
  mkdirSync(project)
  execFileSync('git', ['init', '-q', project])
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'], HOME: home, XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), NOTIFAI_CREDENTIALS: 'file', LANG: 'C',
  }
  return { root, install, launcher, runtimeLog, project, env }
}

function runtimeRuns(at: Lab): { stdin: Buffer; args: string }[] {
  return readdirSync(at.runtimeLog).filter((name) => name.startsWith('stdin.')).map((name) => ({
    stdin: readFileSync(path.join(at.runtimeLog, name)),
    args: readFileSync(path.join(at.runtimeLog, name.replace('stdin.', 'args.')), 'utf8').trim(),
  }))
}

function startHub(at: Lab, identity: { build: string; root: string } | null = { build: BUILD, root: at.install }): Hub {
  const unexpected = new Proxy({} as ApiClient, { get: (_t, property) => property === 'then' ? undefined : async () => { throw new Error(`unexpected ${String(property)}`) } })
  const deps: CommandDeps = {
    io: { out: () => undefined, err: () => undefined, confirm: async () => false, openUrl: () => undefined },
    store: { load: () => null, save: () => undefined, clear: () => undefined, describe: () => 'memory' },
    env: at.env, cwd: '/tmp', logger: nullLogger(), clientFactory: () => unexpected,
  }
  const hub = new Hub(deps, { deps, idleExitMs: 60_000, bootIdentity: () => null, ingressIdentity: () => identity })
  const done = hub.run()
  cleanups.push(() => { hub.requestExit('test-cleanup'); void done })
  return hub
}

async function hubListening(at: Lab): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(hubSocketPath(at.env))) {
    if (Date.now() > deadline) throw new Error('hub did not listen')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

interface HookRun { stdout: string; stderr: string; code: number | null; ms: number }

function runHook(at: Lab, event: string, harness: 'claude-code' | 'codex', input: string | Buffer, extraEnv: NodeJS.ProcessEnv = {}): Promise<HookRun> {
  return new Promise((resolve) => {
    const started = performance.now()
    const child = spawn(at.launcher, ['hook', event, '--owner', 'notifai', '--harness', harness, '--integration-revision', 'c'.repeat(64)],
      { cwd: at.project, env: { ...at.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('close', (code) => resolve({ stdout, stderr, code, ms: performance.now() - started }))
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

const envelope = (event: string, extra: Record<string, unknown> = {}, at?: Lab): string =>
  JSON.stringify({ session_id: SESSION, hook_event_name: event, cwd: at?.project ?? '/tmp', transcript_path: '/tmp/none.jsonl', ...extra })

describe('hook ingress requests', () => {
  const frame = (args: string[], stdin = '{}'): Record<string, unknown> => ({ type: 'hook', args, cwd: '/tmp', build: BUILD, root: '/r',
    env_b64: Buffer.from('HOME=/h\0NOTIFAI_NATIVE_ENTRY=launcher-v1\0BUN_X=1\0HOME=/second\0').toString('base64'),
    stdin_b64: Buffer.from(stdin).toString('base64') })

  it('takes only a served event with the options a generated hook carries, and the runtime\'s view of the environment', () => {
    const request = parseIngressRequest(frame(['hook', 'stop', '--owner', 'notifai', '--harness=claude-code', '--integration-revision', 'x']))
    expect(request).toMatchObject({ event: 'stop', harness: 'claude-code', integrationRevision: 'x', env: { HOME: '/h' } })
    expect((request as IngressRequest).env).not.toHaveProperty('NOTIFAI_NATIVE_ENTRY')
    expect((request as IngressRequest).env).not.toHaveProperty('BUN_X')
    expect(parseIngressRequest(frame(['hook', 'stop', '--harness', 'claude-code', '--json']))).toBe('arguments')
    expect(parseIngressRequest(frame(['hook', 'session-end', '--harness', 'claude-code']))).toBe('event')
    expect(parseIngressRequest(frame(['hook', 'permission-request', '--harness', 'claude-code']))).toBe('event')
    expect(parseIngressRequest(frame(['hook', 'post-tool-use', '--harness', 'claude-code']))).toBe('event')
    expect(parseIngressRequest(frame(['hook', 'stop', '--harness', 'cursor']))).toBe('harness')
    expect(parseIngressRequest(frame(['hook', 'pre-tool-use', '--harness', 'codex']))).toBe('event')
    expect(INGRESS_EVENTS.codex).toContain('post-tool-use')
  })

  it('calls a session quiet only when nothing is asked, answered, staged or unknown', () => {
    expect(stateQuiet({})).toBe(true)
    expect(stateQuiet({ harness: 'codex', last_prompt_at: 1, pending: [], question_history: [{} as never] })).toBe(true)
    // Observations an ordinary turn records, and the pacing a wake that found nothing leaves behind.
    expect(stateQuiet({ harness: 'claude-code', claude_permission_mode: 'acceptEdits', input_wake_unanswered: { count: 1, presented_at: 1 } })).toBe(true)
    for (const busy of [{ pending: [{}] }, { accepted: {} }, { waiting_answers: [{}] }, { claude_picker: {} }, { input_wake: {} },
      { claude_picker_closed: {} }, { claude_picker_presented: {} },
      { acknowledgement_due: [{}] }, { message_acknowledgement_due: [{}] }, { acknowledgement_blocks: 2 }, { retiring: [{}] },
      { codex_question_bindings: [{}] }, { some_future_field: true }] as unknown as SessionState[]) {
      expect(stateQuiet(busy)).toBe(false)
    }
  })
})

describe.skipIf(!supported)('hook ingress through the launcher', () => {
  it('answers a quiet session\'s first turn from the hub, as the runtime would, and starts no runtime', async () => {
    const at = lab()
    enableProject(projectBinding(at.project, at.env)!)
    const hub = startHub(at)
    await hubListening(at)
    const run = await runHook(at, 'session-start', 'claude-code', envelope('SessionStart', { source: 'startup' }, at))
    expect(run.code).toBe(0)
    expect(run.stdout).toBe(`${sessionActivationOutput('claude-code', 'SessionStart', at.project, at.env)}\n`)
    expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toContain('Notifai is enabled for this Project')
    expect(runtimeRuns(at)).toEqual([])
    expect(hub.status()['ingress']).toMatchObject({ served: 1, declined: 0 })
    // The hook's own work happened, in the hook's own state directory.
    expect(readSessionState(SESSION, at.env).harness).toBe('claude-code')
  })

  it('carries activation guidance after compaction and after a changed override (W2)', async () => {
    const at = lab()
    enableProject(projectBinding(at.project, at.env)!)
    startHub(at)
    await hubListening(at)
    const context = (run: HookRun): string => JSON.parse(run.stdout).hookSpecificOutput.additionalContext as string
    const first = await runHook(at, 'session-start', 'claude-code', envelope('SessionStart', { source: 'startup' }, at))
    const compacted = await runHook(at, 'session-start', 'claude-code', envelope('SessionStart', { source: 'compact' }, at))
    expect(context(compacted)).toContain('This conversation was compacted.')
    expect(context(compacted)).toMatch(/load the Notifai skill again \(from `[^`]+SKILL\.md`\)/)
    expect(context(compacted)).toContain('run `notifai guidance`')
    expect(context(first)).not.toContain('This conversation was compacted.')
    const topic = SHIPPED_GUIDANCE[0]!.name
    const overrides = path.join(at.env['XDG_CONFIG_HOME']!, 'notifai', 'guidance')
    mkdirSync(overrides, { recursive: true })
    writeFileSync(path.join(overrides, `${topic}.md`), 'B11 OVERRIDE: changed house rule.\n')
    const changed = await runHook(at, 'session-start', 'claude-code', envelope('SessionStart', { source: 'resume' }, at))
    expect(context(changed)).toContain('B11 OVERRIDE: changed house rule.')
    expect(context(changed)).toContain("Notifai's guidance changed")
    expect(context(first)).not.toContain('B11 OVERRIDE')
    expect(runtimeRuns(at)).toEqual([])
  })

  it('keeps ordinary Claude Code and Codex turns on the hub, whatever their hooks record', async () => {
    const at = lab()
    enableProject(projectBinding(at.project, at.env)!)
    const hub = startHub(at)
    await hubListening(at)
    const turns: [string, 'claude-code' | 'codex', string][] = [
      ['session-start', 'claude-code', envelope('SessionStart', { source: 'startup', permission_mode: 'default' }, at)],
      ['user-prompt-submit', 'claude-code', envelope('UserPromptSubmit', { prompt: 'hello', permission_mode: 'acceptEdits' }, at)],
      ['stop', 'claude-code', envelope('Stop', { stop_hook_active: false, permission_mode: 'acceptEdits' }, at)],
      ['user-prompt-submit', 'claude-code', envelope('UserPromptSubmit', { prompt: 'again', permission_mode: 'plan' }, at)],
      ['stop', 'claude-code', envelope('Stop', { stop_hook_active: false, permission_mode: 'plan' }, at)],
    ]
    const codex = (event: string, extra: Record<string, unknown>): string =>
      JSON.stringify({ ...JSON.parse(envelope(event, { model: 'gpt-5', turn_id: 't1', ...extra }, at)), session_id: CODEX_SESSION })
    turns.push(
      ['session-start', 'codex', codex('SessionStart', { source: 'startup' })],
      ['user-prompt-submit', 'codex', codex('UserPromptSubmit', { prompt: 'hello' })],
      ['post-tool-use', 'codex', codex('PostToolUse', { tool_name: 'shell', tool_use_id: 'u1' })],
      ['stop', 'codex', codex('Stop', { stop_hook_active: false })],
      ['user-prompt-submit', 'codex', codex('UserPromptSubmit', { prompt: 'again', turn_id: 't2' })],
    )
    for (const [event, harness, input] of turns) {
      expect((await runHook(at, event, harness, input)).code).toBe(0)
    }
    expect(readSessionState(SESSION, at.env).claude_permission_mode).toBe('plan')
    expect(runtimeRuns(at)).toEqual([])
    expect(hub.status()['ingress']).toMatchObject({ served: turns.length, declined: 0 })
  })

  it('hands a busy session\'s hook to the runtime with the exact input, and only that hook', async () => {
    const at = lab()
    const hub = startHub(at)
    await hubListening(at)
    updateSessionState(SESSION, at.env, (state) => ({ ...state, harness: 'claude-code', pending: [{ request_id: 'req_x' } as never] }))
    const input = envelope('Stop', { stop_hook_active: false, note: 'ü ✓' }, at)
    const run = await runHook(at, 'stop', 'claude-code', input)
    expect(run.stdout).toBe('{"runtime":true}\n')
    const runs = runtimeRuns(at)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.stdin.toString('utf8')).toBe(input)
    expect(runs[0]!.args).toBe(`hook stop --owner notifai --harness claude-code --integration-revision ${'c'.repeat(64)}`)
    expect(hub.status()['ingress']).toMatchObject({ served: 0, declined: 1, reasons: { 'session-busy': 1 } })
  })

  it('serves an ordinary Codex tool hook and leaves a question card to the runtime', async () => {
    const at = lab()
    startHub(at)
    await hubListening(at)
    const ordinary = await runHook(at, 'post-tool-use', 'codex', envelope('PostToolUse', { tool_name: 'shell', turn_id: 't1', tool_use_id: 'u1' }, at))
    expect(ordinary).toMatchObject({ code: 0, stdout: '' })
    expect(runtimeRuns(at)).toEqual([])
    const card = await runHook(at, 'post-tool-use', 'codex', envelope('PostToolUse', { tool_name: 'request_user_input_async', turn_id: 't1', tool_use_id: 'u2',
      tool_response: { accepted: true } }, at))
    expect(card.stdout).toBe('{"runtime":true}\n')
    expect(runtimeRuns(at)).toHaveLength(1)
  })

  it('starts the runtime when no hub runs, replaying small, large and oversized input byte for byte', async () => {
    const at = lab()
    const small = envelope('UserPromptSubmit', { prompt: 'hello' }, at)
    const large = envelope('PostToolUse', { tool_name: 'shell', tool_response: 'x'.repeat(200_000) }, at)
    const oversized = envelope('PostToolUse', { tool_name: 'shell', tool_response: 'y'.repeat(1_200_000) }, at)
    for (const [event, input] of [['user-prompt-submit', small], ['post-tool-use', large], ['post-tool-use', oversized]] as const) {
      const run = await runHook(at, event, 'codex', input)
      expect(run.stdout).toBe('{"runtime":true}\n')
    }
    expect(runtimeRuns(at).map((entry) => entry.stdin.toString('utf8')).sort()).toEqual([small, large, oversized].sort())
  })

  it('starts the runtime when the hub runs another build', async () => {
    const at = lab()
    const hub = startHub(at, { build: 'd'.repeat(64), root: '' })
    await hubListening(at)
    const run = await runHook(at, 'user-prompt-submit', 'claude-code', envelope('UserPromptSubmit', { prompt: 'hi' }, at))
    expect(run.stdout).toBe('{"runtime":true}\n')
    expect(hub.status()['ingress']).toMatchObject({ reasons: { 'other-build': 1 } })
  })

  it('starts the runtime when a hub socket never answers, within the answer wait', async () => {
    const at = lab()
    const socketPath = hubSocketPath(at.env)
    ensurePrivateDirectory(path.dirname(socketPath))
    const silent = createServer(() => undefined)
    await new Promise<void>((resolve) => silent.listen(socketPath, resolve))
    cleanups.push(() => silent.close())
    const run = await runHook(at, 'stop', 'claude-code', envelope('Stop', {}, at))
    expect(run.stdout).toBe('{"runtime":true}\n')
    expect(run.ms).toBeLessThan(5_000)
  })

  it('never runs a hook whose launcher gave up before committing it to the hub', async () => {
    const at = lab()
    const hub = startHub(at)
    await hubListening(at)
    const socket = createConnection(hubSocketPath(at.env))
    const decoder = new FrameDecoder()
    const replies: Record<string, unknown>[] = []
    socket.on('data', (chunk: Buffer) => replies.push(...decoder.push(chunk)))
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
    socket.write(encodeFrame({ type: 'hello', ipc_version: 1, role: 'ingress', pid: process.pid }))
    socket.write(encodeFrame({ type: 'hook', args: ['hook', 'session-start', '--owner', 'notifai', '--harness', 'claude-code'],
      cwd: at.project, build: BUILD, root: at.install, env_b64: Buffer.from(Object.entries(at.env).map(([k, v]) => `${k}=${v}\0`).join('')).toString('base64'),
      stdin_b64: Buffer.from(envelope('SessionStart', { source: 'startup' }, at)).toString('base64') }))
    const deadline = Date.now() + 5_000
    while (!replies.some((reply) => reply['type'] === 'accepted')) {
      if (Date.now() > deadline) throw new Error('not accepted')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    socket.destroy()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(hub.status()['ingress']).toMatchObject({ served: 0, reasons: { 'launcher-gone': 1 } })
    expect(readSessionState(SESSION, at.env)).toEqual({})
  })

  it('runs every served hook under the hook\'s environment, never the hub\'s own', async () => {
    const at = lab()
    enableProject(projectBinding(at.project, at.env)!)
    startHub(at)
    await hubListening(at)
    // Point this process's own homes somewhere no served hook may touch.
    const poison = path.join(at.root, 'poison')
    const saved = { ...process.env }
    for (const name of ['HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) process.env[name] = path.join(poison, name)
    cleanups.push(() => { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved) })
    for (const harness of ['claude-code', 'codex'] as const) {
      for (const event of INGRESS_EVENTS[harness]) {
        const document = event.split('-').map((part) => part[0]!.toUpperCase() + part.slice(1)).join('')
        const run = await runHook(at, event, harness, envelope(document, { prompt: 'hi', tool_name: 'shell', turn_id: 't1', tool_use_id: 'u1', source: 'startup' }, at))
        expect(run.code).toBe(0)
        if (event === 'session-start') expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toContain('Notifai is enabled')
      }
    }
    expect(runtimeRuns(at)).toEqual([])
    expect(existsSync(poison)).toBe(false)
  })

  it('declines quietly for every reason the runtime must answer', () => {
    const at = { env: { XDG_STATE_HOME: '/nonexistent-b11' } }
    const request = (event: string, stdin: string, build = BUILD): IngressRequest => ({ event, harness: 'codex', integrationRevision: undefined,
      cwd: '/tmp', env: at.env, stdin: Buffer.from(stdin), build, root: '/r' })
    const identity = { build: BUILD, root: '/r' }
    expect(ingressRefusal(request('stop', envelope('Stop')), null)).toBe('unmanaged-hub')
    expect(ingressRefusal(request('stop', envelope('Stop'), 'e'.repeat(64)), identity)).toBe('other-build')
    expect(ingressRefusal(request('stop', 'not json'), identity)).toBe('input')
    expect(ingressRefusal(request('stop', '{}'), identity)).toBe('no-session')
    expect(ingressRefusal(request('user-prompt-submit', envelope('UserPromptSubmit', { prompt: `Notifai wake ${SESSION}. Use any` })), identity)).toBe('input-wake')
    expect(ingressRefusal(request('post-tool-use', envelope('PostToolUse', { tool_name: 'request_user_input' })), identity)).toBe('question-form')
    expect(ingressRefusal(request('post-tool-use', envelope('PostToolUse', { tool_name: 'shell' })), identity)).toBeNull()
    expect(ingressRefusal(request('stop', envelope('Stop')), identity)).toBeNull()
  })
})
