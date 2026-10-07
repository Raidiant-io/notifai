/** Session Message text travels through private pipes to the Gateway plugin, never process argv. */
import { fstatSync, createReadStream, createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { SessionWriteResult } from './session-handoff.js'
import type { WriteGuard } from './wake-support.js'
import type { SessionActivity } from '@raidiant/notifai-protocol'
import { systemMonotonicNs } from './monotonic-clock.js'

const RESPONSE_MS = 30_000
let lastActivity: { value: SessionActivity; at: number } | null = null

/** A missing Gateway observation is uncertainty, never an idle assertion. */
export function openclawBridgeActivity(): SessionActivity | null {
  return lastActivity !== null && Date.now() - lastActivity.at < 10_000
    ? lastActivity.value : null
}

export function openclawMessageBridgeAvailable(env: NodeJS.ProcessEnv): boolean {
  if (env['NOTIFAI_OPENCLAW_MESSAGE_BRIDGE'] !== '1') return false
  try {
    fstatSync(3)
    fstatSync(4)
    return true
  } catch {
    return false
  }
}

/** Each attendant owns its pipes; handOffSessionMessages serializes writes. */
export function openclawMessageBridge(): (
  messageId: string,
  sessionKey: string,
  generation: string,
  text: string,
  begin: () => boolean,
  guard: WriteGuard,
) => Promise<SessionWriteResult> {
  const output = createWriteStream('', { fd: 3, autoClose: false })
  const input = createReadStream('', { fd: 4, autoClose: false })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let pending: { id: string; finish(result: SessionWriteResult): void } | null = null
  output.on('error', (error) => {
    pending?.finish({ status: 'failed', reason: 'Gateway message pipe write failed', error })
  })
  input.on('error', (error) => {
    pending?.finish({ status: 'failed', reason: 'Gateway message pipe read failed', error })
  })
  lines.on('line', (line) => {
    let value: Record<string, unknown>
    try { value = JSON.parse(line) as Record<string, unknown> } catch { return }
    if (value['type'] === 'activity' &&
        (value['activity'] === 'working' || value['activity'] === 'idle')) {
      lastActivity = { value: value['activity'], at: Date.now() }
    } else if (pending !== null && value['message_id'] === pending.id) {
      pending.finish(value['status'] === 'written'
        ? { status: 'written', route: 'session-queue' }
        : { status: 'failed', reason: 'Gateway message hand-off was unconfirmed', error: value['status'] })
    }
  })
  lines.on('close', () => {
    lastActivity = null
    pending?.finish({ status: 'failed', reason: 'Gateway message pipe closed', error: null })
  })
  return async (messageId, sessionKey, generation, text, begin, guard) => {
    if (!guard.writable()) return { status: 'cancelled' }
    if (!begin()) return { status: 'cancelled' }
    if (!guard.writable()) return { status: 'aborted', reason: 'the claim or lease expired before the Gateway hand-off' }
    const remainingMs = guard.remainingMs()
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return { status: 'aborted', reason: 'the claim expired before the Gateway hand-off' }
    }
    const deadlineNs = (systemMonotonicNs() + BigInt(Math.floor(remainingMs * 1_000_000))).toString()
    let timer: NodeJS.Timeout | undefined
    const response = new Promise<SessionWriteResult>((resolve) => {
      const finish = (result: SessionWriteResult): void => {
        if (timer !== undefined) clearTimeout(timer)
        pending = null
        resolve(result)
      }
      pending = { id: messageId, finish }
      timer = setTimeout(() => finish({ status: 'failed', reason: 'Gateway message hand-off timed out', error: null }),
        Math.min(RESPONSE_MS, Math.max(1, remainingMs)))
    })
    try {
      await new Promise<void>((resolve, reject) => output.write(`${JSON.stringify({
        type: 'message', message_id: messageId, session_key: sessionKey, generation, text,
        deadline_ns: deadlineNs,
      })}\n`, (error) => error ? reject(error) : resolve()))
    } catch (error) {
      pending?.finish({ status: 'failed', reason: 'Gateway message pipe write failed', error })
      return { status: 'failed', reason: 'Gateway message pipe write failed', error }
    }
    return response
  }
}
