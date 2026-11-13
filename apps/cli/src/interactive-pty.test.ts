import {
  CAPABILITIES_V1,
  SHIPPED_CLI_CAPABILITIES,
  type Platform,
} from '@raidiant/notifai-protocol'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { globalGuidanceDir, personalProjectGuidanceDir } from './guidance.js'
import { personalProjectConfigPath } from './config.js'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { CommandDeps } from './commands-core.js'
import { writeSetupProof } from './commands-setup-proof.js'
import { FileStore, type MachineCredential } from './credentials.js'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

const python = 'python3'
const pythonHasPty =
  process.platform !== 'win32' &&
  spawnSync(python, ['-c', 'import os, pty; os.waitstatus_to_exitcode'], { stdio: 'ignore' }).status === 0
const ptyIt = pythonHasPty ? it : it.skip

/**
 * Runs argv[1] on a fresh pty, relays the pty to stdout and stdin to the pty,
 * and exits with the child's exit code as soon as the child exits.
 *
 * `pty.spawn` is not usable here. Before Python 3.10, its copy loop treats an
 * end-of-file on the pty as "stop reading the pty" and keeps waiting on stdin,
 * and macOS reports a closed pty that way. With the system Python 3.9 first on
 * PATH, the CLI exits and the wrapper waits forever on the test's open stdin.
 * Waiting on the child instead also covers a descendant that keeps the pty
 * open after the CLI is gone.
 *
 * The pty is deliberately left unsized. SIGTERM takes the CLI down with the
 * wrapper, so a timed-out run leaves nothing behind.
 */
