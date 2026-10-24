import { describe, expect, it } from 'vitest'
import { resolveActiveHarness, sourceContextHarnessSession } from './commands-harness-context.js'

describe('Cursor shell identity', () => {
  it('uses the native conversation marker, not the per-turn request id', () => {
    expect(sourceContextHarnessSession({ CURSOR_AGENT: '1', CURSOR_CONVERSATION_ID: 'agent-conversation', CURSOR_REQUEST_ID: 'turn-a' }, '/project', 0))
      .toEqual({ harness: 'cursor', label: 'Cursor', sessionId: 'agent-conversation' })
  })
  it('keeps older shells detection-only', () => {
    expect(sourceContextHarnessSession({ CURSOR_AGENT: '1', CURSOR_REQUEST_ID: 'turn-a' }, '/project', 0))
      .toEqual({ harness: 'cursor', label: 'Cursor' })
  })
  it('does not attribute an inherited marker to an unrelated harness', () => {
    const env = { CURSOR_AGENT: '1', CURSOR_CONVERSATION_ID: 'agent-conversation', CODEX_THREAD_ID: 'other-thread' }
    expect(resolveActiveHarness(env, '/project', 0).contested).toHaveLength(2)
    expect(sourceContextHarnessSession(env, '/project', 0)).toBeNull()
  })
})
