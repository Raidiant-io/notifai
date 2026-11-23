import { mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { grokHostOwner } from './commands-receive.js'
import { updateSessionState } from './hook-session-state.js'
import { GROK_ROUTE_RECHECK_MS, GrokHostRouteWatch, grokHostCandidate, grokPromptWake, sendGrokHostWake, verifyGrokHostRoute, type GrokHostRefusal, type GrokHostRoute, type GrokHostSystem, type RunResult } from './grok-host-route.js'
import { readT3ActiveGrokThread, readT3GrokThread } from './host-title-store.js'
import { sessionInputWake } from './session-inputs.js'

const CHAT = '089a3738-b97c-4c0e-9542-f472251923db'
const NATIVE = '01a2087a-30f3-7e80-9cb3-314c4940e2a2'
const ORCA_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
const orcaChat = { ORCA_STRUCTURED_SESSION: '1', ORCA_AGENT_SESSION_ID: CHAT, ORCA_CLI_COMMAND: ORCA_CLI, ORCA_ENVIRONMENT: '', ORCA_REMOTE_PAIRING: '', ORCA_PAIRING_CODE: '' }
const any = (): boolean => true

type Call = { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; input?: string }

function system(replies: RunResult[], overrides: Partial<GrokHostSystem> = {}): GrokHostSystem & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    run: async (command, args, options) => {
      calls.push({ command, args, env: options.env, ...(options.input === undefined ? {} : { input: options.input }) })
      return replies.shift() ?? { code: 1, stdout: '', stderr: 'no reply scripted' }
    },
    executable: any,
    t3ServerPid: () => 500,
    parentOf: () => 500,
    t3Thread: () => ({ thread: 'mcp:fd4b9e5e-8572-47ca-a603-38ef0ee784b0' }),
    pause: async () => undefined,
    ...overrides,
  }
}

/** What `orca status --json` prints when asked as a Grok session whose provider id Orca knows. */
function providerRefusal(chat: string): RunResult {
  return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { caller: { live: false, refusal: {
    code: 'session_caller_provider_id',
    message: `${NATIVE} is the provider's own session id, which changes on /clear. This session's Orca session ID is orca_session_id:${chat}; set ORCA_AGENT_SESSION_ID=${chat} instead. No effects were applied.`,
  } } } }) }
}

describe('grokHostCandidate', () => {
  it('names the Orca chat that started this Grok process, only on a verified platform', () => {
    expect(grokHostCandidate(orcaChat, 'darwin', any)).toEqual({ kind: 'orca-chat', chat: CHAT, cli: ORCA_CLI })
    expect(grokHostCandidate(orcaChat, 'win32', any)).toBeNull()
  })

  it('refuses Orca title runs, paired or remote hosts and a missing CLI', () => {
    // Orca's chat-title runs set no chat session and disable hooks.
    expect(grokHostCandidate({ ORCA_AGENT_HOOKS_DISABLED: '1', ORCA_CLI_COMMAND: ORCA_CLI }, 'darwin', any)).toBeNull()
    expect(grokHostCandidate({ ...orcaChat, ORCA_AGENT_HOOKS_DISABLED: '1' }, 'darwin', any)).toBeNull()
    expect(grokHostCandidate({ ...orcaChat, ORCA_ENVIRONMENT: 'paired-server' }, 'darwin', any)).toBeNull()
    expect(grokHostCandidate({ ...orcaChat, ORCA_REMOTE_PAIRING: '1' }, 'darwin', any)).toBeNull()
    expect(grokHostCandidate({ ...orcaChat, ORCA_AGENT_SESSION_ID: 'not-an-id' }, 'darwin', any)).toBeNull()
    expect(grokHostCandidate({ ...orcaChat, ORCA_CLI_COMMAND: 'orca' }, 'darwin', any)).toBeNull()
    expect(grokHostCandidate(orcaChat, 'darwin', () => false)).toBeNull()
  })

  it('names the T3 Code data directory and CLI, and nothing for a terminal', () => {
    expect(grokHostCandidate({ T3CODE_HOME: '/u/.t3', T3CODE_CLI_PATH: '/u/.t3/bin/t3' }, 'darwin', any))
      .toEqual({ kind: 't3-thread', home: '/u/.t3', cli: '/u/.t3/bin/t3' })
    expect(grokHostCandidate({ T3CODE_HOME: 'relative', T3CODE_CLI_PATH: '/u/.t3/bin/t3' }, 'darwin', any)).toBeNull()
    expect(grokHostCandidate({ TERM_PROGRAM: 'Apple_Terminal' }, 'darwin', any)).toBeNull()
  })
})

