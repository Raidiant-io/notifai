import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { inspectCliInstallations, type CliPathEntry, type CliBinReadinessOptions } from './cli-bin.js'
import { canonicalPath, sameLocalPath } from './local-path.js'

export interface LegacyNpmMigration {
  status: 'migration_pending_legacy_owners'
  prefix: string
  artifact: string
  version: string
  command_paths: string[]
  cleanup: { package_manager: 'npm'; args: string[]; requires: string }
}

/** Read-only identification of one exact npm-global layout. This is never
 * process-absence evidence and never authorizes deleting the old package. */
export function legacyNpmMigration(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, stable: string, options: CliBinReadinessOptions = {}):
  { collisions: CliPathEntry[]; migration: LegacyNpmMigration | null } {
  const collisions = inspectCliInstallations(env, platform, options).entries.filter(entry =>
    entry.kind !== 'npm-adapter' && !sameLocalPath(canonicalPath(entry.command_path), canonicalPath(stable), platform))
  const known = collisions.filter(entry => entry.install_prefix !== null && entry.artifact_path !== null)
  if (!known.length) return { collisions, migration: null }
  const first = known[0]!, prefix = first.install_prefix!, artifact = first.artifact_path!
  const bin = platform === 'win32' ? prefix : path.join(prefix, 'bin')
  try {
    if (known.some(entry => !sameLocalPath(entry.install_prefix!, prefix, platform) || !sameLocalPath(entry.artifact_path!, artifact, platform))) throw new Error('Several npm installations')
    for (const entry of collisions) {
      if (!sameLocalPath(canonicalPath(path.dirname(entry.command_path)), canonicalPath(bin), platform)) throw new Error('Unrecognized installation')
      if (sameLocalPath(entry.artifact_path ?? '', artifact, platform)) continue
      // npm on Windows also emits a POSIX shell shim alongside notifai.cmd.
      // Recognize its literal package target, never execute or remove the shim.
      if (platform !== 'win32' || path.basename(entry.command_path) !== 'notifai' || lstatSync(entry.command_path).size > 16 * 1024 ||
          !readFileSync(entry.command_path, 'utf8').includes('/node_modules/@raidiant/notifai/dist/main.js')) throw new Error('Unrecognized shim')
    }
    const manifestFile = path.join(path.dirname(artifact), '..', 'package.json'), stat = lstatSync(manifestFile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Unowned package manifest')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    if (manifest.name !== '@raidiant/notifai' || manifest.bin?.notifai !== 'dist/main.js' || typeof manifest.version !== 'string') throw new Error('Unrecognized npm package')
    return { collisions, migration: { status: 'migration_pending_legacy_owners', prefix, artifact, version: manifest.version,
      command_paths: collisions.map(entry => entry.command_path), cleanup: { package_manager: 'npm',
        args: ['uninstall', '--global', '--prefix', prefix, '@raidiant/notifai'],
        requires: 'Finish outstanding questions, answers and acknowledgements, then stop every harness and other program using the old CLI. Use the npm installation that owns this prefix. Native setup never deletes legacy package files.' } } }
  } catch { return { collisions, migration: null } }
}