const PTY_DRIVER = `import os, pty, select, signal, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1]])

def stop(signum, frame):
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os._exit(128 + signum)

signal.signal(signal.SIGTERM, stop)

def relay(timeout):
    if not select.select([fd], [], [], timeout)[0]:
        return False
    try:
        data = os.read(fd, 65536)
    except OSError:
        return False
    if data:
        os.write(1, data)
    return bool(data)

stdin_open = True
status = None
while status is None:
    watched = [fd, 0] if stdin_open else [fd]
    ready = select.select(watched, [], [], 0.05)[0]
    if fd in ready:
        relay(0)
    if 0 in ready:
        data = os.read(0, 1024)
        if data:
            os.write(fd, data)
        else:
            stdin_open = False
    done, result = os.waitpid(pid, os.WNOHANG)
    if done:
        status = result
while relay(0.05):
    pass
sys.exit(os.waitstatus_to_exitcode(status))
`

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function stripAnsi(value: string): string {
  return value.replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

function compactTerminalOutput(value: string): string {
  return stripAnsi(value).replaceAll(/[^A-Za-z0-9]+/g, '')
}

ptyIt('renders completed setup ahead of a transient evidence failure in a real PTY', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-pty-'))
  roots.push(root)
  const cwd = path.join(root, 'project')
  const bin = path.join(root, 'bin')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: path.join(root, 'home', '.claude'),
    CODEX_HOME: path.join(root, 'home', '.codex'),
    OPENCODE_CONFIG_DIR: path.join(root, 'home', '.config', 'opencode'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    NOTIFAI_CREDENTIALS: 'file',
    NOTIFAI_NO_ANIMATION: '1',
    // Colour on wherever the suite runs: a colour code cut across lines is the
    // visible symptom of a screen laid out at zero columns.
    TERM: 'xterm-256color',
    PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`,
  }
  delete env['CI']
  delete env['NO_COLOR']
  delete env['FORCE_COLOR']
  delete env['NODE_DISABLE_COLORS']
  delete env['NOTIFAI_NO_INPUT']
  mkdirSync(cwd, { recursive: true })
  mkdirSync(bin, { recursive: true })
  const settings = personalProjectConfigPath(cwd, env)
  mkdirSync(path.dirname(settings), { recursive: true })
  writeFileSync(settings, 'project = "pty-proof"\n')

  let evidenceCalls = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/healthz') return json(response, { ok: true })
    if (url.pathname === '/api/v1/compatibility') {
      return json(response, {
        cli: {
          state: 'current',
          reason: 'current',
          affected_operation: null,
          recovery_action: null,
          current_version: '11.0.3',
          current_build: null,
          recommended_version: '11.0.3',
          recommended_build: null,
          minimum_version: null,
          minimum_build: null,
          deprecation: null,
          sunset: null,
        },
        platforms: [],
        server_capabilities: [...SHIPPED_CLI_CAPABILITIES],
      })
    }
    if (url.pathname.startsWith('/api/v1/capabilities/')) {
      const platform = url.pathname.split('/').at(-1) as Platform
      return json(response, CAPABILITIES_V1.describe(platform))
    }
    if (url.pathname === '/api/v1/account/access') {
      return json(response, {
        status: 'active',
        reason: 'alpha_grant',
        expires_at: null,
        email: 'pty@example.test',
      })
    }
    if (url.pathname === '/api/v1/account/alpha-access-request') {
      return json(response, { request: null })
    }
    if (url.pathname === '/api/v1/devices') {
      return json(response, {
        devices: [
          {
            device_id: 'dev_pty',
            display_name: 'iPhone',
            platform: 'ios',
            permission_status: 'authorized',
            registration_healthy: true,
            app_version: '1.0.0',
            app_build: '1',
            os_version: '19.0',
            capabilities: ['answer'],
            support_state: 'current',
            derived_status: 'working',
            status_message: null,
            last_seen_at: '2026-09-05T12:00:00.000Z',
          },
        ],
      })
    }
    if (url.pathname === '/api/v1/notifications/req_pty_proof') {
      evidenceCalls += 1
      return json(
        response,
        { error: { code: 'internal_error', message: 'transient fixture detail' } },
        503,
      )
    }
    return json(response, { error: { code: 'not_found', message: 'fixture route missing' } }, 404)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
    const credential: MachineCredential = {
      machineId: 'mac_pty',
      machineName: 'PTY fixture',
      secret: 'pty-fixture-secret',
      baseUrl: `http://127.0.0.1:${address.port}`,
    }
    const store = new FileStore(env)
    store.save(credential)
    const proofDeps = {
      cwd,
      env,
      store,
      io: { out() {}, err() {}, async confirm() { return false }, openUrl() {} },
    } satisfies CommandDeps
    expect(writeSetupProof(proofDeps, {
      request_id: 'req_pty_proof',
      device_id: 'dev_pty',
      started_at: '2026-09-05T12:00:00.000Z',
      companion_receipt: { state: 'observed', observed_at: '2026-09-05T12:00:02.000Z' },
    })).toBe(true)

    const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url))
    chmodSync(cli, 0o755)
    const command = path.join(bin, 'notifai')
    symlinkSync(cli, command)
    const fetchFixture = path.join(root, 'fetch-fixture.mjs')
    writeFileSync(
      fetchFixture,
      [
        'const fetchImpl = globalThis.fetch;',
        'globalThis.fetch = (input, init) => {',
        "  if (String(input).startsWith('https://registry.npmjs.org/')) {",
        "    return Promise.resolve(new Response('{}', { status: 503 }));",
        '  }',
        '  return fetchImpl(input, init);',
        '};',
        '',
      ].join('\n'),
    )
    env['NODE_OPTIONS'] = `--import=${pathToFileURL(fetchFixture).href}`

    const child = spawn(python, ['-c', PTY_DRIVER, command], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    let stopped = false
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (!stopped && compactTerminalOutput(output).includes('Sendatestnotification')) {
        stopped = true
        child.stdin.write('\u0003')
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    let timeout: NodeJS.Timeout | undefined
    const result = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve({ code, signal }))
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          child.kill('SIGTERM')
          const phase = stopped ? 'after Ctrl-C at the menu' : 'before the menu appeared'
          reject(new Error(`PTY CLI timed out ${phase}. Output:\n${output}`))
        }, 15_000).unref()
      }),
    ])
    if (timeout !== undefined) clearTimeout(timeout)

    expect(result.signal).toBeNull()
    expect(result.code).toBe(0)
    expect(compactTerminalOutput(output)).toContain('Sendatestnotification')
    // The pty here reports no size; the screen must still lay out whole lines.
    expect(stripAnsi(output)).toContain('Send a test notification')
    expect(compactTerminalOutput(output)).not.toContain('Finishsetup')
    expect(evidenceCalls).toBe(1)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})


function guidanceFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-guidance-edit-'))
  roots.push(root)
  const cwd = path.join(root, 'project')
  mkdirSync(cwd)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'),
    NOTIFAI_CREDENTIALS: 'file', TERM: 'xterm-256color', NOTIFAI_NO_ANIMATION: '1' }
  for (const key of ['CI', 'NOTIFAI_NO_INPUT', 'VISUAL', 'EDITOR']) delete env[key]
  const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url))
  return { root, cwd, env, cli }
}

it('refuses guidance edit without a human terminal and offers the file command', () => {
  const { cwd, env, cli } = guidanceFixture()
  const result = spawnSync(process.execPath, [cli, 'guidance', 'edit', 'titles', '--local'], {
    cwd, env, encoding: 'utf8', timeout: 5000,
  })
  expect(result.status).toBe(2)
  expect(result.stderr).toContain('notifai guidance set')
  expect(result.stderr).toContain('--file')
  expect(existsSync(globalGuidanceDir(env))).toBe(false)
})


type GuidanceFixture = ReturnType<typeof guidanceFixture>

function editorFixture(at: GuidanceFixture, body: string): string {
  const file = path.join(at.root, 'test editor.cjs')
  writeFileSync(file, body)
  return `"${process.execPath}" "${file}"`
}