describe('verifyGrokHostRoute', () => {
  it('turns the Orca route on only when Orca names this chat for the Grok session', async () => {
    const host = system([providerRefusal(CHAT)])
    expect(await verifyGrokHostRoute({ kind: 'orca-chat', chat: CHAT, cli: ORCA_CLI }, NATIVE, 42, orcaChat, host))
      .toEqual({ kind: 'orca-chat', chat: CHAT, cli: ORCA_CLI })
    // Asked as the Grok session itself, never as the chat the environment claims.
    expect(host.calls[0]!.args).toEqual(['status', '--json'])
    expect(host.calls[0]!.env['ORCA_AGENT_SESSION_ID']).toBe(NATIVE)
  })

  it('refuses another chat or a session Orca no longer runs, definitively, and a silent Orca only for now', async () => {
    const other = '11111111-2222-4333-8444-555555555555'
    const route = { kind: 'orca-chat' as const, chat: CHAT, cli: ORCA_CLI }
    // The session now belongs to another chat (moved or shared process).
    expect(await verifyGrokHostRoute(route, NATIVE, 42, orcaChat, system([providerRefusal(other)])))
      .toEqual({ unavailable: 'orca-chat-binding-unverified', definite: true })
    // Orca 1.4.271 after the chat's /clear: the old native id is unknown.
    const unknown = { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { caller: { live: false, refusal: {
      code: 'session_caller_unknown', message: `No Orca agent session ${NATIVE} exists on this host. No effects were applied.` } } } }) }
    expect(await verifyGrokHostRoute(route, NATIVE, 42, orcaChat, system([unknown]))).toEqual({ unavailable: 'orca-chat-binding-unverified', definite: true })
    const live = { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { caller: { orcaSessionId: `orca_session_id:${CHAT}`, live: true } } }) }
    expect(await verifyGrokHostRoute(route, NATIVE, 42, orcaChat, system([live]))).toEqual({ unavailable: 'orca-chat-binding-unverified', definite: false })
    expect(await verifyGrokHostRoute(route, NATIVE, 42, orcaChat, system([{ code: 1, stdout: 'not json', stderr: '' }])))
      .toEqual({ unavailable: 'orca-chat-binding-unverified', definite: false })
  })

  it('needs the T3 server to be the Grok process parent and one live thread', async () => {
    const candidate = { kind: 't3-thread' as const, home: '/u/.t3', cli: '/u/.t3/bin/t3' }
    expect(await verifyGrokHostRoute(candidate, NATIVE, 42, {}, system([])))
      .toEqual({ ...candidate, thread: 'mcp:fd4b9e5e-8572-47ca-a603-38ef0ee784b0' })
    expect(await verifyGrokHostRoute(candidate, NATIVE, 42, {}, system([], { t3ServerPid: () => null })))
      .toEqual({ unavailable: 't3-server-not-parent', definite: false })
    expect(await verifyGrokHostRoute(candidate, NATIVE, 42, {}, system([], { parentOf: () => 501 })))
      .toEqual({ unavailable: 't3-server-not-parent', definite: false })
    // Archived, deleted or replaced: T3's readable record names no thread.
    expect(await verifyGrokHostRoute(candidate, NATIVE, 42, {}, system([], { t3Thread: () => 'none' })))
      .toEqual({ unavailable: 't3-thread-not-found', definite: true })
    expect(await verifyGrokHostRoute(candidate, NATIVE, 42, {}, system([], { t3Thread: () => 'ambiguous' })))
      .toEqual({ unavailable: 't3-thread-not-found', definite: true })
    expect(await verifyGrokHostRoute(candidate, NATIVE, 42, {}, system([], { t3Thread: () => 'unreadable' })))
      .toEqual({ unavailable: 't3-thread-not-found', definite: false })
  })
})

