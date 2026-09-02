/** Structured gate decisions shared by lifecycle and acknowledgement handling. */
import type { HookContext } from './hook-types.js'

/** Runtime vocabulary for every recorded question gate. */
export const GATE_REASONS = [
  'no-session',
  'no-question',
  'answered',
  'continuation-repeat',
  'continuation-limit',
  'delivery-limit',
  'acknowledgement-required',
  'acknowledgement-abandoned',
  'harness-cannot-continue',
  'notifications-off',
  'claimed-elsewhere',
  'elapsed',
  'proceeding',
] as const

export type GateReason = (typeof GATE_REASONS)[number]

/** Record one gate decision using a stable reason agents can filter on. */
export function gate(
  ctx: HookContext,
  verdict: 'held' | 'proceeding',
  reason: GateReason,
  data: Record<string, unknown> = {},
): void {
  ctx.log?.info('hook.gate', { verdict, reason, stage: 'queued', ...data })
}
