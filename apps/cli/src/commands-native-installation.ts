import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { EXIT, type CommandDeps } from './commands-core.js'
import { resolveHookAdapterHome } from './hook-adapter.js'
import type { Installation } from './installation.js'
import { managedInstallation } from './native-installation.js'
import { updateWorkPending } from './commands-update-resume.js'
import { pathNotifaiEntries } from './cli-bin.js'
import { canonicalPath, sameLocalPath } from './local-path.js'

export interface NativeUpdateFlags {
  json?: boolean
  channel?: string
  allowDowngrade?: boolean
  rollback?: boolean
  repair?: boolean
  abandon?: boolean
}
interface NativeUpdateSeams {
  installation?: Installation
  pendingWork?: () => string | null
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
    if ([flags.rollback, flags.repair, flags.abandon].filter(Boolean).length > 1 ||
        ((flags.rollback || flags.repair || flags.abandon) && (flags.channel !== undefined || flags.allowDowngrade)) ||
        (flags.allowDowngrade && flags.channel !== 'stable')) throw new Error('Choose one operation; --allow-downgrade requires --channel stable')
    const installation = seams.installation ?? managedInstallation(deps)
    if (!seams.installation) {
      const platform = deps.hookPlatform ?? process.platform
      const home = resolveHookAdapterHome(deps.hookAdapterHome, deps.env, platform)
      const stable = path.join(home, '.notifai', 'bin', platform === 'win32' ? 'notifai.exe' : 'notifai')
      if (pathNotifaiEntries(deps.env, platform).some(entry => !sameLocalPath(canonicalPath(entry), canonicalPath(stable), platform))) {
        throw new Error('Another Notifai installation is on PATH; resolve the collision with notifai doctor --json before changing this installation')
      }
    }
    const before = installation.inspect()
    const waiting = seams.pendingWork ? seams.pendingWork() : updateWorkPending(deps)
    if (waiting) throw new Error(waiting)
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
    emit({ ok: false, operation: 'update', message, recovery_command: 'notifai doctor --json' }, message)
    return EXIT.failed
  }
}
