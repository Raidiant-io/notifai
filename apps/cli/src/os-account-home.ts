import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { buildIdentity } from './distribution.js'

let nativeHome: string | undefined

/** Shared wiring belongs to the OS account, not an inherited HOME override.
 * Bun's os.userInfo().homedir follows HOME, unlike Node's implementation.
 * The sibling launcher reads the POSIX account record / Windows token profile.
 * Failure must not fall back to the environment-derived runtime value. */
export function osAccountHome(): string {
  if (buildIdentity() === null) return os.userInfo().homedir
  if (nativeHome !== undefined) return nativeHome
  const launcher = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'notifai.exe' : 'notifai')
  const output = execFileSync(launcher, ['--internal-account-home'], {
    encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 128 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const home = output.replace(/\r?\n$/, '')
  if (!path.isAbsolute(home) || /[\0\r\n]/.test(home)) throw new Error('Cannot establish this OS account home')
  nativeHome = home
  return home
}
