import { spawn } from 'node:child_process'
import { closeSync, constants, existsSync, openSync } from 'node:fs'
import path from 'node:path'
import { configHome } from './install-hooks.js'
import {
  hookContinuationRoute,
  type ContinuationEvent,
  type DeliveryOutcome,
  type EscalationDeliveryRoute,
} from './hooks.js'

/** Codex's per-thread writer lock directory, relative to `$CODEX_HOME`. */
export const CODEX_THREAD_LOCK_DIR = 'thread-writer-locks'

/**
 * BSD `open(2)` lock flags. Node does not surface them in `fs.constants`, and
 * they are the only way to take a non-blocking `flock` from Node without a
 * native addon: the kernel takes the lock at open and drops it at close.
 */
const O_EXLOCK = 0x20
const O_NONBLOCK = 0x4

/** Platforms whose `open(2)` implements `O_EXLOCK`. Everything else fails closed. */
const LOCK_PROBE_PLATFORMS: ReadonlySet<string> = new Set(['darwin', 'freebsd', 'openbsd'])

/** Codex thread ids are UUIDs, and the lock file is named by the exact id. */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CodexWakeObservation =
  /** A live writer owns this thread. Resuming it would create a divergent ghost. */
  | { state: 'live' }
  /** No process holds the thread's writer lock; a cold resume can own it. */
  | { state: 'stopped' }
  | { state: 'unknown'; reason: string }

export interface CodexWakeAdapters {
  /** Non-blocking writer-lock probe. Never holds the lock beyond the probe. */
  probeThreadWriter(lockPath: string): CodexWakeObservation
  /** Is the harness process that will read this hook's stdout still running? */
  sourceAlive(pid: number): boolean
  resume(threadId: string, cwd: string, context: string): Promise<void>
}

/**
 * The one cross-process oracle for "who owns this Codex thread".
 *
 * Codex's thread store takes a non-blocking `flock(LOCK_EX)` on a zero-byte
 * file per thread and holds it for as long as that process owns the thread —
 * verified against both a hosted app-server thread sitting idle and an
 * in-process `codex exec` run (2026-08-12). Because the kernel holds it, a
 * crash, SIGKILL, or reboot releases it instantly, and the leftover file proves
 * nothing: only the lock does. Codex fails closed itself with `-32600` when a
 * second writer contends, but that is the backstop; this is the gate.
 */
