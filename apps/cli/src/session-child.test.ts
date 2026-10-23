/**
 * The native session child, compiled from `launcher/main.c` and run for real:
 * a stand-in harness process starts it as its own child (exec form) or through
 * a shell that does not exec, exactly as Claude Code does, and an in-process
 * hub verifies it with the kernel's peer credentials.
 */
import { once } from 'node:events'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AttendanceBatchRequestT, AttendanceBatchResponse } from '@raidiant/notifai-protocol'
import type { ApiClient } from './client.js'
import type { CommandDeps } from './commands-core.js'
import { readSessionIncarnation, recordSessionNotified } from './hook-session-state.js'
import { childLockPath, endedRecordsDir, writerLockPath } from './hub-ipc.js'
import { Hub, peerVerifierFor, type HubOptions } from './hub.js'
import { nullLogger } from './logging.js'

const supported = (process.platform === 'darwin' || process.platform === 'linux') && spawnSync('cc', ['--version']).status === 0
const SESSION = '33333333-4444-5555-6666-777777777777'

let build = ''
let launcher = ''
beforeAll(() => {
  if (!supported) return
  build = mkdtempSync(path.join('/tmp', 'b3child-build-'))
  launcher = path.join(build, 'notifai')
  const source = fileURLToPath(new URL('../launcher/main.c', import.meta.url))
  execFileSync('cc', ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-D_XOPEN_SOURCE=700',
    ...(process.platform === 'darwin' ? ['-D_DARWIN_C_SOURCE', '-mmacosx-version-min=13.0'] : []),
    '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', launcher], { stdio: 'inherit' })
  // The launcher requires its runtime beside it; this one cannot start a hub.
  writeFileSync(path.join(build, 'notifai-runtime'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
}, 120_000)
afterAll(() => { if (build !== '') rmSync(build, { recursive: true, force: true }) })

const cleanups: (() => void | Promise<unknown>)[] = []
const directories: string[] = []
afterEach(async (context) => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length === 0) {
    for (const root of directories.splice(0)) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) } catch (error) { errors.push(error) }
    }
  } else {
    console.error('Retaining scratch directories because writers did not stop:', directories.splice(0))
  }
  if (errors.length > 0) {
    // Keep the assertion failure primary while retaining every cleanup error.
    if (context.task.result?.state === 'fail') console.error('Session Child cleanup failed:', errors)
    else throw new AggregateError(errors, 'Session Child cleanup failed')
  }
})

/** A stand-in for one Claude Code process: descriptor, inbox socket, and the attend hook. */
const HARNESS_SCRIPT = `
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
const [mode, launcher, session, configDir, inbox] = process.argv.slice(2)
// What Claude Code writes: start ticks on Linux, \`ps -o lstart\` text elsewhere.
const stat = process.platform === 'linux' ? readFileSync('/proc/self/stat', 'utf8') : ''
const procStart = process.platform === 'linux' ? stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  : execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { TZ: 'UTC', LC_ALL: 'C', PATH: '/bin:/usr/bin' } }).trim().replace(/\\s+/g, ' ')
mkdirSync(path.join(configDir, 'sessions'), { recursive: true })
writeFileSync(path.join(configDir, 'sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: session, cwd: '/tmp',
  startedAt: Date.now(), procStart, version: '2.1.304', peerProtocol: 1, messagingSocketPath: inbox, status: 'idle' }))
rmSync(inbox, { force: true })
const server = net.createServer((socket) => { let data = ''; socket.on('data', (c) => data += c); socket.on('end', () => { process.stdout.write(JSON.stringify({ inbox: data }) + '\\n') }) })
server.listen(inbox, () => {
  const env = { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: inbox, CLAUDE_CODE_MESSAGING_TOKEN: 'tok-' + session, CLAUDE_CODE_SESSION_ID: session }
  const attend = (event) => {
    const args = ['hook', 'attend', '--owner', 'notifai', '--harness', 'claude-code']
    const child = mode === 'shell'
      ? spawn('/bin/sh', ['-c', "'" + launcher + "' " + args.join(' ') + '; true'], { env, stdio: ['pipe', 'ignore', 'ignore'] })
      : spawn(launcher, args, { env, stdio: ['pipe', 'ignore', 'ignore'] })
    child.stdin.end(JSON.stringify({ session_id: session, hook_event_name: event, cwd: '/tmp', ...(event === 'SessionStart' ? { source: 'startup' } : {}) }))
    process.stdout.write(JSON.stringify({ spawned: child.pid, event }) + '\\n')
  }
  attend('SessionStart')
  process.stdin.on('data', (chunk) => { if (String(chunk).includes('prompt')) attend('UserPromptSubmit') })
  process.stdout.write(JSON.stringify({ ready: process.pid }) + '\\n')
})
`

