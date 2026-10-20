import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootstrapLogger } from './logging.js'
import type { TerminalLaunch } from './reopen-terminal.js'
import {
  guardRecord,
  launchRecordOf,
  REOPEN_CONFIRM_MS,
  reopenDir,
  reopenReport,
  reopenSettings,
  SessionReopen,
  type ReopenHost,
  type ReopenTarget,
} from './session-reopen.js'

function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-reopen-'))
  return { HOME: path.join(root, 'home'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config'), PATH: '/usr/bin:/bin' }
}

function setting(env: NodeJS.ProcessEnv, toml: string): void {
  const file = path.join(env['XDG_CONFIG_HOME']!, 'notifai', 'config.toml')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, toml)
}

function rig(overrides: Partial<ReopenHost> = {}) {
  const env = overrides.env ?? environment()
  const opened: { launch: TerminalLaunch; cwd: string; script: string }[] = []
  const queued: string[] = []
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
    resolveHarness: (name) => `/usr/local/bin/${name}`,
    queueCodexWake: async (id) => { queued.push(id) },
    open: async (launch, cwd) => {
      opened.push({ launch, cwd, script: readFileSync(launch.args.at(-1)!, 'utf8') })
      return true
    },
    codexApp: { platform: 'linux', launcher: null, alive: () => false, bundleOf: () => null, hasOpenUnder: () => false, processesOf: () => 'unknown',
      holders: () => 'unknown', originator: () => ({ place: 'unknown', originator: null }), queuedWake: () => null,
      sendEvent: async () => 'failed', openUrl: async () => 'not here' },
    ...overrides,
  }
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-reopen-cwd-'))
  const target = (extra: Partial<ReopenTarget> = {}): ReopenTarget => ({
    sessionId: 'sess-1', harness: 'claude-code', place: 'terminal', stoppedSince: 500, cwd, claudeConfigDir: null, codexHome: null,
    orcaPane: false, launch: { exe: null, options: ['--model', 'opus'], start_mode: null, codex_host: null },
    hooks: { terminal: 'terminal', terminal_seen: 'terminal', orca_pane: false, permission_mode: 'acceptEdits' }, items: ['answer:r1:1'],
    transcriptPath: null, hostApp: null, harnessProcess: null, ...extra,
  })
  return { env, host, reopen: new SessionReopen(host), opened, queued, target, cwd, advance: (ms: number) => { now += ms } }
}

