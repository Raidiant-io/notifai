import { lstatSync } from 'node:fs'
import path from 'node:path'
import { accountHome } from './platform.js'
import { buildIdentity } from './distribution.js'

/** Presence closes admission even when an interrupted journal is malformed.
 * The installation authority owns recovery; ordinary work cannot bypass it.
 * This is one metadata read, with no process lease or installation lock. */
export function nativeUninstallPending(env: NodeJS.ProcessEnv): boolean {
  if (buildIdentity() === null) return false
  try { lstatSync(path.join(accountHome(env), '.notifai', 'uninstall.json')); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
}

export function assertNativeLaunchAllowed(env: NodeJS.ProcessEnv): void {
  if (nativeUninstallPending(env)) throw new Error('Notifai uninstall is in progress. Finish or recover the uninstall before starting more work.')
}
