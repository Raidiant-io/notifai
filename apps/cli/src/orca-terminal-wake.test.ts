import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexRouteProfile } from './codex-surface.js'
import { readSessionState, writeSessionState } from './hook-session-state.js'
import type { OrcaRpcEnvelope, OrcaRuntime } from './orca-runtime.js'
import { orcaTerminalOf, recordOrcaTerminal, wakeOrcaTerminal } from './orca-terminal-wake.js'

const NOW = 1_793_900_000_000
/** An idle Codex 0.166 TUI in Orca, as `terminal.read --screen` showed it live (2026-11-05). */
const EMPTY = ['› Run the shell command: sleep 60.', '• I’ll run sleep 60.', '■ Conversation interrupted', '› Ask Codex to do anything',
  '  GPT-6.1-Sol high Fast · sw1 · main · Context 3% used', '  ? for shortcuts']

/** Orca as `terminal.show`, `agentStatus` and a screen read report a stopped Codex TUI (live shape, Orca 1.4.250). */
function fakeOrca(options: { identity?: string; status?: string; lastOutputAt?: number; agentWait?: unknown;
  screens?: Array<{ tail: string[]; draft?: string }>; stages?: string[]; capabilities?: string[] } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown>; envelope?: OrcaRpcEnvelope }> = []
  let reads = 0
  const runtime: OrcaRuntime = { call: async (method, params, _timeout, envelope) => {
    calls.push({ method, params: params as Record<string, unknown>, ...(envelope === undefined ? {} : { envelope }) })
    if (method === 'status.get') return { ok: true, result: { capabilities: options.capabilities ?? ['terminal.prompt-delivery.v1'] } }
    if (method === 'terminal.show') return { ok: true, result: { terminal: { handle: 'term_1', agentIdentity: options.identity ?? 'codex', agentWait: options.agentWait ?? null,
      lastOutputAt: options.lastOutputAt ?? NOW - 10_000, connected: true, writable: true } } }
    if (method === 'terminal.agentStatus') return { ok: true, result: { agentStatus: { handle: 'term_1', isRunningAgent: true, status: options.status ?? 'idle' } } }
    if (method === 'terminal.read') {
      const screen = (options.screens ?? [{ tail: EMPTY }])[Math.min(reads, (options.screens?.length ?? 1) - 1)]!
      reads += 1
      return { ok: true, result: { terminal: { handle: 'term_1', status: 'running', source: 'screen', truncated: false, nextCursor: null, ...screen } } }
    }
    if (method === 'terminal.send') return { ok: true, result: { send: { handle: 'term_1', accepted: true, bytesWritten: 10,
      prompt: { stages: options.stages ?? ['input_accepted', 'turn_started'] } } } }
    return { ok: false, code: 'method_not_found' }
  } }
  return { runtime, calls }
}

const wake = (orca: ReturnType<typeof fakeOrca>, mayType = async () => true) => wakeOrcaTerminal({ env: {}, terminal: { handle: 'term_1' }, text: 'WAKE',
  remainingMs: () => 30_000, mayType, runtime: orca.runtime, sleep: async () => undefined, now: () => NOW })

describe('typing the wake into a stopped Codex in an Orca terminal', () => {
  it('types once through Orca\'s prompt send, after every guard, and confirms the turn started', async () => {
    const orca = fakeOrca()
    const order: string[] = []
    expect(await wake(orca, async () => { order.push(`cleared after ${orca.calls.filter((call) => call.method === 'terminal.read').length} reads`); return true })).toBe('sent')
    expect(order).toEqual(['cleared after 2 reads'])
    const sends = orca.calls.filter((call) => call.method === 'terminal.send')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.params).toEqual({ terminal: 'term_1', text: 'WAKE', enter: true, agentPrompt: true, waitSubmitMs: 8_000, client: { id: 'notifai', type: 'desktop' } })
    expect(sends[0]!.envelope?.orchestrationRequestId).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('never types over a draft, a dialog, a changing screen, or a composer it cannot see', async () => {
    const cases: Array<[string, Parameters<typeof fakeOrca>[0], string]> = [
      // With a draft Orca leaves the bare glyph on the screen and moves the text to `draft`.
      ['a draft', { screens: [{ tail: [...EMPTY.slice(0, 3), '›', ...EMPTY.slice(4)], draft: 'half typed' }] }, 'held'],
      ['a draft typed between the reads', { screens: [{ tail: EMPTY }, { tail: EMPTY, draft: 'h' }] }, 'held'],
      ['the screen changing between the reads', { screens: [{ tail: EMPTY }, { tail: [...EMPTY, '• new output'].slice(1) }] }, 'held'],
      ['output within the last 3 seconds', { lastOutputAt: NOW - 1_000 }, 'held'],
      ['an open dialog', { agentWait: { source: 'hook', reason: 'permission' } }, 'held'],
      ['a permission prompt', { status: 'permission' }, 'held'],
      ['no composer row on screen', { screens: [{ tail: ['some other program'] }] }, 'not-sent'],
      ['another agent', { identity: 'claude' }, 'not-sent'],
      ['a turn the User already started', { status: 'working' }, 'not-sent'],
      ['an Orca without prompt receipts', { capabilities: [] }, 'not-sent'],
    ]
    for (const [name, options, outcome] of cases) {
      const orca = fakeOrca(options)
      let cleared = false
      expect(await wake(orca, async () => { cleared = true; return true }), name).toBe(outcome)
      expect(cleared, name).toBe(false)
      expect(orca.calls.some((call) => call.method === 'terminal.send'), name).toBe(false)
    }
  })

  it('types nothing when the queued wake could not be removed, and never repeats a send it cannot confirm', async () => {
    const kept = fakeOrca()
    expect(await wake(kept, async () => false)).toBe('not-sent')
    expect(kept.calls.some((call) => call.method === 'terminal.send')).toBe(false)
    const silent = fakeOrca({ stages: ['input_accepted'] })
    expect(await wake(silent)).toBe('unknown')
    expect(silent.calls.filter((call) => call.method === 'terminal.send')).toHaveLength(1)
  })
})

describe('which Orca terminal a Codex session runs in', () => {
  const env = { ORCA_TERMINAL_HANDLE: 'term_6b5d950d-f2ac-490e-a103-67acd2c6a30e', ORCA_PANE_KEY: 'pane', ORCA_USER_DATA_PATH: '/u/orca' }
  it('is the terminal a Codex TUI runs in, on this machine; an app\'s server or a remote Orca host has none', () => {
    expect(orcaTerminalOf(env, codexRouteProfile(env, 'other', 'darwin'))).toEqual({ handle: env.ORCA_TERMINAL_HANDLE, user_data: '/u/orca' })
    expect(orcaTerminalOf(env, codexRouteProfile(env, 'shared-server', 'linux'))).not.toBeNull()
    expect(orcaTerminalOf(env, codexRouteProfile(env, 'app-server', 'darwin'))).toBeNull()
    expect(orcaTerminalOf({ ...env, ORCA_ENVIRONMENT: 'ssh:box' }, codexRouteProfile(env, 'other', 'darwin'))).toBeNull()
    expect(orcaTerminalOf({ ...env, ORCA_TERMINAL_HANDLE: 'bad handle;rm' }, codexRouteProfile(env, 'other', 'darwin'))).toBeNull()
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
