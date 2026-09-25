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
import type { SessionActivity } from '@raidiant/notifai-protocol'

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
    // Proven on macOS: the hook's parent is the Codex process, and Codex keeps
    // an async hook for its declared timeout while the thread stays loaded.
    // Windows reports no parent the same way.
    return platform === 'darwin' || platform === 'linux'
      ? { supported: true }
      : { supported: false, reason: `codex-${platform}-unproven` }
  }
  return { supported: false, reason: 'harness-has-no-exact-session-probe' }
}

export interface ClaudeProbeAdapters {
  readDescriptor(pid: number): unknown
  pidExists(pid: number): boolean
  readStart(pid: number): string | null
  /** This process's current parent; the kernel updates it when the parent exits. */
  parentPid(): number
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
    parentPid: () => process.ppid,
  }
}

/**
 * The Claude Code probe. Every call re-establishes the evidence; nothing is
 * carried over from an earlier call, so one failed check can never be
 * followed by `running` without a fresh successful one.
 *
 * - The harness PID is gone, or now belongs to a process with another start
 *   time: `ended` (harness-gone). Checked on every call: a SIGKILLed harness
 *   leaves its descriptor behind, and a reused PID would satisfy the rest.
 *   While the harness is still this process's parent the identity holds
 *   without a lookup — a parent cannot be replaced under a living child;
 *   otherwise (an npx adapter in between, or an orphaned attendant) the start
 *   time is read again.
 * - The start time cannot be read: `uncertain`.
 * - The descriptor for that PID names another session id: `/clear` or
 *   `/resume` replaced this session in the same process: `ended`.
 * - The descriptor is missing: Claude Code 2.1.282 removes it about a second
 *   *before* SessionEnd and exit, so with the process alive this is
 *   `uncertain`.
 * - The descriptor's `procStart` (UTC `ps` text) differs from the harness
 *   start read the same way: the evidence disagrees, `uncertain`.
 *
 * Activity comes from the descriptor `status`: `idle` is idle, anything else
 * (busy, waiting on a permission prompt) is working.
 */
export function claudeAttendanceProbe(options: {
  sessionId: string
  harness: ProcessIdentity
  /** SessionEnd's marker for exactly this incarnation. */
  endedByHook: () => boolean
  adapters: ClaudeProbeAdapters
}): () => HarnessProbe {
  const { adapters, harness } = options
  const expectedStart = normalizeProcessStart(harness.start)
  return () => {
    if (options.endedByHook()) return { state: 'ended', reason: 'session-end-hook' }
    const alive =
      adapters.parentPid() === harness.pid
        ? 'alive'
        : processIdentityLiveness(harness, adapters.readStart, adapters.pidExists)
    if (alive === 'gone') return { state: 'ended', reason: 'harness-gone' }
    let raw: unknown
    try {
      raw = adapters.readDescriptor(harness.pid)
    } catch {
      return { state: 'uncertain', reason: 'descriptor-missing' }
    }
    const descriptor = parseDescriptor(raw)
    if (descriptor === null || descriptor.pid !== harness.pid) {
      return { state: 'uncertain', reason: 'descriptor-unrecognised' }
    }
    if (normalizeProcessStart(descriptor.procStart) !== expectedStart) {
      // A stale descriptor, or a clock format this build does not know.
      return { state: 'uncertain', reason: 'process-start-mismatch' }
    }
    if (descriptor.sessionId !== options.sessionId) {
      return { state: 'ended', reason: 'session-replaced' }
    }
    if (alive === 'unknown') return { state: 'uncertain', reason: 'process-start-unreadable' }
    return { state: 'running', activity: descriptor.status === 'idle' ? 'idle' : 'working' }
  }
}

/**
 * The Codex probe. Codex publishes no session descriptor, so the evidence is
 * the Codex process that started this attendant and the thread's own hooks:
 *
 * - SessionEnd's marker for this incarnation: `ended`. Codex runs SessionEnd
 *   when the thread closes, is archived or deleted, or unloads after idling
 *   with no client, then kills the attendant.
 * - The Codex PID is gone or now names a process with another start time:
 *   `ended` (harness-gone). A crashed or killed Codex never runs SessionEnd
 *   and leaves the attendant behind in its own process group.
 * - The start time cannot be read: `uncertain`.
 *
 * Activity comes from this thread's own prompt and turn-end hooks.
 */
export function codexAttendanceProbe(options: {
  harness: ProcessIdentity
  /** SessionEnd's marker for exactly this incarnation. */
  endedByHook: () => boolean
  /** Working while this thread's latest recorded turn has not ended. */
  activity: () => SessionActivity
  adapters: Pick<ClaudeProbeAdapters, 'pidExists' | 'readStart' | 'parentPid'>
}): () => HarnessProbe {
  const { adapters, harness } = options
  return () => {
    if (options.endedByHook()) return { state: 'ended', reason: 'session-end-hook' }
    const alive =
      adapters.parentPid() === harness.pid
        ? 'alive'
        : processIdentityLiveness(harness, adapters.readStart, adapters.pidExists)
    if (alive === 'gone') return { state: 'ended', reason: 'harness-gone' }
    if (alive === 'unknown') return { state: 'uncertain', reason: 'process-start-unreadable' }
    return { state: 'running', activity: options.activity() }
  }
}
