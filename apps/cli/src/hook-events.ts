/** Canonical lifecycle event vocabulary shared by installation and execution. */
import { type HookInstallableHarness } from './harnesses.js'

// ---------------------------------------------------------------------------
// hook / ask / close — harness integration
// ---------------------------------------------------------------------------

export const HOOK_EVENTS = [
  'session-start',
  'subagent-start',
  'activation-stop',
  'user-prompt-submit',
  'stop',
  'session-end',
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

/** Lifecycle handlers one installed harness must carry in this CLI build. */
export function requiredHookEvents(harness: HookInstallableHarness): readonly HookEvent[] {
  if (harness === 'opencode' || harness === 'openclaw') return []
  return harness === 'cursor'
    ? ['session-start', 'activation-stop', 'user-prompt-submit', 'stop', 'session-end']
    : ['session-start', 'subagent-start', 'user-prompt-submit', 'stop', 'session-end']
}
