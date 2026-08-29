import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  inspectCliInstallations,
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
import { compareCliSemVer } from './cli-release.js'

export interface CliUpdateFlags {
  json?: boolean
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
  const npmCli = deps.env['npm_execpath']
  if (typeof npmCli === 'string' && npmCli !== '') {
    return spawnSync(process.execPath, [npmCli, ...args], {
      encoding: 'utf8',
      env: deps.env,
      windowsHide: true,
    })
  }
  return spawnSync((deps.hookPlatform ?? process.platform) === 'win32' ? 'npm.cmd' : 'npm', args, {
    encoding: 'utf8',
    env: deps.env,
    windowsHide: true,
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

function sameLocalPath(left: string, right: string): boolean {
  const canonical = (value: string) => {
    try {
      return realpathSync(value)
    } catch {
      return path.resolve(value)
    }
  }
  return canonical(left) === canonical(right)
}

function prefixIsAddressable(deps: CommandDeps, prefix: string): boolean {
  const platform = deps.hookPlatform ?? process.platform
  const raw = platform === 'win32' ? (deps.env['Path'] ?? deps.env['PATH'] ?? '') : (deps.env['PATH'] ?? '')
  const delimiter = platform === 'win32' ? ';' : ':'
  const commandDirectory = platform === 'win32' ? prefix : path.join(prefix, 'bin')
  return raw.split(delimiter).some((directory) => directory !== '' && sameLocalPath(directory, commandDirectory))
}

function failed(
  deps: CommandDeps,
  flags: CliUpdateFlags,
  code: string,
  before: CliInstallationInspection,
  packageManagerPrefix: string | null,
): number {
  if (flags.json === true) {
    deps.io.out(JSON.stringify({ ok: false, code, package_manager_prefix: packageManagerPrefix, before }, null, 2))
  } else {
    deps.io.err('Notifai could not safely update the command that wins PATH. Run `notifai doctor --json` for the local installation details.')
  }
  return EXIT.failed
}

/**
 * Update the npm-global installation the shell actually resolves, then point
 * the stable hook adapter at that same artifact. The npm executable may own a
 * different global prefix; --prefix makes that ambient choice irrelevant.
 */
export function cliUpdateCommand(deps: CommandDeps, flags: CliUpdateFlags): number {
  const before = inspection(deps)
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
    '@raidiant/notifai',
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
  const minimumCurrent = before.current.version
  const currentComparison = minimumCurrent === null
    ? null
    : compareCliSemVer(effective.version, minimumCurrent)
  if (
    currentComparison !== null &&
    currentComparison < 0
  ) {
    return failed(deps, flags, 'effective_command_still_older', before, packageManagerPrefix)
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

  if (flags.json === true) {
    const adapterInspection = existsSync(adapter)
      ? inspectHookAdapter(deps.hookAdapterHome, deps.hookPlatform ?? process.platform)
      : null
    deps.io.out(JSON.stringify({
      ok: true,
      package_manager_prefix: packageManagerPrefix,
      update_prefix: targetPrefix,
      before,
      after,
      hook_adapter: adapterInspection === null
        ? null
        : { path: adapterInspection.path, target: adapterInspection.target, retargeted: adapterRetargeted },
    }, null, 2))
  } else {
    deps.io.out('Notifai is updated. Re-run `notifai init` to continue setup.')
  }
  return EXIT.ok
}
