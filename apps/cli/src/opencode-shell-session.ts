/**
 * Which OpenCode 2 Agent Session an agent shell belongs to.
 *
 * OpenCode 1's plugin named the session in the shell's environment itself.
 * OpenCode 2's shell hook (`create.before`) carries no session ID, but
 * OpenCode sets `OPENCODE_SESSION_ID` in the command's environment after the
 * hooks run (anomalyco/opencode v2.1.3, `packages/core/src/tool/plugin/shell.ts`).
 * That value is a plain environment variable, so a command can also set it to
 * any other value. It is believed only for a session the plugin itself
 * recorded as live:
 *
 * - The plugin records every session it serves through `notifai hook
 *   opencode-session`, from the OpenCode process that hosts the session. The
 *   hook names that process (`NOTIFAI_HOOK_SOURCE_PID`, the adapter's
 *   parent), and the record keeps it by PID and start time.
 * - A shell's value counts only when its record exists, the session has not
 *   ended, the recorded host still runs, and, where the process tree can be
 *   read, that host is an ancestor of the asking process.
 *
 * Whether the session is a worker, and its title, come from the record, never
 * from the shell. A value that fails any check names no session: the command
 * then behaves as in a shell OpenCode did not identify.
 */
import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { withFileLock } from './file-lock.js'
import { atomicWriteFileSync } from './atomic-file.js'
import { log, type CommandDeps } from './commands-core.js'
import { sanitizeSessionId, stateDir } from './config.js'
import { sessionHasEnded } from './hook-session-state.js'
import { processAncestry, type AncestorProcess } from './process-ancestry.js'
import { processIdentityLiveness, processStartTime, type ProcessIdentity, type ProcessLiveness } from './process-identity.js'

/** The environment value the OpenCode 2 plugin sets in agent shells: read the session from `OPENCODE_SESSION_ID`. */
export const OPENCODE_2_SHELL_MARKER = '2'

/** OpenCode 2 session IDs, as its `Session.ID` makes them (`ses_` and base62). */
const SESSION_ID = /^ses_[A-Za-z0-9]{1,128}$/

/** Records swept per write: enough to keep the directory small. */
const SWEEP_LIMIT = 32

interface OpencodeSessionRecord {
  schema: 1
  session_id: string
  worker: boolean
  session_label?: string
  session_label_pending?: true
  host: ProcessIdentity
  recorded_at: number
}

export interface TrustedOpencodeShellSession {
  sessionId: string
  worker: boolean
  sessionLabel?: string
  sessionLabelPending?: true
}

function recordsDir(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'opencode-sessions')
}

function recordFile(env: NodeJS.ProcessEnv, sessionId: string): string {
  return path.join(recordsDir(env), `${sanitizeSessionId(sessionId)}.json`)
}

function readRecord(file: string): OpencodeSessionRecord | null {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > 16 * 1024 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return null
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<OpencodeSessionRecord>
    if (value?.schema !== 1 || typeof value.session_id !== 'string' || typeof value.worker !== 'boolean' ||
        typeof value.host?.pid !== 'number' || typeof value.host.start !== 'string') return null
    return value as OpencodeSessionRecord
  } catch {
    return null
  }
}

/**
 * `notifai hook opencode-session`: the plugin reports a session it serves.
 * The reporting process's parent is the OpenCode host; without one, nothing
 * is recorded and the session's shells stay unidentified.
 */
