import { describe, expect, it } from 'vitest'
import {
  SESSION_ADJECTIVES,
  SESSION_NOUNS,
  sessionLabelFromId,
} from './source-context.js'

describe('sessionLabelFromId', () => {
  it('keeps both frozen dictionaries at 64 words', () => {
    expect(SESSION_ADJECTIVES).toHaveLength(64)
    expect(SESSION_NOUNS).toHaveLength(64)
    expect(new Set(SESSION_ADJECTIVES).size).toBe(64)
    expect(new Set(SESSION_NOUNS).size).toBe(64)
  })

  it.each([
    ['sess_abc123', 'Olive Caribou'],
    ['019ff59e-1234-5678-9abc-def012345678', 'Ember Marten'],
    ['线程-α', 'Copper Fox'],
  ])('maps %s to its frozen label', (sessionId, expected) => {
    expect(sessionLabelFromId(sessionId)).toBe(expected)
  })

  it('is deterministic without leaking an id or hash fragment', () => {
    const id = 'opaque-session-id-42'
    const label = sessionLabelFromId(id)
    expect(sessionLabelFromId(id)).toBe(label)
    expect(label).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
    expect(label).not.toContain('42')
    expect(label).not.toContain(id)
  })
})