async function editInTerminal(at: GuidanceFixture, args: string[], steps: { prompt: string; input: string }[] = []) {
  const launcher = path.join(at.root, 'cli')
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  writeFileSync(launcher, '#!/bin/sh\nexec ' + [process.execPath, at.cli, 'guidance', 'edit', ...args].map(quote).join(' ') + '\n', { mode: 0o755 })
  const child = spawn(python, ['-c', PTY_DRIVER, launcher], { cwd: at.cwd, env: at.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let step = 0
  const collect = (chunk: Buffer) => {
    output += chunk.toString('utf8')
    const next = steps[step]
    if (next !== undefined && compactTerminalOutput(output).includes(compactTerminalOutput(next.prompt))) {
      step += 1
      child.stdin.write(next.input)
    }
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  let timeout: NodeJS.Timeout | undefined
  try {
    const code = await Promise.race([
      new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Guidance PTY timed out at step ${step}: ${output}`)) }, 5000) }),
    ])
    expect(code, stripAnsi(output)).toBe(0)
    expect(step, stripAnsi(output)).toBe(steps.length)
    return stripAnsi(output)
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    child.stdin.end()
  }
}

ptyIt('leaves inherited and existing guidance untouched on an unchanged editor save', async () => {
  const at = guidanceFixture()
  const machine = path.join(globalGuidanceDir(at.env), 'titles.md')
  const project = path.join(personalProjectGuidanceDir(at.cwd, at.env), 'titles.md')
  mkdirSync(path.dirname(machine), { recursive: true })
  mkdirSync(path.dirname(project), { recursive: true })
  writeFileSync(machine, 'Machine words.\n')
  writeFileSync(project, 'Project words.\n')
  const before = statSync(machine).mtimeMs
  at.env.VISUAL = editorFixture(at, "const fs = require('node:fs'); if (fs.readFileSync(process.argv[2], 'utf8') !== 'Machine words.\\n') process.exit(3)")
  const output = await editInTerminal(at, ['titles'])
  expect(output).toContain('unchanged')
  expect(statSync(machine).mtimeMs).toBe(before)
  expect(readFileSync(project, 'utf8')).toBe('Project words.\n')
  at.env.VISUAL = editorFixture(at, '')
  await editInTerminal(at, ['questions', '--local'])
  expect(existsSync(path.join(path.dirname(project), 'questions.md'))).toBe(false)
})

ptyIt.each([false, true])('offers to unset emptied guidance, and respects the answer (%s)', async (remove) => {
  const at = guidanceFixture()
  const target = path.join(personalProjectGuidanceDir(at.cwd, at.env), 'titles.md')
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, 'Keep these words.\n')
  at.env.EDITOR = editorFixture(at, "require('node:fs').writeFileSync(process.argv[2], '  \\n')")
  await editInTerminal(at, ['titles', '--local'], [{ prompt: 'Empty guidance.', input: remove ? 'y\r' : 'n\r' }])
  expect(existsSync(target)).toBe(!remove)
  if (!remove) expect(readFileSync(target, 'utf8')).toBe('Keep these words.\n')
})

ptyIt('opens direct Project edits in VISUAL and saves without another confirmation', async () => {
  const at = guidanceFixture()
  const machine = path.join(globalGuidanceDir(at.env), 'titles.md')
  const project = path.join(personalProjectGuidanceDir(at.cwd, at.env), 'titles.md')
  mkdirSync(path.dirname(machine), { recursive: true })
  mkdirSync(path.dirname(project), { recursive: true })
  writeFileSync(machine, 'Machine words.\n')
  writeFileSync(project, 'Project words.\n')
  at.env.EDITOR = 'exit 7'
  at.env.VISUAL = editorFixture(at, "const fs = require('node:fs'); if (fs.readFileSync(process.argv[2], 'utf8') !== 'Project words.\\n') process.exit(3); fs.writeFileSync(process.argv[2], 'Edited project words.\\n')")
  await editInTerminal(at, ['titles', '--local'])
  expect(readFileSync(project, 'utf8')).toBe('Edited project words.\n')
  expect(readFileSync(machine, 'utf8')).toBe('Machine words.\n')
})

ptyIt('prints the selected path without creating an override when no editor is configured', async () => {
  const at = guidanceFixture()
  const target = path.join(personalProjectGuidanceDir(at.cwd, at.env), 'new-topic.md')
  const output = await editInTerminal(at, ['new-topic', '--local'])
  expect(output).toContain(target)
  expect(existsSync(target)).toBe(false)
})

ptyIt('lists topic provenance and creates additive guidance through the topic and layer pickers', async () => {
  const at = guidanceFixture()
  const machine = path.join(globalGuidanceDir(at.env), 'custom-machine.md')
  const project = path.join(personalProjectGuidanceDir(at.cwd, at.env), 'custom-project.md')
  mkdirSync(path.dirname(machine), { recursive: true })
  mkdirSync(path.dirname(project), { recursive: true })
  writeFileSync(machine, 'Machine extra.\n')
  writeFileSync(project, 'Project extra.\n')
  at.env.EDITOR = editorFixture(at, "const fs = require('node:fs'); if (fs.readFileSync(process.argv[2], 'utf8') !== '') process.exit(3); fs.writeFileSync(process.argv[2], 'My added guidance.\\n')")
  const output = await editInTerminal(at, [], [
    { prompt: 'New topic', input: '\u001b[B'.repeat(7) + '\r' },
    { prompt: 'Topic name', input: 'my-guidance\r' },
    { prompt: 'Where should this guidance live?', input: '\u001b[B\r' },
  ])
  expect(output).toContain('custom-machine [this machine]')
  expect(output).toContain('custom-project [this Project]')
  expect(output).toContain('[shipped default]')
  expect(readFileSync(path.join(path.dirname(project), 'my-guidance.md'), 'utf8')).toBe('My added guidance.\n')
  expect(existsSync(path.join(path.dirname(machine), 'my-guidance.md'))).toBe(false)
  const effective = spawnSync(process.execPath, [at.cli, 'guidance', 'show', '--json'], { cwd: at.cwd, env: at.env, encoding: 'utf8' })
  expect(effective.status).toBe(0)
  const topics = JSON.parse(effective.stdout).topics as { name: string; content: string; authority: string }[]
  expect(topics.find(topic => topic.name === 'my-guidance')).toMatchObject({ content: 'My added guidance.\n', authority: 'user' })
  expect(topics.find(topic => topic.name === 'titles')?.authority).toBe('shipped')
})
