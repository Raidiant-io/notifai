/**
 * Hook ingress, run for real: the launcher compiled from `launcher/main.c` in a
 * managed installation layout, offering hooks to an in-process hub, and a
 * stand-in runtime that records whenever the launcher starts it instead.
 */
import { execFileSync,spawn,spawnSync } from 'node:child_process'
import { chmodSync,copyFileSync,existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll,afterEach,beforeAll,describe,expect,it } from 'vitest'
import type { ApiClient } from './client.js'
import type { CommandDeps } from './commands-core.js'
import { readSessionState } from './hook-session-state.js'
import { INGRESS_EVENTS,parseIngressRequest,type IngressRequest } from './hub-ingress.js'
import { ensurePrivateDirectory,hubSocketPath } from './hub-ipc.js'
import { Hub } from './hub.js'
import { nullLogger } from './logging.js'
import { enableProject,projectBinding } from './project-enablement.js'
import { sessionActivationOutput } from './session-activation.js'

const supported = (process.platform === 'darwin' || process.platform === 'linux') && spawnSync('cc', ['--version']).status === 0
const SESSION = '44444444-5555-6666-7777-888888888888'
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
})