describe('GrokHostRouteWatch', () => {
  const route: GrokHostRoute = { kind: 't3-thread', home: '/u/.t3', cli: '/u/.t3/bin/t3', thread: 'mcp:t' }
  const lost: GrokHostRefusal = { unavailable: 't3-thread-not-found', definite: true }
  const silent: GrokHostRefusal = { unavailable: 't3-server-not-parent', definite: false }

  function clock() {
    let t = 0
    return { now: () => t, sleep: async (ms: number) => { t += ms }, advance: (ms: number) => { t += ms } }
  }

  it('waits for a starting session to appear in its host record, then gives up with the last refusal', async () => {
    const c = clock()
    const answers: Array<GrokHostRoute | GrokHostRefusal> = [lost, silent, route]
    const watch = await GrokHostRouteWatch.start(async () => answers.shift()!, c.now, c.sleep, 20_000)
    expect(watch).toBeInstanceOf(GrokHostRouteWatch)
    expect((watch as GrokHostRouteWatch).route).toEqual(route)
    const never = await GrokHostRouteWatch.start(async () => lost, c.now, c.sleep, 5_000)
    expect(never).toEqual(lost)
  })

  it('loses the route only on a definite answer, and never gets it back', async () => {
    const c = clock()
    let answer: GrokHostRoute | GrokHostRefusal = route
    let checks = 0
    const watch = await GrokHostRouteWatch.start(async () => { checks += 1; return answer }, c.now, c.sleep) as GrokHostRouteWatch
    answer = silent
    c.advance(GROK_ROUTE_RECHECK_MS['t3-thread'])
    await watch.poll()
    expect(watch.lost()).toBeNull()
    // Not due yet: no host call.
    await watch.poll()
    expect(checks).toBe(2)
    answer = lost
    c.advance(GROK_ROUTE_RECHECK_MS['t3-thread'])
    await watch.poll()
    expect(watch.lost()).toBe('t3-thread-not-found')
    // A wake's own check cannot revive a lost route.
    expect(watch.observe(route)).toBeNull()
  })
})

describe('sendGrokHostWake', () => {
  const wake = sessionInputWake('6f9619ff-8b86-4d01-b42d-00cf4fc964ff')

  it('mails the Orca chat as itself, the wake on stdin, and counts only an accepted message', async () => {
    const host = system([{ code: 0, stderr: '', stdout: '{"ok":true,"result":{"messageId":"msg_1"}}' }])
    expect(await sendGrokHostWake({ kind: 'orca-chat', chat: CHAT, cli: ORCA_CLI }, wake, { ...orcaChat, ORCA_AGENT_SESSION_ID: 'stale' }, host)).toBe('written')
    expect(host.calls[0]).toMatchObject({ command: ORCA_CLI, input: wake,
      args: ['orchestration', 'send', '--to', `orca_session_id:${CHAT}`, '--subject', 'Notifai', '--body-file', '-', '--json'] })
    expect(host.calls[0]!.env['ORCA_AGENT_SESSION_ID']).toBe(CHAT)
    expect(await sendGrokHostWake({ kind: 'orca-chat', chat: CHAT, cli: ORCA_CLI }, wake, orcaChat,
      system([{ code: 1, stderr: 'error', stdout: '{"ok":false,"error":{"code":"session_caller_not_live"}}' }]))).toBe('failed')
  })

  it('retries a busy T3 database, never a refusal', async () => {
    const route = { kind: 't3-thread' as const, home: '/u/.t3', cli: '/u/.t3/bin/t3', thread: 'mcp:t' }
    const busy = system([{ code: 1, stdout: '', stderr: 'SQLITE_BUSY: database is locked' }, { code: 0, stdout: '', stderr: '' }])
    expect(await sendGrokHostWake(route, wake, {}, busy)).toBe('written')
    expect(busy.calls.map((call) => call.args)).toEqual([['thread', 'send', 'mcp:t', '-'], ['thread', 'send', 'mcp:t', '-']])
    expect(busy.calls[0]!.env['T3CODE_HOME']).toBe('/u/.t3')
    const refused = system([{ code: 1, stdout: '', stderr: 'thread not found' }, { code: 0, stdout: '', stderr: '' }])
    expect(await sendGrokHostWake(route, wake, {}, refused)).toBe('failed')
    expect(refused.calls).toHaveLength(1)
  })
})

