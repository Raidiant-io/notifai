import { realpathSync } from 'node:fs'
import path from 'node:path'

/** Resolve an existing path through symlinks, or normalize the local spelling. */
export function canonicalPath(file: string): string {
  try {
    // The JS fallback can retain Windows 8.3 aliases (RUNNER~1) while the OS
    // reports the same executable by its long name. Compare canonical OS paths.
    return realpathSync.native(file)
  } catch {
    return path.resolve(file)
  }
}

/** Filesystem identity comparison, including Windows' case-insensitivity. */
export function sameLocalPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const a = canonicalPath(left)
  const b = canonicalPath(right)
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** PATH directories in shell resolution order for the selected host. */
export function pathDirectories(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const raw =
    platform === 'win32' ? (env['Path'] ?? env['PATH'] ?? '') : (env['PATH'] ?? '')
  const delimiter = platform === 'win32' ? ';' : ':'
  return raw.split(delimiter).filter((directory) => directory !== '')
}

export function pathContainsDirectory(
  env: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return pathDirectories(env, platform).some((entry) =>
    sameLocalPath(entry, directory, platform),
  )
}
