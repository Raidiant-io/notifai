/** Native Codex threads owned by OpenClaw, observed by its documented event API.
 * Records are private local attribution, never project files. A generation and
 * a live Gateway ancestor fence reused sessions and inherited shell markers.
 */
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { sanitizeSessionId, stateDir } from './config.js'
import { readOpenclawGeneration } from './openclaw-generation.js'
import { readSessionIncarnation, sessionHasEnded } from './hook-session-state.js'
import { processAncestry } from './process-ancestry.js'
import { processIdentityLiveness, processStartTime, type ProcessIdentity } from './process-identity.js'

interface Binding { threadId: string; sessionKey: string; generation: string; host: ProcessIdentity }
const threadPattern = /^[a-zA-Z0-9_-]{1,128}$/
function bindingPath(env: NodeJS.ProcessEnv, threadId: string): string {
  return path.join(stateDir(env), 'openclaw-native-sessions', `${sanitizeSessionId(threadId)}.json`)
}
export function recordOpenclawNativeSession(env: NodeJS.ProcessEnv, threadId: unknown, sessionKey: string, generation: string): boolean {
  if (typeof threadId !== 'string' || !threadPattern.test(threadId)) return false
  const pid = Number(env['NOTIFAI_HOOK_SOURCE_PID'])
  const start = processStartTime(pid)
  if (start === null || !processAncestry()?.some((p) => p.pid === pid)) return false
  const record: Binding = { threadId, sessionKey, generation, host: { pid, start } }
  atomicWriteFileSync(bindingPath(env, threadId), `${JSON.stringify(record)}\n`, { mode: 0o600 })
  return true
}
/** undefined: ordinary Codex; null: known OpenClaw thread with stale authority. */
export function openclawNativeSession(env: NodeJS.ProcessEnv): Binding | null | undefined {
  const threadId = env['CODEX_THREAD_ID']
  if (!threadId || !threadPattern.test(threadId)) return undefined
  const file = bindingPath(env, threadId)
  let record: Binding
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > 4096 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return null
    record = JSON.parse(readFileSync(file, 'utf8')) as Binding
  } catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null }
  if (record.threadId !== threadId || typeof record.sessionKey !== 'string' || typeof record.generation !== 'string' ||
      !record.host || typeof record.host.pid !== 'number' || typeof record.host.start !== 'string') return null
  const generation = readOpenclawGeneration(record.sessionKey, env)
  if (generation?.id !== record.generation || !generation.recorded || generation.ended ||
      readSessionIncarnation(record.sessionKey, env)?.openclaw_generation !== record.generation ||
      sessionHasEnded(record.sessionKey, env) || processIdentityLiveness(record.host) !== 'alive' ||
      !processAncestry()?.some((p) => p.pid === record.host.pid)) return null
  return record
}