interface Harness { process: ChildProcess; lines: Record<string, unknown>[]; pid: number }

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function scratch(): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(path.join('/tmp', 'b3child-'))
  directories.push(root)
  mkdirSync(path.join(root, 'claude'), { recursive: true })
  writeFileSync(path.join(root, 'harness.mjs'), HARNESS_SCRIPT)
  return { root, env: { ...process.env, XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude') } }
}

async function startHarness(root: string, env: NodeJS.ProcessEnv, mode: 'direct' | 'shell', inbox = 'inbox.sock'): Promise<Harness> {
  const child = spawn(process.execPath, [path.join(root, 'harness.mjs'), mode, launcher, SESSION, env['CLAUDE_CONFIG_DIR']!, path.join(root, inbox)],
    { env, stdio: ['pipe', 'pipe', 'inherit'] })
  const harness: Harness = { process: child, lines: [], pid: child.pid! }
  let buffered = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    let newline: number
    while ((newline = buffered.indexOf('\n')) >= 0) {
      harness.lines.push(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>)
      buffered = buffered.slice(newline + 1)
    }
  })
  // Register completion immediately, including stdio closure, before any kill.
  const closed = once(child, 'close')
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
    // The attend hook (or its non-exec shell) can outlive its harness long
    // enough to write an end record. A zombie has exited and cannot write.
    const pids = harness.lines.flatMap(line => typeof line['spawned'] === 'number' ? [line['spawned']] : [])
    await until(() => pids.every(pid => {
      const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 1_000 })
      return state.status === 1 || (state.status === 0 && state.stdout.trim().startsWith('Z'))
    }))
  })
  child.once('exit', (code) => harness.lines.push({ exited: code }))
  await until(() => harness.lines.some((line) => 'ready' in line || 'exited' in line))
  if (harness.lines.some((line) => 'exited' in line)) throw new Error(`harness exited: ${JSON.stringify(harness.lines)}`)
  return harness
}

interface Service { client: ApiClient; batches: AttendanceBatchRequestT[]; notes: { body: string }[] }

function service(): Service {
  const batches: AttendanceBatchRequestT[] = []
  const notes: { body: string }[] = []
  const client = new Proxy({} as ApiClient, {
    get(_target, property) {
      if (property === 'then') return undefined
      if (property === 'compatibility') return async () => ({ cli: {}, platforms: [], server_capabilities: ['session_attendance', 'session_attendance_batch'] })
      if (property === 'attendBatch') {
        return async (body: AttendanceBatchRequestT, { waitSeconds, signal }: { waitSeconds: number; signal?: AbortSignal }): Promise<AttendanceBatchResponse> => {
          batches.push(structuredClone(body))
          // Like the service: hold only while nothing is newer than the cursor.
          if (waitSeconds > 0 && body.message_cursor === `c${notes.length}`) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 1_000)
              signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
            })
          }
          return { message_cursor: `c${notes.length}`, sessions: body.sessions.map((entry) => entry.state === 'running'
            ? { session_id: entry.session_id, status: 'attending', generation: 1, lease_remaining_ms: 120_000, message_cursor: `c${notes.length}`,
              messages: notes.map((note, index) => ({ message_id: `sm_test${index}`, created_at: new Date(0).toISOString(),
                agent_acknowledgement_text_required: false, kind: 'note' as const, body: note.body })) }
            : { session_id: entry.session_id, status: 'withdrawn' }) }
        }
      }
      return async () => { throw new Error(`unexpected ${String(property)}`) }
    },
  })
  return { client, batches, notes }
}

interface RunningHub { hub: Hub; done: Promise<number>; stop: () => Promise<number> }

/**
 * An in-process hub that stays up until the test stops it. With a short idle
 * exit it would race the stand-in harness: a node process that can take
 * longer than the idle window to start on a loaded machine, leaving its child
 * no hub to register with. The idle exit itself is the hub tests' subject.
 */
function startHub(env: NodeJS.ProcessEnv, fake: Service, options: Partial<HubOptions> = {}): RunningHub {
  const deps: CommandDeps = {
    io: { out: () => undefined, err: () => undefined, confirm: async () => false, openUrl: () => undefined },
    store: { load: () => ({ machineId: 'mch_test', secret: 's', baseUrl: 'https://example.invalid', machineName: 't' }), save: () => undefined, clear: () => undefined, describe: () => 'memory' },
    env, cwd: '/tmp', logger: nullLogger(), clientFactory: () => fake.client,
  }
  const hub = new Hub(deps, { deps, verifyPeer: peerVerifierFor(launcher), bootIdentity: () => null, endConfirmMs: 500, ...options })
  const done = hub.run()
  cleanups.push(async () => { hub.requestExit('test-cleanup'); await done })
  return { hub, done, stop: () => { hub.requestExit('test-done'); return done } }
}