describe('reopening a stopped conversation', () => {
  it('opens one terminal window that resumes it in place, in the mode it last ran in', async () => {
    const { reopen, opened, target, cwd, env } = rig()
    expect(await reopen.reopenFor(target(), 'answer')).toMatchObject({ outcome: 'launched', terminal: 'terminal' })
    expect(opened).toHaveLength(1)
    expect(opened[0]!.launch.command).toBe('/usr/bin/open')
    expect(opened[0]!.launch.args.slice(0, 3)).toEqual(['-g', '-a', 'Terminal'])
    expect(opened[0]!.cwd).toBe(cwd)
    expect(opened[0]!.script).toContain(`exec '/bin/zsh' -l -c 'exec "$@"' notifai '/usr/local/bin/claude' '--resume' 'sess-1' '--model' 'opus' '--permission-mode' 'acceptEdits'`)
    // The script is private and executable; the guard record names this conversation and its home.
    const script = opened[0]!.launch.args.at(-1)!
    expect(statSync(script).mode & 0o777).toBe(0o700)
    const record = readFileSync(script.replace(/\.command$/, '.json'), 'utf8')
    expect(record).toMatch(/^\{"v":1,"token":"[0-9a-f]{32}","harness":"claude-code","session_id":"sess-1","home":".*\/\.claude","default_home":".*\/\.claude","allow_holder":0,"expires_at":\d+\}\n$/)
    expect(statSync(reopenDir(env)).mode & 0o777).toBe(0o700)
  })

  it('opens once for several items, and not again for an item it already considered', async () => {
    const { reopen, opened, target, advance } = rig()
    const [first, second] = await Promise.all([reopen.reopenFor(target(), 'answer'), reopen.reopenFor(target({ items: ['answer:r1:1', 'message:m1'] }), 'note')])
    expect([first.outcome, second.outcome].sort()).toEqual(['launched', 'skipped'])
    expect(await reopen.reopenFor(target({ items: ['answer:r1:1', 'message:m1'] }), 'note')).toEqual({ outcome: 'skipped', reason: 'in-progress' })
    advance(REOPEN_CONFIRM_MS)
    reopen.check('sess-1')
    expect(await reopen.reopenFor(target(), 'answer')).toEqual({ outcome: 'skipped', reason: 'nothing-new' })
    // A later item tries once more; then the stopped period's attempts are used.
    expect((await reopen.reopenFor(target({ items: ['answer:r1:1', 'message:m2'] }), 'note')).outcome).toBe('launched')
    advance(REOPEN_CONFIRM_MS)
    reopen.check('sess-1')
    expect(await reopen.reopenFor(target({ items: ['message:m3'] }), 'note')).toEqual({ outcome: 'waiting', reason: 'attempts-used' })
    expect(opened).toHaveLength(2)
    // A new stopped period starts over.
    expect((await reopen.reopenFor(target({ stoppedSince: 900, items: ['message:m3'] }), 'note')).outcome).toBe('launched')
  })

  it('opens at most three windows a minute on the machine; the rest wait their turn', async () => {
    const { reopen, opened, target, advance } = rig()
    for (const id of ['a', 'b', 'c']) expect((await reopen.reopenFor(target({ sessionId: id }), 'answer')).outcome).toBe('launched')
    expect(await reopen.reopenFor(target({ sessionId: 'd' }), 'answer')).toEqual({ outcome: 'skipped', reason: 'burst' })
    advance(60_000)
    expect((await reopen.reopenFor(target({ sessionId: 'd' }), 'answer')).outcome).toBe('launched')
    expect(opened).toHaveLength(4)
  })

  it('leaves it waiting, with the reason, wherever it cannot reopen in place', async () => {
    const cases: [string, Partial<ReopenHost>, Partial<ReopenTarget>, string, string?][] = [
      ['an app with no adapter', {}, { place: 'claude-desktop' }, 'place-waits'],
      ['a scripted run', {}, { place: 'headless' }, 'place-waits'],
      ['the Codex app, off this Mac', {}, { place: 'codex-app', harness: 'codex' }, 'not-macos'],
      ['the Codex app, off', {}, { place: 'codex-app', harness: 'codex' }, 'off', '"reopen.codex_app" = "off"\n'],
      ['an Orca pane', {}, { orcaPane: true }, 'orca-pane'],
      ['an Orca pane its hooks saw', {}, { hooks: { terminal: null, terminal_seen: 'orca', orca_pane: true, permission_mode: null } }, 'orca-pane'],
      ['a missing folder', {}, { cwd: '/nonexistent/notifai-reopen' }, 'folder-missing'],
      ['Claude Code open elsewhere', { claudeLive: () => true }, {}, 'live-elsewhere'],
      ['a Codex thread another process holds', { codexHolders: () => [4242] }, { harness: 'codex' }, 'live-elsewhere'],
      ['a Codex thread whose holders cannot be read', { codexHolders: () => 'unknown' }, { harness: 'codex' }, 'live-unknown'],
      ['the shared server holding it, attach unknown', { codexHolders: () => [4242], codexSharedServer: () => true }, { harness: 'codex' }, 'attach-unknown'],
      ['the shared server holding it, a terminal attached', { codexHolders: () => [4242], codexSharedServer: () => true,
        codexAttach: async () => ({ state: 'attached', confirmed: true, reason: 'joined' }) }, { harness: 'codex' }, 'live-elsewhere'],
      ['the shared server holding it, closed but not confirmed', { codexHolders: () => [4242], codexSharedServer: () => true,
        codexAttach: async () => ({ state: 'closed', confirmed: false, reason: 'passive' }) }, { harness: 'codex' }, 'attach-unknown'],
      ['no harness on the login shell PATH', { resolveHarness: () => null }, {}, 'harness-missing'],
      ['no native launcher', { launcher: null }, {}, 'launcher-missing'],
      ['Linux without a desktop session', { terminal: { platform: 'linux', env: {}, hasApp: () => false, which: () => '/usr/bin/xterm' } }, {}, 'no-display'],
      ['the window failing to open', { open: async () => 'open exited 1' }, {}, 'launch-failed'],
      ['terminals off', {}, {}, 'off', '"reopen.terminal" = "off"\n'],
      ['reopening off', {}, {}, 'off', '"reopen.automatic" = false\n'],
    ]
    for (const [name, host, extra, reason, toml] of cases) {
      const r = rig(host)
      if (toml !== undefined) setting(r.env, toml)
      expect(await r.reopen.reopenFor(r.target(extra), 'answer'), name).toEqual({ outcome: 'waiting', reason })
      expect(r.opened, name).toHaveLength(0)
      // Considered once: the same item does not try again.
      expect(await r.reopen.reopenFor(r.target(extra), 'answer'), name).toEqual({ outcome: 'skipped', reason: 'nothing-new' })
    }
  })

  it('queues an unloaded Codex thread\'s wake before its terminal opens, and joins one the shared server holds unattached', async () => {
    const order: string[] = []
    const unloaded = rig({ queueCodexWake: async () => { order.push('queued') }, open: async () => { order.push('opened'); return true } })
    const codex = { harness: 'codex' as const, launch: { exe: null, options: ['--no-daemon'], start_mode: null, codex_host: 'tui' as const },
      hooks: { terminal: null, terminal_seen: null, orca_pane: false, permission_mode: 'default' } }
    expect((await unloaded.reopen.reopenFor(unloaded.target(codex), 'answer')).outcome).toBe('launched')
    expect(order).toEqual(['queued', 'opened'])

    const shared = rig({ codexHolders: () => [4242], codexSharedServer: (pid) => pid === 4242,
      codexAttach: async () => ({ state: 'closed', confirmed: true, reason: 'terminal-gone+reloaded' }) })
    expect((await shared.reopen.reopenFor(shared.target({ ...codex, launch: { exe: null, options: [], start_mode: null, codex_host: 'shared-server' },
      hooks: { terminal: 'iterm2', terminal_seen: 'iterm2', orca_pane: true, permission_mode: null } }), 'answer')).outcome).toBe('launched')
    // Loaded: no wake before the terminal holds it; the guard lets that server's lock be.
    expect(shared.queued).toEqual([])
    expect(shared.opened[0]!.script).toContain(`'/usr/local/bin/codex' 'resume' 'sess-1'`)
    // The server's environment is not the conversation's: its terminal and Orca facts are ignored.
    expect(shared.opened[0]!.launch.args).toContain('Terminal')
    const record = readFileSync(shared.opened[0]!.launch.args.at(-1)!.replace(/\.command$/, '.json'), 'utf8')
    expect(record).toContain('"allow_holder":4242')
  })

  it('treats a thread the shared server turns out not to hold as unloaded: its wake is queued first', async () => {
    const r = rig({ codexHolders: () => [4242], codexSharedServer: () => true,
      codexAttach: async () => ({ state: 'not-loaded', confirmed: false, reason: 'not-loaded' }) })
    expect((await r.reopen.reopenFor(r.target({ harness: 'codex', launch: { exe: null, options: [], start_mode: null, codex_host: 'shared-server' } }),
      'answer')).outcome).toBe('launched')
    expect(r.queued).toEqual(['sess-1'])
  })

  it('confirms when the conversation comes back, and records no response after a minute otherwise', async () => {
    const { reopen, target, env, advance } = rig()
    const launched = await reopen.reopenFor(target(), 'answer')
    if (launched.outcome !== 'launched') throw new Error('not launched')
    const files = path.join(reopenDir(env), launched.token)
    writeFileSync(`${files}.pid`, '777\n')
    reopen.resumed('sess-1', 777)
    expect(existsSync(`${files}.json`)).toBe(false)
    expect(reopenReport(env, 'darwin').sessions).toMatchObject([{ session_id: 'sess-1', outcome: 'confirmed', terminal: 'terminal', attempts: 1 }])

    // The conversation can come back before the window's `open` returns: still confirmed.
    let early: SessionReopen | null = null
    const fast = rig({ open: async (launch) => {
      writeFileSync(launch.args.at(-1)!.replace(/\.command$/, '.pid'), '778\n')
      early!.resumed('sess-1', 778)
      return true
    } })
    early = fast.reopen
    expect((await fast.reopen.reopenFor(fast.target(), 'answer')).outcome).toBe('launched')
    expect(reopenReport(fast.env, 'darwin').sessions[0]).toMatchObject({ outcome: 'confirmed' })

    const other = rig()
    await other.reopen.reopenFor(other.target(), 'answer')
    other.advance(REOPEN_CONFIRM_MS - 1)
    other.reopen.check('sess-1')
    expect(reopenReport(other.env, 'darwin').sessions[0]).toMatchObject({ outcome: 'launched' })
    other.advance(1)
    other.reopen.check('sess-1')
    expect(reopenReport(other.env, 'darwin').sessions[0]).toMatchObject({ outcome: 'no-response', reason: 'window-did-not-run' })
    advance(0)
  })
})

