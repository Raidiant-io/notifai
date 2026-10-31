import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { readAutomaticUpdateRecord, updateAutomaticUpdateRecord } from './automatic-update.js'
import type { CommandDeps } from './commands-core.js'
import { automaticUpdatesSetting } from './config.js'
import { buildIdentity } from './distribution.js'
import { currentRuntimeBuild } from './launch-self.js'
import { managedInstallation } from './native-installation.js'
import { accountHome } from './platform.js'

const RETRY_INTERVAL_MS = 60_000

/** Scheduling hint only. Full signature, ownership and generation checks remain
 * inside Installation; ordinary commands never construct that heavy path for
 * an interrupted/unmarked journal. This read cannot grant activation authority. */
function waitingBuild(home: string): string | null {
  try {
    const file = path.join(home, '.notifai', 'transaction.json'), stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ||
        typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)) return null
    const value = JSON.parse(readFileSync(file, 'utf8')) as { schema?: unknown; kind?: unknown; waiting_for_sessions?: unknown; to?: { active?: unknown } } | null
    const build = value?.to?.active
    return value?.schema === 1 && value.kind === 'activation' && value.waiting_for_sessions === true &&
      typeof build === 'string' && /^[a-f0-9]{64}$/.test(build) ? build : null
  } catch { return null }
}

function attemptedRecently(attempt: { build: string; at: number } | undefined, build: string, now: number): boolean {
  return attempt?.build === build && Number.isSafeInteger(attempt.at) && now >= attempt.at - RETRY_INTERVAL_MS &&
    now - attempt.at < RETRY_INTERVAL_MS
}

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
      deps.env['NOTIFAI_NATIVE_RETRY'] !== undefined) return
  const build = waitingBuild(accountHome(deps.env)), now = Date.now()
  if (build === null || attemptedRecently(readAutomaticUpdateRecord(deps.env).command_activation_attempt, build, now)) return
  try {
    if (!automaticUpdatesSetting(deps.env).enabled) return
    const reference = currentRuntimeBuild(deps.env)
    if (reference === null) return
    // One cheap, nonwaiting claim per build/minute across concurrent commands.
    const claimed = updateAutomaticUpdateRecord(deps.env, record => attemptedRecently(record.command_activation_attempt, build, now)
      ? { record, result: false } : { record: { ...record, command_activation_attempt: { build, at: now } }, result: true }, { waitMs: 0 })
    if (!claimed) return
    installation(deps).retryWaitingActivation(reference, activation => {
      // Durable intent before activation. A crash after the swap cannot lose
      // the integration handoff; only the hub performs resume/repair work.
      updateAutomaticUpdateRecord(deps.env, record => ({ result: undefined,
        record: { ...record, resume_pending: activation } }), { waitMs: 0 })
    })
  } catch { /* Busy, still waiting or unreadable: fresh admission remains the authority. */ }
}
