import path from 'node:path'
import { EXIT, type CommandDeps } from './commands-core.js'
import { stateDir } from './config.js'
import { managedInstallation } from './native-installation.js'
import type { Installation } from './installation.js'
import { findInstallations, findLegacyProjectInstallations } from './install-hooks.js'
import { hooksUninstallCommand } from './commands-hook-install.js'
import { HOOK_INSTALLABLE_HARNESSES } from './harnesses.js'
import { SkillInstallation } from './skill-installation.js'
import { inspectCliInstallations, nativeLifecycleCommand, type CliBinReadinessOptions } from './cli-bin.js'

export interface NativeUninstallFlags { json?: boolean; cancel?: boolean; finish?: boolean; installationId?: string; installationRoot?: string }
interface Seams { installation?: Installation; removeWiring?: () => { ok: boolean; conflicts: string[] }; sessions?: string; inspection?: CliBinReadinessOptions }
function removeOwnedWiring(deps: CommandDeps, stateRoots: string[]): { ok: boolean; conflicts: string[] } {
  const conflicts: string[] = []
  const quiet = { ...deps, io: { ...deps.io, confirm: deps.io.confirm.bind(deps.io), openUrl: deps.io.openUrl.bind(deps.io),
    out() {}, err(message: string) { conflicts.push(message) } } }
  for (const harness of HOOK_INSTALLABLE_HARNESSES) {
    if (hooksUninstallCommand(quiet, { harness }) !== EXIT.ok && conflicts.length === 0) conflicts.push(`Could not remove ${harness} wiring`)
  }
  const remaining = findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform, conflicts)
  remaining.push(...findLegacyProjectInstallations(deps.cwd, deps.env, deps.hookAdapterHome, deps.hookPlatform, conflicts))
  conflicts.push(...remaining.map(item => `Notifai wiring remains in ${item.file}`))
  if (conflicts.length === 0) {
    for (const root of new Set([stateDir(deps.env), ...stateRoots])) {
      conflicts.push(...new SkillInstallation({ cwd: deps.cwd, env: { ...deps.env, XDG_STATE_HOME: path.dirname(root) } }).removeRecorded().conflicts)
    }
  }
  return { ok: conflicts.length === 0, conflicts }
}

/** This lifecycle command withdraws Notifai only. It never ends a harness
 * session, signals a resident, removes credentials or erases session history. */
export async function nativeUninstallCommand(deps: CommandDeps, flags: NativeUninstallFlags, seams: Seams = {}): Promise<number> {
  const emit = (result: Record<string, unknown>, message: string): number => {
    if (flags.json || !deps.io.interactive) deps.io.out(JSON.stringify(result, null, 2))
    else { deps.io.out(message); if (result['recovery_command']) deps.io.out(String(result['recovery_command'])) }
    return result['ok'] === true ? EXIT.ok : EXIT.failed
  }
  try {
    const platform = deps.hookPlatform ?? process.platform
    const routes = inspectCliInstallations(deps.env, platform, { nativeHome: deps.hookAdapterHome, ...seams.inspection }).entries
    const adapterCleanup = [...new Set(routes.filter(entry => entry.kind === 'npm-adapter' && entry.install_prefix !== null)
      .map(entry => entry.install_prefix!))].map(prefix => ({ package_manager: 'npm',
      args: ['uninstall', '--global', '--prefix', prefix, '@raidiant/notifai'],
      requires: 'Finish native uninstall before removing this npm launcher. npm removes only the launcher, not the native runtime.',
      command: nativeLifecycleCommand('npm', ['uninstall', '--global', '--prefix', prefix, '@raidiant/notifai'], platform) }))
    if (flags.finish && flags.cancel) throw new Error('Choose either --finish or --cancel')
    if (!flags.finish && (flags.installationId || flags.installationRoot)) throw new Error('Recovery identity is only valid with --finish')
    if (flags.finish && (!flags.installationId || !flags.installationRoot || !path.isAbsolute(flags.installationRoot) || path.basename(flags.installationRoot) !== '.notifai')) {
      throw new Error('The temporary cleanup command requires its original installation identity and root')
    }
    const installation = seams.installation ?? managedInstallation(flags.finish ? { ...deps, hookAdapterHome: path.dirname(flags.installationRoot!) } : deps)
    const sessions = seams.sessions ?? path.join(stateDir(deps.env), 'sessions')
    if (flags.finish) {
      const result = installation.finishUninstall(flags.installationId!, sessions)
      return emit({ ok: result.status === 'removed', operation: 'uninstall', ...result, adapter_cleanup: adapterCleanup }, 'Windows installation cleanup finished.')
    }
    const problems: string[] = []
    const wiring = seams.removeWiring || flags.cancel ? [] : findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform, problems)
    if (problems.length) return emit({ ok: false, status: 'uncertain', conflicts: problems }, problems.join('\n'))
    if (!seams.removeWiring && !flags.cancel) findLegacyProjectInstallations(deps.cwd, deps.env, deps.hookAdapterHome, deps.hookPlatform, problems)
    if (problems.length) return emit({ ok: false, status: 'uncertain', conflicts: problems }, problems.join('\n'))
    const before = installation.uninstallState()
    const begun = installation.beginUninstall(before?.generation ?? installation.inspect().active?.generation ?? 0, sessions)
    if (begun.status !== 'preparing' && begun.status !== 'removing') {
      return emit({ ok: false, ...begun }, 'Finish outstanding questions and answers before uninstalling Notifai.')
    }
    if (flags.cancel) {
      installation.cancelUninstall(begun.token)
      return emit({ ok: true, status: 'cancelled' }, 'The pending uninstall was cancelled; Notifai can run again.')
    }
    // Older loaded plugins have no registration. Removing their source is not
    // evidence that a Gateway stopped using it, so retain the runtime.
    if (wiring.some(item => item.harness === 'openclaw') && begun.owners.hosts.length === 0) {
      if (begun.status === 'preparing') installation.cancelUninstall(begun.token)
      return emit({ ok: false, status: 'uncertain', message: 'OpenClaw host ownership is unavailable. Update its Notifai integration and stop the Gateway before retrying uninstall.' },
        'OpenClaw host ownership is unavailable. Update its Notifai integration and stop the Gateway before retrying uninstall.')
    }
    let gate = installation.enterUninstallRemoval(begun.token, sessions)
    const deadline = Date.now() + 10_000
    while (gate.status === 'residents_running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250))
      gate = installation.enterUninstallRemoval(begun.token, sessions)
    }
    // A persisted plan can resume even after its original metadata is gone.
    if (!before?.planned && gate.status !== 'removing') return emit({ ok: false, ...gate,
      recovery_command: 'notifai uninstall --json', cancel_command: 'notifai uninstall --cancel --json' },
    'Notifai is waiting for its running commands to exit. Retry uninstall when they finish, or cancel it.')
    const result = installation.completeUninstall(begun.token, sessions, seams.removeWiring ?? (() => removeOwnedWiring(deps, begun.owners.stateRoots)))
    return emit({ ok: result.status === 'removed', operation: 'uninstall', ...result, adapter_cleanup: adapterCleanup }, result.status === 'removed'
      ? `Notifai was uninstalled. Your configuration and session history were preserved.${adapterCleanup.length ? ` Remove the remaining npm launcher with: ${adapterCleanup.map(item => item.command).join('; ')}` : ''}`
      : result.recovery_command ? 'Run this PowerShell command after this command exits to finish removing Notifai.'
        : `Uninstall remains incomplete: ${result.conflicts?.join('; ') ?? result.status}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return emit({ ok: false, status: 'incomplete', message }, message)
  }
}
