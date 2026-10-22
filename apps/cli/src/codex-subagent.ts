/**
 * Which root Agent Session a Codex subagent's question belongs to.
 *
 * Codex runs a spawned subagent inside the root's own Codex process and gives
 * the subagent's shell its own thread in `CODEX_THREAD_ID` and the root's in
 * `CODEX_SESSION_ID`. Notifai records only the root, so a subagent's `ask`
 * names a session Notifai never activated. Its question belongs to the root,
 * and its answer must wake the root, as a Claude Code subagent's does.
 *
 * This takes the root's identity on the same evidence Notifai already accepts
 * from the root's own shell, and no less (`docs/TRUST.md`, "Agent Session
 * identity"): a variable naming the thread, and the Codex process its hooks
 * recorded for that thread among this process's ancestors. Any script in a
 * subagent's shell can already copy `CODEX_SESSION_ID` into `CODEX_THREAD_ID`
 * and pass that check, so a stronger-looking proof here would secure nothing.
 * The ancestry check is kept because it is real protection against an honest
 * mistake: a tmux pane or editor started from a subagent's shell inherits its
 * variables but not its place in the tree.
 *
 * Whether a subagent should ask at all is its brief's business, which
 * Notifai cannot read: an ordinary worker is told by its worker context to
 * report to its parent instead.
 */
import { readSessionIncarnation, sessionHasEnded } from './hook-session-state.js'
import type { AncestorProcess } from './process-ancestry.js'
import { processIdentityLiveness } from './process-identity.js'

/** Whether this shell says it belongs to a Codex subagent. Says nothing about which root; never routes. */
export function codexSubagentShell(env: NodeJS.ProcessEnv): boolean {
  const thread = env['CODEX_THREAD_ID']
  const session = env['CODEX_SESSION_ID']
  return thread !== undefined && thread !== '' && session !== undefined && session !== '' && thread !== session
}

/**
 * The root this Codex subagent's shell asks for, with the root's current
 * start, when the root's recorded Codex process is alive and among this
 * process's ancestors; otherwise null. Registration rechecks that start under
 * the root's lock, so a root that ends or restarts meanwhile takes nothing.
 * Where the process tree cannot be read (Windows) there is no evidence, so
 * nothing is rerouted.
 */
export function codexSubagentRoot(
  env: NodeJS.ProcessEnv,
  chain: readonly AncestorProcess[] | null,
): { rootSessionId: string; rootKey: string } | null {
  if (chain === null || !codexSubagentShell(env)) return null
  const rootSessionId = env['CODEX_SESSION_ID']!
  const incarnation = readSessionIncarnation(rootSessionId, env)
  const host = incarnation?.harness_process
  if (incarnation === null || host === undefined || sessionHasEnded(rootSessionId, env) ||
      processIdentityLiveness(host) !== 'alive') return null
  return chain.some((ancestor) => ancestor.pid === host.pid) ? { rootSessionId, rootKey: incarnation.key } : null
}
