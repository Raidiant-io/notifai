import { resolveActiveHarness } from './commands-harness-context.js'
import {
  authedClient,
  EXIT,
  loadLoggedConfig,
  reportError,
  type CommandDeps,
} from './commands-core.js'
import { HARNESS_LABELS } from './harnesses.js'
import {
  normalizeExplicitSessionLabel,
  renameStoredSessionLabel,
  storedSessionLabel,
} from './session-labels.js'

export interface AgentSessionRenameFlags {
  json?: boolean
}

/** Rename only the exact harness-owned Agent Session running this command. */
export async function agentSessionRenameCommand(
  deps: CommandDeps,
  label: string,
  flags: AgentSessionRenameFlags = {},
): Promise<number> {
  const now = deps.now?.() ?? Date.now()
  const resolution = resolveActiveHarness(deps.env, deps.cwd, now)
  const active = resolution.active
  if (resolution.contested.length === 0 && active?.harness === 'cursor') {
    deps.io.err(
      'Cursor does not identify its Agent Session to Notifai, so this session has no name to rename. Keep working.',
    )
    return EXIT.usage
  }
  if (resolution.contested.length > 0 || active?.sessionId === undefined) {
    deps.io.err(
      'No exact active Agent Session can be proven here. Run this command inside the Agent Session you intend to rename.',
    )
    return EXIT.usage
  }

  const normalized = normalizeExplicitSessionLabel({
    env: deps.env,
    sessionId: active.sessionId,
    label,
  })
  if (!normalized.ok) {
    deps.io.err(normalized.error)
    return EXIT.usage
  }

  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env })
  const auth = authedClient(deps, config)
  if (!auth) return EXIT.auth
  try {
    const renamed = await auth.client.putAgentSessionLabel({
      session_id: active.sessionId,
      label: normalized.label,
    })
    const local = renameStoredSessionLabel({
      env: deps.env,
      sessionId: active.sessionId,
      label: renamed.label,
      harness: active.harness,
      now,
    })
    if (!local.ok) {
      deps.io.err(local.error)
      return EXIT.failed
    }
    deps.io.out(
      flags.json
        ? JSON.stringify(renamed)
        : `Agent Session renamed to "${renamed.label}" across your Notifai account.`,
    )
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err, { operation: 'agent_session_rename' })
  }
}

/** Where the current name came from, in words an agent can act on. */
export type AgentSessionNameSource = 'agent' | 'harness' | 'generated'

const NAME_SOURCES = { explicit: 'agent', harness: 'harness', fallback: 'generated' } as const

export interface AgentSessionStatusView {
  /**
   * The exact Agent Session owned by the active harness, or null when none is
   * identified here. More session facts join this object, never the top level.
   */
  session: {
    harness: string
    /** Null until Notifai first names it (its first send or ask). */
    name: string | null
    name_source: AgentSessionNameSource | null
  } | null
  /** Why `session` is null. */
  reason?: 'not_identified' | 'ambiguous'
  /** The harness that runs here without identifying its Agent Session. */
  harness?: string
}

/**
 * Read-only: the name this machine gave the exact Agent Session that
 * `session rename` would rename, and where that name came from.
 */
export function agentSessionStatusCommand(deps: CommandDeps, flags: { json?: boolean } = {}): number {
  const now = deps.now?.() ?? Date.now()
  const resolution = resolveActiveHarness(deps.env, deps.cwd, now)
  const active = resolution.active
  let view: AgentSessionStatusView
  if (resolution.contested.length > 0) {
    view = { session: null, reason: 'ambiguous' }
  } else if (active?.sessionId === undefined) {
    view = { session: null, reason: 'not_identified', ...(active === null ? {} : { harness: active.harness }) }
  } else {
    let stored
    try {
      stored = storedSessionLabel(active.sessionId, deps.env)
    } catch (err) {
      deps.io.err(`Could not read this Agent Session's name: ${err instanceof Error ? err.message : String(err)}`)
      return EXIT.failed
    }
    view = {
      session: {
        harness: active.harness,
        name: stored?.label ?? null,
        name_source: stored === undefined ? null : NAME_SOURCES[stored.source],
      },
    }
  }
  if (flags.json) {
    deps.io.out(JSON.stringify(view))
    return EXIT.ok
  }
  const session = view.session
  if (session === null) {
    deps.io.out(view.reason === 'ambiguous'
      ? 'More than one agent app could own this shell, so no exact Agent Session can be proven here.'
      : view.harness === undefined
        ? 'No agent app identifies an Agent Session here, so there is no name to show.'
        : `${HARNESS_LABELS[active!.harness]} does not identify its Agent Session here, so there is no name to show.`)
  } else if (session.name === null) {
    deps.io.out('This Agent Session has no name yet; Notifai names it when it first sends.')
  } else {
    const origin = session.name_source === 'agent' ? 'set by an agent'
      : session.name_source === 'harness' ? `from ${HARNESS_LABELS[active!.harness]}'s own session title`
        : 'a generated placeholder'
    deps.io.out(`Agent Session "${session.name}": ${origin}.`)
  }
  return EXIT.ok
}
