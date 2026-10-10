import type { Command } from 'commander'
import { buildIdentity } from './distribution.js'
import { currentRuntimeBuild, validRuntimeBuildReference, type RuntimeBuildReference } from './launch-self.js'
import { nativeInstallationIdentity } from './native-installation-identity.js'
import { accountHome } from './platform.js'
import { readSessionIncarnation, readSessionState, sessionHasEnded, sessionStatePath } from './hook-session-state.js'
import { QUESTION_SETTLEMENT_INPUT_ENV } from './question-settlement-process.js'
import { withFileLock } from './file-lock.js'
import { RuntimeRetention } from './runtime-retention.js'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { assertNativeLaunchAllowed } from './native-uninstall-barrier.js'
import { inspectCliInstallations, type CliBinReadinessOptions } from './cli-bin.js'
import { NativeSelectionChanged } from './native-launch-retry.js'

export type NativeAdmission = 'development' | 'installer' | 'diagnostic' | 'read-only-managed' | 'managed' | 'retained-owner'

function ownsRetainedWork(command: Command, env: NodeJS.ProcessEnv, reference: RuntimeBuildReference): boolean {
  let session: unknown
  if (command.name() === 'attendant-resume') session = command.processedArgs[0]
  else if (command.name() === 'hook' && ['question-submission', 'question-settlement'].includes(command.processedArgs[0])) {
    try { session = JSON.parse(env[QUESTION_SETTLEMENT_INPUT_ENV] ?? '')?.session_id } catch { return false }
  } else return false
  if (typeof session !== 'string' || session.length === 0) return false
  const sessionId = session, file = sessionStatePath(sessionId, env)
  if (!existsSync(file)) return false
  return withFileLock(`${file}.lock`, () => {
    if (sessionHasEnded(sessionId, env)) return false
    const state = readSessionState(sessionId, env)
    if (!Array.isArray(state.runtime_builds) || !state.runtime_builds.some(item => validRuntimeBuildReference(item) &&
        item.installation_id === reference.installation_id && item.build === reference.build)) return false
    const admitted = command.name() === 'attendant-resume'
      ? state.harness === 'codex' && readSessionIncarnation(sessionId, env)?.key === command.processedArgs[1]
      : typeof state.harness === 'string' && state.harness === command.opts()['harness']
    if (admitted) new RuntimeRetention(path.join(accountHome(env), '.notifai'), reference.installation_id).resume(reference.build)
    // The hook still performs its normal incarnation, routing, and question
    // admission checks. This permits only its already-retained executable.
    return admitted
  })
}

/** Before logging or any command action. Help/version never reach preAction.
 * A portable payload can stage itself, but cannot become a shared-state writer.
 * Only durable owner entrypoints may use a generation that is no longer active. */
export function admitNativeCommand(command: Command, env: NodeJS.ProcessEnv): NativeAdmission {
  if (buildIdentity() === null) return 'development'
  if (command.name() === 'self-check') return 'diagnostic'
  // A supported mutating entry always passed through C, which execs the
  // canonical payload name. Consume this local protocol marker so unrelated
  // child programs cannot accidentally inherit admission. This is a launch
  // contract, not a credential or a defence against code running as this User.
  const launched = env['NOTIFAI_NATIVE_ENTRY'] === 'launcher-v1'
  const stableRoute = env['NOTIFAI_NATIVE_ROUTE'] === 'stable-v1'
  const retry = env['NOTIFAI_NATIVE_RETRY']
  const attempts = retry === undefined ? 0 : /^[12]$/.test(retry) ? Number(retry) : 2
  delete env['NOTIFAI_NATIVE_ENTRY']
  delete env['NOTIFAI_NATIVE_ROUTE']
  delete env['NOTIFAI_NATIVE_RETRY']
  if (!launched) {
    if (command.name() === 'doctor') return 'diagnostic'
    throw new Error('Run the native launcher named notifai; direct runtime payload execution cannot change this installation.')
  }
  if (command.name() === 'install' && command.parent?.name() === 'notifai') return 'installer'
  if (command.name() === 'uninstall' && command.parent?.name() === 'notifai' && command.opts()['finish'] === true) return 'installer'
  let reference: RuntimeBuildReference | null
  let installed: ReturnType<typeof nativeInstallationIdentity>
  try {
    reference = currentRuntimeBuild(env)
    installed = nativeInstallationIdentity(accountHome(env))
    if (reference === null || installed.installationId !== reference.installation_id) throw new Error('Installation identity mismatch')
  } catch {
    if (command.name() === 'doctor') return 'diagnostic'
    throw new Error('Install Notifai before running this command. Run this executable with install, or use the installed Notifai command.')
  }
  if (command.name() === 'doctor') return reference.build === installed.build ? 'read-only-managed' : 'diagnostic'
  if (command.name() !== 'uninstall') assertNativeLaunchAllowed(env)
  if (reference.build === installed.build) return 'managed'
  if (ownsRetainedWork(command, env, reference)) return 'retained-owner'
  if (stableRoute && attempts < 2) throw new NativeSelectionChanged(installed.command, attempts)
  throw new Error(`This build is no longer active. Retry with the installed command: ${installed.command}`)
}

/** Portable diagnostics deliberately avoid the regular doctor's saved setup
 * observations, credential access, network checks and local log writes. */
export function portableNativeReport(env: NodeJS.ProcessEnv, options: CliBinReadinessOptions = {}): Record<string, unknown> {
  const inspection = inspectCliInstallations(env, process.platform, options), installation = inspection.native
  return { ok: false, status: inspection.transaction.uninstall_pending ? 'uninstall_pending' : 'native_installation_required',
    running: buildIdentity(), installation, inspection,
    message: inspection.transaction.uninstall_pending ? 'Finish or explicitly cancel the pending uninstall before installing Notifai.'
      : installation ? `Use the installed command: ${installation.command}` : 'Install Notifai before running ordinary commands.',
    read_only: true }
}
