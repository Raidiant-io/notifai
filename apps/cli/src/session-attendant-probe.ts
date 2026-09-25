/**
 * Per-harness exact-session probes for the Session Attendant.
 *
 * Each answers one local question every two seconds: is the harness process
 * that started this attendant still running, and does it still host this
 * exact Agent Session? Anything short of proof is `uncertain`, never `running`.
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseDescriptor } from './claude-wake.js'
import type { HookHarness } from './hook-types.js'
import {
  normalizeProcessStart,
  pidExists,
  processIdentityLiveness,
  processStartTime,
  type ProcessIdentity,
} from './process-identity.js'
import type { HarnessProbe } from './session-attendant.js'

/** Whether this build runs a Session Attendant for a harness on a platform, and why not. */
export type AttendantSupport = { supported: true } | { supported: false; reason: string }

export function attendantSupport(
  harness: HookHarness | undefined,
  platform: NodeJS.Platform,
): AttendantSupport {
  if (harness === 'claude-code') {
    // The descriptor, inbox socket, and own-child delivery are proven on macOS.
    // Windows has none of them; Linux shares the socket design.
    return platform === 'darwin' || platform === 'linux'
      ? { supported: true }
      : { supported: false, reason: `claude-code-${platform}-unproven` }
  }
  if (harness === 'codex') {
    // Codex cancels unfinished managed background hooks and caps them per
    // session; a resident attendant ships only once that shape is proven.
    return { supported: false, reason: 'codex-attendant-unproven' }
  }
  return { supported: false, reason: 'harness-has-no-exact-session-probe' }
}

/** How often the PID's start time is re-read even while the descriptor looks right. */
const START_TIME_RECHECK_MS = 30_000

export interface ClaudeProbeAdapters {
  readDescriptor(pid: number): unknown
  pidExists(pid: number): boolean
  readStart(pid: number): string | null
  now(): number
}

export function claudeDescriptorDir(env: NodeJS.ProcessEnv): string {
  const configured = env['CLAUDE_CONFIG_DIR']
  return path.join(configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), '.claude'), 'sessions')
}

export function systemClaudeProbeAdapters(env: NodeJS.ProcessEnv): ClaudeProbeAdapters {
  const dir = claudeDescriptorDir(env)
  return {
    readDescriptor: (pid) => JSON.parse(readFileSync(path.join(dir, `${pid}.json`), 'utf8')) as unknown,
    pidExists,
    readStart: processStartTime,
    now: Date.now,
  }
}

/**
 * The Claude Code probe.
 *
 * - The harness PID is gone, or now belongs to a process with another start
 *   time: `ended` (harness-gone).
 * - The descriptor for that PID names another session id: `/clear` or
 *   `/resume` replaced this session in the same process: `ended`.
 * - The descriptor is missing: Claude Code 2.1.282 removes it about a second
 *   *before* SessionEnd and exit, so this alone is `uncertain` until the PID
 *   check decides.
 * - The descriptor's `procStart` (UTC `ps` text) differs from the harness
 *   start read the same way: the evidence disagrees, `uncertain`.
 *
 * Activity comes from the descriptor `status`: `idle` is idle, anything else
 * (busy, waiting on a permission prompt) is working.
 */
export function claudeAttendanceProbe(options: {
  sessionId: string
  harness: ProcessIdentity
  /** SessionEnd's marker for an end at or after this incarnation's start. */
  endedByHook: () => boolean
  adapters: ClaudeProbeAdapters
}): () => HarnessProbe {
  const { adapters, harness } = options
  const expectedStart = normalizeProcessStart(harness.start)
  let startCheckedAt = adapters.now()
  return () => {
    if (options.endedByHook()) return { state: 'ended', reason: 'session-end-hook' }
    if (!adapters.pidExists(harness.pid)) return { state: 'ended', reason: 'harness-gone' }
    const liveness = (): ReturnType<typeof processIdentityLiveness> =>
      processIdentityLiveness(harness, adapters.readStart, adapters.pidExists)
    let raw: unknown
    try {
      raw = adapters.readDescriptor(harness.pid)
    } catch {
      const alive = liveness()
      if (alive === 'gone') return { state: 'ended', reason: 'harness-gone' }
      return { state: 'uncertain', reason: 'descriptor-missing' }
    }
    const descriptor = parseDescriptor(raw)
    if (descriptor === null || descriptor.pid !== harness.pid) {
      return { state: 'uncertain', reason: 'descriptor-unrecognised' }
    }
    if (normalizeProcessStart(descriptor.procStart) !== expectedStart) {
      // A stale descriptor for a reused PID, or a clock format this build does
      // not know. The PID check tells the two apart.
      return liveness() === 'gone'
        ? { state: 'ended', reason: 'harness-gone' }
        : { state: 'uncertain', reason: 'process-start-mismatch' }
    }
    if (descriptor.sessionId !== options.sessionId) {
      return { state: 'ended', reason: 'session-replaced' }
    }
    const now = adapters.now()
    if (now - startCheckedAt >= START_TIME_RECHECK_MS || now < startCheckedAt) {
      startCheckedAt = now
      // A SIGKILLed harness leaves its descriptor behind; a reused PID would
      // otherwise keep satisfying the checks above.
      const alive = liveness()
      if (alive === 'gone') return { state: 'ended', reason: 'harness-gone' }
      if (alive === 'unknown') return { state: 'uncertain', reason: 'process-start-unreadable' }
    }
    return { state: 'running', activity: descriptor.status === 'idle' ? 'idle' : 'working' }
  }
}
