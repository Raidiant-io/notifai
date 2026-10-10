import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { lstatSync, readFileSync } from 'node:fs'
import { legacyNpmMigration } from './legacy-npm-migration.js'
import { EXIT, type CommandDeps } from './commands-core.js'
import { resolveHookAdapterHome } from './hook-adapter.js'
import type { Installation, InstallSource } from './installation.js'
import { managedInstallation } from './native-installation.js'
import { nativeLifecycleCommand } from './cli-bin.js'
import { ContinuityPending } from './local-continuity.js'
import { npmRepairCommand } from './commands-npm-repair.js'
import { integrationRecoveryCommand } from './commands-integration-recovery.js'

function stagedRecovery(deps: CommandDeps, installation?: Installation): string {
  try {
    const pending = (installation ?? managedInstallation(deps)).pendingRelease()
    if (pending) return nativeLifecycleCommand(pending.launcher, ['install', '--upgrade', '--version', pending.version,
      '--channel', pending.channel, '--no-init', '--no-path', '--json'], deps.hookPlatform ?? process.platform)
  } catch { /* Diagnostic uncertainty grants no activation authority. */ }
  return 'notifai doctor --json'
}

export interface NativeUpdateFlags {
  json?: boolean
  channel?: string
  allowDowngrade?: boolean
  rollback?: boolean
  repair?: boolean
  abandon?: boolean
  cleanup?: boolean
}
interface NativeUpdateSeams {
  installation?: Installation
  resume?: (executable: string, from: string) => Record<string, unknown>
}
function resumeIntegration(deps: CommandDeps, executable: string, from: string): Record<string, unknown> {
  // The immutable native launcher sanitizes pre-entrypoint runtime controls.
  // Never launch the current (old) process or a command selected through PATH.
  const result = spawnSync(executable, ['update', '--resume', '--json', '--from', from], {
    cwd: deps.cwd, env: deps.env, encoding: 'utf8', windowsHide: true,
    timeout: 120_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) return { ok: false, integration_complete: false,
    pending_actions: ['Runtime activation succeeded; resume integration with notifai update --resume --json.'] }
  try {
    const report: unknown = JSON.parse(result.stdout)
    if (report && typeof report === 'object' && !Array.isArray(report)) return { ...report, ok: result.status === 0 && (report as Record<string, unknown>)['ok'] === true }
  } catch { /* Invalid child output cannot establish integration completion. */ }
  return { ok: false, integration_complete: false, pending_actions: ['Integration returned no valid report; run notifai update --resume --json.'] }
}

/** One runtime owner regardless of which bootstrap installed it. */
export async function nativeUpdateCommand(deps: CommandDeps, flags: NativeUpdateFlags, seams: NativeUpdateSeams = {}): Promise<number> {
  const emit = (report: Record<string, unknown>, message: string) => {
    if (flags.json || !deps.io.interactive) deps.io.out(JSON.stringify(report, null, 2))
    else deps.io.out(message)
  }
  try {
    if (flags.channel !== undefined && flags.channel !== 'stable' && flags.channel !== 'beta') throw new Error('--channel must be stable or beta')
    if ([flags.rollback, flags.repair, flags.abandon, flags.cleanup].filter(Boolean).length > 1 ||
        ((flags.rollback || flags.repair || flags.abandon || flags.cleanup) && (flags.channel !== undefined || flags.allowDowngrade)) ||
        (flags.allowDowngrade && flags.channel !== 'stable')) throw new Error('Choose one operation; --allow-downgrade requires --channel stable')
    const installation = seams.installation ?? managedInstallation(deps)
    const before = installation.inspect()
    if (before.uninstall_pending) throw new Error('Finish or explicitly cancel the pending uninstall before updating Notifai')
    if (flags.cleanup) {
      const result = installation.cleanup(before.active?.generation ?? 0)
      emit({ ok: true, operation: 'cleanup', ...result },
        `Removed ${result.removed.length} retired builds; retained ${result.retained.length} active, referenced or unverified builds.`)
      return EXIT.ok
    }
    if (flags.abandon) {
      const after = installation.abandonPending(before.active?.generation ?? 0)
      emit({ ok: true, operation: 'abandon', installation: after }, 'Uncommitted installation changes were abandoned; retained runtimes and data were preserved.')
      return EXIT.ok
    }
    if (flags.repair) {
      const recovered = installation.recover()
      if (!recovered.active) throw new Error('No active installation is available to repair')
      const candidate = installation.activeRelease(recovered.active.generation)
      const repaired = installation.repairLauncher(recovered.active.generation)
      const repairCommand = `${(deps.hookPlatform ?? process.platform) === 'win32' ? '& ' : ''}'${candidate.launcher.replaceAll("'", (deps.hookPlatform ?? process.platform) === 'win32' ? "''" : "'\\''")}' update --repair --json`
      emit({ ok: !repaired.launcher_update_pending, operation: 'repair', ...repaired,
        ...(repaired.launcher_update_pending ? { recovery_command: repairCommand,
          message: 'The launcher is busy. Retry from the installed immutable launcher after other commands finish.' } : {}) },
      repaired.launcher_update_pending ? 'The launcher is busy; retry repair after other commands finish.' : 'Installation recovery and launcher repair are verified.')
      return repaired.launcher_update_pending ? EXIT.failed : EXIT.ok
    }
    const previous = installation.activeRelease(before.active?.generation)
    const channel = flags.channel ?? before.channel
    if (!channel) throw new Error('Installed release channel is unavailable')
    const activation = flags.rollback ? installation.rollback(previous.generation) : await installation.installRelease({
      channel, source: before.source!, expectedGeneration: previous.generation,
      allowStableDowngrade: flags.allowDowngrade === true,
    })
    const active = installation.activeRelease(activation.active.generation)
    let integration: Record<string, unknown>
    try { integration = seams.resume ? seams.resume(active.launcher, previous.version) : resumeIntegration(deps, active.launcher, previous.version) }
    catch { integration = { ok: false, integration_complete: false, pending_actions: ['Resume integration with notifai update --resume --json.'] } }
    const complete = integration['ok'] === true && integration['files_complete'] === true && integration['migration_complete'] === true
    const ok = complete && !activation.launcher_update_pending
    emit({ ok, operation: flags.rollback ? 'rollback' : 'update', version: active.version,
      channel: installation.inspect().channel, ...activation, integration_complete: complete, integration,
      ...(!ok ? { recovery_command: activation.launcher_update_pending ? 'notifai update --repair --json' : 'notifai update --resume --json' } : {}) },
    ok ? `Notifai ${active.version} is active and integration is verified.` : `Notifai ${active.version} is active; ${activation.launcher_update_pending ? 'launcher repair' : 'integration'} remains pending.`)
    return ok ? EXIT.ok : EXIT.failed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ ok: false, operation: 'update', message,
      ...(error instanceof ContinuityPending ? { code: error.code, staged_build: error.build,
        runtime_active: false, recovery_command: stagedRecovery(deps, seams.installation) }
        : { recovery_command: 'notifai doctor --json' }) }, message)
    return EXIT.failed
  }
}


