import type { CommandDeps } from './commands-core.js'
import { resolveActiveHarness } from './commands-harness-context.js'
import { findOwningSession, readProjectSession } from './hooks.js'

export interface ResolvedCommandSession {
  sessionId: string
  source: 'exact-harness' | 'stable-id' | 'project-pointer'
}

/**
 * Resolve only Question Routing lifecycle ownership.
 *
 * Exact harness identity wins across checkouts. A stable question/request id
 * wins next. The cwd pointer remains a compatibility fallback for shells that
 * genuinely have no exact harness identity; it never owns Project or config
 * scope, which stay with the command's invocation directory.
 */
export function resolveCommandSession(
  deps: CommandDeps,
  stableId?: string,
): ResolvedCommandSession | null {
  if (stableId !== undefined) {
    const owner = findOwningSession(stableId, deps.env)
    if (owner.ambiguous) return null
    if (owner.sessionId !== null) return { sessionId: owner.sessionId, source: 'stable-id' }
  }
  const now = (deps.now ?? Date.now)()
  const resolution = resolveActiveHarness(deps.env, deps.cwd, now)
  if (resolution.contested.length > 0) return null
  if (
    resolution.active?.sessionId !== undefined &&
    resolution.contested.length === 0
  ) {
    return { sessionId: resolution.active.sessionId, source: 'exact-harness' }
  }
  const pointer = readProjectSession(deps.cwd, deps.env, now)
  return pointer === null ? null : { sessionId: pointer, source: 'project-pointer' }
}
