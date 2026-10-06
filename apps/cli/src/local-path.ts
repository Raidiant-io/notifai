import { realpathSync } from 'node:fs'
import path from 'node:path'

/** Resolve an existing path through symlinks, or normalize the local spelling. */
export function canonicalPath(file: string): string {
  const absolute = path.resolve(file)
  let ancestor = absolute
  const suffix: string[] = []
  for (;;) {
    try {
      // Resolve the existing ancestor too: a not-yet-created destination must
      // keep its identity after creation under /var aliases or Windows 8.3 paths.
      return path.join(realpathSync.native(ancestor), ...suffix)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return absolute
      const parent = path.dirname(ancestor)
      if (parent === ancestor) return absolute
      suffix.unshift(path.basename(ancestor))
      ancestor = parent
    }
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