describe('reopen settings and records', () => {
  it('reads the machine file only, with the decided defaults', () => {
    const env = environment()
    expect(reopenSettings(env)).toEqual({ automatic: true, terminal: 'automatic', codexApp: 'when-running', terminalApp: 'auto', terminalCommand: null,
      focus: 'background', permissionMode: 'same' })
    setting(env, '[reopen]\nautomatic = false\nterminal = "sideways"\nfocus = "front"\n')
    expect(reopenSettings(env)).toMatchObject({ automatic: false, terminal: 'automatic', focus: 'front' })
  })

  it('reads how a terminal harness was started without its prompt or its config overrides', () => {
    expect(launchRecordOf('claude-code', ['/usr/local/bin/claude', '--permission-mode', 'plan', '--model', 'opus', 'do it'], 'linux'))
      .toEqual({ exe: '/usr/local/bin/claude', options: ['--model', 'opus'], start_mode: 'plan', codex_host: null })
    expect(launchRecordOf('codex', ['codex', '--no-daemon', '-c', 'secret=1', '-p', 'work'], 'linux'))
      .toEqual({ exe: null, options: ['--no-daemon', '-p', 'work'], start_mode: null, codex_host: 'tui' })
    expect(launchRecordOf('codex', ['/opt/codex', 'app-server', '--listen', 'unix:///x'], 'linux'))
      .toEqual({ exe: null, options: [], start_mode: null, codex_host: 'shared-server' })
    // macOS joins arguments with spaces: a folder that does not exist was split, and is not kept.
    expect(launchRecordOf('claude-code', ['claude', '--add-dir', '/nonexistent/My', 'Folder', os.tmpdir()], 'darwin')?.options)
      .toEqual(['--add-dir', os.tmpdir()])
  })

  it('writes no guard record a fixed grammar could misread', () => {
    const base = { token: 'a'.repeat(32), harness: 'codex' as const, sessionId: 't1', home: '/h/.codex', defaultHome: '/h/.codex', allowHolder: null, expiresAt: 5 }
    expect(guardRecord(base)).toBe(`{"v":1,"token":"${'a'.repeat(32)}","harness":"codex","session_id":"t1","home":"/h/.codex","default_home":"/h/.codex","allow_holder":0,"expires_at":5}\n`)
    expect(guardRecord({ ...base, home: '/h/"x' })).toBeNull()
    expect(guardRecord({ ...base, sessionId: 'a/b' })).toBeNull()
  })
})
