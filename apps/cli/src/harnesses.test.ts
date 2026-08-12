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
          'the Stop hook returns at once and waits out of band, then posts the answer into this same session over its own inbox socket; a session that has stopped is resumed only once a liveness probe proves it stopped',
      },
      codex: {
        stopContinuation: 'decision-block',
        deliveryRoutes: ['hook-continuation', 'cold-resume', 'hold-for-next-turn'],
        deliveryContract:
          'live Stop continuation while the turn is held; once it returns, a stopped thread is resumed behind its writer lock and anything else waits for the next turn',
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
