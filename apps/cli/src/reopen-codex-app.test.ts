import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCodexLastTurnInterrupted } from './codex-session-end.js'
import { codexAppPlan, type CodexAppHost } from './reopen-codex-app.js'

const THREAD = '01a1ab45-a8ef-7893-b1dd-b985a616cd66'
const APP = { pid: 89_000, start: 'Thu Nov  5 09:00:00 2026' }
const SERVER = { pid: 89_640, start: 'Thu Nov  5 09:00:01 2026' }

function host(interrupted: boolean | null): CodexAppHost {
  return {
    platform: 'darwin', launcher: '/opt/notifai/launcher', alive: () => true,
    bundleOf: () => ({ bundleId: 'com.openai.codex', version: '26.1029.61003', executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' }),
    hasOpenUnder: () => true, processesOf: () => [APP.pid], holders: () => [],
    originator: () => ({ place: 'sessions', originator: 'Codex Desktop', path: '/u/.codex/sessions/rollout.jsonl' }),
    lastTurnInterrupted: () => interrupted, queuedWake: () => 'wake_token',
    sendEvent: async () => 'sent', openUrl: async () => true,
  }
}
const target = { sessionId: THREAD, codexHome: null, transcriptPath: null, hostApp: APP, appServer: SERVER, env: {} }

describe('the Codex app wake link', () => {
  it('is handed only for a conversation whose last turn was not stopped', () => {
    expect(codexAppPlan(target, host(false), () => false)).toMatchObject({ url: `codex://threads/wake/${THREAD}` })
    // Past a stop the link starts nothing and can leave the thread held by the app's server.
    expect(codexAppPlan(target, host(true), () => false)).toEqual({ wait: 'turn-stopped' })
    expect(codexAppPlan(target, host(null), () => false)).toEqual({ wait: 'turn-stopped' })
  })

  it('reads a stop from the rollout\'s last turn event, as Codex rebuilds its pause', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-rollout-'))
    try {
      const file = path.join(root, 'rollout.jsonl')
      const event = (payload: Record<string, unknown>) => JSON.stringify({ type: 'event_msg', payload })
      writeFileSync(file, [event({ type: 'task_started', turn_id: 't1' }), event({ type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message' } }), ''].join('\n'))
      expect(readCodexLastTurnInterrupted(file)).toBe(true)
      writeFileSync(file, [event({ type: 'task_started', turn_id: 't1' }), event({ type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' }),
        event({ type: 'task_started', turn_id: 't2' }), event({ type: 'task_complete', turn_id: 't2' }), ''].join('\n'))
      expect(readCodexLastTurnInterrupted(file)).toBe(false)
      writeFileSync(file, [event({ type: 'turn_aborted', turn_id: 't1', reason: 'replaced' }), ''].join('\n'))
      expect(readCodexLastTurnInterrupted(file)).toBe(false)
      expect(readCodexLastTurnInterrupted(path.join(root, 'missing.jsonl'))).toBeNull()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
