import { spawn } from 'node:child_process'
import type { DeliveryOutcome } from './hook-types.js'

export function holdForNextTurn(reason: string): DeliveryOutcome {
  return {
    notes: [`holding the accepted answer for the next turn: ${reason}`],
    log: { route: 'hold-for-next-turn', stage: 'queued', reason },
    acknowledgement: 'held',
  }
}

export function cancelledDelivery(): DeliveryOutcome {
  return {
    notes: ['the Agent Session ended before answer delivery; stopping this observer'],
    log: { route: 'hold-for-next-turn', stage: 'queued', reason: 'session-ended' },
    acknowledgement: 'held',
  }
}

/** Run one harness child and preserve its diagnostic stderr on failure. */
export function runWakeCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
