/**
 * Which root Agent Session a Codex subagent works for.
 *
 * Codex gives a spawned child's shell its own thread in `CODEX_THREAD_ID` and
 * the root's in `CODEX_SESSION_ID`, and the child runs in the root's Codex
 * process. Notifai records only the root, so a child's `ask` names a session
 * Notifai never activated. A worker delegated Notification Requests asks on
 * behalf of the root, and its answer must wake the root, as a Claude Code
 * subagent's does.
 *
 * Variables are inherited by anything a shell starts and can be set by any
 * script a repository ships, so they only point at evidence:
 *
 * - SubagentStart, run by the root's own Codex process, records the child's
 *   thread against the root's current start. That is Codex speaking, not the
 *   shell.
 * - The asking process must run below that same live Codex process.
 *
 * Without both, nothing is rerouted, and the child stays an unactivated
 * session, as before.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { sanitizeSessionId, stateDir } from './config.js'
import { readSessionIncarnation, sessionHasEnded } from './hook-session-state.js'
import type { AncestorProcess } from './process-ancestry.js'
import { processIdentityLiveness, type ProcessIdentity } from './process-identity.js'

interface CodexSubagentRecord {
  root_session_id: string
  /** The root's incarnation key when Codex reported the spawn. */
  root_incarnation: string
  recorded_at: number
}

export function codexSubagentRecordPath(childThreadId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(childThreadId)}.codex-subagent.json`)
}

/** The root's start and its host, while that host is the live process it was. */
function liveRoot(rootSessionId: string, env: NodeJS.ProcessEnv): { key: string; host: ProcessIdentity } | null {
  const incarnation = readSessionIncarnation(rootSessionId, env)
  const host = incarnation?.harness_process
  if (incarnation === null || host === undefined || sessionHasEnded(rootSessionId, env) ||
      processIdentityLiveness(host) !== 'alive') return null
  return { key: incarnation.key, host }
}

/**
 * Record a spawned child against its root, from a SubagentStart the root's own
 * Codex process ran. Returns whether it was recorded.
 */
export function recordCodexSubagent(input: {
  rootSessionId: string
  childThreadId: string
  hookSourcePid: number | undefined
  env: NodeJS.ProcessEnv
  now: number
}): boolean {
  if (input.childThreadId === '' || input.childThreadId === input.rootSessionId) return false
  const root = liveRoot(input.rootSessionId, input.env)
  if (root === null || root.host.pid !== input.hookSourcePid) return false
  const record: CodexSubagentRecord = {
    root_session_id: input.rootSessionId, root_incarnation: root.key, recorded_at: input.now,
  }
  atomicWriteFileSync(codexSubagentRecordPath(input.childThreadId, input.env), `${JSON.stringify(record)}\n`)
  return true
}

function readCodexSubagent(childThreadId: string, env: NodeJS.ProcessEnv): CodexSubagentRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(codexSubagentRecordPath(childThreadId, env), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (typeof record['root_session_id'] !== 'string' || typeof record['root_incarnation'] !== 'string' ||
        typeof record['recorded_at'] !== 'number') return null
    return {
      root_session_id: record['root_session_id'], root_incarnation: record['root_incarnation'],
      recorded_at: record['recorded_at'],
    }
  } catch {
    return null
  }
}

/** Whether this shell says it belongs to a Codex subagent. Says nothing about which root; never routes. */
export function codexSubagentShell(env: NodeJS.ProcessEnv): boolean {
  const thread = env['CODEX_THREAD_ID']
  const session = env['CODEX_SESSION_ID']
  return thread !== undefined && thread !== '' && session !== undefined && session !== '' && thread !== session
}

/**
 * The root this shell's Codex subagent works for, when Codex recorded the
 * spawn against the root's current start and this process runs below the
 * root's live Codex process; otherwise null. A root thread's own shell, where
 * both variables name the same thread, is not a subagent.
 */
export function delegatedCodexRoot(
  env: NodeJS.ProcessEnv,
  chain: readonly AncestorProcess[] | null,
): { rootSessionId: string; childThreadId: string } | null {
  if (chain === null || !codexSubagentShell(env)) return null
  const childThreadId = env['CODEX_THREAD_ID']!
  const rootSessionId = env['CODEX_SESSION_ID']!
  const record = readCodexSubagent(childThreadId, env)
  if (record === null || record.root_session_id !== rootSessionId) return null
  const root = liveRoot(rootSessionId, env)
  if (root === null || root.key !== record.root_incarnation) return null
  return chain.some((ancestor) => ancestor.pid === root.host.pid) ? { rootSessionId, childThreadId } : null
}
