/**
 * Cursor runs the Claude Code hooks it imports from ~/.claude/settings.json
 * with its own environment and input. Its importer drops `args`, so an
 * exec-form Notifai handler arrives as a bare `notifai`; a shell-form one
 * arrives whole with `--harness claude-code`. Both must end silently with exit
 * 0, start nothing and record nothing, while a person's `notifai` and every
 * real Claude Code hook stay as they were.
 *
 * The shapes below are what Cursor IDE 3.24.4, cursor-agent 2026.10.01 and
 * @cursor/sdk 1.0.35 build for a hook (`buildHookEnvironment`, the hook
 * request), and what a Claude Code hook and a Cursor agent shell receive.
 */
import { execFileSync,spawn,spawnSync } from 'node:child_process'
import { existsSync,mkdirSync,mkdtempSync,readdirSync,rmSync,writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll,afterEach,beforeAll,describe,expect,it } from 'vitest'
import { cursorHookEnvironment } from './cursor-imported-hook.js'

const WORKSPACE = '/Volumes/work/project'

/** cursor-agent and @cursor/sdk: the workspace is always known. */
const CURSOR_CLI_HOOK_ENV = {
  CURSOR_PROJECT_DIR: WORKSPACE,
  CURSOR_VERSION: '2026.10.01-e373342',
  CURSOR_USER_EMAIL: 'user@example.com',
  CURSOR_TRANSCRIPT_PATH: '/home/user/.cursor/projects/x/agent-transcripts/a.jsonl',
  CLAUDE_PROJECT_DIR: WORKSPACE,
}
/** The IDE with no folder open sets the project directories empty. */
const CURSOR_IDE_NO_FOLDER_HOOK_ENV = { CURSOR_PROJECT_DIR: '', CURSOR_VERSION: '3.24.4', CLAUDE_PROJECT_DIR: '' }
/** A Cursor agent's own shell commands: not a hook. */
const CURSOR_AGENT_SHELL_ENV = {
  CURSOR_AGENT: '1',
  CURSOR_CONVERSATION_ID: 'agent-ca7de424-0000-4000-8000-000000000000',
  CURSOR_REQUEST_ID: 'req-1',
  AGENT_TRANSCRIPTS: '/home/user/.cursor/projects/x/agent-transcripts',
}
/** Claude Code's own hook. */
const CLAUDE_HOOK_ENV = { CLAUDE_PROJECT_DIR: WORKSPACE, CLAUDE_CODE_ENTRYPOINT: 'cli' }

/** The request Cursor writes to an imported Claude Stop handler's stdin. */
const CURSOR_STOP_INPUT = JSON.stringify({
  conversation_id: 'agent-ca7de424-0000-4000-8000-000000000000',
  generation_id: 'agent-ca7de424-0000-4000-8000-000000000000',
  model: 'default',
  status: 'completed',
  loop_count: 0,
  session_id: 'agent-ca7de424-0000-4000-8000-000000000000',
  hook_event_name: 'stop',
  cursor_version: '2026.10.01-e373342',
  workspace_roots: [WORKSPACE],
  user_email: 'user@example.com',
  transcript_path: null,
})
const CURSOR_PROMPT_INPUT = JSON.stringify({
  conversation_id: 'c1', generation_id: 'g1', model: 'default', prompt: 'hello', attachments: [],
  hook_event_name: 'beforeSubmitPrompt', cursor_version: '3.24.4', workspace_roots: [WORKSPACE], user_email: null,
  transcript_path: null,
})

describe('Cursor hook detection', () => {
  it.each([
    ['cursor-agent and the SDK', CURSOR_CLI_HOOK_ENV],
    ['the IDE with no folder open', CURSOR_IDE_NO_FOLDER_HOOK_ENV],
    ['the version alone', { CURSOR_VERSION: '3.24.4' }],
  ])('recognises the hook environment of %s', (_name, env) => {
    expect(cursorHookEnvironment(env)).toBe(true)
  })

  it.each([
    ['a Claude Code hook', CLAUDE_HOOK_ENV],
    ['a Cursor agent shell', CURSOR_AGENT_SHELL_ENV],
    ['an empty version', { CURSOR_VERSION: '' }],
    ['nothing', {}],
  ])('does not mistake %s for a Cursor hook', (_name, env) => {
    expect(cursorHookEnvironment(env)).toBe(false)
  })
})

const posix = process.platform === 'darwin' || process.platform === 'linux'
const supported = posix && spawnSync('cc', ['--version']).status === 0

let compiled = ''
let compiledDir = ''
beforeAll(() => {
  if (!supported) return
  compiledDir = mkdtempSync(path.join('/tmp', 'cursor-copy-launcher-'))
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
  const root = mkdtempSync(path.join('/tmp', 'cursor-copy-'))
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
  const result = spawnSync(at.launcher, args, { cwd: at.home, env: { ...at.env, ...env }, input, encoding: 'utf8', timeout: 10_000 })
  return { ...result, ms: Date.now() - started }
}


describe.skipIf(!supported)('the native launcher with Cursor copies of Claude Code hooks', () => {
  it.each([
    ['cursor-agent', CURSOR_CLI_HOOK_ENV, CURSOR_STOP_INPUT],
    ['the IDE with no folder open', CURSOR_IDE_NO_FOLDER_HOOK_ENV, CURSOR_PROMPT_INPUT],
  ])('ends a bare exec-form copy from %s silently before the runtime starts', (_name, env, input) => {
    const at = lab()
    const result = run(at, [], env, input)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(result.ms).toBeLessThan(2_000)
    expect(starts(at)).toEqual([])
    expect(readdirSync(at.home)).toEqual([])
    expect(existsSync(at.env['XDG_STATE_HOME']!)).toBe(false)
  })

  it('does not wait on input that never ends', async () => {
    const at = lab()
    // A pipe nobody closes: the launcher leaves it behind after a short bound.
    const started = Date.now()
    const child = spawn(at.launcher, [], { cwd: at.home, env: { ...at.env, ...CURSOR_CLI_HOOK_ENV }, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stdin.write(CURSOR_STOP_INPUT.slice(0, 40))
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
    child.stdin.destroy()
    expect(code).toBe(0)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(output).toBe('')
    expect(starts(at)).toEqual([])
  })
})

describe('the runtime entry with a bare Cursor copy', () => {
  const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url))

  function runEntry(env: NodeJS.ProcessEnv) {
    const root = mkdtempSync(path.join('/tmp', 'cursor-copy-entry-'))
    roots.push(root)
    const state = path.join(root, 'state')
    const result = spawnSync(process.execPath, [entry], {
      cwd: root,
      env: { PATH: process.env['PATH'], HOME: root, USERPROFILE: root, XDG_STATE_HOME: state, XDG_CONFIG_HOME: path.join(root, 'config'),
        LOCALAPPDATA: path.join(root, 'local'), NOTIFAI_CREDENTIALS: 'file', ...env },
      input: CURSOR_STOP_INPUT,
      encoding: 'utf8',
      timeout: 20_000,
    })
    return { ...result, root, state }
  }

  it('exits 0 with no output and records nothing', () => {
    const result = runEntry(CURSOR_CLI_HOOK_ENV)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(existsSync(result.state)).toBe(false)
    expect(readdirSync(result.root)).toEqual([])
  })
})
