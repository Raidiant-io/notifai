import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexRouteProfile } from './codex-surface.js'
import { readSessionState, writeSessionState } from './hook-session-state.js'
import type { OrcaRuntime } from './orca-runtime.js'
import { codexRestingScreen, orcaTerminalOf, recordOrcaTerminal, wakeOrcaTerminal, type StopScreen } from './orca-terminal-wake.js'

const NOW = 1_793_900_000_000
const ABOVE = ['› Run the shell command: sleep 60.', '• I’ll run sleep 60.', '■ Conversation interrupted - use /feedback if something went wrong']
const FOOTER = ['  GPT-6.1-Sol high Fast · sw1 · main · Context 3% used', '  ? for shortcuts']
/** An idle Codex 0.166 TUI in Orca, as `terminal.read --screen` showed it live right after Esc (2026-11-05). */
const EMPTY = [...ABOVE, '› Ask Codex to do anything', ...FOOTER]
const STOP: StopScreen = codexRestingScreen({ source: 'screen', status: 'running', tail: EMPTY })!

/**
 * Orca as its runtime answers for a stopped Codex TUI: `terminal.show`,
 * `agentStatus`, screen reads, and guarded sends that refuse without an
 * agent in the foreground. A paste shows as the draft; an Enter starts a turn.
 */
function fakeOrca(options: { identity?: string; status?: string; lastOutputAt?: number; agentWait?: unknown; appVersion?: string
  screens?: Array<{ tail: string[]; draft?: string }>; agentGone?: 'paste' | 'enter'; userTypes?: string; enterStarts?: boolean } = {}) {
  const writes: Array<Record<string, unknown>> = []
  let reads = 0
  let draft: string | undefined
  let working = false
  const runtime: OrcaRuntime = { call: async (method, params) => {
    const p = params as Record<string, unknown>
    if (method === 'status.get') return { ok: true, result: { appVersion: options.appVersion ?? '1.4.250', capabilities: [] } }
    if (method === 'terminal.show') return { ok: true, result: { terminal: { handle: 'term_1', agentIdentity: options.identity ?? 'codex', agentWait: options.agentWait ?? null,
      lastOutputAt: options.lastOutputAt ?? NOW - 10_000, connected: true, writable: true } } }
    if (method === 'terminal.agentStatus') return { ok: true, result: { agentStatus: { handle: 'term_1', isRunningAgent: true, status: working ? 'working' : options.status ?? 'idle' } } }
    if (method === 'terminal.read') {
      if (draft !== undefined) return { ok: true, result: { terminal: { status: 'running', source: 'screen', tail: [...ABOVE, '›', ...FOOTER], draft } } }
      const screens = options.screens ?? [{ tail: EMPTY }]
      const screen = screens[Math.min(reads, screens.length - 1)]!
      reads += 1
      return { ok: true, result: { terminal: { status: 'running', source: 'screen', ...screen } } }
    }
    if (method === 'terminal.send') {
      writes.push(p)
      // Orca refuses a guarded write with no agent in the foreground: nothing is written.
      if (p['requireAgentStatus'] !== 'sendable') throw new Error('every write must be guarded')
      if ((options.agentGone === 'paste' && 'text' in p) || (options.agentGone === 'enter' && 'enter' in p)) {
        return { ok: true, result: { send: { handle: 'term_1', accepted: false, bytesWritten: 0, refusedReason: 'no-agent' } } }
      }
      if (typeof p['text'] === 'string') draft = `${(p['text'] as string).replace(/^\x1b\[200~|\x1b\[201~$/gu, '')}${options.userTypes ?? ''}`
      if (p['enter'] === true) { draft = undefined; working = options.enterStarts ?? true }
      return { ok: true, result: { send: { handle: 'term_1', accepted: true, bytesWritten: 1 } } }
    }
    return { ok: false, code: 'method_not_found' }
  } }
  return { runtime, writes }
}

