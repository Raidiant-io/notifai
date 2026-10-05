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

export type NativeAdmission = 'development' | 'installer' | 'diagnostic' | 'managed' | 'retained-owner'

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
  if (command.name() === 'install' && command.parent?.name() === 'notifai') return 'installer'
  if (command.name() === 'self-check') return 'diagnostic'
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
  if (reference.build === installed.build) return 'managed'
  if (command.name() === 'doctor') return 'diagnostic'
  if (ownsRetainedWork(command, env, reference)) return 'retained-owner'
  throw new Error(`This build is no longer active. Retry with the installed command: ${installed.command}`)
}

/** Portable diagnostics deliberately avoid the regular doctor's saved setup
 * observations, credential access, network checks and local log writes. */
export function portableNativeReport(env: NodeJS.ProcessEnv): Record<string, unknown> {
  let installation: ReturnType<typeof nativeInstallationIdentity> | null = null
  try { installation = nativeInstallationIdentity(accountHome(env)) } catch { /* Not a verified local installation. */ }
  return { ok: false, status: 'native_installation_required', running: buildIdentity(), installation,
    message: installation ? `Use the installed command: ${installation.command}` : 'Install Notifai before running ordinary commands.',
    read_only: true }
}