export function recordOpencodeSession(
  env: NodeJS.ProcessEnv,
  envelope: unknown,
  now: number,
  startOf: (pid: number) => string | null = processStartTime,
  chain: () => readonly AncestorProcess[] | null = processAncestry,
  liveness: (identity: ProcessIdentity) => ProcessLiveness = processIdentityLiveness,
): 'recorded' | 'invalid' | 'no-host' | 'host-conflict' {
  if (typeof envelope !== 'object' || envelope === null) return 'invalid'
  const { session_id: sessionId, worker, session_label: label, session_label_pending: pending } = envelope as Record<string, unknown>
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || typeof worker !== 'boolean') return 'invalid'
  const pid = Number(env['NOTIFAI_HOOK_SOURCE_PID'])
  const start = Number.isInteger(pid) && pid > 1 ? startOf(pid) : null
  if (start === null || !chain()?.some((ancestor) => ancestor.pid === pid)) return 'no-host'
  const file = recordFile(env, sessionId)
  return withFileLock(`${file}.lock`, () => {
    const previous = readRecord(file)
    if (previous !== null && (previous.host.pid !== pid || previous.host.start !== start) &&
        liveness(previous.host) !== 'gone') return 'host-conflict'
    const record: OpencodeSessionRecord = {
      schema: 1,
      session_id: sessionId,
      worker,
      ...(typeof label === 'string' && label.trim() !== '' && label.length <= 512 ? { session_label: label.trim() } : {}),
      ...(pending === true ? { session_label_pending: true as const } : {}),
      host: { pid, start },
      recorded_at: now,
    }
    atomicWriteFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    sweepRecords(env, sessionId)
    return 'recorded'
  })
}

/** Drop records whose OpenCode is gone: their sessions can no longer run a shell. */
function sweepRecords(env: NodeJS.ProcessEnv, keep: string): void {
  let names: string[]
  try { names = readdirSync(recordsDir(env)).filter((name) => name.endsWith('.json')) } catch { return }
  let checked = 0
  for (const name of names) {
    if (checked >= SWEEP_LIMIT) break
    const file = path.join(recordsDir(env), name)
    const record = readRecord(file)
    if (record?.session_id === keep) continue
    checked += 1
    if (record === null || processIdentityLiveness(record.host) === 'gone') rmSync(file, { force: true })
  }
}

/** The session ended: its shells name no session any more. */
export function forgetOpencodeSession(env: NodeJS.ProcessEnv, sessionId: string): void {
  try { rmSync(recordFile(env, sessionId), { force: true }) } catch { /* nothing to forget */ }
}

/**
 * The session an OpenCode 2 agent shell's `OPENCODE_SESSION_ID` names, or
 * null when nothing proves it (see the module comment).
 */
export function trustedOpencodeShellSession(
  env: NodeJS.ProcessEnv,
  sessionId: string | undefined,
  chain: () => readonly AncestorProcess[] | null,
  liveness: (identity: ProcessIdentity) => ProcessLiveness = (identity) => processIdentityLiveness(identity),
): TrustedOpencodeShellSession | null {
  if (sessionId === undefined || !SESSION_ID.test(sessionId)) return null
  const record = readRecord(recordFile(env, sessionId))
  if (record === null || record.session_id !== sessionId || sessionHasEnded(sessionId, env)) return null
  if (liveness(record.host) !== 'alive') return null
  const ancestors = chain()
  if (ancestors !== null && !ancestors.some((ancestor) => ancestor.pid === record.host.pid)) return null
  return {
    sessionId,
    worker: record.worker,
    ...(record.session_label === undefined ? {} : { sessionLabel: record.session_label }),
    ...(record.session_label_pending === true ? { sessionLabelPending: true as const } : {}),
  }
}

/** `notifai hook opencode-session`. It never fails the plugin: a session it cannot record just stays unidentified in shells. */
export function opencodeSessionCommand(deps: CommandDeps, input: string): number {
  let envelope: unknown = null
  try { envelope = JSON.parse(input) } catch { /* recorded as invalid */ }
  let outcome: string
  try {
    outcome = recordOpencodeSession(deps.env, envelope, (deps.now ?? Date.now)())
  } catch (err) {
    outcome = 'failed'
    log(deps).info('hook.gate', { hook: 'opencode-session', reason: 'record-failed', error: err instanceof Error ? err.message : String(err) })
  }
  const sessionId = typeof envelope === 'object' && envelope !== null ? (envelope as { session_id?: unknown }).session_id : undefined
  log(deps).info('hook.end', { hook: 'opencode-session', outcome, ...(typeof sessionId === 'string' ? { session: sessionId } : {}) })
  return 0
}