function wake(orca: ReturnType<typeof fakeOrca>, stopScreen: StopScreen | null = STOP, enterAfter: 'render-quiet' | number = 'render-quiet') {
  let clock = NOW
  return wakeOrcaTerminal({ env: {}, terminal: { handle: 'term_1' }, text: 'WAKE', stopScreen, remainingMs: () => 30_000, enterAfter,
    runtime: orca.runtime, sleep: async (ms) => { clock += ms }, now: () => clock })
}

describe('typing the wake into a stopped Codex in an Orca terminal', () => {
  it('pastes, waits for the paste to show, then presses Enter, each write guarded by Orca, and sees the turn start', async () => {
    const orca = fakeOrca()
    expect(await wake(orca)).toBe('sent')
    expect(orca.writes).toEqual([
      { terminal: 'term_1', text: '\x1b[200~WAKE\x1b[201~', requireAgentStatus: 'sendable', client: { id: 'notifai', type: 'desktop' } },
      { terminal: 'term_1', enter: true, requireAgentStatus: 'sendable', client: { id: 'notifai', type: 'desktop' } },
    ])
    // A shorter wait between the paste and Enter is one setting away.
    expect(await wake(fakeOrca(), STOP, 50)).toBe('sent')
  })

  it('never types into a shell: Orca refuses the guarded paste or Enter once Codex left the foreground', async () => {
    const paste = fakeOrca({ agentGone: 'paste' })
    expect(await wake(paste)).toBe('not-sent')
    expect(paste.writes).toHaveLength(1)
    const enter = fakeOrca({ agentGone: 'enter' })
    expect(await wake(enter)).toBe('unknown')
    // An Orca whose guarded sends were not checked gets nothing at all.
    const old = fakeOrca({ appVersion: '1.4.200' })
    expect(await wake(old)).toBe('not-sent')
    expect(old.writes).toEqual([])
  })

  it('never types over a draft, including one that looks like a placeholder, a dialog, or a changing screen', async () => {
    const cases: Array<[string, Parameters<typeof fakeOrca>[0], string]> = [
      // With a draft Orca leaves the bare glyph on the screen and moves the text to `draft`.
      ['a draft', { screens: [{ tail: [...ABOVE, '›', ...FOOTER], draft: 'half typed' }] }, 'held'],
      ['a draft typed between the reads', { screens: [{ tail: EMPTY }, { tail: [...ABOVE, '›', ...FOOTER], draft: 'h' }] }, 'held'],
      ['a draft typed right before the paste', { screens: [{ tail: EMPTY }, { tail: EMPTY }, { tail: [...ABOVE, '›', ...FOOTER], draft: 'x' }] }, 'held'],
      // Orca's matcher counts these as placeholders; a User can type them.
      ['a "Try …" draft', { screens: [{ tail: [...ABOVE, '› Try "pnpm test" and fix what fails', ...FOOTER] }] }, 'held'],
      ['an old Codex placeholder', { screens: [{ tail: [...ABOVE, '› Explain this codebase', ...FOOTER] }] }, 'held'],
      ['the screen changing between the reads', { screens: [{ tail: EMPTY }, { tail: [...EMPTY, '• new output'] }] }, 'held'],
      ['output within the last 3 seconds', { lastOutputAt: NOW - 1_000 }, 'held'],
      ['an open dialog', { agentWait: { source: 'hook', reason: 'permission' } }, 'held'],
      ['a permission prompt', { status: 'permission' }, 'held'],
      ['another agent', { identity: 'claude' }, 'not-sent'],
      ['a turn the User already started', { status: 'working' }, 'not-sent'],
    ]
    for (const [name, options, outcome] of cases) {
      const orca = fakeOrca(options)
      expect(await wake(orca), name).toBe(outcome)
      expect(orca.writes, name).toEqual([])
    }
  })

  it('types only into the screen the User stopped it on: not after a /new or /resume, nor without that screen', async () => {
    const renewed = fakeOrca({ screens: [{ tail: ['>_ OpenAI Codex (v0.166.0)', '  model: gpt-6.1-sol', '› Ask Codex to do anything', ...FOOTER] }] })
    expect(await wake(renewed)).toBe('not-sent')
    expect(renewed.writes).toEqual([])
    const unseen = fakeOrca()
    expect(await wake(unseen, null)).toBe('not-sent')
    expect(unseen.writes).toEqual([])
  })

  it('leaves the paste unsubmitted when the composer shows anything but the wake, and never repeats a write', async () => {
    const typedAlong = fakeOrca({ userTypes: 'x' })
    expect(await wake(typedAlong)).toBe('unknown')
    expect(typedAlong.writes.map((write) => 'enter' in write)).toEqual([false])
    const silent = fakeOrca({ enterStarts: false })
    expect(await wake(silent)).toBe('unknown')
    expect(silent.writes).toHaveLength(2)
  })
})

