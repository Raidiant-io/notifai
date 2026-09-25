import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  inspectCliInstallations,
  withoutNpxLauncherPath,
  type CliInstallationInspection,
} from './cli-bin.js'
import { EXIT, type CommandDeps } from './commands-core.js'
import {
  hookAdapterPath,
  installHookAdapter,
  inspectHookAdapter,
  isNpxAdapterTarget,
} from './hook-adapter.js'
import { packageVersion } from './release.js'
import {
  CLI_PACKAGE_NAME,
  cliPackageSpec,
  cliUpdateChannel,
  cliUpdateRecoveryCommand,
  type CliUpdateChannel,
} from './cli-contract.js'
import { cliReleaseTarget, parseCliDistTags, type CliReleaseTarget } from './cli-release.js'
import { pathContainsDirectory } from './local-path.js'
import { npmInvocation } from './npm-invocation.js'
import { compareReleasePrecedence } from './version.js'

export interface CliUpdateFlags {
  json?: boolean
  channel?: string
}

function runningArtifact(deps: CommandDeps): string | undefined {
  const target = deps.hookInstallTarget
  if (target !== undefined && !isNpxAdapterTarget(target)) return target.scriptPath
  return process.argv[1]
}

function npmRun(
  deps: CommandDeps,
  args: readonly string[],
): ReturnType<typeof spawnSync> {
  const invocation = npmInvocation(args, {
    platform: deps.hookPlatform ?? process.platform,
    env: deps.env,
    nodeExecutable: process.execPath,
  })
  return spawnSync(invocation.file, invocation.args, {
    ...invocation.options,
    encoding: 'utf8',
    env: deps.env,
    cwd: deps.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    killSignal: 'SIGKILL',
  })
}

function inspection(deps: CommandDeps): CliInstallationInspection {
  const artifact = runningArtifact(deps)
  return inspectCliInstallations(
    deps.env,
    deps.hookPlatform ?? process.platform,
    {
      ...(artifact === undefined ? {} : { runningArtifactPath: artifact }),
      currentVersion: packageVersion(),
    },
  )
}

function prefixIsAddressable(deps: CommandDeps, prefix: string): boolean {
  const platform = deps.hookPlatform ?? process.platform
  const commandDirectory = platform === 'win32' ? prefix : path.join(prefix, 'bin')
  return pathContainsDirectory(deps.env, commandDirectory, platform)
}

/**
 * Read the dist-tags from the registry npm itself installs from, so a custom
 * registry configuration answers for both the read and the install.
 */
function publishedDistTags(deps: CommandDeps) {
  const view = npmRun(deps, ['view', CLI_PACKAGE_NAME, 'dist-tags', '--json'])
  if (view.status !== 0 || typeof view.stdout !== 'string') return null
  try {
    return parseCliDistTags(JSON.parse(view.stdout))
  } catch {
    return null
  }
}

interface UpdateFailure {
  code: string
  /** Replaces the generic retry advice; the recovery is then a diagnostic unless given. */
  message?: string
  recoveryCommand?: string
  target?: CliReleaseTarget
}

function failed(
  deps: CommandDeps,
  flags: CliUpdateFlags & { channel: CliUpdateChannel },
  failure: UpdateFailure | string,
  before: CliInstallationInspection,
  packageManagerPrefix: string | null,
): number {
  const { code, message, recoveryCommand: explicitRecovery, target } =
    typeof failure === 'string' ? { code: failure } as UpdateFailure : failure
  const recoveryMessage = message ?? (code === 'update_destination_unknown'
    ? 'Notifai could not identify an npm-global installation to update. Use the package manager that installed the resolved command to update it; the diagnostic below can inspect the installation.'
    : code === 'package_manager_prefix_not_on_path'
      ? 'The npm global command directory is not on PATH. Add the bin directory for the reported package-manager prefix to PATH (the prefix itself on Windows), then inspect the installation with the diagnostic below before retrying the update.'
      : null)
  const recoveryCommand = explicitRecovery ?? (recoveryMessage === null
    ? cliUpdateRecoveryCommand(flags.channel)
    : `npx --yes ${cliPackageSpec(flags.channel === 'beta' ? 'beta' : 'latest')} doctor --json`)
  if (flags.json === true) {
    deps.io.out(JSON.stringify({
      ok: false,
      code,
      recovery_command: recoveryCommand,
      ...(recoveryMessage === null ? {} : { message: recoveryMessage }),
      ...(target === undefined ? {} : { target }),
      package_manager_prefix: packageManagerPrefix,
      before,
      after: inspection(deps),
    }, null, 2))
  } else {
    deps.io.err(recoveryMessage ?? 'Notifai could not finish updating. Retry with:')
    deps.io.err(recoveryCommand)
  }
  return EXIT.failed
}

