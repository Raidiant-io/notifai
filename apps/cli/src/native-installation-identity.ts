import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { activeRecord, activeBytes } from './installation.js'
import { isSemVer } from './version.js'

function localRecord(file: string): Record<string, unknown> {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ||
      (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) {
    throw new Error('Native installation identity is not a private regular record')
  }
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native installation identity')
  return value as Record<string, unknown>
}

/** Read-only LOCAL identity for readiness and command generation. Installation
 * authenticates signed releases; the native launcher admits executable paths.
 * This bounded metadata read grants neither execution nor mutation authority. */
export function nativeInstallationIdentity(home: string, windows = process.platform === 'win32') {
  const root = path.join(home, '.notifai'), extension = windows ? '.exe' : ''
  const checkDirectory = (directory: string) => {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' &&
        (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) throw new Error('Unsafe native installation directory')
  }
  checkDirectory(root)
  const installation = localRecord(path.join(root, 'install.json'))
  const active = activeRecord(localRecord(path.join(root, 'active.json')))
  if (readFileSync(path.join(root, 'active.json'), 'utf8') !== activeBytes(active)) throw new Error('Native active generation needs repair')
  for (const directory of ['bin', 'versions', path.join('versions', active.active)]) checkDirectory(path.join(root, directory))
  if (installation['schema'] !== 1 || installation['owner'] !== 'notifai' ||
      typeof installation['id'] !== 'string' || !/^[a-f0-9-]{36}$/.test(installation['id'])) throw new Error('Invalid native installation identity')
  const envelope = localRecord(path.join(root, 'versions', active['active'], 'inventory.json'))
  if (typeof envelope['payload'] !== 'string') throw new Error('Native release inventory is unavailable')
  const inventory = JSON.parse(Buffer.from(envelope['payload'], 'base64').toString('utf8')) as Record<string, unknown>
  if (typeof inventory['version'] !== 'string' || !isSemVer(inventory['version'])) throw new Error('Native release version is unavailable')
  return { command: path.join(root, 'bin', `notifai${extension}`),
    runtime: path.join(root, 'versions', active['active'], `notifai-runtime${extension}`),
    version: inventory['version'], build: active['active'], installationId: installation['id'],
    source_revision: typeof inventory['source_revision'] === 'string' ? inventory['source_revision'] : null,
    channel: installation['channel'] ?? null, source: installation['source'] ?? null,
    launcher_update_pending: installation['launcherUpdatePending'] === true }
}
