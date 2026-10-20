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
 * Mirrors the automatic integration resume exactly: it rewrites a Codex or
 * Claude Code hook file only when this build finds a fault in it beyond Claude
 * Code's hook form, so those files are the ones an activation would change.
 */
export function activationPlan(deps: CommandDeps): ActivationPlan {
  const changes: ActivationPlan['hook_changes'] = []
  for (const { installation } of integrationInstallations(deps)) {
    if (!TRUST_SENSITIVE_HOOK_HARNESSES.has(installation.harness)) continue
    // Claude Code's shell/exec form alone is not counted: that rewrite runs the
    // same handlers, is picked up live, and is never made while an older
    // attendant that reads only shell form runs (claude-form-readers).
    const reasons = installationFaults(installation, deps.hookPlatform)
    if (reasons.length > 0) changes.push({ harness: installation.harness, file: installation.file, reasons })
  }
  return { schema: 1, version: packageVersion(), hub_ipc_versions: { ...HUB_IPC_VERSIONS }, hook_changes: changes }
}
