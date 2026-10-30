import { forgetAutomaticLookup } from './automatic-update.js'
import { EXIT, type CommandDeps } from './commands-core.js'
import { nativeUpdateCommand } from './commands-native-installation.js'
import type { Installation } from './installation.js'
import type { ReleaseChannel } from './release-distribution.js'
import { managedInstallation } from './native-installation.js'
import { compareReleasePrecedence, isPrerelease } from './version.js'

/** How people read a channel; JSON keeps the `stable` and `beta` values. */
const CHANNEL_NAMES: Record<ReleaseChannel, string> = { stable: 'Stable', beta: 'Beta' }

interface ReleaseChannelSeams {
  installation?: Installation
  /** Installs a newer release on the chosen channel; production runs `notifai update --channel`. */
  update?: (deps: CommandDeps, channel: ReleaseChannel) => Promise<Record<string, unknown>>
}

/** Runs the ordinary native update and returns its report instead of printing it. */
async function installNewer(deps: CommandDeps, channel: ReleaseChannel): Promise<Record<string, unknown>> {
  let printed = ''
  await nativeUpdateCommand({ ...deps, io: { ...deps.io, interactive: false, out: (line) => { printed += line } } },
    { channel, json: true })
  try {
    const report: unknown = JSON.parse(printed)
    if (report && typeof report === 'object' && !Array.isArray(report)) return report as Record<string, unknown>
  } catch { /* An unreadable report proves no completed update. */ }
  return { ok: false, recovery_command: 'notifai doctor --json' }
}

/**
 * Show or save this computer's release channel. Showing is local and offline.
 * Choosing a channel never installs an older version: a newer release on it is
 * installed now, otherwise the active build stays until the channel offers a
 * newer one, which automatic updates then install.
 */
export async function releaseChannelCommand(deps: CommandDeps, requested: string | undefined,
  flags: { json?: boolean }, seams: ReleaseChannelSeams = {}): Promise<number> {
  const emit = (report: Record<string, unknown>, message: string) => {
    if (flags.json || !deps.io.interactive) deps.io.out(JSON.stringify(report, null, 2))
    else deps.io.out(message)
  }
  const operation = requested === undefined ? 'show' : 'set'
  if (requested !== undefined && requested !== 'stable' && requested !== 'beta') {
    emit({ ok: false, operation, code: 'invalid_channel', message: 'The channel must be stable or beta' }, 'The channel must be stable or beta')
    return EXIT.usage
  }
  let installation: Installation
  try {
    installation = seams.installation ?? managedInstallation(deps)
  } catch {
    const message = 'Only the standalone Notifai installation saves a release channel, and this Notifai is not one.'
    emit({ ok: false, operation, code: 'native_installation_required', channel: null, message,
      recovery_command: 'notifai doctor --json' }, message)
    return EXIT.failed
  }
  const state = () => {
    const status = installation.inspect()
    const active = installation.activeRelease(status.active?.generation)
    if (status.channel === null) throw new Error('Installed release channel is unavailable')
    return { channel: status.channel, version: active.version, generation: active.generation,
      waiting_for_stable: status.channel === 'stable' && isPrerelease(active.version) }
  }
  const describe = (current: ReturnType<typeof state>) => current.waiting_for_stable
    ? `Release channel: Stable. Notifai ${current.version} stays until a newer Stable release replaces it.`
    : `Release channel: ${CHANNEL_NAMES[current.channel]}. Notifai ${current.version} is active.`
  try {
    const before = state()
    if (requested === undefined || requested === before.channel) {
      emit({ ok: true, operation, changed: false, channel: before.channel, active_version: before.version,
        waiting_for_stable: before.waiting_for_stable }, describe(before))
      return EXIT.ok
    }
    if (installation.inspect().uninstall_pending) throw new Error('Finish or explicitly cancel the pending uninstall before changing Notifai')
    const channel: ReleaseChannel = requested
    let update: Record<string, unknown> | null = null
    let releaseCheckError: string | null = null
    try {
      const found = await installation.stageRelease({ channel, expectedGeneration: before.generation,
        accept: version => compareReleasePrecedence(version, before.version) === 'after' })
      if (found.staged) update = await (seams.update ?? installNewer)(deps, channel)
    } catch (error) {
      releaseCheckError = error instanceof Error ? error.message : String(error)
    }
    // Nothing newer was activated: keep the active build and save the channel.
    if (installation.inspect().channel !== channel) installation.changeChannel({ channel, expectedGeneration: state().generation })
    forgetAutomaticLookup(deps.env)
    const after = state()
    const ok = update === null || update['ok'] === true
    emit({ ok, operation, changed: true, channel: after.channel, previous_channel: before.channel,
      active_version: after.version, previous_version: before.version, waiting_for_stable: after.waiting_for_stable,
      ...(update === null ? {} : { update }),
      ...(releaseCheckError === null ? {} : { release_check_error: releaseCheckError }),
      ...(!ok && typeof update?.['recovery_command'] === 'string' ? { recovery_command: update['recovery_command'] } : {}) },
    describe(after))
    return ok ? EXIT.ok : EXIT.failed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ ok: false, operation, message, recovery_command: 'notifai doctor --json' }, message)
    return EXIT.failed
  }
}
