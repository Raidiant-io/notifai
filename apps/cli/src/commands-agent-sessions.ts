import { resolveActiveHarness } from './commands-harness-context.js'
import {
  authedClient,
  EXIT,
  loadLoggedConfig,
  reportError,
  type CommandDeps,
} from './commands-core.js'
import {
  normalizeExplicitSessionLabel,
  renameStoredSessionLabel,
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
