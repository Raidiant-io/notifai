import { describe, expect, it } from 'vitest'
import { HARNESS_CAPABILITIES, HARNESSES } from './harnesses.js'

describe('harness continuation contract', () => {
  it('requires one explicit native delivery contract for every shipped harness', () => {
    expect(Object.keys(HARNESS_CAPABILITIES).sort()).toEqual([...HARNESSES].sort())
    expect(HARNESS_CAPABILITIES).toEqual({
      'claude-code': {
        stopContinuation: 'decision-block',
        deliveryRoutes: ['hook-continuation', 'inbox-socket', 'cold-resume', 'hold-for-next-turn'],
        deliveryContract:
          'live Stop continuation; no automatic wake after its bounded wait returns',
      },
      codex: {
        stopContinuation: 'decision-block',
        deliveryRoutes: ['hook-continuation', 'cold-resume', 'hold-for-next-turn'],
        deliveryContract:
          'live Stop continuation; no automatic wake after its bounded wait returns',
      },
      cursor: {
        stopContinuation: 'unsupported',
        deliveryRoutes: ['unsupported'],
        deliveryContract:
          'the hook can return a live follow-up, but the invoking shell exposes no exact conversation id; asynchronous ask is unsupported',
      },
      opencode: {
        stopContinuation: 'unsupported',
        deliveryRoutes: ['unsupported'],
        deliveryContract:
          'no proven answer continuation after session.idle; use a blocking reply command',
      },
    })
  })
})
