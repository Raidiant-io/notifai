import { spawn } from 'node:child_process'
import type { DeliveryOutcome } from './hook-types.js'

export function holdForNextTurn(reason: string): DeliveryOutcome {
  return {
    notes: [`holding the accepted answer for the next turn: ${reason}`],
    log: { route: 'hold-for-next-turn', stage: 'queued', reason },
    acknowledgement: 'held',
  }
}

/** `log.reason` of a claimed write stopped at its boundary before any byte left. */
export const WRITE_ABORTED_REASON = 'write-aborted'

export function abortedDelivery(): DeliveryOutcome {
  return {
    notes: ['the claim lapsed before the write started; nothing was handed over'],
    log: { route: 'hold-for-next-turn', stage: 'queued', reason: WRITE_ABORTED_REASON },
    acknowledgement: 'held',
  }
}

/**
 * The last check before a claimed write's first byte: a connected socket asks
 * `writable()`, and a connection still pending after `remainingMs()` is
 * abandoned. Either way nothing is written.
 */
export interface WriteGuard {
  writable(): boolean
  remainingMs(): number
}

/** Thrown when a guarded write was stopped before any byte left. */
export class WriteAbortedError extends Error {}

export function cancelledDelivery(): DeliveryOutcome {
  return {
    notes: ['the Agent Session ended before answer delivery; stopping this observer'],
    log: { route: 'hold-for-next-turn', stage: 'queued', reason: 'session-ended' },
    acknowledgement: 'held',
  }
}

/**
 * Run one harness child and preserve its diagnostic stderr on failure.
 *
 * With `onSpawn` the child is started in its own process group (its pid is
 * the group id) and reported at once, so a writer can journal the whole group
 * that might still write if the writer itself dies. It is still awaited.
 */
export function runWakeCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; onSpawn?: (pgid: number) => void } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.onSpawn === undefined ? {} : { detached: true }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (options.onSpawn !== undefined && child.pid !== undefined) options.onSpawn(child.pid)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString())
        return
      }
      reject(
        new Error(
          `${command} ${args[0] ?? ''} exited ${code === null ? `on ${String(signal)}` : String(code)}: ${Buffer.concat(stderr).toString().trim()}`,
        ),
      )
    })
  })
}
