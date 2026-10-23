/**
 * Grok runs the Claude Code and Cursor hooks it imports from
 * ~/.claude/settings.json and ~/.cursor/hooks.json beside its own, with its own
 * hook environment, and runs `async` handlers in line. Every Notifai copy must
 * end silently with exit 0, start nothing and record nothing, while Grok's own
 * Notifai hooks and every real Claude Code and Cursor hook stay as they were.
 *
 * The environment and input below are what Grok 1.0.67's hook runner gives a
 * handler from Claude Code's settings (`GROK_HOOK_EVENT`, `GROK_HOOK_NAME`,
 * `GROK_SESSION_ID`, `GROK_WORKSPACE_ROOT`, `CLAUDE_PROJECT_DIR`).
 */
import { execFileSync,spawnSync } from 'node:child_process'
import { existsSync,mkdirSync,mkdtempSync,readdirSync,rmSync,writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll,afterEach,beforeAll,describe,expect,it } from 'vitest'
import { grokHookEnvironment } from './grok-imported-hook.js'

const WORKSPACE = '/Volumes/work/project'
const SESSION = '01a164cd-6317-75a2-899c-e47cf0a73c89'

/** Grok running the Notifai handlers it loaded from Claude Code's settings. */
const GROK_IMPORTED_HOOK_ENV = {
  GROK_HOOK_EVENT: 'user_prompt_submit',
  GROK_HOOK_NAME: 'global/settings:user_prompt_submit[0].hooks[1]',
  GROK_SESSION_ID: SESSION,
  GROK_WORKSPACE_ROOT: WORKSPACE,
  CLAUDE_PROJECT_DIR: WORKSPACE,
}
/** A Grok agent's own shell commands, as Grok 1.0.67 runs them: not a hook. A
 * Claude Code started there keeps its real hooks. */
const GROK_TOOL_SHELL_ENV = { GROK_SESSION_ID: SESSION, GROK_AGENT: '1', GROK_HOME: '/home/user/.grok' }
/** Claude Code's own hook. */
const CLAUDE_HOOK_ENV = { CLAUDE_PROJECT_DIR: WORKSPACE, CLAUDE_CODE_ENTRYPOINT: 'cli' }

const GROK_PROMPT_INPUT = JSON.stringify({
  sessionId: SESSION, session_id: SESSION, hook_event_name: 'UserPromptSubmit', cwd: WORKSPACE, prompt: 'hello', promptId: 'p1',
})

const hookArgs = (event: string, harness: string): string[] =>
  ['hook', event, '--owner', 'notifai', '--harness', harness, '--integration-revision', 'a'.repeat(64)]

describe('Grok imported-hook detection', () => {
  it('recognises the hook environment only by its runner variable', () => {
    expect(grokHookEnvironment(GROK_IMPORTED_HOOK_ENV)).toBe(true)
    expect(grokHookEnvironment(GROK_TOOL_SHELL_ENV)).toBe(false)
    expect(grokHookEnvironment(CLAUDE_HOOK_ENV)).toBe(false)
    expect(grokHookEnvironment({ GROK_HOOK_EVENT: '' })).toBe(false)
  })
})

const posix = process.platform === 'darwin' || process.platform === 'linux'
const supported = posix && spawnSync('cc', ['--version']).status === 0

let compiled = ''
let compiledDir = ''
beforeAll(() => {
  if (!supported) return
  compiledDir = mkdtempSync(path.join('/tmp', 'grok-copy-launcher-'))
  compiled = path.join(compiledDir, 'notifai')
  const source = fileURLToPath(new URL('../launcher/main.c', import.meta.url))
  execFileSync('cc', ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-D_XOPEN_SOURCE=700',
    ...(process.platform === 'darwin' ? ['-D_DARWIN_C_SOURCE', '-mmacosx-version-min=13.0'] : []),
    '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', compiled], { stdio: 'inherit' })
}, 120_000)
afterAll(() => { if (compiledDir !== '') rmSync(compiledDir, { recursive: true, force: true }) })

const roots: string[] = []
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }) })

interface Lab { launcher: string; ran: string; home: string; env: NodeJS.ProcessEnv }

/** The launcher beside a stand-in runtime that records each start, in a throwaway home. */
function lab(): Lab {
  const root = mkdtempSync(path.join('/tmp', 'grok-copy-'))
  roots.push(root)
  const home = path.join(root, 'home'), directory = path.join(root, 'build'), ran = path.join(root, 'ran')
  for (const made of [home, directory, ran]) mkdirSync(made, { recursive: true, mode: 0o700 })
  const launcher = path.join(directory, 'notifai')
  execFileSync('cp', ['-f', compiled, launcher])
  writeFileSync(path.join(directory, 'notifai-runtime'),
    `#!/bin/sh\necho "$@" > "${ran}/args.$$"\nprintf 'runtime ran\\n'\n`, { mode: 0o700 })
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'], HOME: home, XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config'), LANG: 'C',
  }
  return { launcher, ran, home, env }
}

const starts = (at: Lab): string[] => readdirSync(at.ran)

function run(at: Lab, args: string[], env: NodeJS.ProcessEnv, input: string) {
  const started = Date.now()
  const result = spawnSync(at.launcher, args, { cwd: at.home, env: { ...at.env, ...env }, input, encoding: 'utf8', timeout: 30_000 })
  return { ...result, ms: Date.now() - started }
}

describe.skipIf(!supported)('the native launcher with Grok copies of Claude Code and Cursor hooks', () => {
  it.each([
    ['claude-code', 'attend'], ['claude-code', 'user-prompt-submit'], ['claude-code', 'session-start'], ['claude-code', 'stop'],
    ['cursor', 'stop'], ['cursor', 'before-submit-prompt'],
  ])('ends a %s %s copy silently before the session child, the hub or the runtime', (harness, event) => {
    const at = lab()
    const result = run(at, hookArgs(event, harness), GROK_IMPORTED_HOOK_ENV, GROK_PROMPT_INPUT)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(result.ms).toBeLessThan(2_000)
    expect(starts(at)).toEqual([])
    expect(readdirSync(at.home)).toEqual([])
    expect(existsSync(at.env['XDG_STATE_HOME']!)).toBe(false)
  })
})

describe('the runtime entry with a Grok copy', () => {
  const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url))

  function runEntry(args: string[], env: NodeJS.ProcessEnv) {
    const root = mkdtempSync(path.join('/tmp', 'grok-copy-entry-'))
    roots.push(root)
    const state = path.join(root, 'state')
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: root,
      env: { PATH: process.env['PATH'], HOME: root, USERPROFILE: root, XDG_STATE_HOME: state, XDG_CONFIG_HOME: path.join(root, 'config'),
        LOCALAPPDATA: path.join(root, 'local'), NOTIFAI_CREDENTIALS: 'file', ...env },
      input: GROK_PROMPT_INPUT,
      encoding: 'utf8',
      timeout: 20_000,
    })
    return { ...result, root, state }
  }

  it.each(['claude-code', 'cursor'])('exits 0 for a %s copy with no output and records nothing', (harness) => {
    const result = runEntry(hookArgs('user-prompt-submit', harness), GROK_IMPORTED_HOOK_ENV)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(existsSync(result.state)).toBe(false)
    expect(readdirSync(result.root)).toEqual([])
  })
})
