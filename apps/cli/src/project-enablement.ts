import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync, ensurePrivateDirectory } from './atomic-file.js'
import { withTargetFileLock } from './file-lock.js'
import { globalConfigDir, projectLocation, projectRepositoryAnchor } from './config.js'
import { inferInvocationContext } from './invocation-context.js'

interface ProjectEnablementMarker {
  version: 1
  project: string
  enabled: boolean
  updated_at: string
}

export interface ProjectBinding {
  project: string
  markerPath: string
  /** Folder registration renames preserve the decision for this root. */
  folder?: true
}

/**
 * The User's decision for one Project: `enabled` and `disabled` are recorded
 * decisions; `unset` is a Project the User never switched either way.
 */
export type ProjectEnablementState = 'enabled' | 'disabled' | 'unset'

/**
 * The Project name inferred for a folder: from its Project root (see
 * `projectLocation`), so a subdirectory is named like its checkout. Null when
 * the folder belongs to no Project or its root yields no usable name.
 */
export function inferredProjectName(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const location = projectLocation(cwd, env)
  return location === null ? null : location.name ?? inferInvocationContext(location.root, undefined, { branch: false }).project
}

/**
 * Resolve the User-owned enablement record for this exact local Project.
 *
 * Name and key both come from the one Project root `projectLocation` decides,
 * so a hook fired in a subdirectory reads the same decision `notifai project
 * enable` wrote at the root. The opaque key binds the Project id to the root's
 * Git common directory: linked worktrees share one decision, while another
 * checkout with the same name cannot borrow it. Outside Git the root itself is
 * the anchor. The home folder is never a Project, so it has no record.
 */
export function projectBinding(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  explicitProject?: string | null,
): ProjectBinding | null {
  const location = projectLocation(cwd, env)
  if (location === null) return null
  const project = explicitProject ?? location.name ?? inferInvocationContext(location.root, undefined, { branch: false }).project
  if (project === null) return null
  const key = createHash('sha256')
    .update('notifai-project-enablement-v1\0')
    .update(projectRepositoryAnchor(location))
    .update('\0')
    .update(location.name === undefined ? project : '')
    .digest('hex')
  return {
    project,
    markerPath: path.join(globalConfigDir(env), 'project-enablement', `${key}.json`),
    ...(location.name === undefined ? {} : { folder: true as const }),
  }
}

/** An unreadable record is no decision: `unset`. */
export function projectEnablementState(binding: ProjectBinding | null): ProjectEnablementState {
  if (binding === null || !existsSync(binding.markerPath)) return 'unset'
  try {
    const marker = JSON.parse(readFileSync(binding.markerPath, 'utf8')) as Partial<ProjectEnablementMarker>
    if (marker.version !== 1 || (!binding.folder && marker.project !== binding.project) || typeof marker.enabled !== 'boolean') return 'unset'
    return marker.enabled ? 'enabled' : 'disabled'
  } catch {
    return 'unset'
  }
}

export function projectEnabled(binding: ProjectBinding | null): boolean {
  return projectEnablementState(binding) === 'enabled'
}

/** The User switched Notifai off here: nothing from this Project reaches their devices. */
export function projectDisabled(binding: ProjectBinding | null): boolean {
  return projectEnablementState(binding) === 'disabled'
}

/**
 * Record that the User enabled this Project: `notifai project enable`, the
 * only way back from disabled.
 *
 * The record carries a decision, not a heartbeat, so a Project that is
 * already enabled is left untouched. A write, and any racing disable, is
 * serialized under the record's lock, so a sibling's write is never mistaken
 * for a foreign replacement by the atomic write's guard.
 */
export function enableProject(binding: ProjectBinding, now: Date = new Date()): void {
  if (projectEnabled(binding)) return
  withEnablementLock(binding, () => {
    if (projectEnabled(binding)) return
    writeMarker(binding, true, now)
  })
}

/**
 * An explicit request for Notifai in this Project (`send`, `ask`, `init`):
 * enable a Project with no record; never change the User's disable.
 *
 * Every send and ask reaches here, often from several Agent Sessions at the
 * same instant; once a decision is recorded they only read it.
 */
export function enableProjectUnlessDisabled(binding: ProjectBinding, now: Date = new Date()): 'enabled' | 'disabled' {
  return enableProjectNoting(binding, now).decision
}

/**
 * `enableProjectUnlessDisabled`, also saying whether this very call recorded
 * the Project's first decision. Only then is a Project newly set up: it is the
 * moment to ask the agent to name it (`projectNameNudge`), once.
 */
export function enableProjectNoting(
  binding: ProjectBinding,
  now: Date = new Date(),
): { decision: 'enabled' | 'disabled'; first: boolean } {
  const state = projectEnablementState(binding)
  if (state !== 'unset') return { decision: state, first: false }
  let decided: 'enabled' | 'disabled' = 'enabled'
  let first = false
  withEnablementLock(binding, () => {
    const current = projectEnablementState(binding)
    if (current !== 'unset') {
      decided = current
      return
    }
    writeMarker(binding, true, now)
    first = true
  })
  return { decision: decided, first }
}

/** "the-beacon" becomes "The Beacon": the suggestion offered to the agent, who runs or corrects it. */
export function suggestedProjectName(identifier: string): string {
  const words = identifier.split(/[-_.]+/).filter((word) => word.length > 0)
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || identifier
}

/**
 * The one line that asks the agent to name a newly set-up Project in one
 * command. A good name is the product's own name, one to three words in title
 * case, with no "Project" or "App" suffix. An icon is optional.
 */
export function projectNameNudge(project: string): string {
  const quoted = suggestedProjectName(project).replaceAll("'", "'\\''")
  return (
    `New Project "${project}" has no display name. Name it once, now, with one command: ` +
    `notifai project set --name '${quoted}' (the product's own name, 1-3 words in title case, no "Project" or "App" suffix; ` +
    'fix the suggestion if it is wrong). Add --icon <id> only if an icon obviously fits (`notifai project icons` lists them); ' +
    'never pick a colour or design an avatar. If the command reports a name already set, leave it.'
  )
}

/** Record that the User disabled this Project; only `enableProject` lifts it. */
export function disableProject(binding: ProjectBinding, now: Date = new Date()): void {
  if (projectDisabled(binding)) return
  withEnablementLock(binding, () => {
    if (projectDisabled(binding)) return
    writeMarker(binding, false, now)
  })
}

function writeMarker(binding: ProjectBinding, enabled: boolean, now: Date): void {
  const marker: ProjectEnablementMarker = {
    version: 1,
    project: binding.project,
    enabled,
    updated_at: now.toISOString(),
  }
  atomicWriteFileSync(binding.markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
    mode: 0o600,
    preserveMode: false,
    requireCurrentUserOwner: true,
    directoryMode: 0o700,
  })
}

function withEnablementLock(binding: ProjectBinding, action: () => void): void {
  ensurePrivateDirectory(path.dirname(binding.markerPath))
  withTargetFileLock(binding.markerPath, action)
}