/**
 * Update the npm-global installation the shell actually resolves, then point
 * the stable hook adapter at that same artifact. The npm executable may own a
 * different global prefix; --prefix makes that ambient choice irrelevant.
 */
export function cliUpdateCommand(deps: CommandDeps, requested: CliUpdateFlags): number {
  const requestedChannel = requested.channel ?? 'stable'
  if (requestedChannel !== 'stable' && requestedChannel !== 'beta') {
    deps.io.err('--channel must be stable or beta')
    return EXIT.failed
  }
  const channel: CliUpdateChannel = requestedChannel
  // Carry the caller's effective PATH into npm and the new artifact's handoff,
  // otherwise each child would diagnose the temporary npx runner as installed.
  deps = { ...deps, env: withoutNpxLauncherPath(deps.env, deps.hookPlatform ?? process.platform,
    runningArtifact(deps) ?? 'notifai') }
  const flags = { ...requested, channel, json: requested.json === true || deps.io.interactive !== true }
  const before = inspection(deps)

  // A beta channel, or a beta installation, installs one exact resolved
  // release, and never one that would move the installation backwards. A
  // stable installation updating on the stable channel keeps plain `latest`.
  const installed = before.effective?.version ?? before.current.version
  let target: CliReleaseTarget | null = null
  if (channel === 'beta' || cliUpdateChannel(installed) === 'beta') {
    const tags = publishedDistTags(deps)
    if (tags === null) {
      return failed(deps, flags, {
        code: 'release_versions_unavailable',
        message: 'Notifai could not read the published release versions, so nothing was installed. Check the connection to the npm registry, then retry with:',
        recoveryCommand: cliUpdateRecoveryCommand(channel),
      }, before, null)
    }
    target = cliReleaseTarget(tags, channel)
    if (installed !== null && compareReleasePrecedence(target.version, installed) === 'before') {
      const betaTarget = cliReleaseTarget(tags, 'beta')
      const betaMovesForward = channel === 'stable' &&
        compareReleasePrecedence(betaTarget.version, installed) !== 'before'
      return failed(deps, flags, betaMovesForward
        ? {
            code: 'update_would_downgrade',
            message: `The installed Notifai ${installed} is newer than the stable release ${target.version}, so nothing was installed. Keep it current on the beta channel with:`,
            recoveryCommand: cliUpdateRecoveryCommand('beta'),
            target,
          }
        : {
            code: 'update_would_downgrade',
            message: `The installed Notifai ${installed} is newer than every published release, so nothing was installed. Inspect the installation with:`,
            target,
          }, before, null)
    }
  }

  const prefixResult = npmRun(deps, ['prefix', '--global'])
  const packageManagerPrefix =
    prefixResult.status === 0 && typeof prefixResult.stdout === 'string' && prefixResult.stdout.trim() !== ''
      ? prefixResult.stdout.trim()
      : null
  const pathCandidate = before.effective ?? before.entries[0] ?? null
  const targetPrefix = pathCandidate === null
    ? packageManagerPrefix
    : pathCandidate.install_prefix
  if (targetPrefix === null) {
    return failed(deps, flags, 'update_destination_unknown', before, packageManagerPrefix)
  }
  if (pathCandidate === null && !prefixIsAddressable(deps, targetPrefix)) {
    return failed(deps, flags, 'package_manager_prefix_not_on_path', before, packageManagerPrefix)
  }

  const install = npmRun(deps, [
    'install',
    '--global',
    '--prefix',
    targetPrefix,
    cliPackageSpec(target?.version ?? 'latest'),
  ])
  if (install.status !== 0) {
    return failed(deps, flags, 'package_install_failed', before, packageManagerPrefix)
  }

  const after = inspection(deps)
  const effective = after.effective
  if (
    effective === null ||
    effective.artifact_path === null ||
    effective.version === null ||
    (before.effective !== null && effective.command_path !== before.effective.command_path)
  ) {
    return failed(deps, flags, 'effective_command_not_repaired', before, packageManagerPrefix)
  }
  if (target !== null && effective.version !== target.version) {
    return failed(deps, flags, { code: 'effective_command_not_target', target }, before, packageManagerPrefix)
  }
  const minimumCurrent = before.current.version
  const currentComparison = minimumCurrent === null
    ? 'unparseable'
    : compareReleasePrecedence(effective.version, minimumCurrent)
  if (currentComparison === 'unparseable') {
    return failed(deps, flags, 'effective_command_version_unknown', before, packageManagerPrefix)
  }
  if (currentComparison === 'before') {
    return failed(deps, flags, 'effective_command_still_older', before, packageManagerPrefix)
  }

  // A package manifest can land before its dependencies or executable. Prove
  // this artifact starts before making every trusted hook depend on it.
  const probe = spawnSync(process.execPath, [effective.artifact_path, '--version'], {
    encoding: 'utf8',
    env: deps.env,
    cwd: deps.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    killSignal: 'SIGKILL',
  })
  if (probe.status !== 0 || probe.stdout?.trim() !== effective.version) {
    return failed(deps, flags, 'effective_command_not_runnable', before, packageManagerPrefix)
  }

  let adapterRetargeted = false
  const adapter = hookAdapterPath(deps.hookAdapterHome)
  if (existsSync(adapter)) {
    try {
      adapterRetargeted = installHookAdapter(
        { execPath: process.execPath, scriptPath: effective.artifact_path },
        deps.hookAdapterHome,
        deps.hookPlatform ?? process.platform,
      ).changed
    } catch {
      return failed(deps, flags, 'hook_adapter_retarget_failed', before, packageManagerPrefix)
    }
  }

  // The old updater has already imported its modules. Only the newly installed
  // artifact can describe the new release's guidance and harness requirements.
  const previousVersion = before.effective?.version ?? before.current.version
  const handoffArgs = [effective.artifact_path, 'update', '--check', '--json']
  if (previousVersion !== null) handoffArgs.push('--from', previousVersion)
  const handoffProbe = spawnSync(process.execPath, handoffArgs, {
    encoding: 'utf8', env: deps.env, cwd: deps.cwd,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL',
  })
  let handoff: Record<string, unknown> | null = null
  try {
    const value: unknown = JSON.parse(handoffProbe.stdout ?? '')
    if (handoffProbe.status === 0 && typeof value === 'object' && value !== null &&
        (value as Record<string, unknown>).ok === true &&
        (value as Record<string, unknown>).read_only === true &&
        (value as Record<string, unknown>).running_version === effective.version) {
      handoff = value as Record<string, unknown>
    }
  } catch {
    // Package installation succeeded; failure to inspect session effects is
    // explicit incomplete follow-up, never permission to restart blindly.
  }

  if (flags.json === true) {
    const adapterInspection = existsSync(adapter)
      ? inspectHookAdapter(deps.hookAdapterHome, deps.hookPlatform ?? process.platform)
      : null
    deps.io.out(JSON.stringify({
      ok: true,
      package_manager_prefix: packageManagerPrefix,
      update_prefix: targetPrefix,
      target: target ?? { version: null, dist_tag: 'latest' },
      handoff,
      follow_up_required: true,
      handoff_error: handoff === null ? 'Run notifai update --check --json with the updated CLI before claiming guidance or session readiness.' : null,
      before,
      after,
      hook_adapter: adapterInspection === null
        ? null
        : { path: adapterInspection.path, target: adapterInspection.target, retargeted: adapterRetargeted },
    }, null, 2))
  } else {
    deps.io.out('The CLI is updated. Read the new release notes and guidance before continuing Notifai work.')
    deps.io.out('Run `notifai update --check --json` for skill refresh and session requirements; a restart is not automatic.')
  }
  return EXIT.ok
}