describe('grokPromptWake', () => {
  const wake = sessionInputWake('6f9619ff-8b86-4d01-b42d-00cf4fc964ff')

  it('finds the wake in Orca mail and leaves every other prompt as it is', () => {
    // Orca 1.4.271 shows a mail to Grok as this prompt.
    const mail = `──── From: ORCA_SESSION_ID:${CHAT.toUpperCase()} (orca_session_id:${CHAT}) (status) ────\nSubject: Notifai\n${wake}\n` +
      `[Reply: orca orchestration reply --id msg_1 --from orca_session_id:${CHAT} --body "..."]\n────`
    expect(grokPromptWake(mail)).toBe(wake)
    expect(grokPromptWake(wake)).toBe(wake)
    expect(grokPromptWake(mail.replace('Subject: Notifai', 'Subject: Other'))).toBe(mail.replace('Subject: Notifai', 'Subject: Other'))
    expect(grokPromptWake(`Please run this: ${wake}`)).toBe(`Please run this: ${wake}`)
    expect(grokPromptWake(undefined)).toBeUndefined()
  })
})

describe('the exact-session consumer', () => {
  it('hands input in only below the Grok process the route verified, for this incarnation', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-grok-host-'))
    const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config') }
    updateSessionState(NATIVE, env, (state) => ({ ...state, grok_host_owner: { incarnation: 'inc-1', pid: 300, start: 'Mon', route: 'orca-chat' } }))
    const below = () => [{ pid: 9 }, { pid: 8 }, { pid: 300 }, { pid: 1 }]
    expect(grokHostOwner(NATIVE, env, 'inc-1', below)).toEqual({ pid: 300, start: 'Mon' })
    expect(grokHostOwner(NATIVE, env, 'inc-2', below)).toBeUndefined()
    expect(grokHostOwner(NATIVE, env, 'inc-1', () => [{ pid: 9 }, { pid: 1 }])).toBeUndefined()
    expect(grokHostOwner(NATIVE, env, 'inc-1', () => null)).toBeUndefined()
  })
})

describe('readT3ActiveGrokThread', () => {
  function t3(): { env: NodeJS.ProcessEnv; db: DatabaseSync } {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-grok-t3-'))
    mkdirSync(path.join(root, 'userdata'), { recursive: true })
    const db = new DatabaseSync(path.join(root, 'userdata', 'statev2.sqlite'))
    db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, active_provider_thread_id TEXT, archived_at TEXT, deleted_at TEXT);
      CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, thread_id TEXT, driver TEXT, payload_json TEXT);`)
    db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL, NULL)').run('mcp:thread', 'provider-thread:1')
    db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?)').run('provider-thread:1', 'mcp:thread', 'grok',
      JSON.stringify({ nativeThreadRef: { driver: 'grok', nativeId: NATIVE, strength: 'strong' } }))
    return { env: { T3CODE_HOME: root }, db }
  }

  it('names the thread whose active provider thread is this Grok session', () => {
    const { env, db } = t3()
    expect(readT3ActiveGrokThread(env, NATIVE)).toBe('mcp:thread')
    expect(readT3GrokThread(env, NATIVE)).toEqual({ thread: 'mcp:thread' })
    expect(readT3GrokThread(env, 'another-session')).toBe('none')
    expect(readT3GrokThread({ T3CODE_HOME: path.join(os.tmpdir(), 'notifai-no-such-t3-home') }, NATIVE)).toBe('unreadable')
    db.close()
  })

  it('refuses an archived thread and one a newer provider session replaced', () => {
    const { env, db } = t3()
    db.exec("UPDATE orchestration_v2_projection_threads SET active_provider_thread_id = 'provider-thread:2'")
    expect(readT3GrokThread(env, NATIVE)).toBe('none')
    db.exec("UPDATE orchestration_v2_projection_threads SET active_provider_thread_id = 'provider-thread:1', archived_at = '2026-11-23T00:00:00Z'")
    expect(readT3GrokThread(env, NATIVE)).toBe('none')
    db.close()
  })
})