export interface NativeInstallFlags {
  recoverIntegration?: string
  quiescence?: string
  prepare?: boolean
  scope?: string
  node?: string
  artifact?: string
  resume?: string
  confirm?: string
  upgrade?: boolean
  migrateNpm?: boolean
  json?: boolean
  directory?: string
  inventory?: string
  source?: string
  channel?: string
  version?: string
  init?: boolean
  path?: boolean
  shell?: string
}
interface NativeInstallSeams {
  installation?: Installation
  init?: (executable: string, env: NodeJS.ProcessEnv) => Record<string, unknown>
}

function installedSetup(deps: CommandDeps, executable: string, json: boolean): Record<string, unknown> {
  const structured = json || !deps.io.interactive
  const result = spawnSync(executable, ['init', ...(structured ? ['--json'] : [])], {
    cwd: deps.cwd, env: deps.env, windowsHide: true,
    ...(structured ? { encoding: 'utf8' as const, maxBuffer: 1024 * 1024, timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] } : { stdio: 'inherit' as const }),
  })
  if (result.error) return { ok: false, code: 'setup_interrupted' }
  if (!structured) return { ok: result.status === 0 }
  try {
    const report: unknown = JSON.parse(String(result.stdout))
    if (report && typeof report === 'object' && !Array.isArray(report)) {
      return { ...report, ok: result.status === 0 && (report as Record<string, unknown>)['ready'] === true }
    }
  } catch { /* No valid setup report means incomplete setup, not failed runtime activation. */ }
  return { ok: false, code: 'setup_report_unavailable' }
}

