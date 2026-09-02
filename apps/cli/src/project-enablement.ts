import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { globalConfigDir } from './config.js'
import { inferInvocationContext } from './invocation-context.js'
import { canonicalPath } from './local-path.js'

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

function gitCommonDirectory(cwd: string): string | null {
  try {
    const raw = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
      windowsHide: true,
    }).trim()
    if (raw === '') return null
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
    return canonicalPath(resolved)
  } catch {
    return null
  }
}

/**
 * Resolve the User-owned enablement record for this exact local Project.
 *
 * The opaque key binds the semantic Project id to Git's shared common
 * directory. Linked worktrees therefore share one decision, while another
 * checkout cannot borrow it merely by committing the same Project id.
 */
export function projectBinding(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  explicitProject?: string | null,
): ProjectBinding | null {
  const project = explicitProject ?? inferInvocationContext(cwd).project
  if (project === null) return null
  const repository = gitCommonDirectory(cwd) ?? path.resolve(cwd)
  const key = createHash('sha256')
    .update('notifai-project-enablement-v1\0')
    .update(repository)
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

export function enableProject(binding: ProjectBinding, now: Date = new Date()): void {
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
}

export function disableProject(binding: ProjectBinding): void {
  try {
    unlinkSync(binding.markerPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
