import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import path from 'node:path'
import { ensurePrivateDirectory } from './atomic-file.js'

/** Installation-only adapter. Native launch checks use the same C policy
 * directly, without starting PowerShell or another process on the hook path. */
export interface InstallationAccess {
  check(file: string, directory: boolean): void
  checkState?(file: string, directory: boolean): void
  directory(file: string): void
  beforePublish(file: string): void
  protectExistingDirectory(file: string): void
}
export function installationAccess(launcher = path.join(path.dirname(process.execPath), 'notifai.exe')): InstallationAccess {
  if (process.platform !== 'win32') return {
    check(file) { if ((lstatSync(file).mode & 0o022) !== 0) throw new Error('Installation path allows another user to write') },
    directory: ensurePrivateDirectory, beforePublish() {},
    protectExistingDirectory(file) { if ((lstatSync(file).mode & 0o022) !== 0) throw new Error('Installation path allows another user to write') },
  }
  const run = (operation: string, file: string) => {
    execFileSync(launcher, [operation, file], { windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
  }
  return {
    check(file, directory) { run(directory ? '--internal-check-private-directory' : '--internal-check-private-file', file) },
    checkState(file, directory) { run(directory ? '--internal-check-state-directory' : '--internal-check-state-file', file) },
    directory(file) {
      const missing: string[] = []
      let current = file
      for (;;) {
        try { lstatSync(current); break } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          missing.push(current)
          const parent = path.dirname(current)
          if (parent === current) throw new Error('Installation directory has no existing parent')
          current = parent
        }
      }
      for (const directory of missing.reverse()) run('--internal-private-directory', directory)
      run('--internal-check-private-directory', file)
    },
    // An elevated token can assign Administrators as a new file's default
    // owner. Normalize our private temporary file BEFORE atomic publication.
    beforePublish(file) { run('--internal-own-created-file', file) },
    protectExistingDirectory(file) { run('--internal-protect-existing-directory', file) },
  }
}

/** npm owns these paths. Inspect inherited ACLs without changing them or
 * requiring the protected ACLs used for Notifai-managed installation paths. */
export function npmAdapterWindowsAccess(launcher = path.join(path.dirname(process.execPath), 'notifai.exe')) {
  return (file: string, directory: boolean): void => {
    if (process.platform !== 'win32') throw new Error('Windows ownership proof is unavailable')
    execFileSync(launcher, [directory ? '--internal-check-package-directory' : '--internal-check-package-file', file],
      { windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
  }
}
