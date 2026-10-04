/** Bounded native answer transport. Exact question evidence belongs to bindings. */
import { connectCodexControl } from './codex-native-control.js'

export interface CodexAnswerControl {
  namespace: string
  threadId: string
  /** Revalidate after preparation; this is not proof a form is unanswered. */
  currentTurn(turnId: string): Promise<boolean>
  /** A success receipt proves admission to this turn, not agent acknowledgement. */
  steer(turnId: string, text: string): Promise<void>
  close(): void
}

/** Optional bounded-turn capability, independent of queue support. A missing
 * read API returns null before answer bytes; the caller uses ordinary input.
 * The owner, lease and bound question must still be fenced by the caller.
 */
export async function connectCodexAnswerControl(
  sessionId: string, turnId: string, env: NodeJS.ProcessEnv, deadlineAt: number,
  now: () => number = () => performance.now(),
): Promise<CodexAnswerControl | null> {
  const control = await connectCodexControl(sessionId, env, deadlineAt, now)
  if (control === null) return null
  const currentTurn = async (expected: string): Promise<boolean> => {
    // Full thread/read can exceed the response bound in an ordinary long
    // session. Question identity comes from the owned accepted transcript.
    const result = await control.call('thread/turns/list', {
      threadId: sessionId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
    }) as { data?: Array<{ id?: string; status?: string; itemsView?: string }> } | null
    return result !== null && Array.isArray(result.data) && result.data.length === 1 &&
      result.data[0]?.id === expected && result.data[0]?.status === 'inProgress' &&
      result.data[0]?.itemsView === 'notLoaded'
  }
  try {
    if (!await currentTurn(turnId)) { control.close(); return null }
    return { namespace: control.namespace, threadId: control.threadId, currentTurn,
      steer: async (expected, text) => {
        const result = await control.call('turn/steer', {
          threadId: sessionId, expectedTurnId: expected, input: [{ type: 'text', text }],
        }) as { turnId?: string } | null
        if (result === null || result.turnId !== expected) throw new Error('Native answer receipt is unknown; do not replay it.')
      },
      close: () => control.close(),
    }
  } catch { control.close(); return null }
}