/** Offline-capable native installation from already obtained release files.
 * Trust comes only from the compiled keys, never from a bootstrap argument. */
export async function nativeInstallCommand(deps: CommandDeps, flags: NativeInstallFlags, seams: NativeInstallSeams = {}): Promise<number> {
  if (flags.recoverIntegration !== undefined || flags.quiescence !== undefined) return integrationRecoveryCommand(deps, flags, seams.installation)
  if (flags.prepare || flags.resume !== undefined || flags.scope !== undefined || flags.node !== undefined || flags.artifact !== undefined || flags.confirm !== undefined) {
    return npmRepairCommand(deps, flags)
  }
  const emit = (report: Record<string, unknown>, message: string) => {
    if (flags.json || !deps.io.interactive) deps.io.out(JSON.stringify(report, null, 2))
    else deps.io.out(message)
  }
  let installed: Record<string, unknown> = { runtime_installed: false, setup_complete: false }
  try {
    const source = flags.source ?? 'manual'
    if (!['shell', 'powershell', 'npm', 'manual'].includes(source)) throw new Error('--source must be shell, powershell, npm or manual')
    if (flags.channel !== undefined && flags.channel !== 'stable' && flags.channel !== 'beta') throw new Error('--channel must be stable or beta')
    if (flags.upgrade && (!flags.version || !flags.channel || flags.init !== false || flags.path !== false)) {
      throw new Error('--upgrade requires --version, --channel, --no-init and --no-path')
    }
    const installation = seams.installation ?? managedInstallation(deps)
    const platform = deps.hookPlatform ?? process.platform
    const home = resolveHookAdapterHome(deps.hookAdapterHome, deps.env, platform)
    const stable = path.join(home, '.notifai', 'bin', platform === 'win32' ? 'notifai.exe' : 'notifai')
    if (installation.inspect().uninstall_pending) {
      emit({ ok: false, code: 'uninstall_pending', ...installed,
        recovery_command: nativeLifecycleCommand(stable, ['uninstall', '--json'], platform),
        cancel_command: nativeLifecycleCommand(stable, ['uninstall', '--cancel', '--json'], platform) },
        'Finish or explicitly cancel the pending uninstall, then rerun this installer.')
      return EXIT.failed
    }
    const legacy = legacyNpmMigration(deps.env, platform, stable, { nativeHome: home })
    if (legacy.collisions.length && (!flags.migrateNpm || legacy.migration === null)) {
      emit({ ok: false, code: 'installation_collision', ...installed, collisions: legacy.collisions,
        ...(legacy.migration ? { migration: legacy.migration,
          message: 'A legacy npm installation is on PATH. Rerun with --migrate-npm to stage the native runtime while preserving that package. Its replacement needs a separate assessed maintenance operation.' }
          : { message: 'Another Notifai installation is on PATH. Resolve this collision before installing; no package or shim was changed.' }) },
      legacy.migration ? 'A legacy npm installation is on PATH. Rerun with --migrate-npm to stage the native runtime while preserving the old package.'
        : 'Resolve the existing Notifai installation before installing.')
      return EXIT.failed
    }
    // Default to this portable release, never to the invocation directory.
    const directory = path.resolve(flags.directory ?? path.dirname(process.execPath))
    const inventoryFile = path.resolve(flags.inventory ?? path.join(directory, 'inventory.json'))
    const stat = lstatSync(inventoryFile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('Release inventory must be a bounded regular file')
    const signedInventory = readFileSync(inventoryFile, 'utf8')
    const result = installation.installCandidate({ directory, signedInventory,
      source: source as InstallSource, ...(flags.channel === undefined ? {} : { channel: flags.channel }),
      ...(flags.upgrade ? { upgrade: true } : {}),
      ...(flags.version === undefined ? {} : { version: flags.version }) })
    const active = installation.activeRelease(result.active.generation)
    const command = path.join(path.dirname(path.dirname(path.dirname(active.launcher))), 'bin', path.basename(active.launcher))
    installed = { runtime_installed: true, setup_complete: false, ...result, channel: installation.inspect().channel,
      effective_command: command, recovery: { executable: command, args: ['init', '--json'] } }
    if (legacy.migration) installed = { ...installed, migration: legacy.migration }
    if (result.launcher_update_pending) throw new Error('The runtime is installed; finish launcher repair before setup')
    let pathResult: Record<string, unknown> = { ok: true, skipped: true }
    if (flags.path !== false) pathResult = { ...installation.shellPath('configure', flags.shell ?? deps.env['SHELL'] ?? '', deps.env) }
    installed = { ...installed, path: pathResult }
    if (pathResult['ok'] !== true) {
      const conflicts = Array.isArray(pathResult['conflicts']) ? pathResult['conflicts'].join(', ') : ''
      throw new Error(`The runtime is installed, but its command could not be added to PATH without changing files Notifai does not own (${conflicts}). Resolve those, or rerun with --no-path and add ${path.dirname(command)} to PATH yourself`)
    }
    // A shell this installer does not configure gets its one line, not a failure.
    const pathNote = typeof pathResult['manual'] === 'string' ? ` ${pathResult['manual']}` : ''
    if (legacy.migration) {
      // Keep all old executable/package bytes. The new runtime can be verified
      // independently, but setup/update readiness remains incomplete while the
      // previous command is still exposed through PATH.
      emit({ ok: false, code: 'migration_pending_legacy_owners', ...installed, setup_skipped: true,
        next_step: legacy.migration.repair.requires },
      `The native CLI is staged at ${command}. The npm package is preserved. Your agent must assess and prepare its replacement at the existing command location, then arrange any necessary pause before finishing setup.`)
      return EXIT.failed
    }
    if (flags.init === false) {
      emit({ ok: true, code: 'installed', ...installed, setup_skipped: true }, `Notifai ${active.version} is installed. Continue with ${command} init.${pathNote}`)
      return EXIT.ok
    }
    // Persistent PATH changes cannot update this bootstrap's parent shell.
    // Give only the setup child the owned command directory; preserve the parent.
    const env = { ...deps.env }
    const priorPath = platform === 'win32' ? env['Path'] ?? env['PATH'] ?? '' : env['PATH'] ?? ''
    const childPath = `${path.dirname(command)}${priorPath ? `${platform === 'win32' ? ';' : ':'}${priorPath}` : ''}`
    env['PATH'] = childPath
    if (platform === 'win32') for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = childPath
    let setup: Record<string, unknown>
    try { setup = seams.init ? seams.init(active.launcher, env) : installedSetup({ ...deps, env }, active.launcher, flags.json === true) }
    catch { setup = { ok: false, code: 'setup_interrupted' } }
    const complete = setup['ok'] === true
    emit({ ok: complete, code: complete ? 'ready' : 'setup_pending', ...installed, setup_complete: complete, setup },
      complete ? `Notifai ${active.version} is installed and setup is complete.${pathNote}` : `Notifai ${active.version} is installed. Continue setup with ${command} init.${pathNote}`)
    return complete ? EXIT.ok : EXIT.failed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ ok: false, code: error instanceof ContinuityPending ? error.code : installed['runtime_installed'] ? 'installation_incomplete' : 'installation_failed',
      ...installed, message, ...(error instanceof ContinuityPending ? { staged_build: error.build,
        recovery_command: stagedRecovery(deps, seams.installation) } : {}) }, message)
    return EXIT.failed
  }
}
