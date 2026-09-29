/** Pointer-only hand-off from a CLI answer owner to its Gateway plugin service. */
import { createReadStream, createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { EscalationDeliveryRoute } from './hook-types.js'

const BRIDGE_WAIT_MS = 30_000

/**
 * FDs 3 and 4 are private pipes opened by the generated Gateway service.
 * Neither User text nor reply content is written to them: only exact request
 * identifiers and the durable service hand-off protocol cross this boundary.
 */
export function openclawContinuationRoute(
  sessionKey: string,
  generation: string,
): EscalationDeliveryRoute {
  return {
    kind: 'session-queue',
    deliver: async (event) => {
      const requestIds = event.request_ids
      const guard = event.writeGuard
      if (requestIds.length === 0 || guard === undefined || !guard.writable()) {
        return { acknowledgement: 'held', notes: [] }
      }
      const output = createWriteStream('', { fd: 3, autoClose: false })
      const input = createReadStream('', { fd: 4, autoClose: false })
      const lines = createInterface({ input, crlfDelay: Infinity })
      const response = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Gateway service hand-off timed out')), BRIDGE_WAIT_MS)
        const finish = (value: unknown): void => {
          clearTimeout(timer)
          resolve(value)
        }
        lines.once('line', (line) => {
          try { finish(JSON.parse(line) as unknown) }
          catch { reject(new Error('Invalid Gateway service hand-off')) }
        })
        lines.once('close', () => reject(new Error('Gateway service hand-off closed')))
      })
      try {
        await new Promise<void>((resolve, reject) => output.write(`${JSON.stringify({
          type: 'prepare', session_key: sessionKey, generation,
          request_ids: requestIds,
        })}\n`, (err) => err ? reject(err) : resolve()))
        const reply = await response
        if (typeof reply !== 'object' || reply === null ||
            (reply as Record<string, unknown>)['type'] !== 'prepared') {
          return { acknowledgement: 'held', notes: [], log: { reason: 'gateway-service-refused' } }
        }
        if (!guard.writable() || !event.commitDelivery('subprocess')) {
          return { acknowledgement: 'held', notes: [], log: { reason: 'generation-fenced' } }
        }
        output.write(`${JSON.stringify({ type: 'committed' })}\n`)
        return {
          acknowledgement: 'delivered', notes: [],
          log: { route: 'session-queue', stage: 'gateway-service-handoff' },
        }
      } finally {
        lines.close()
        output.end()
      }
    },
  }
}
