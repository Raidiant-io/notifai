import { withFileLock } from './file-lock.js'
import { readSessionState, sessionHasEnded, sessionStatePath, writeSessionStateUnlocked } from './hook-session-state.js'
import { validRuntimeBuildReference, type RuntimeBuildReference } from './launch-self.js'

/** Existing session state retains every native build serving that session.
 * Replacing one reference would lose an older still-running question owner. */
export function retainSessionRuntime(sessionId: string, env: NodeJS.ProcessEnv,
  reference: RuntimeBuildReference | null, lockHeld = false): void {
  if (reference === null) return
  if (!validRuntimeBuildReference(reference)) throw new Error('Invalid runtime build reference')
  const file = sessionStatePath(sessionId, env)
  const retain = () => {
    if (sessionHasEnded(sessionId, env)) throw new Error('The Agent Session has ended')
    const current = readSessionState(sessionId, env)
    if (!current.harness) throw new Error('Resident work requires an existing Agent Session')
    const retained = current.runtime_builds ?? []
    if (!Array.isArray(retained) || !retained.every(validRuntimeBuildReference)) throw new Error('Runtime ownership needs repair')
    if (retained.some(item => item.installation_id === reference.installation_id && item.build === reference.build)) return
    if (retained.length >= 1024) throw new Error('This Agent Session retains too many runtime builds')
    writeSessionStateUnlocked(file, sessionId, { ...current, runtime_builds: [...retained, reference] })
  }
  if (lockHeld) retain()
  else withFileLock(`${file}.lock`, retain)
}
