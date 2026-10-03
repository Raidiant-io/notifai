/** Optional exact queue capability on a verified existing Codex connection. */
import { connectCodexControl } from './codex-native-control.js'

export interface NativeQueueItem { id: string; clientUserMessageId: string; input: Array<{ type: string; text?: string }> }
export interface QueueControl {
  namespace: string
  threadId: string
  add(token: string, text: string): Promise<string>
  find(token: string, text: string): Promise<'absent' | 'ambiguous' | { id: string }>
  remove(id: string): Promise<boolean>
  close(): void
}

/** Missing queue capability is a preflight result. Errors after add starts
 * remain uncertain acceptance and cannot authorize another writer. */
export async function connectCodexQueue(
  sessionId: string, env: NodeJS.ProcessEnv, deadlineAt: number,
  now: () => number = () => performance.now(),
  unavailable?: (stage: string) => void,
): Promise<QueueControl | null> {
  const control = await connectCodexControl(sessionId, env, deadlineAt, now, unavailable)
  if (control === null) return null
  const call = control.call
  try {
    const list = async (): Promise<NativeQueueItem[]> => {
      const all: NativeQueueItem[] = []
      let cursor: string | null = null
      for (let page = 0; page < 16; page += 1) {
        const result = await call('thread/queue/list', { threadId: sessionId, ...(cursor === null ? {} : { cursor }) }) as { data: NativeQueueItem[]; nextCursor: string | null }
        if (!Array.isArray(result.data) || !result.data.every(item => typeof item.id === 'string' && typeof item.clientUserMessageId === 'string' && Array.isArray(item.input))) throw new Error('Unrecognized native queue response')
        all.push(...result.data)
        if (result.nextCursor === null) return all
        if (typeof result.nextCursor !== 'string' || result.nextCursor === cursor) throw new Error('Unrecognized native queue cursor')
        cursor = result.nextCursor
      }
      throw new Error('Native queue inspection exceeded its bound')
    }
    await list() // Capability check before any mutation or election.
    return {
      namespace: control.namespace,
      threadId: sessionId,
      add: async (token, text) => {
        const response = await call('thread/queue/add', { threadId: sessionId, clientUserMessageId: token, input: [{ type: 'text', text }] }) as { queuedSubmission?: NativeQueueItem }
        if (typeof response.queuedSubmission?.id !== 'string' || response.queuedSubmission.clientUserMessageId !== token) throw new Error('Native queue receipt unknown')
        return response.queuedSubmission.id
      },
      find: async (token, text) => {
        const matches = (await list()).filter(item => item.clientUserMessageId === token)
        if (matches.length === 0) return 'absent'
        const match = matches[0]!
        return matches.length === 1 && match.input.length === 1 && match.input[0]?.type === 'text' && match.input[0].text === text ? { id: match.id } : 'ambiguous'
      },
      remove: async id => {
        const result = await call('thread/queue/delete', { threadId: sessionId, queuedSubmissionId: id }) as { deleted?: boolean }
        if (typeof result.deleted !== 'boolean') throw new Error('Native queue deletion unknown')
        return result.deleted
      },
      close: () => control.close(),
    }
  } catch {
    control.close()
    unavailable?.('queue-list')
    return null
  }
}
