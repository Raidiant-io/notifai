/** Gateway service inventory: only identity and timing, never question text. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { stateDir, loadConfig } from './config.js'
import { readSessionState, sessionHasEnded, sessionStatePath, readSessionIncarnation } from './hook-session-state.js'
import { readOpenclawGeneration } from './openclaw-generation.js'
import { projectBinding, projectEnabled } from './project-enablement.js'

export interface OpenclawPendingSession {
  session_key: string
  cwd: string
  generation: string
  session_id?: string
}

/** Scan CLI-owned state so a Gateway restart finds unanswered questions. */
export function listPendingOpenclawSessions(env: NodeJS.ProcessEnv): OpenclawPendingSession[] {
  const directory = path.join(stateDir(env), 'sessions')
  if (!existsSync(directory)) return []
  const sessions: OpenclawPendingSession[] = []
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(directory, name), 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) continue
      const raw = parsed as Record<string, unknown>
      const sessionKey = raw['session_id']
      if (typeof sessionKey !== 'string' ||
          path.basename(sessionStatePath(sessionKey, env)) !== name) continue
      const state = readSessionState(sessionKey, env)
      const cwd = state.activation_cwd
      if (state.harness !== 'openclaw' || typeof cwd !== 'string' ||
          !path.isAbsolute(cwd) || sessionHasEnded(sessionKey, env)) continue
      const generation = readOpenclawGeneration(sessionKey, env)
      if (generation === null || generation.ended || !generation.activated ||
          readSessionIncarnation(sessionKey, env)?.openclaw_generation !== generation.id) continue
      const config = loadConfig({ cwd, env, sessionId: sessionKey })
      if (!projectEnabled(projectBinding(cwd, env, config.project.value))) continue
      const stopped = state.last_stop_at
      if (stopped === undefined ||
          !((state.pending ?? []).some((entry) => (entry.asked_at ?? Infinity) <= stopped) ||
            (state.accepted !== undefined && state.accepted.delivered_at === undefined))) continue
      sessions.push({ session_key: sessionKey, cwd, generation: generation.id,
        ...(generation.sessionId === undefined ? {} : { session_id: generation.sessionId }) })
    } catch {
      // Corrupt or unreadable state never authorizes a continuation.
    }
  }
  return sessions
}