describe.skipIf(!supported)('native session child', () => {
  it('stays the harness\'s own child, registers under kernel peer checks, writes the inbox with the token, and reports the harness exit', async () => {
    const { root, env } = scratch()
    recordSessionNotified(SESSION, env, Date.now())
    const fake = service()
    const { hub, stop } = startHub(env, fake)
    const harness = await startHarness(root, env, 'direct')
    await until(() => fake.batches.some((batch) => batch.sessions.some((entry) => entry.session_id === SESSION && entry.state === 'running')))
    const spawned = harness.lines.find((line) => 'spawned' in line)!['spawned'] as number
    // The child is the harness's direct child and still alive: a resident.
    expect(execFileSync('ps', ['-o', 'ppid=', '-p', String(spawned)], { encoding: 'utf8' }).trim()).toBe(String(harness.pid))

    fake.notes.push({ body: 'hello' })
    await until(() => harness.lines.some((line) => 'inbox' in line))
    const inbox = String(harness.lines.find((line) => 'inbox' in line)!['inbox']).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(inbox[0]).toEqual({ type: 'auth', token: `tok-${SESSION}` })
    expect(inbox[1]).toMatchObject({ type: 'user', message: { role: 'user', content: expect.stringMatching(/^Notifai wake [0-9a-f-]{36}\. /) } })
    expect(JSON.stringify(inbox)).not.toContain('hello') // a wake never carries the note itself

    harness.process.kill('SIGKILL')
    await until(() => hub.sessions.get(SESSION)?.stopped != null)
    expect(fake.batches.flatMap(batch => batch.sessions).some(entry => entry.state === 'ended')).toBe(false)
    expect(await stop()).toBe(0)
  }, 30_000)

  it('reports where the conversation runs and the process that started it, so only the desktop app can pause one', async () => {
    const { root, env } = scratch()
    env['CLAUDE_CODE_ENTRYPOINT'] = 'claude-desktop'
    recordSessionNotified(SESSION, env, Date.now())
    const fake = service()
    const { hub, stop } = startHub(env, fake)
    const harness = await startHarness(root, env, 'direct')
    await until(() => hub.sessions.get(SESSION)?.registration.place === 'claude-desktop')
    // The harness's parent: here this test process, in the app its main process.
    expect(hub.sessions.get(SESSION)?.registration.hostApp?.pid).toBe(process.pid)
    harness.process.kill('SIGKILL')
    await until(() => fake.batches.some((batch) => batch.sessions.some((entry) => entry.state === 'ended')))
    expect(await stop()).toBe(0)
  }, 30_000)

  it('says when the harness runs in an Orca pane, so the hub records the pane\'s terminal host', async () => {
    const { root, env } = scratch()
    env['CLAUDE_CODE_ENTRYPOINT'] = 'cli'
    env['ORCA_AGENT_PANE'] = 'tab-1:pane-1'
    recordSessionNotified(SESSION, env, Date.now())
    const fake = service()
    const asked: number[] = []
    const terminalHost = { pid: process.pid, start: 'Tue Oct 20 10:00:00 2026' }
    const { hub, stop } = startHub(env, fake, { orcaTerminalHostOf: (pid) => { asked.push(pid); return terminalHost } })
    const harness = await startHarness(root, env, 'direct')
    await until(() => hub.sessions.get(SESSION)?.registration.terminalHost !== null && hub.sessions.get(SESSION) !== undefined)
    expect(asked).toEqual([harness.pid])
    expect(hub.sessions.get(SESSION)?.registration.place).toBe('terminal')
    harness.process.kill('SIGKILL')
    await until(() => fake.batches.some((batch) => batch.sessions.some((entry) => entry.state === 'ended')))
    expect(await stop()).toBe(0)
  }, 30_000)

  it('adopts the harness through a shell that does not exec, and a second attend only hints', async () => {
    const { root, env } = scratch()
    recordSessionNotified(SESSION, env, Date.now())
    const fake = service()
    const { stop } = startHub(env, fake)
    const harness = await startHarness(root, env, 'shell')
    await until(() => fake.batches.some((batch) => batch.sessions.some((entry) => entry.session_id === SESSION)))
    const locked = readFileSync(childLockPath(env, SESSION), 'utf8').trim().split(' ')
    expect(locked[1]).toBe(String(harness.pid)) // the grandparent, not the shell
    // The next prompt's attend finds the child alive: it exits at once.
    harness.process.stdin!.write('prompt\n')
    await until(() => harness.lines.filter((line) => 'spawned' in line).length === 2)
    const second = harness.lines.filter((line) => 'spawned' in line)[1]!['spawned'] as number
    await until(() => spawnSync('kill', ['-0', String(second)]).status !== 0, 5_000)
    harness.process.kill('SIGKILL')
    expect(await stop()).toBe(0)
  }, 30_000)

  it('reconnects to a restarted hub and registers again, with no end reported', async () => {
    const { root, env } = scratch()
    recordSessionNotified(SESSION, env, Date.now())
    const fake = service()
    const first = startHub(env, fake)
    const harness = await startHarness(root, env, 'direct')
    await until(() => fake.batches.some((batch) => batch.sessions.some((entry) => entry.state === 'running')))
    // The hub goes away; its leases stay saved, and the child stays.
    first.hub.requestExit('test-crash')
    expect(await first.done).toBe(0)
    const before = fake.batches.length
    const second = startHub(env, fake)
    await until(() => fake.batches.length > before, 15_000)
    const after = fake.batches.slice(before).flatMap((batch) => batch.sessions)
    expect(after.every((entry) => entry.state === 'running' && entry.generation === 1)).toBe(true)
    expect(fake.batches.flatMap((batch) => batch.sessions).some((entry) => entry.state === 'ended')).toBe(false)
    harness.process.kill('SIGKILL')
    await until(() => fake.batches.some((batch) => batch.sessions.some((entry) => entry.state === 'ended')))
    expect(await second.stop()).toBe(0)
  }, 40_000)

  it('gives each process hosting one conversation its own child: the most recently opened receives, and the other takes over when it exits', async () => {
    const { root, env } = scratch()
    recordSessionNotified(SESSION, env, Date.now())
    const fake = service()
    const { hub, stop } = startHub(env, fake)
    const first = await startHarness(root, env, 'direct', 'first.sock')
    await until(() => hub.sessions.get(SESSION)?.child !== null && hub.sessions.get(SESSION) !== undefined)
    // A second terminal resumes the same conversation (Claude Code allows it).
    const second = await startHarness(root, env, 'direct', 'second.sock')
    await until(() => hub.sessions.get(SESSION)?.harnessProcess.pid === second.pid)
    const session = hub.sessions.get(SESSION)!
    expect(session.standbys.map((writer) => writer.harnessProcess.pid)).toEqual([first.pid])
    expect(readSessionIncarnation(SESSION, env)?.harness_process?.pid).toBe(second.pid)
    for (const harness of [first, second]) {
      expect(readFileSync(writerLockPath(env, SESSION, harness.pid), 'utf8').trim().split(' ')[1]).toBe(String(harness.pid))
    }
    // A note is handed to exactly one place: the most recently opened.
    fake.notes.push({ body: 'hello' })
    await until(() => second.lines.some((line) => 'inbox' in line))
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(first.lines.some((line) => 'inbox' in line)).toBe(false)
    expect(second.lines.filter((line) => 'inbox' in line)).toHaveLength(1)
    // The newer place closes: the conversation goes on in the other, not ended.
    second.process.kill('SIGKILL')
    await until(() => hub.sessions.get(SESSION)?.harnessProcess.pid === first.pid)
    expect(readSessionIncarnation(SESSION, env)?.harness_process?.pid).toBe(first.pid)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(fake.batches.flatMap((batch) => batch.sessions).some((entry) => entry.state === 'ended')).toBe(false)
    // Losing the last observer preserves the unread note.
    first.process.kill('SIGKILL')
    await until(() => hub.sessions.get(SESSION)?.stopped != null)
    expect(fake.batches.flatMap(batch => batch.sessions).some(entry => entry.state === 'ended')).toBe(false)
    expect(await stop()).toBe(0)
  }, 40_000)

  it('records the close locally when no hub can be reached', async () => {
    const { root, env } = scratch()
    const harness = await startHarness(root, env, 'direct')
    // No hub, and none can start (this build has no runtime beside the launcher).
    await until(() => existsSync(childLockPath(env, SESSION)))
    await new Promise((resolve) => setTimeout(resolve, 500))
    harness.process.kill('SIGKILL')
    await until(() => existsSync(endedRecordsDir(env)) && readdirSync(endedRecordsDir(env)).some((name) => name.endsWith('.json')), 20_000)
    const name = readdirSync(endedRecordsDir(env)).find((file) => file.endsWith('.json'))!
    expect(JSON.parse(readFileSync(path.join(endedRecordsDir(env), name), 'utf8'))).toMatchObject({
      session_id: SESSION, harness: 'claude-code', harness_pid: harness.pid, reason: 'harness-gone',
    })
  }, 40_000)
})
