/** Exact-generation access to OpenClaw reply pointers in agent tool subprocesses. */
import { readSessionIncarnation, readSessionState, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import { openclawGenerationLockPath, readOpenclawGeneration } from './openclaw-generation.js'
import { withFileLock } from './file-lock.js'
import { loadConfig } from './config.js'
import { projectBinding, projectEnabled } from './project-enablement.js'

/**
 * A stable sessionKey alone is insufficient: /new and /reset can reuse it.
 * The generated plugin places the generation observed by resolve_exec_env in
 * the tool's environment, and this check compares it with fresh CLI-owned state.
 */
export function activeOpenclawGeneration(
  sessionKey: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): string | null {
  if (env['NOTIFAI_ACTIVE_HARNESS'] !== 'openclaw' ||
      env['NOTIFAI_ACTIVE_SESSION_ID'] !== sessionKey) return null
  const marker = env['NOTIFAI_ACTIVE_OPENCLAW_GENERATION']
  if (marker === undefined || marker === '') return null
  const generation = readOpenclawGeneration(sessionKey, env)
  const incarnation = readSessionIncarnation(sessionKey, env)
  if (generation === null || incarnation === null || generation.ended ||
      !generation.activated || sessionHasEnded(sessionKey, env) ||
      generation.id !== marker || incarnation.openclaw_generation !== marker) return null
  if (cwd !== undefined) {
    try {
      const config = loadConfig({ cwd, env, sessionId: sessionKey })
      if (!projectEnabled(projectBinding(cwd, env, config.project.value))) return null
    } catch {
      return null
    }
  }
  return marker
}

/** A pointer may reveal User text only to the active generation that owns it. */
export function openclawOwnsReply(
  sessionKey: string,
  requestId: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): boolean {
  return withFileLock(openclawGenerationLockPath(sessionKey, env), () => {
    const generation = activeOpenclawGeneration(sessionKey, env, cwd)
    if (generation === null) return false
    const state = readSessionState(sessionKey, env)
    return (state.pending ?? []).some((entry) => entry.request_id === requestId) ||
      (state.delivered_answers ?? []).some((entry) => entry.pending.request_id === requestId) ||
      (state.acknowledgement_due ?? []).some((entry) => entry.request_id === requestId) ||
      (state.accepted?.answers ?? []).some((entry) => entry.pending.request_id === requestId) ||
      (state.openclaw_foreground_replies ?? []).some((entry) =>
        entry.request_id === requestId && entry.generation === generation)
  })
}

/** Record ownership as soon as a foreground submission returns its request ID. */
export function recordOpenclawForegroundReply(
  sessionKey: string,
  requestId: string,
  generation: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): boolean {
  return withFileLock(openclawGenerationLockPath(sessionKey, env), () => {
    if (activeOpenclawGeneration(sessionKey, env, cwd) !== generation) return false
    let recorded = false
    updateSessionState(sessionKey, env, (state) => {
      recorded = true
      const entries = state.openclaw_foreground_replies ?? []
      return entries.some((entry) => entry.request_id === requestId && entry.generation === generation)
        ? state
        : { ...state, openclaw_foreground_replies: [
          ...entries, { request_id: requestId, generation },
        ] }
    })
    return recorded
  })
}
