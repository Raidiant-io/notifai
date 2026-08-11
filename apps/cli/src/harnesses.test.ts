import { describe, expect, it } from 'vitest'
import { HARNESS_CAPABILITIES, HARNESSES, HOOK_TIMING } from './harnesses.js'

describe('harness continuation contract', () => {
  it('requires one explicit native delivery contract for every shipped harness', () => {
    expect(Object.keys(HARNESS_CAPABILITIES).sort()).toEqual([...HARNESSES].sort())
    expect(HARNESS_CAPABILITIES).toEqual({
      'claude-code': {
        stopContinuation: 'decision-block',
        dormantWake: 'unsupported',
        deliveryContract:
          'live Stop continuation; no automatic wake after its bounded wait returns',
      },
      codex: {
        stopContinuation: 'decision-block',
        dormantWake: 'unsupported',
        deliveryContract:
          'live Stop continuation; no automatic wake after its bounded wait returns',
      },
      cursor: {
        stopContinuation: 'unsupported',
        dormantWake: 'unsupported',
        deliveryContract:
          'the hook can return a live follow-up, but the invoking shell exposes no exact conversation id; asynchronous ask is unsupported',
      },
      opencode: {
        stopContinuation: 'unsupported',
        dormantWake: 'unsupported',
        deliveryContract:
          'no proven answer continuation after session.idle; use a blocking reply command',
      },
    })
  })

  it('derives the maximum grace from the reserves every Stop must retain', () => {
    expect(HOOK_TIMING.maxGraceSeconds).toBe(
      HOOK_TIMING.totalSeconds -
        HOOK_TIMING.finalizationReserveSeconds -
        HOOK_TIMING.submissionReserveSeconds -
        HOOK_TIMING.minimumReplySeconds -
        HOOK_TIMING.schedulingSlackSeconds,
    )
    expect(HOOK_TIMING.finalizationReserveSeconds).toBeGreaterThan(
      HOOK_TIMING.stdoutReserveSeconds,
    )
    expect(HOOK_TIMING.totalSeconds + HOOK_TIMING.hostHeadroomSeconds).toBe(540)
  })
})
