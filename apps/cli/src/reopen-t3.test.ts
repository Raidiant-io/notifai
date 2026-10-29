import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootstrapLogger } from './logging.js'
import type { T3Host } from './reopen-t3.js'
import { readReopenLaunch, t3ThreadOf } from './reopen-terminal.js'
import { sessionInputWake } from './session-inputs.js'
import { REOPEN_CONFIRM_MS, reopenLine, reopenReport, SessionReopen, type ReopenHost, type ReopenTarget } from './session-reopen.js'

function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-reopen-t3-'))
  return { HOME: path.join(root, 'home'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config'), PATH: '/usr/bin:/bin' }
}

const THREAD = { thread: 'mcp:00000000-0000-4000-8000-000000000001', cli: '/Users/u/.t3/bin/t3', home: null }

function rig(t3: Partial<T3Host> = {}) {
  const env = environment()
  const sends: { cli: string; home: string | null; thread: string; message: string }[] = []
  const replies: (true | string)[] = []
  let now = 1_000_000
  const host: ReopenHost = {
    env,
    logger: bootstrapLogger({ env }),
    now: () => now,
    launcher: '/opt/notifai/notifai',
    loginShell: '/bin/zsh',
    terminal: { platform: 'darwin', env, hasApp: () => false, which: () => null },
    claudeLive: () => false,
    codexHolders: () => [],
    codexSharedServer: () => false,
    codexAttach: async () => ({ state: 'unknown', confirmed: false, reason: 'test' }),
    resolveHarness: () => null,
    codexPostures: () => null,
    queueCodexWake: async () => undefined,
    open: async () => 'no window in a T3 reopen',
    codexApp: { platform: 'linux', launcher: null, alive: () => false, bundleOf: () => null, hasOpenUnder: () => false, processesOf: () => 'unknown',
      holders: () => 'unknown', originator: () => ({ place: 'unknown', originator: null }), queuedWake: () => null,
      sendEvent: async () => 'failed', openUrl: async () => 'not here' },
    t3: {
      serverRunning: () => true,
      cli: (thread) => thread.cli,
      send: async (cli, home, thread, message) => { sends.push({ cli, home, thread, message }); return replies.shift() ?? true },
      pause: async () => undefined,
      ...t3,
    },
  }
  const target = (extra: Partial<ReopenTarget> = {}): ReopenTarget => ({
    sessionId: 'sess-t3', harness: 'claude-code', place: 't3', stoppedSince: 500, cwd: null, claudeConfigDir: null, codexHome: null,
    orcaPane: false, launch: null, hooks: { terminal: null, terminal_seen: null, orca_pane: false, permission_mode: 'bypassPermissions', t3: THREAD },
    items: ['answer:r1:1'], transcriptPath: null, hostApp: null, harnessProcess: null, ...extra,
  })
  return { env, reopen: new SessionReopen(host), sends, replies, target, advance: (ms: number) => { now += ms } }
}

describe('reopening a conversation T3 Code stopped', () => {
  it('sends its own thread one Notifai wake through its T3 Code, and its coming back confirms it', async () => {
    const { env, reopen, sends, target } = rig()
    expect(await reopen.reopenFor(target(), 'answer')).toMatchObject({ outcome: 'launched', terminal: 't3' })
    expect(sends).toEqual([{ cli: THREAD.cli, home: null, thread: THREAD.thread, message: sessionInputWake() }])
    // The same answer arriving again causes nothing more.
    expect(await reopen.reopenFor(target(), 'answer')).toMatchObject({ outcome: 'skipped' })
    reopen.resumed('sess-t3', 4242)
    expect(reopenReport(env, 'darwin').sessions[0]).toMatchObject({ session_id: 'sess-t3', outcome: 'confirmed', terminal: 't3', attempts: 1 })
    expect(reopenLine(reopenReport(env, 'darwin'))).toContain('T3 Code threads while T3 Code runs')
  })

  it('retries a busy T3 Code database, and waits for the User when the send still fails', async () => {
    const busy = rig()
    busy.replies.push('database is locked', true)
    expect(await busy.reopen.reopenFor(busy.target(), 'answer')).toMatchObject({ outcome: 'launched' })
    expect(busy.sends).toHaveLength(2)

    const failing = rig()
    failing.replies.push('thread not found')
    expect(await failing.reopen.reopenFor(failing.target(), 'note')).toEqual({ outcome: 'waiting', reason: 'launch-failed' })
    expect(failing.sends).toHaveLength(1)
    // A failed send spends no attempt: the next item tries again.
    expect(await failing.reopen.reopenFor(failing.target({ items: ['answer:r1:1', 'held:m2'] }), 'note')).toMatchObject({ outcome: 'launched' })
  })

  it('waits while T3 Code is not running, without the thread, for a Codex thread, open elsewhere, or with reopen.t3 off', async () => {
    const stopped = rig({ serverRunning: () => false })
    expect(await stopped.reopen.reopenFor(stopped.target(), 'answer')).toEqual({ outcome: 'waiting', reason: 't3-not-running' })
    const unknown = rig()
    expect(await unknown.reopen.reopenFor(unknown.target({ hooks: null }), 'answer')).toEqual({ outcome: 'waiting', reason: 'thread-unknown' })
    const codex = rig()
    expect(await codex.reopen.reopenFor(codex.target({ harness: 'codex' }), 'answer')).toEqual({ outcome: 'waiting', reason: 'place-waits' })
    const off = rig()
    const file = path.join(off.env['XDG_CONFIG_HOME']!, 'notifai', 'config.toml')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '[reopen]\nt3 = "off"\n')
    expect(await off.reopen.reopenFor(off.target(), 'answer')).toEqual({ outcome: 'waiting', reason: 'off' })
    expect(reopenLine(reopenReport(off.env, 'darwin'))).not.toContain('T3 Code')
    for (const each of [stopped, unknown, codex, off]) expect(each.sends).toEqual([])
  })

  it('counts a reopen nothing confirmed within its minute as no response, and stops after two', async () => {
    const { env, reopen, sends, target, advance } = rig()
    await reopen.reopenFor(target(), 'answer')
    advance(REOPEN_CONFIRM_MS + 1)
    reopen.check('sess-t3')
    expect(reopenReport(env, 'darwin').sessions[0]).toMatchObject({ outcome: 'no-response', reason: 'not-back' })
    await reopen.reopenFor(target({ items: ['answer:r1:1', 'held:m2'] }), 'note')
    advance(REOPEN_CONFIRM_MS + 1)
    reopen.check('sess-t3')
    expect(await reopen.reopenFor(target({ items: ['answer:r1:1', 'held:m2', 'held:m3'] }), 'note')).toEqual({ outcome: 'waiting', reason: 'attempts-used' })
    expect(sends).toHaveLength(2)
  })
})

describe('what T3 Code tells a hook', () => {
  it('keeps the thread T3 Code names and its own t3, and nothing outside T3 Code', () => {
    expect(t3ThreadOf({ T3CODE_THREAD_ID: THREAD.thread, T3CODE_CLI_PATH: THREAD.cli })).toEqual(THREAD)
    expect(t3ThreadOf({ T3CODE_THREAD_ID: THREAD.thread, T3CODE_CLI_PATH: '/tmp/evil', T3CODE_HOME: 'relative' })).toEqual({ ...THREAD, cli: null })
    expect(t3ThreadOf({ T3CODE_THREAD_ID: 'a b; rm -rf /' })).toBeNull()
    expect(t3ThreadOf({})).toBeNull()
    expect(readReopenLaunch({ terminal: null, orca_pane: false, t3: THREAD })?.t3).toEqual(THREAD)
    expect(readReopenLaunch({ terminal: null, orca_pane: false })?.t3).toBeNull()
  })
})
