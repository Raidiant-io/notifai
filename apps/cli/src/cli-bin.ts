import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import path from 'node:path'
import type { ReadinessState } from './readiness.js'
import { packageVersion } from './release.js'
import { cliUpdateRecoveryCommand } from './cli-contract.js'
import { canonicalPath, pathDirectories } from './local-path.js'

const POSIX_NAMES = ['notifai']
const WINDOWS_NAMES = ['notifai.cmd', 'notifai.exe', 'notifai']

export interface CliBinReadinessOptions {
  runningArtifactPath?: string
  currentVersion?: string | null
}

export interface CliPathEntry {
  command_path: string
  executable: boolean
  artifact_path: string | null
  version: string | null
  install_prefix: string | null
}

export interface CliInstallationInspection {
  current: { artifact_path: string; version: string | null }
  effective: CliPathEntry | null
  entries: CliPathEntry[]
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
      if (!existsSync(candidate)) continue
      if (!found.includes(candidate)) found.push(candidate)
    }
  }
  return found
}

export function isExecutablePath(file: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!existsSync(file)) return false
  if (platform === 'win32') return true
  try {
    const target = lstatSync(file).isSymbolicLink() ? realpathSync(file) : file
    accessSync(target, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function windowsShimArtifact(file: string): string | null {
  if (path.extname(file).toLowerCase() !== '.cmd') return null
  try {
    const source = readFileSync(file, 'utf8')
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
    return canonicalPath(file)
  } catch {
    return null
  }
}

function artifactVersion(artifact: string | null): string | null {
  if (artifact === null) return null
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(path.dirname(artifact), '..', 'package.json'), 'utf8'),
    )
    if (typeof parsed !== 'object' || parsed === null) return null
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

function installPrefix(artifact: string | null): string | null {
  if (artifact !== null) {
    const marker = /[\\/]lib[\\/]node_modules[\\/]@raidiant[\\/]notifai[\\/]/i.exec(artifact)
      ?? /[\\/]node_modules[\\/]@raidiant[\\/]notifai[\\/]/i.exec(artifact)
    if (marker?.index !== undefined) return artifact.slice(0, marker.index)
  }
  return null
}

export function inspectCliInstallations(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  options: CliBinReadinessOptions = {},
): CliInstallationInspection {
  const runningArtifact = canonicalPath(options.runningArtifactPath ?? process.argv[1] ?? 'notifai')
  const entries = pathNotifaiEntries(env, platform).map((command): CliPathEntry => {
    const artifact = artifactForCommand(command, platform)
    return {
      command_path: command,
      executable: isExecutablePath(command, platform),
      artifact_path: artifact,
      version: artifactVersion(artifact),
      install_prefix: installPrefix(artifact),
    }
  })
  return {
    current: {
      artifact_path: runningArtifact,
      version: options.currentVersion === undefined ? packageVersion() : options.currentVersion,
    },
    effective: entries.find((entry) => entry.executable) ?? null,
    entries,
  }
}

export function cliBinReadiness(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  options: CliBinReadinessOptions = {},
): ReadinessState {
  const inspection = inspectCliInstallations(env, platform, options)
  const { current, effective, entries } = inspection
  const updateCommand = cliUpdateRecoveryCommand()
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
      detail:
        'no `notifai` on PATH — this process runs, but a typed `notifai …` command will not be found',
      remedy: {
        by: 'user-here',
        summary: 'install notifai globally so the command is on your PATH',
        command: updateCommand,
      },
    }
  }

  const effectiveIsCurrent =
    effective.artifact_path === current.artifact_path ||
    (effective.version !== null && current.version !== null && effective.version === current.version)
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
