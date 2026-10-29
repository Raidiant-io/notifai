/**
 * Reopening a stopped T3 Code conversation in place (`reopen.t3`).
 *
 * T3 Code ends a Claude Code process 30 minutes after its last turn and starts
 * it again, with the same conversation, the next time its thread gets a
 * message. Notifai sends that message itself: `t3 thread send` hands the
 * thread a Notifai wake, the conversation comes back in the same thread, and
 * its prompt hook hands in what waits. It shows in the thread like any
 * message, so nothing runs where the User cannot see it.
 *
 * Only through the `t3` of the T3 Code that runs the thread (T3 Code names it
 * in `T3CODE_CLI_PATH`), only while that T3 Code's server runs: Notifai never
 * starts T3 Code, and a send to a server that is not running would.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { accountHome } from './platform.js'
import { pidExists } from './process-identity.js'
import type { T3ThreadFacts } from './reopen-terminal.js'
import { sessionInputWake } from './session-inputs.js'

/** Why a T3 Code conversation waits for the User. */
export type T3Wait = 'thread-unknown' | 't3-not-running' | 't3-cli-missing'

/** A send attempt runs no longer than this. */
const SEND_TIMEOUT_MS = 30_000
/** T3 Code's CLI opens the same database as its server: a busy moment is retried this many times. */
const SEND_TRIES = 3

/** What the T3 adapter asks of the machine; tests replace it. */
export interface T3Host {
  /** Whether the T3 Code server of this data directory runs. */
  serverRunning(home: string): boolean
  /** The `t3` to run: the recorded one when it is still there, else the data directory's own. */
  cli(thread: T3ThreadFacts, home: string): string | null
  /** Run `t3 thread send <thread> -` with the message on stdin: true, or why it failed. */
  send(cli: string, home: string | null, thread: string, message: string): Promise<true | string>
  /** Wait before the next try. */
  pause(ms: number): Promise<void>
}

/** The data directory T3 Code runs from: the recorded one, else `~/.t3`. */
export function t3HomeOf(thread: T3ThreadFacts, env: NodeJS.ProcessEnv): string {
  return thread.home ?? path.join(accountHome(env), '.t3')
}

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function systemT3Host(env: NodeJS.ProcessEnv): T3Host {
  return {
    serverRunning: (home) => {
      try {
        const runtime = JSON.parse(readFileSync(path.join(home, 'userdata', 'server-runtime.json'), 'utf8')) as { pid?: unknown }
        return typeof runtime.pid === 'number' && Number.isSafeInteger(runtime.pid) && runtime.pid > 1 && pidExists(runtime.pid)
      } catch {
        return false
      }
    },
    cli: (thread, home) => {
      if (thread.cli !== null && executable(thread.cli)) return thread.cli
      const own = path.join(home, 'bin', process.platform === 'win32' ? 't3.exe' : 't3')
      return executable(own) ? own : null
    },
    send: (cli, home, thread, message) => new Promise((resolve) => {
      const childEnv: NodeJS.ProcessEnv = { ...env }
      delete childEnv['T3CODE_HOME']
      if (home !== null) childEnv['T3CODE_HOME'] = home
      const child = execFile(cli, ['thread', 'send', thread, '-'], { env: childEnv, timeout: SEND_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (error, _stdout, stderr) => {
          if (error === null) { resolve(true); return }
          const detail = `${stderr}`.trim().split('\n').find((line) => line.trim() !== '') ?? error.message
          resolve(detail.slice(0, 200))
        })
      child.stdin?.end(message)
    }),
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

/** A failure the next try may not meet: T3 Code's database was busy. */
function busy(detail: string): boolean {
  return /database is locked|SQLITE_BUSY|LockTimeout/i.test(detail)
}

/** What the reopen needs, or why it waits. */
export function t3Plan(thread: T3ThreadFacts | null, env: NodeJS.ProcessEnv, host: T3Host): { wait: T3Wait } | { cli: string; home: string; thread: string } {
  if (thread === null) return { wait: 'thread-unknown' }
  const home = t3HomeOf(thread, env)
  if (!host.serverRunning(home)) return { wait: 't3-not-running' }
  const cli = host.cli(thread, home)
  if (cli === null) return { wait: 't3-cli-missing' }
  return { cli, home, thread: thread.thread }
}

/** Hand the thread its Notifai wake, retrying a busy database: true, or why it failed. */
export async function sendT3Wake(plan: { cli: string; home: string; thread: string }, recordedHome: string | null, host: T3Host): Promise<true | string> {
  let outcome: true | string = 'not-sent'
  for (let attempt = 1; attempt <= SEND_TRIES; attempt += 1) {
    outcome = await host.send(plan.cli, recordedHome, plan.thread, sessionInputWake())
    if (outcome === true || !busy(outcome) || attempt === SEND_TRIES) return outcome
    await host.pause(attempt * 1_000)
  }
  return outcome
}
