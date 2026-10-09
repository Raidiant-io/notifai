import { buildIdentity, Distribution } from './distribution.js'
import { RELEASE_PUBLIC_KEYS } from './release-trust.js'
import { NPM_ADAPTER_BIN, NPM_ADAPTER_MANIFEST } from './npm-adapter-contract.js'
import { verifyNpmAdapterArtifact, type NpmAdapterAccessCheck } from './npm-adapter-verification.js'
import { inspectNpmAdapterRoute, environmentForVerifiedAdapter, type NpmAdapterRoute } from './npm-adapter-route.js'
import { npmAdapterWindowsAccess } from './installation-access.js'
import { nativeInstallationIdentity } from './native-installation-identity.js'
import { accountHome } from './platform.js'
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs'
import path from 'node:path'
import type { ReadinessState } from './readiness.js'
import { packageVersion } from './release.js'
import { cliUpdateChannel, cliUpdateRecoveryCommand } from './cli-contract.js'
import { canonicalPath, pathDirectories, sameLocalPath } from './local-path.js'

const POSIX_NAMES = ['notifai']
const WINDOWS_NAMES = ['notifai.exe', 'notifai.cmd', 'notifai.ps1', 'notifai']

export interface CliBinReadinessOptions {
  runningArtifactPath?: string
  currentVersion?: string | null
  nativeHome?: string | undefined
  distribution?: Pick<Distribution, 'verifyInventory'>
  checkAccess?: NpmAdapterAccessCheck
  invokingNpmAdapterArtifact?: string | undefined
}

export interface CliPathEntry {
  command_path: string
  executable: boolean
  artifact_path: string | null
  version: string | null
  install_prefix: string | null
  kind: 'native' | 'npm-adapter' | 'legacy-node' | 'dangling' | 'unknown'
  adapter?: { version: string; source_revision: string; directory: string; route: NpmAdapterRoute }
  problem?: string
}

export interface CliInstallationInspection {
  current: { artifact_path: string; version: string | null }
  effective: CliPathEntry | null
  entries: CliPathEntry[]
  native: ReturnType<typeof nativeInstallationIdentity> | null
  transaction: { install_pending: boolean; uninstall_pending: boolean }
  update_owner: 'native' | null
  invoking_adapter: { artifact_path: string; version: string; source_revision: string } | null
}

export function consumeNpmAdapterLocator(env: NodeJS.ProcessEnv): string | undefined {
  const locator = env['NOTIFAI_NPM_ADAPTER_ARTIFACT']
  delete env['NOTIFAI_NPM_ADAPTER_ARTIFACT']
  return locator && locator.length <= 4096 && path.isAbsolute(locator) ? locator : undefined
}

/** Lifecycle advice always names the durable native owner, never PATH. */
export function nativeLifecycleCommand(command: string, args: readonly string[], platform: NodeJS.Platform): string {
  const quote = (value: string) => `'${value.replaceAll("'", platform === 'win32' ? "''" : "'\\''")}'`
  return `${platform === 'win32' ? '& ' : ''}${quote(command)} ${args.map(arg => /^[A-Za-z0-9@/_.=-]+$/.test(arg) ? arg : quote(arg)).join(' ')}`
}

/** npm exec prepends its own temporary .bin; it is not the user's installed CLI. */
export function withoutNpxLauncherPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  runningArtifact: string,
): NodeJS.ProcessEnv {
  const artifact = canonicalPath(runningArtifact)
  const modules = path.dirname(path.dirname(path.dirname(path.dirname(artifact))))
  const cacheEntry = path.dirname(modules)
  if (path.basename(path.dirname(cacheEntry)) !== '_npx' ||
      !sameLocalPath(artifact, path.join(modules, '@raidiant', 'notifai', 'dist', 'main.js'), platform) ||
      path.basename(modules) !== 'node_modules') return env
  const launcher = path.join(modules, '.bin')
  const key = platform === 'win32' && env['Path'] !== undefined ? 'Path' : 'PATH'
  const directories = pathDirectories(env, platform)
  const retained = directories.filter(directory => !sameLocalPath(directory, launcher, platform))
  const next = { ...env }
  const value = retained.join(platform === 'win32' ? ';' : ':')
  // Node's Windows child environment deduplicates case-insensitive keys. Keep
  // every spelling coherent so an inherited PATH cannot defeat the new Path.
  const keys = platform === 'win32' ? Object.keys(env).filter(name => name.toLowerCase() === 'path') : [key]
  if (keys.every(name => env[name] === value)) return env
  for (const name of keys) next[name] = value
  return next
}

