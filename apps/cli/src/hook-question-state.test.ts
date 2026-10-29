import { describe, expect, it } from 'vitest'
import { sourceContextAtHookEvent } from './hook-question-state.js'

describe('sourceContextAtHookEvent', () => {
  it('keeps the session name provenance a hook-linked question was registered with', () => {
    // Without it the service treats the generated fallback as a real name and
    // the name the agent gives the session later can never replace it.
    expect(sourceContextAtHookEvent({
      session_id: 'session-one',
      session_label: 'Yellow Bear',
      session_label_source: 'fallback',
      harness: 'claude-code',
    }, undefined)).toEqual({
      session_id: 'session-one',
      session_label: 'Yellow Bear',
      session_label_source: 'fallback',
      harness: 'claude-code',
    })
    expect(sourceContextAtHookEvent({
      session_id: 'session-one',
      session_label: 'Fix the parser',
      session_label_source: 'semantic',
      session_label_previous_source: 'fallback',
    }, undefined)).toMatchObject({ session_label_source: 'semantic', session_label_previous_source: 'fallback' })
  })
})
