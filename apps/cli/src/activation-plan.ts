/**
 * What activating this build would change, asked of the build itself before it
 * becomes active. The automatic updater runs it from the staged, not yet
 * active, immutable version directory. Read-only: no file, host or service
 * changes.
 */
import type { CommandDeps } from './commands-core.js'
import { HUB_IPC_VERSIONS } from './hub-ipc.js'
import { installationFaults, integrationInstallations } from './integration-health.js'
import { packageVersion } from './release.js'

/**
 * Harnesses whose hook definitions an automatic update must never rewrite:
 * Codex skips a changed hook until the User trusts it again in `/hooks`, and
 * Claude Code applies a settings change to its running sessions at once.
 */
export const TRUST_SENSITIVE_HOOK_HARNESSES: ReadonlySet<string> = new Set(['codex', 'claude-code'])

export interface ActivationPlan {
  schema: 1
  version: string | null
  /** The session-child IPC versions this build's hub serves. */
  hub_ipc_versions: { min: number; max: number }
  /** Hook files this build's integration resume would rewrite, and why. */
  hook_changes: { harness: string; file: string; reasons: string[] }[]
}

/**
 * Mirrors the integration resume exactly: resume rewrites a harness's hook
 * file only when this build finds a fault in it, so those files are the ones
 * whose bytes an activation would change.
 */
export function activationPlan(deps: CommandDeps): ActivationPlan {
  const changes: ActivationPlan['hook_changes'] = []
  for (const { installation, env } of integrationInstallations(deps)) {
    if (!TRUST_SENSITIVE_HOOK_HARNESSES.has(installation.harness)) continue
    const reasons = installationFaults(installation, deps.hookPlatform, { ...deps, env })
    if (reasons.length > 0) changes.push({ harness: installation.harness, file: installation.file, reasons })
  }
  return { schema: 1, version: packageVersion(), hub_ipc_versions: { ...HUB_IPC_VERSIONS }, hook_changes: changes }
}