describe('the empty composer', () => {
  it('is an empty row or exactly the placeholder this Codex shows, with no draft', () => {
    const at = (row: string, draft?: string) => codexRestingScreen({ source: 'screen', status: 'running', tail: [...ABOVE, row, ...FOOTER], ...(draft === undefined ? {} : { draft }) })
    expect(at('› Ask Codex to do anything')).toEqual({ above: ABOVE, composer: 'Ask Codex to do anything' })
    expect(at('›')).toEqual({ above: ABOVE, composer: '' })
    expect(at('› Try “pnpm test”')).toBeNull()
    expect(at('› Ask a follow-up question')).toBeNull()
    expect(at('›', 'typed')).toBeNull()
  })

  it('names the screen by the conversation\'s own last lines, not Codex\'s status rows that come and go', () => {
    const withStatus = codexRestingScreen({ source: 'screen', status: 'running', tail: [...ABOVE, '  1 background terminal running · /ps to view', '› Ask Codex to do anything', ...FOOTER] })
    expect(withStatus).toEqual(STOP)
  })
})

describe('which Orca terminal a Codex session runs in', () => {
  const env = { TERM_PROGRAM: 'Orca', ORCA_TERMINAL_HANDLE: 'term_6b5d950d-f2ac-490e-a103-67acd2c6a30e', ORCA_PANE_KEY: 'pane', ORCA_USER_DATA_PATH: '/u/orca' }
  it('is the Orca terminal a Codex TUI runs in directly, on this machine', () => {
    const tui = (extra: NodeJS.ProcessEnv, kind: 'other' | 'shared-server' | 'app-server' = 'other') =>
      orcaTerminalOf({ ...env, ...extra }, codexRouteProfile({ ...env, ...extra }, kind, 'darwin'))
    expect(tui({})).toEqual({ handle: env.ORCA_TERMINAL_HANDLE, user_data: '/u/orca' })
    expect(tui({}, 'shared-server')).not.toBeNull()
    expect(tui({}, 'app-server')).toBeNull()
    // Orca's variables inherited by a multiplexer or another terminal app started inside it.
    expect(tui({ TMUX: '/tmp/tmux-501/default,1,0' })).toBeNull()
    expect(tui({ STY: '1234.pts-0' })).toBeNull()
    expect(tui({ ZELLIJ: '0' })).toBeNull()
    expect(tui({ TERM_PROGRAM: 'WezTerm' })).toBeNull()
    expect(tui({ ORCA_ENVIRONMENT: 'ssh:box' })).toBeNull()
    expect(tui({ ORCA_TERMINAL_HANDLE: 'bad handle;rm' })).toBeNull()
  })

  it('is recorded for the owner, and forgotten once the owner is no longer in one', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-orca-terminal-'))
    try {
      const state = { HOME: root, XDG_STATE_HOME: path.join(root, 'state'), NOTIFAI_HOOK_SOURCE_PID: String(process.pid) }
      writeSessionState('thread', { ...state }, { harness: 'codex' })
      recordOrcaTerminal('thread', { ...state, ...env }, 'owner', () => 'other')
      expect(readSessionState('thread', state).orca_terminal).toEqual({ key: 'owner', handle: env.ORCA_TERMINAL_HANDLE, user_data: '/u/orca' })
      recordOrcaTerminal('thread', { ...state }, 'owner', () => 'other')
      expect(readSessionState('thread', state).orca_terminal).toBeUndefined()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