export function pathNotifaiEntries(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const names = platform === 'win32' ? WINDOWS_NAMES : POSIX_NAMES
  const found: string[] = []
  for (const directory of pathDirectories(env, platform)) {
    for (const name of names) {
      const candidate = path.join(directory, name)
      // A dangling npm symlink is still installation evidence after an
      // interrupted upgrade. Keep its destination available to local repair.
      try {
        lstatSync(candidate)
      } catch {
        continue
      }
      if (!found.includes(candidate)) found.push(candidate)
    }
  }
  return found
}

export function isExecutablePath(file: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!existsSync(file)) return false
  try {
    const target = lstatSync(file).isSymbolicLink() ? realpathSync(file) : file
    if (!lstatSync(target).isFile()) return false
    if (platform === 'win32') return true
    accessSync(target, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function windowsShimArtifact(file: string): string | null {
  const extension = path.extname(file).toLowerCase()
  if (!['.cmd', '.ps1'].includes(extension)) return null
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) return null
    const source = readFileSync(file, 'utf8')
    if (extension === '.ps1') {
      const match = /\$basedir[\\/](node_modules[\\/]@raidiant[\\/]notifai[\\/]dist[\\/]main\.js)/i.exec(source)
      return match?.[1] ? canonicalPath(path.join(path.dirname(file), match[1].replaceAll('\\', path.sep))) : null
    }
    const match = /(?:%dp0%|%~dp0)?([^"\r\n]*node_modules[\\/]@raidiant[\\/]notifai[\\/]dist[\\/]main\.js)/i.exec(source)
    if (match?.[0] === undefined) return null
    const expanded = match[0]
      .replace(/^%~?dp0%/i, `${path.dirname(file)}${path.sep}`)
      .replaceAll('\\', path.sep)
    return canonicalPath(expanded)
  } catch {
    return null
  }
}

function artifactForCommand(file: string, platform: NodeJS.Platform): string | null {
  const shim = platform === 'win32' ? windowsShimArtifact(file) : null
  if (shim !== null) return shim
  try {
    if (lstatSync(file).isSymbolicLink()) {
      return canonicalPath(path.resolve(path.dirname(file), readlinkSync(file)))
    }
    return canonicalPath(file)
  } catch {
    return null
  }
}

function artifactVersion(artifact: string | null): string | null {
  if (artifact === null) return null
  try {
    const file = path.join(path.dirname(artifact), '..', 'package.json'), stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return null
    const parsed: unknown = JSON.parse(
      readFileSync(file, 'utf8'),
    )
    if (typeof parsed !== 'object' || parsed === null) return null
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

function installPrefix(artifact: string | null, command: string, platform: NodeJS.Platform): string | null {
  if (artifact === null) return null
  // Only an npm-global layout is writable through npm --global --prefix.
  // A local dependency or pnpm store path also contains node_modules, but
  // treating its parent as a global prefix writes an unrelated installation.
  const suffix = path.sep + path.join(
    ...(platform === 'win32' ? [] : ['lib']),
    'node_modules', '@raidiant', 'notifai', 'dist', 'main.js',
  )
  const normalized = platform === 'win32' ? artifact.toLowerCase() : artifact
  if (!normalized.endsWith(suffix)) return null
  const prefix = canonicalPath(artifact.slice(0, -suffix.length))
  const bin = platform === 'win32' ? prefix : path.join(prefix, 'bin')
  return sameLocalPath(path.dirname(command), bin, platform) ? prefix : null
}

export function inspectCliInstallations(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  options: CliBinReadinessOptions = {},
): CliInstallationInspection {
  const runningArtifact = canonicalPath(options.runningArtifactPath ?? (buildIdentity() !== null ? process.execPath : process.argv[1]) ?? 'notifai')
  const home = options.nativeHome ?? accountHome(env, platform), root = path.join(home, '.notifai')
  let native: ReturnType<typeof nativeInstallationIdentity> | null = null
  try { native = nativeInstallationIdentity(home, platform === 'win32') } catch { /* Missing identity never establishes native ownership. */ }
  const distribution = options.distribution ?? new Distribution(RELEASE_PUBLIC_KEYS)
  const unverifiedAdapters = new Set<string>()
  const checkAccess = options.checkAccess ?? (platform === 'win32'
    ? (buildIdentity() !== null && process.platform === 'win32' ? npmAdapterWindowsAccess() : () => { throw new Error('Windows ownership proof is unavailable') })
    : undefined)
  const proofFor = (command: string, artifact: string | null) => {
    const bin = path.dirname(command)
    const candidates = new Set([
      ...(artifact === null ? [] : [path.dirname(path.dirname(artifact))]),
      path.join(bin, 'node_modules', '@raidiant', 'notifai'),
      path.join(path.dirname(bin), 'lib', 'node_modules', '@raidiant', 'notifai'),
      path.join(path.dirname(bin), '@raidiant', 'notifai'),
    ])
    for (const directory of candidates) {
      if (!existsSync(path.join(directory, NPM_ADAPTER_MANIFEST)) && !existsSync(path.join(directory, NPM_ADAPTER_BIN))) continue
      unverifiedAdapters.add(command)
      try {
        const proof = verifyNpmAdapterArtifact(directory, distribution, checkAccess)
        const route = inspectNpmAdapterRoute(command, proof, { platform, ...(checkAccess ? { checkAccess } : {}) })
        if (route) return { proof, route }
      } catch { /* A marker only identifies a candidate, never grants trust. */ }
    }
    return null
  }
  const runningProof = proofFor(runningArtifact, runningArtifact)
  const invokingProof = options.invokingNpmAdapterArtifact && path.isAbsolute(options.invokingNpmAdapterArtifact)
    ? proofFor(options.invokingNpmAdapterArtifact, options.invokingNpmAdapterArtifact) : null
  const launcherProof = runningProof ?? invokingProof
  const inspectedEnv = launcherProof ? environmentForVerifiedAdapter(launcherProof.proof, env, { platform, ...(checkAccess ? { checkAccess } : {}) })
    : buildIdentity() === null ? withoutNpxLauncherPath(env, platform, runningArtifact) : env
  const entries = pathNotifaiEntries(inspectedEnv, platform).map((command): CliPathEntry => {
    // The stable command itself, or the installer's link to it in the User command directory.
    const managed = native !== null && existsSync(native.command) && lstatSync(native.command).isFile() && !lstatSync(native.command).isSymbolicLink() &&
      sameLocalPath(canonicalPath(command), canonicalPath(native.command), platform)
    const artifact = managed ? native!.runtime : artifactForCommand(command, platform)
    const adapter = managed ? null : proofFor(command, artifact)
    const prefix = installPrefix(artifact, command, platform)
    return {
      command_path: command,
      executable: isExecutablePath(command, platform),
      artifact_path: adapter ? native?.runtime ?? null : artifact,
      version: managed || adapter ? native?.version ?? null : artifactVersion(artifact),
      install_prefix: adapter ? adapter.route.global_prefix : prefix,
      kind: managed ? 'native' : adapter ? 'npm-adapter' : !existsSync(command) ? 'dangling' : prefix !== null ? 'legacy-node' : 'unknown',
      ...(adapter ? { adapter: { version: adapter.proof.manifest.adapter_version,
        source_revision: adapter.proof.manifest.native.source_revision, directory: adapter.proof.directory, route: adapter.route } } : {}),
      ...(!adapter && unverifiedAdapters.has(command) ? { problem: 'npm adapter release, payload or command ownership could not be verified' } : {}),
    }
  })
  return {
    current: {
      artifact_path: runningArtifact,
      version: options.currentVersion === undefined ? packageVersion() : options.currentVersion,
    },
    effective: entries.find((entry) => entry.executable) ?? null,
    entries,
    native,
    transaction: { install_pending: localPathPresent(path.join(root, 'transaction.json')), uninstall_pending: localPathPresent(path.join(root, 'uninstall.json')) },
    update_owner: native === null ? null : 'native',
    invoking_adapter: invokingProof ? { artifact_path: invokingProof.proof.executable,
      version: invokingProof.proof.manifest.adapter_version, source_revision: invokingProof.proof.manifest.native.source_revision } : null,
  }
}

function localPathPresent(file: string): boolean {
  try { lstatSync(file); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
}

export function cliBinReadiness(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  options: CliBinReadinessOptions = {},
): ReadinessState {
  const inspection = inspectCliInstallations(env, platform, options)
  const { current, effective, entries } = inspection
  const updateCommand = inspection.native ? nativeLifecycleCommand(inspection.native.command, ['doctor', '--json'], platform)
    : buildIdentity() === null ? cliUpdateRecoveryCommand(cliUpdateChannel(current.version)) : 'notifai init'
  if (inspection.transaction.uninstall_pending || inspection.transaction.install_pending) return {
    id: 'cli-bin', title: 'notifai command', status: 'gap', technical: inspection,
    detail: inspection.transaction.uninstall_pending ? 'uninstall is pending; installation and ordinary work remain paused' : 'installation recovery is pending',
    remedy: { by: 'user-here', summary: inspection.transaction.uninstall_pending ? 'finish the pending uninstall, or explicitly cancel it' : 'repair the pending installation',
      command: inspection.native ? nativeLifecycleCommand(inspection.native.command,
        inspection.transaction.uninstall_pending ? ['uninstall', '--json'] : ['update', '--repair', '--json'], platform) : updateCommand },
  }
  if (effective === null && entries.length > 0) {
    return {
      id: 'cli-bin',
      title: 'notifai command',
      status: 'gap',
      detail: 'the notifai command is on PATH but cannot run',
      technical: inspection,
      remedy: {
        by: 'user-here',
        summary: 'repair the global notifai command so it can run',
        command: updateCommand,
      },
    }
  }
  // A global install that landed outside PATH used to report `ready` with
  // "this process can run" — which is true of the running process and false of
  // every instruction it goes on to print. Hooks embed absolute paths, so
  // nothing visibly breaks until the reader types `notifai` themselves.
  //
  // Not a blocker: this process is already running, so the whole setup —
  // pairing, the app, the delivery proof — still completes. It is the later
  // `notifai …` lines that will not be found, and saying so is the fix.
  if (effective === null) {
    return {
      id: 'cli-bin',
      title: 'notifai command',
      status: 'optional-gap',
      technical: inspection,
      detail:
        'no `notifai` on PATH — this process runs, but a typed `notifai …` command will not be found',
      remedy: {
        by: 'user-here',
        summary: inspection.native ? 'use the installed command and open a shell with its command directory on PATH' : 'install notifai globally so the command is on your PATH',
        command: updateCommand,
      },
    }
  }

  const effectiveIsCurrent = effective.artifact_path !== null && sameLocalPath(effective.artifact_path, current.artifact_path, platform)
  if (!effectiveIsCurrent) {
    return {
      id: 'cli-bin',
      title: 'notifai command',
      status: 'gap',
      detail: 'the notifai command resolves to a different installation than this current CLI',
      technical: inspection,
      remedy: {
        by: 'user-here',
        summary: 'update the notifai command that wins PATH',
        command: updateCommand,
      },
    }
  }

  const duplicateNeedsCleanup = entries.some(
    (entry) =>
      entry !== effective &&
      (!entry.executable || entry.artifact_path !== effective.artifact_path),
  )
  if (duplicateNeedsCleanup) {
    return {
      id: 'cli-bin',
      title: 'notifai command',
      status: 'optional-gap',
      detail: 'the notifai command is ready; another installation remains for cleanup',
      technical: inspection,
    }
  }
  return {
    id: 'cli-bin',
    title: 'notifai command',
    status: 'ready',
    detail: 'the notifai command is ready',
    technical: inspection,
  }
}