export function observeCodexThread(
  threadId: string,
  env: NodeJS.ProcessEnv,
  adapters: Pick<CodexWakeAdapters, 'probeThreadWriter'>,
): CodexWakeObservation {
  if (!THREAD_ID.test(threadId)) {
    return { state: 'unknown', reason: 'the Codex session id is not a thread id' }
  }
  try {
    return adapters.probeThreadWriter(codexThreadLockPath(threadId, env))
  } catch (err) {
    return {
      state: 'unknown',
      reason: `Codex thread-writer lock probe failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export function codexThreadLockPath(threadId: string, env: NodeJS.ProcessEnv): string {
  return path.join(codexThreadLockDirectory(env), `${threadId}.lock`)
}

export function codexThreadLockDirectory(env: NodeJS.ProcessEnv): string {
  return path.join(configHome(env, 'CODEX_HOME', '.codex'), CODEX_THREAD_LOCK_DIR)
}

export type CodexResumeReadiness =
  | { state: 'ready'; lockDirectory: string }
  | { state: 'unavailable'; reason: string }

/**
 * Whether a Codex thread whose Stop hook has already returned could still be
 * cold-resumed, decided without taking any lock or spawning anything.
 *
 * Two things have to hold: this platform must implement the non-blocking
 * `flock` the probe is built on, and `$CODEX_HOME` must actually have a
 * thread-writer-lock directory — its absence is not evidence that a thread is
 * unowned, so the gate fails closed and the answer waits for the next turn.
 * Neither affects the ordinary path, where the hook's own stdout continues the
 * held turn.
 */
export function inspectCodexResume(
  env: NodeJS.ProcessEnv,
  options: { platform: NodeJS.Platform; directoryExists: (directory: string) => boolean },
): CodexResumeReadiness {
  const lockDirectory = codexThreadLockDirectory(env)
  if (!LOCK_PROBE_PLATFORMS.has(options.platform)) {
    return {
      state: 'unavailable',
      reason: `no non-blocking thread-writer lock probe exists on ${options.platform}`,
    }
  }
  if (!options.directoryExists(lockDirectory)) {
    return {
      state: 'unavailable',
      reason: `no thread-writer-lock directory at ${lockDirectory}, so no thread can be proven unowned`,
    }
  }
  return { state: 'ready', lockDirectory }
}

/**
 * Codex's answer-delivery route: the blocking Stop hook, then nothing else.
 *
 * The default is the hook continuation itself. While the Codex process that
 * invoked this hook is alive it is reading this process's stdout, and
 * `{"decision":"block"}` there creates a real new user turn — no launch
 * ownership, no control plane, no probe required. That path must never depend
 * on the lock probe: printing to a dead pipe cannot ghost-write anything, so
 * an unreadable `$CODEX_HOME` is not a reason to withhold a continuation.
 *
 * Only when that process is gone does the answer need another last meter, and
 * then exactly one is safe: a cold `codex exec resume` of a thread no live
 * writer owns. Anything else — a live writer, an unprobeable platform, a thread
 * id we cannot name — is journaled and replayed at the session's next Stop.
 * That accepted gap is the honest floor of the Codex adapter: a session that
 * went idle after its Stop returned, which Notifai did not launch, cannot be
 * woken in place.
 */
export function codexWakeRoute(options: {
  threadId: string
  cwd: string
  sourcePid: number
  env?: NodeJS.ProcessEnv
  adapters?: CodexWakeAdapters
}): EscalationDeliveryRoute {
  const env = options.env ?? process.env
  const adapters = options.adapters ?? systemCodexWakeAdapters(env)
  const continuation = hookContinuationRoute()
  return {
    kind: 'hook-continuation',
    async deliver(event: ContinuationEvent): Promise<DeliveryOutcome> {
      if (adapters.sourceAlive(options.sourcePid)) return continuation.deliver(event)

      // Probe immediately before the spawn, twice, and never trust the earlier
      // answer: ownership is a kernel fact that can change between two syscalls,
      // and resuming a thread someone else owns is the disqualifying failure.
      const observed = observeCodexThread(options.threadId, env, adapters)
      const held = holdForNextTurn(observed)
      if (held !== null) return held
      const confirmed = observeCodexThread(options.threadId, env, adapters)
      const raced = holdForNextTurn(confirmed)
      if (raced !== null) return raced

      await adapters.resume(options.threadId, options.cwd, event.context)
      return {
        notes: ['cold-resumed the stopped Codex thread with its accepted answer'],
        log: { route: 'cold-resume', stage: 'delivered' },
        // The resume ran: the thread holds the answer, and no later hook of this
        // session will report on a turn that started elsewhere.
        acknowledgement: 'delivered',
      }
    },
  }
}

/** The journal, with the exact reason the thread could not be resumed. */
function holdForNextTurn(observation: CodexWakeObservation): DeliveryOutcome | null {
  if (observation.state === 'stopped') return null
  const reason =
    observation.state === 'live'
      ? 'a live writer owns the Codex thread and this hook can no longer continue it'
      : observation.reason
  return {
    notes: [`holding the accepted answer for the next turn: ${reason}`],
    log: { route: 'hold-for-next-turn', stage: 'queued', reason },
    acknowledgement: 'held',
  }
}

/**
 * Take and release the writer lock in one open/close pair.
 *
 * The probe momentarily owns the lock when it is free, so it is held for
 * microseconds and never across a spawn — a probe racing a legitimate resume
 * must not be what makes that resume fail.
 */
function probeThreadWriterLock(lockPath: string): CodexWakeObservation {
  if (!LOCK_PROBE_PLATFORMS.has(process.platform)) {
    return {
      state: 'unknown',
      reason: `no non-blocking thread-writer lock probe exists on ${process.platform}`,
    }
  }
  const directory = path.dirname(lockPath)
  if (!existsSync(directory)) {
    // No lock directory means this is not a Codex home that has ever opened a
    // thread, so its silence is not evidence that nothing owns this one.
    return { state: 'unknown', reason: `no Codex thread-writer lock directory at ${directory}` }
  }
  let handle: number
  try {
    handle = openSync(lockPath, constants.O_RDONLY | O_EXLOCK | O_NONBLOCK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return { state: 'live' }
    // Codex unlinks the lock file when its writer drops cleanly, so a missing
    // file inside a real lock directory means the thread has no owner.
    if (code === 'ENOENT') return { state: 'stopped' }
    return {
      state: 'unknown',
      reason: `Codex thread-writer lock probe failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  closeSync(handle)
  return { state: 'stopped' }
}

function runCodex(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: options.cwd,
      env: options.env,
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
          `codex ${args[0] ?? ''} exited ${code === null ? `on ${String(signal)}` : String(code)}: ${Buffer.concat(stderr).toString().trim()}`,
        ),
      )
    })
  })
}

/**
 * The resumed process must not inherit the ended session's identity, or it
 * reports itself as that thread to every hook it fires. `CODEX_HOME` is the one
 * exception: it names the thread store the resume has to open.
 */
function coldResumeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const key of Object.keys(next)) {
    if (key.startsWith('CODEX_') && key !== 'CODEX_HOME') delete next[key]
  }
  return next
}

export function systemCodexWakeAdapters(
  env: NodeJS.ProcessEnv = process.env,
): CodexWakeAdapters {
  return {
    probeThreadWriter: probeThreadWriterLock,
    sourceAlive(pid) {
      if (!Number.isInteger(pid) || pid <= 1) return false
      try {
        process.kill(pid, 0)
        return true
      } catch (err) {
        // Signalling a process we may not touch still proves it exists.
        return (err as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
    async resume(threadId, cwd, context) {
      if (!existsSync(cwd)) throw new Error(`Codex thread cwd no longer exists: ${cwd}`)
      await runCodex(['exec', 'resume', threadId, context], {
        cwd,
        env: coldResumeEnvironment(env),
      })
    },
  }
}
