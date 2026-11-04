/**
 * A Notifai wake in a Codex thread whose last turn the User interrupted.
 *
 * Codex pauses a thread's durable queue after an interrupt (Esc): nothing
 * queued runs until the User's next prompt, and a wake still queued then
 * runs as an extra turn after that prompt's turn ends. Two routes settle it:
 *
 * - **Start it.** Where the shared Codex server owns the thread (a plain
 *   `codex` terminal), `thread/queue/start` with the wake's exact queued id is
 *   Codex's own "send now": it runs that one item as a turn only while the
 *   thread is idle, deletes it as it starts, and refuses a second start.
 * - **Remove it.** Where nothing can start it, the answer reaches the agent
 *   with the User's next prompt instead, and the wake is then redundant:
 *   `thread/queue/delete` removes exactly that item. Through the shared
 *   server when one runs for the home (Codex itself refuses to write a queue
 *   through a separate server then); otherwise through a private stdio server
 *   in the same home, as `codex queue` writes it. Neither loads the thread.
 *
 * Notifai never starts a server for either.
 */
import { connectCodexControl, codexStdioRequest, type CodexControl } from './codex-native-control.js'

export type PausedWakeStart = 'started' | 'gone' | 'refused' | 'unreachable'
export type PausedWakeRemoval = 'deleted' | 'gone' | 'failed'

export interface PausedWakeSeams {
  connect?: typeof connectCodexControl
  stdio?: typeof codexStdioRequest
}

/** Whether the item is still in the thread's queue; null when that cannot be read. */
async function stillQueued(control: CodexControl, threadId: string, id: string): Promise<boolean | null> {
  try {
    let cursor: string | null = null
    for (let page = 0; page < 8; page += 1) {
      const result = await control.call('thread/queue/list', cursor === null ? { threadId } : { threadId, cursor }) as
        { data?: Array<{ id?: unknown }>; nextCursor?: string | null } | null
      if (!Array.isArray(result?.data)) return null
      if (result.data.some((item) => item?.id === id)) return true
      if (result.nextCursor == null || result.nextCursor === cursor) return false
      cursor = result.nextCursor
    }
    return null
  } catch {
    return null
  }
}

/**
 * Start the exact queued wake on the server that has the thread loaded.
 * `gone`: the item is no longer queued (it already ran, or was removed), so
 * it counts as woken. `refused`: Codex kept it (a turn is running). The
 * caller claims the attempt first: a wake is never started twice.
 */
export async function startPausedCodexWake(threadId: string, env: NodeJS.ProcessEnv, id: string, deadlineAt: number,
  seams: PausedWakeSeams = {}): Promise<PausedWakeStart> {
  const control = await (seams.connect ?? connectCodexControl)(threadId, env, deadlineAt)
  if (control === null) return 'unreachable'
  try {
    try {
      const result = await control.call('thread/queue/start', { threadId, queuedSubmissionId: id }) as { turn?: { id?: unknown } } | null
      if (typeof result?.turn?.id === 'string') return 'started'
    } catch { /* Refused, or the receipt is unknown: the queue says which. */ }
    const queued = await stillQueued(control, threadId, id)
    return queued === false ? 'gone' : 'refused'
  } finally {
    control.close()
  }
}

/** Whether the shared server has this thread loaded now, so a paused wake there can be started. */
export async function codexThreadOnSharedServer(threadId: string, env: NodeJS.ProcessEnv, deadlineAt: number,
  seams: PausedWakeSeams = {}): Promise<boolean> {
  const control = await (seams.connect ?? connectCodexControl)(threadId, env, deadlineAt)
  control?.close()
  return control !== null
}

/** Remove exactly this queued item. Never loads, resumes or starts the thread. */
export async function removeQueuedCodexWake(threadId: string, env: NodeJS.ProcessEnv, cwd: string, id: string, deadlineAt: number,
  seams: PausedWakeSeams = {}): Promise<PausedWakeRemoval> {
  let stage: string | null = null
  const control = await (seams.connect ?? connectCodexControl)(threadId, env, deadlineAt, undefined, (failed) => { stage = failed },
    { allowUnloaded: true })
  const params = { threadId, queuedSubmissionId: id }
  if (control !== null) {
    try {
      const result = await control.call('thread/queue/delete', params) as { deleted?: unknown } | null
      if (result?.deleted === true) return 'deleted'
      if (result?.deleted === false) return 'gone'
      return 'failed'
    } catch {
      return 'failed'
    } finally {
      control.close()
    }
  }
  // A shared server runs for this home but could not be reached: writing
  // through another server is what Codex itself refuses to do then.
  if (stage !== 'discovery') return 'failed'
  const remaining = Math.max(1, Math.ceil(deadlineAt - performance.now()))
  const result = await (seams.stdio ?? codexStdioRequest)(env, cwd, 'thread/queue/delete', params, remaining) as { deleted?: unknown } | null
  return result?.deleted === true ? 'deleted' : result?.deleted === false ? 'gone' : 'failed'
}
