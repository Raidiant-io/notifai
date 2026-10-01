/** Explicit recovery of already-owned resident writers after an installation. */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { EXIT, log, type CommandDeps } from './commands-core.js'
import { attendHook, attendantGates, attendantRuntimeRevision } from './commands-hook-attend.js'
import { findNativeTranscript, nativeTranscriptOwned } from './codex-native-turn.js'
import { lifecycleStamp, readSessionIncarnation, readSessionState, sessionHasEnded } from './hook-session-state.js'
import { readClaimFile } from './hook-question-lock.js'
import { processExecutableName, processIdentityLiveness } from './process-identity.js'
import { attendantClaimPath, attendantStatusPath, codexNativeActivityObserved, listAttendantReports } from './session-attendant-state.js'
import { packageVersion } from './release.js'
import { codexTrustProblems, findInstallations } from './install-hooks.js'

/** Existing durable ownership is required; this path cannot create a session. */
export function recoveryOwner(deps: CommandDeps, sessionId: string, key: string) {
  const state = readSessionState(sessionId, deps.env)
  const owner = readSessionIncarnation(sessionId, deps.env)
  if (state.harness !== 'codex' || typeof state.activation_cwd !== 'string' ||
      owner?.key !== key || owner.harness_process === undefined || sessionHasEnded(sessionId, deps.env) ||
      processIdentityLiveness(owner.harness_process) !== 'alive' ||
      processExecutableName(owner.harness_process.pid) !== 'codex') return null
  return { owner, cwd: state.activation_cwd }
}

/** Internal child entrypoint. It observes native data; it does not impersonate a hook. */
export async function resumeAttendantCommand(deps: CommandDeps, sessionId: string, key: string): Promise<number> {
  const owned = recoveryOwner(deps, sessionId, key)
  if (owned === null) return EXIT.failed
  const transcript = readSessionState(sessionId, deps.env).codex_native_turn?.transcript_path ?? findNativeTranscript(sessionId, deps.env)
  if (transcript === null || !nativeTranscriptOwned(transcript, sessionId, deps.env)) return EXIT.failed
  const installations = findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform).filter(entry => entry.harness === 'codex')
  if (installations.length === 0 || codexTrustProblems(installations, deps.env).length > 0) return EXIT.failed
  const logger = log(deps)
  logger.bind({ session: sessionId })
  logger.info('attendant.state', { source: 'update-resume', phase: 'recovering' })
  return attendHook(deps, {
    envelope: { session_id: sessionId, cwd: owned.cwd }, harness: 'codex', cwd: owned.cwd,
    invokedAt: lifecycleStamp(), logger,
    recovery: { key, harnessProcess: owned.owner.harness_process!, transcriptPath: transcript },
  })
}

export interface AttendantActivation {
  session_id: string
  state: 'current' | 'activated' | 'pending'
  native_activity: boolean
}

/** Called only by the authorized updater, after effective installation checks. */
export async function activateInstalledAttendants(deps: CommandDeps, artifact: string): Promise<AttendantActivation[]> {
  const reports = listAttendantReports(deps.env).filter(report => report.alive && readSessionState(report.session_id, deps.env).harness === 'codex')
  // Each current owner is independent. Bound subprocess fanout and wall time.
  return Promise.all(reports.map(async (report, index): Promise<AttendantActivation> => {
    const sessionId = report.session_id
    const result = (state: AttendantActivation['state']): AttendantActivation => ({
      session_id: sessionId, state, native_activity: codexNativeActivityObserved(sessionId, deps.env),
    })
    const current = readSessionIncarnation(sessionId, deps.env)
    if (current === null || index >= 16) return result('pending')
    const owned = recoveryOwner(deps, sessionId, current.key)
    if (owned === null || !attendantGates(deps, owned.cwd, sessionId, 'codex', packageVersion()).ok) return result('pending')
    const claimFile = attendantClaimPath(sessionId, deps.env)
    const holder = readClaimFile(claimFile)
    if (holder?.['runtime_revision'] === attendantRuntimeRevision && holder['runtime_version'] === packageVersion()) return result('current')
    const transcript = readSessionState(sessionId, deps.env).codex_native_turn?.transcript_path ?? findNativeTranscript(sessionId, deps.env)
    if (transcript === null || !nativeTranscriptOwned(transcript, sessionId, deps.env)) return result('pending')
    let child
    try {
      child = spawn(process.execPath, [artifact, 'attendant-resume', sessionId, current.key], {
        cwd: owned.cwd, env: deps.env, detached: true, stdio: 'ignore', windowsHide: true,
      })
    } catch { return result('pending') }
    let failed = false
    child.on('error', () => { failed = true })
    child.unref()
    const until = performance.now() + 8_000
    while (!failed && performance.now() < until) {
      const claim = readClaimFile(claimFile)
      let active: { pid?: number; phase?: string } = {}
      try { active = JSON.parse(readFileSync(attendantStatusPath(sessionId, deps.env), 'utf8')) } catch { /* not started */ }
      if (claim?.['runtime_revision'] === attendantRuntimeRevision && active.pid === claim['pid'] &&
          ['dormant', 'attending'].includes(active.phase ?? '')) return result('activated')
      if (recoveryOwner(deps, sessionId, current.key) === null) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return result('pending')
  }))
}
