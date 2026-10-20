import { createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync, ensurePrivateDirectory } from './atomic-file.js'
import { withTargetFileLock } from './file-lock.js'
import { globalConfigDir, projectLocation, projectRepositoryAnchor } from './config.js'
import { inferInvocationContext } from './invocation-context.js'

interface ProjectEnablementMarker {
  version: 1
  project: string
  enabled: true
  updated_at: string
}

export interface ProjectBinding {
  project: string
  markerPath: string
}

/**
 * The Project name inferred for a folder: from its Project root (see
 * `projectLocation`), so a submodule or nested checkout inside a configured
 * repository is named like the repository it belongs to. Null when the folder
 * belongs to no Project or its root yields no usable name.
 */
export function inferredProjectName(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const location = projectLocation(cwd, env)
  return location === null ? null : inferInvocationContext(location.root, undefined, { branch: false }).project
}

/**
 * Resolve the User-owned enablement record for this exact local Project.
 *
 * Name and key both come from the one Project root `projectLocation` decides,
 * so a hook fired in a subdirectory, a submodule or a worktree's submodule
 * reads the same decision `notifai project enable` wrote at the root. The
 * opaque key binds the Project id to the root's Git common directory: linked
 * worktrees share one decision, while another checkout cannot borrow it
 * merely by committing the same Project id. Outside Git the root itself is
 * the anchor. The home folder is never a Project, so it has no record.
 */
export function projectBinding(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  explicitProject?: string | null,
): ProjectBinding | null {
  const location = projectLocation(cwd, env)
  if (location === null) return null
  const project = explicitProject ?? inferInvocationContext(location.root, undefined, { branch: false }).project
  if (project === null) return null
  const key = createHash('sha256')
    .update('notifai-project-enablement-v1\0')
    .update(projectRepositoryAnchor(location))
    .update('\0')
    .update(project)
    .digest('hex')
  return {
    project,
    markerPath: path.join(globalConfigDir(env), 'project-enablement', `${key}.json`),
  }
}

export function projectEnabled(binding: ProjectBinding | null): boolean {
  if (binding === null || !existsSync(binding.markerPath)) return false
  try {
    const marker = JSON.parse(readFileSync(binding.markerPath, 'utf8')) as Partial<ProjectEnablementMarker>
    return marker.version === 1 && marker.enabled === true && marker.project === binding.project
  } catch {
    return false
  }
}

/**
 * Record that the User enabled this Project.
 *
 * Every send and ask in an enabled Project reaches here, often from several
 * Agent Sessions at the same instant. The record carries a decision, not a
 * heartbeat, so a Project that is already enabled is left untouched: concurrent
 * senders then only read it. The first enablement, and any racing disable, is
 * serialized under the record's lock, so a sibling's write is never mistaken
 * for a foreign replacement by the atomic write's guard.
 */
export function enableProject(binding: ProjectBinding, now: Date = new Date()): void {
  if (projectEnabled(binding)) return
  withEnablementLock(binding, () => {
    if (projectEnabled(binding)) return
    const marker: ProjectEnablementMarker = {
      version: 1,
      project: binding.project,
      enabled: true,
      updated_at: now.toISOString(),
    }
    atomicWriteFileSync(binding.markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
      mode: 0o600,
      preserveMode: false,
      requireCurrentUserOwner: true,
      directoryMode: 0o700,
    })
  })
}

export function disableProject(binding: ProjectBinding): void {
  if (!existsSync(binding.markerPath)) return
  withEnablementLock(binding, () => {
    try {
      unlinkSync(binding.markerPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  })
}

function withEnablementLock(binding: ProjectBinding, action: () => void): void {
  ensurePrivateDirectory(path.dirname(binding.markerPath))
  withTargetFileLock(binding.markerPath, action)
}
