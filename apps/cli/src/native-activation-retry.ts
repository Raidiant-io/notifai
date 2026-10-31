import { existsSync } from 'node:fs'
import path from 'node:path'
import { readAutomaticUpdateRecord, updateAutomaticUpdateRecord } from './automatic-update.js'
import type { CommandDeps } from './commands-core.js'
import { automaticUpdatesSetting } from './config.js'
import { buildIdentity } from './distribution.js'
import { currentRuntimeBuild } from './launch-self.js'
import { managedInstallation } from './native-installation.js'
import { accountHome } from './platform.js'

const EXPLICIT_OR_INTERNAL = new Set(['doctor', 'self-check', 'install', 'update', 'uninstall', 'channel',
  'hook', 'hub', 'activation-plan', 'attendant-resume'])

/** Before admission or stdin: finish one already authenticated waiting plan if
 * its owners now allow it. Admission always runs again afterwards, so a winning
 * activation forwards the original command through the stable launcher. */
export function retryWaitingNativeActivation(command: { path: string; args: readonly unknown[] }, deps: CommandDeps,
  installation = managedInstallation): void {
  if (EXPLICIT_OR_INTERNAL.has(command.path.split(' ')[0]!) ||
      command.path.startsWith('config ') && command.args[0] === 'updates.automatic' || buildIdentity() === null ||
      deps.env['NOTIFAI_NATIVE_ENTRY'] !== 'launcher-v1' || deps.env['NOTIFAI_NATIVE_ROUTE'] !== 'stable-v1' ||
      deps.env['NOTIFAI_NATIVE_RETRY'] !== undefined ||
      !existsSync(path.join(accountHome(deps.env), '.notifai', 'transaction.json'))) return
  try {
    if (!automaticUpdatesSetting(deps.env).enabled) return
    const reference = currentRuntimeBuild(deps.env)
    if (reference === null) return
    const activated = installation(deps).retryWaitingActivation(reference)
    if (activated && readAutomaticUpdateRecord(deps.env).staged?.build === activated.build) {
      updateAutomaticUpdateRecord(deps.env, record => ({ result: undefined,
        record: record.staged?.build === activated.build ? { ...record, staged: null, waiting_for: [], hook_changes: [], error: null,
          last_automatic: { from: activated.from, to: activated.to, at: Date.now() } } : record }))
    }
  } catch { /* Busy, still waiting or unreadable: fresh admission remains the authority. */ }
}
