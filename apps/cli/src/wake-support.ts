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
/** A subprocess writer was stopped at its deadline; it may already have written. */
export class WriteDeadlineError extends Error {}

/**
 * Run one harness command to completion. With `onSpawn` it runs in its own
 * process group (reported as soon as it exists). With `signal`, an abort
 * SIGKILLs that whole group — or the child, without one — and rejects with
 * `WriteDeadlineError` at once: nothing the command started keeps running.
 */
export function runWakeCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    onSpawn?: (pgid: number) => void
    signal?: AbortSignal
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const signal = options.signal
    if (signal?.aborted === true) {
      reject(new WriteDeadlineError(`${command} ${args[0] ?? ''} was not started: its deadline had passed`))
      return
    }
    const grouped = options.onSpawn !== undefined
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(grouped ? { detached: true } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      finish()
    }
    const onAbort = (): void => {
      try {
        if (child.pid !== undefined) process.kill(grouped ? -child.pid : child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
      settle(() =>
        reject(new WriteDeadlineError(`${command} ${args[0] ?? ''} was stopped at its deadline and may have written`)),
      )
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (options.onSpawn !== undefined && child.pid !== undefined) options.onSpawn(child.pid)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)))
    child.once('error', (err) => settle(() => reject(err)))
    child.once('exit', (code, exitSignal) => {
      settle(() => {
        if (code === 0) {
          resolve(Buffer.concat(stdout).toString())
          return
        }
        reject(
          new Error(
            `${command} ${args[0] ?? ''} exited ${code === null ? `on ${String(exitSignal)}` : String(code)}: ${Buffer.concat(stderr).toString().trim()}`,
          ),
        )
      })
    })
  })
}
