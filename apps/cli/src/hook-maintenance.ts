/**
 * Daily housekeeping that used to run inside prompt hooks.
 *
 * Pruning abandoned session state walks a directory with no useful bound, and
 * the update lookup is network work with ceilings far longer than any prompt
 * hook's harness timeout. Neither belongs in front of the User's prompt. A
 * prompt-path hook only checks one stamp file; when the day's work is due it
 * hands it to one detached `notifai hook maintenance` process and returns.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { refreshAgentUpdateState } from './agent-update-notice.js'
import { stateDir } from './config.js'
import type { HookInstallableHarness } from './harnesses.js'
import { pruneAbandonedSessions } from './hook-session-state.js'
import { launchSelf } from './launch-self.js'

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface HookMaintenanceLaunch {
  cwd: string
  harness?: HookInstallableHarness
  /** The launching hook's share of its harness timeout for the Windows hand-off. */
  detachTimeoutMs?: number
}

/**
 * Claim today's maintenance. One `stat` when it is not due; when it is, the
 * stamp is moved first so concurrent hooks do not all launch. Real clock,
 * deliberately: this compares against a file mtime.
 */
export function claimHookMaintenance(env: NodeJS.ProcessEnv, now: number = Date.now()): boolean {
  const stamp = path.join(stateDir(env), 'last-maintenance')
  try {
    // A negative age means the clock moved, not that the stamp is old.
    if (now - statSync(stamp).mtimeMs < MAINTENANCE_INTERVAL_MS) return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  try {
    mkdirSync(path.dirname(stamp), { recursive: true, mode: 0o700 })
    writeFileSync(stamp, '', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** Start the exact installed build as the detached maintenance process. */
export function spawnHookMaintenance(launch: HookMaintenanceLaunch): void {
  launchSelf(['hook', 'maintenance', '--owner', 'notifai', ...(launch.harness === undefined ? [] : ['--harness', launch.harness])], {
    cwd: launch.cwd,
    env: process.env,
    ...(launch.detachTimeoutMs === undefined ? {} : { detachTimeoutMs: launch.detachTimeoutMs }),
    // Short-lived and bound to no Agent Session: nothing to retain.
    retain: () => undefined,
  })
}

/** The work itself, run by the detached process. Each part keeps its own throttle. */
export async function runHookMaintenance(options: {
  env: NodeJS.ProcessEnv
  now: number
  fetchImpl?: typeof fetch
}): Promise<{ pruned: number }> {
  const pruned = pruneAbandonedSessions(options.env)
  await refreshAgentUpdateState({
    env: options.env,
    now: options.now,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  return { pruned }
}
