/** Every harness Notifai ships. This is the sole source of the harness union. */
export const HARNESSES = ['claude-code', 'codex', 'cursor', 'opencode'] as const

export type Harness = (typeof HARNESSES)[number]

export type DeliveryRoute =
  | 'hook-continuation'
  | 'inbox-socket'
  | 'owned-control-plane'
  | 'cold-resume'
  | 'hold-for-next-turn'
  | 'unsupported'

export type StopContinuation =
  | 'decision-block'
  | 'followup-message'
  | 'unsupported'

export interface HarnessCapability {
  /** How an answer is admitted to another turn in the already-open session. */
  stopContinuation: StopContinuation
  /** Available answer-delivery routes, best current route first. */
  deliveryRoutes: readonly DeliveryRoute[]
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
    deliveryRoutes: ['hook-continuation', 'inbox-socket', 'cold-resume', 'hold-for-next-turn'],
    deliveryContract: 'live Stop continuation; no automatic wake after its bounded wait returns',
  },
  codex: {
    stopContinuation: 'decision-block',
    deliveryRoutes: ['hook-continuation', 'cold-resume', 'hold-for-next-turn'],
    deliveryContract: 'live Stop continuation; no automatic wake after its bounded wait returns',
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
}
