/**
 * The Codex app adapter: every precondition, the link, the route it takes and
 * the faults that stop it. No test hands a link to a real app: the machine is
 * a fake, and the one real process run is the launcher against a dead pid.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bootstrapLogger } from './logging.js'
import {
  CODEX_APP_BUNDLE_ID,
  codexAppEventArgs,
  codexAppOpenArgs,
  codexWakeUrl,
  systemCodexAppHost,
  type CodexAppHost,
} from './reopen-codex-app.js'
import { REOPEN_CONFIRM_MS, SessionReopen, type ReopenHost, type ReopenTarget } from './session-reopen.js'

const THREAD = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b'
const WAKE = `codex://threads/wake/${THREAD}`
const APP = { pid: 700, start: 'Tue Oct 20 10:00:00 2026' }
const SERVER = { pid: 701, start: 'Tue Oct 20 10:00:01 2026' }
const EXE = '/Applications/Codex.app/Contents/MacOS/Codex'

function rig(app: Partial<CodexAppHost> = {}, settings?: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-app-'))
  const env: NodeJS.ProcessEnv = { HOME: path.join(root, 'home'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config') }
  if (settings !== undefined) {
    mkdirSync(path.join(root, 'config', 'notifai'), { recursive: true })
    writeFileSync(path.join(root, 'config', 'notifai', 'config.toml'), settings)
  }
  const events: { pid: number; url: string }[] = []
  const opened: string[] = []
  const queued: string[] = []
  const calls: string[] = []
  let now = 1_000_000
  let version = '26.1015 (1234)'
  const codexApp: CodexAppHost = {
    platform: 'darwin',
    launcher: '/opt/notifai/notifai',
    alive: () => true,
    bundleOf: () => ({ bundleId: CODEX_APP_BUNDLE_ID, version, executable: EXE }),
    hasOpenUnder: () => true,
    processesOf: () => [APP.pid],
    holders: () => [],
    originator: () => ({ place: 'sessions', originator: 'Codex Desktop' }),
    queuedWake: () => { calls.push('queued-wake'); return 'wake-1' },
    sendEvent: async (pid, url) => { events.push({ pid, url }); return 'sent' },
    openUrl: async (url) => { opened.push(url); return true },
    ...app,
  }
  const host: ReopenHost = {
    env, logger: bootstrapLogger({ env }), now: () => now, launcher: '/opt/notifai/notifai', loginShell: '/bin/zsh',
    terminal: { platform: 'darwin', env, hasApp: () => false, which: () => null },
    claudeLive: () => false, codexHolders: () => [], codexSharedServer: () => false,
    codexAttach: async () => ({ state: 'unknown', confirmed: false, reason: 'test' }),
    resolveHarness: () => null,
    queueCodexWake: async (id) => { calls.push('queue'); queued.push(id) },
    open: async () => { throw new Error('a Codex app conversation never opens a terminal') },
    codexApp,
  }
  const target = (extra: Partial<ReopenTarget> = {}): ReopenTarget => ({
    sessionId: THREAD, harness: 'codex', place: 'codex-app', stoppedSince: 500, cwd: root, claudeConfigDir: null, codexHome: path.join(root, '.codex'),
    orcaPane: false, launch: null, hooks: null, items: ['answer:r1:1'], transcriptPath: null, hostApp: APP, harnessProcess: SERVER, ...extra,
  })
  return { env, host, reopen: new SessionReopen(host), events, opened, queued, calls, target,
    advance: (ms: number) => { now += ms }, setVersion: (value: string) => { version = value } }
}

describe('the Codex app adapter', () => {
  it('builds only the wake link for a Codex thread id', () => {
    expect(codexWakeUrl(THREAD)).toBe(WAKE)
    expect(codexWakeUrl(THREAD.toUpperCase())).toBe(WAKE)
    expect(codexWakeUrl('sess-1')).toBeNull()
    expect(codexWakeUrl(`${THREAD}/../x`)).toBeNull()
    expect(codexAppEventArgs(700, WAKE)).toEqual(['--internal-codex-app-url', '700', WAKE])
    expect(codexAppOpenArgs(WAKE)).toEqual(['-g', '-b', 'com.openai.codex', WAKE])
  })

  it('queues the wake, then hands the running app its link once, by its process id', async () => {
    const r = rig()
    expect(await r.reopen.reopenFor(r.target(), 'answer')).toMatchObject({ outcome: 'launched', terminal: 'codex-app' })
    expect(r.calls.slice(0, 2)).toEqual(['queue', 'queued-wake'])
    expect(r.events).toEqual([{ pid: APP.pid, url: WAKE }])
    expect(r.opened).toEqual([])
    // The app-server loading it again confirms it.
    r.reopen.resumed(THREAD, SERVER.pid)
    expect((await r.reopen.reopenFor(r.target({ items: ['message:m2'] }), 'note'))).toEqual({ outcome: 'waiting', reason: 'wake-linked' })
    expect(r.events).toHaveLength(1)
  })

  it('hands a wake one link across two hubs', async () => {
    const r = rig()
    const other = new SessionReopen(r.host)
    const outcomes = await Promise.all([r.reopen.reopenFor(r.target(), 'answer'), other.reopenFor(r.target(), 'answer')])
    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(['launched', 'waiting'])
    expect(r.events).toHaveLength(1)
  })

  it('sends nothing unless every precondition holds', async () => {
    const cases: [string, Partial<CodexAppHost>, Partial<ReopenTarget>, string, string?][] = [
      ['off this Mac', { platform: 'linux' }, {}, 'not-macos'],
      ['a terminal thread', { originator: () => ({ place: 'sessions', originator: 'codex-tui' }) }, {}, 'not-app-thread'],
      ['an IDE thread', { originator: () => ({ place: 'sessions', originator: 'codex_vscode' }) }, {}, 'not-app-thread'],
      ['a T3 thread', { originator: () => ({ place: 'sessions', originator: 't3code' }) }, {}, 'not-app-thread'],
      ['no rollout', { originator: () => ({ place: 'missing', originator: null }) }, {}, 'not-app-thread'],
      ['archived', { originator: () => ({ place: 'archived', originator: 'Codex Desktop' }) }, {}, 'archived'],
      ['not a thread id', {}, { sessionId: 'sess-1' }, 'not-app-thread'],
      ['the app quit', { alive: (identity) => identity.pid !== APP.pid }, {}, 'app-not-running'],
      ['no app recorded', {}, { hostApp: null }, 'app-not-running'],
      ['another app', { bundleOf: () => ({ bundleId: 'com.openai.codex.helper', version: '1', executable: EXE }) }, {}, 'app-unrecognised'],
      ['the app-server gone', { alive: (identity) => identity.pid !== SERVER.pid }, {}, 'app-server-gone'],
      ['the app-server on another home', { hasOpenUnder: () => false }, {}, 'app-server-gone'],
      ['loaded somewhere', { holders: () => [4242] }, {}, 'live-elsewhere'],
      ['holders unreadable', { holders: () => 'unknown' }, {}, 'live-unknown'],
      ['no wake of Notifai\'s queued', { queuedWake: () => null }, {}, 'no-wake-queued'],
      ['no launcher', { launcher: null }, {}, 'launcher-missing'],
      ['the app policy off', {}, {}, 'off', '"reopen.codex_app" = "off"\n'],
      ['the master switch off', {}, {}, 'off', '"reopen.automatic" = false\n'],
    ]
    for (const [name, app, extra, reason, toml] of cases) {
      const r = rig(app, toml)
      expect(await r.reopen.reopenFor(r.target(extra), 'answer'), name).toEqual({ outcome: 'waiting', reason })
      expect(r.events, name).toEqual([])
      expect(r.opened, name).toEqual([])
    }
  })

  it('a Claude Code conversation recorded in the Codex app place is never sent', async () => {
    const r = rig()
    expect(await r.reopen.reopenFor(r.target({ harness: 'claude-code' }), 'answer')).toEqual({ outcome: 'waiting', reason: 'place-waits' })
    expect(r.events).toEqual([])
  })

  it('uses LaunchServices only while the same app runs, and stops links when that started the app', async () => {
    let pids = [APP.pid]
    const r = rig({ sendEvent: async () => 'needs-consent', processesOf: () => pids, openUrl: async (url) => { pids = [...pids, 900]; return url === WAKE || 'x' } })
    expect(await r.reopen.reopenFor(r.target(), 'answer')).toEqual({ outcome: 'waiting', reason: 'app-started' })
    // No more links for this app version.
    const again = new SessionReopen(r.host)
    expect(await again.reopenFor(r.target({ stoppedSince: 900 }), 'answer')).toEqual({ outcome: 'waiting', reason: 'app-ignored-links' })

    const plain = rig({ sendEvent: async () => 'needs-consent' })
    expect(await plain.reopen.reopenFor(plain.target(), 'answer')).toMatchObject({ outcome: 'launched' })
    expect(plain.opened).toEqual([WAKE])

    const gone = rig({ sendEvent: async () => 'needs-consent', processesOf: () => [] })
    expect(await gone.reopen.reopenFor(gone.target(), 'answer')).toEqual({ outcome: 'waiting', reason: 'app-not-running' })
    expect(gone.opened).toEqual([])
  })

  it('a send to a dead app process starts nothing', async () => {
    const r = rig({ sendEvent: async () => 'gone' })
    expect(await r.reopen.reopenFor(r.target(), 'answer')).toEqual({ outcome: 'waiting', reason: 'app-not-running' })
    expect(r.opened).toEqual([])
  })

  it('an app that ignores its link gets no more until its version changes', async () => {
    const r = rig()
    expect((await r.reopen.reopenFor(r.target(), 'answer')).outcome).toBe('launched')
    r.advance(REOPEN_CONFIRM_MS)
    r.reopen.check(THREAD)
    const second = { ...r.host, codexApp: { ...r.host.codexApp, queuedWake: () => 'wake-2' } }
    const reopen = new SessionReopen(second)
    expect(await reopen.reopenFor(r.target({ items: ['message:m2'] }), 'note')).toEqual({ outcome: 'waiting', reason: 'app-ignored-links' })
    r.setVersion('26.1020 (1300)')
    expect((await reopen.reopenFor(r.target({ items: ['message:m3'] }), 'note')).outcome).toBe('launched')
  })
})

describe.runIf(process.platform === 'darwin')('the launcher\'s Apple Event', () => {
  it('reaches no process for a dead pid, and launches nothing', () => {
    const build = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-url-build-'))
    const launcher = path.join(build, 'notifai')
    execFileSync('cc', ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-D_XOPEN_SOURCE=700', '-D_DARWIN_C_SOURCE', '-mmacosx-version-min=13.0',
      '-Wall', '-Wextra', '-Werror', '-O2', fileURLToPath(new URL('../launcher/main.c', import.meta.url)), '-o', launcher], { stdio: 'inherit' })
    const host = systemCodexAppHost(launcher)
    return expect(host.sendEvent(999_999, WAKE)).resolves.toBe('gone')
  }, 120_000)
})
