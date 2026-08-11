/** Every harness Notifai ships. This is the sole source of the harness union. */
export const HARNESSES = ['claude-code', 'codex', 'cursor', 'opencode'] as const

export type Harness = (typeof HARNESSES)[number]

/** One canonical wall-clock budget shared by config, hooks, and installers. */
export const HOOK_TIMING = Object.freeze({
  totalSeconds: 480,
  finalizationReserveSeconds: 45,
  submissionReserveSeconds: 40,
  minimumReplySeconds: 60,
  schedulingSlackSeconds: 1,
  stdoutReserveSeconds: 5,
  hostHeadroomSeconds: 60,
  maxGraceSeconds: 334,
})

export type StopContinuation =
  | 'decision-block'
  | 'followup-message'
  | 'unsupported'

export interface HarnessCapability {
  /** How an answer is admitted to another turn in the already-open session. */
  stopContinuation: StopContinuation
  /** Whether delivery remains native after the turn-end event has returned. */
  dormantWake: 'unsupported' | 'native-session-prompt'
  /** Concise, honest readiness text for doctor and installation guidance. */
  deliveryContract: string
}

/**
 * Exhaustive runtime contract. Adding a harness without deciding every
 * continuation joint is a type error, not a silently degraded notification.
 */
export const HARNESS_CAPABILITIES: Record<Harness, HarnessCapability> = {
  'claude-code': {
    stopContinuation: 'decision-block',
    dormantWake: 'unsupported',
    deliveryContract: 'live Stop continuation; no automatic wake after its bounded wait returns',
  },
  codex: {
    stopContinuation: 'decision-block',
    dormantWake: 'unsupported',
    deliveryContract: 'live Stop continuation; no automatic wake after its bounded wait returns',
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
}
