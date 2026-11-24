/** A native Grok monitor carries only a wake. The existing exact-session
 * foreground consumer claims and presents the User's input. */
import { randomBytes } from 'node:crypto'
import { statSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type CommandDeps, log } from './commands-core.js'
import { grokHostOwner } from './commands-receive.js'
import { sanitizeSessionId, stateDir } from './config.js'
import { grokTerminalStartKey } from './grok-terminal-session.js'
import { acquireClaimFile, processCommandLine, readClaimFile, releaseClaimFile } from './hook-question-lock.js'
import { readSessionIncarnation, readSessionState, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import type { HookEnvelope, SessionState } from './hook-types.js'
import { currentProcessIdentity, processIdentityLiveness } from './process-identity.js'
import { readAttendantLease } from './session-attendant-state.js'
import { readDeliveryJournal } from './session-delivery.js'
import { pendingSessionInputs, wakeSessionInputs } from './session-inputs.js'

export const GROK_MONITOR_UNAVAILABLE = 'grok-monitor-not-running'
const MONITOR_DESCRIPTION = 'Notifai session input'
// Stay below Grok's volume limit even when a busy User sends consecutive notes.
const POLL_MS = 2_500
const HEARTBEAT_MAX_AGE_MS = POLL_MS * 3
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const TICKET = /^[a-f0-9]{24}$/u
const commandFor = (sessionId: string, ticket: string): string => 'exec notifai grok-watch ' + sessionId + ' ' + ticket + ' 2>/dev/null'

export function grokMonitorSurface(pid: number): 'acp' | 'terminal' | null {
  if (process.platform !== 'darwin') return null
  const command = processCommandLine(pid)
  // Interactive TUI and persistent ACP sessions were qualified. A one-shot
  // session ends with its turn and cannot use a persistent monitor.
  if (command === null || /(?:^|\s)(?:-p|--single|--prompt-file|--prompt-json)(?:[=\s]|$)/u.test(command)) return null
  const args = command.trim().split(/\s+/u)
  const agent = args.indexOf('agent')
  if (args[1] === 'dashboard') return null
  if (agent >= 0) {
    const subcommands = args.slice(agent + 1)
    if (subcommands.includes('stdio')) return 'acp'
    if (subcommands.includes('serve') || subcommands.includes('leader')) return null
  }
  return 'terminal'
}

function claimPath(sessionId: string, env: NodeJS.ProcessEnv, ticket: string): string {
  return path.join(stateDir(env), 'sessions', sanitizeSessionId(sessionId) + '.grok-monitor-' + ticket)
}

function liveOffer(sessionId: string, env: NodeJS.ProcessEnv, state: SessionState) {
  const record = readSessionIncarnation(sessionId, env)
  const owner = state.grok_host_owner
  if (record === null || owner?.route !== 'monitor' || owner.incarnation !== record.incarnation || sessionHasEnded(sessionId, env) ||
      (owner.terminal === true && grokTerminalStartKey(owner, env) !== record.key)) return null
  return { record, owner, offer: state.grok_monitor?.key === record.key ? state.grok_monitor : undefined }
}

/** Capability requires both the native tool's success and its live watcher. */
export function grokMonitorReady(sessionId: string, env: NodeJS.ProcessEnv, state = readSessionState(sessionId, env)): boolean {
  const binding = liveOffer(sessionId, env, state)
  if (binding === null) return false
  const { offer } = binding
  if (offer?.taskId === undefined || offer.started !== true || !TICKET.test(offer.ticket)) return false
  const file = claimPath(sessionId, env, offer.ticket)
  const claim = readClaimFile(file)
  if (typeof claim?.['pid'] !== 'number' || typeof claim['start'] !== 'string') return false
  try {
    const age = Date.now() - statSync(file).mtimeMs
    return age >= 0 && age <= HEARTBEAT_MAX_AGE_MS &&
      processIdentityLiveness({ pid: claim['pid'], start: claim['start'] }) === 'alive'
  } catch { return false }
}

/** Offer once per activation at a passive tool boundary. A normal shell tool
 * running the same text cannot qualify: Grok must confirm its own monitor. */
export function grokMonitorContext(envelope: HookEnvelope, env: NodeJS.ProcessEnv): string | undefined {
  const sessionId = envelope.session_id
  if (sessionId === undefined || !SESSION_ID.test(sessionId) || envelope.subagentType) return undefined
  const current = readSessionState(sessionId, env)
  if (current.grok_host_owner?.route !== 'monitor') return undefined
  if (current.grok_monitor !== undefined && (envelope.tool_name !== 'monitor' || current.grok_monitor.taskId !== undefined)) return undefined
  let ticket: string | undefined
  updateSessionState(sessionId, env, state => {
    const binding = liveOffer(sessionId, env, state)
    if (binding === null) return state
    const { record, offer } = binding
    if (offer === undefined) {
      ticket = randomBytes(12).toString('hex')
      return { ...state, grok_monitor: { key: record.key, ticket } }
    }
    const input = envelope.tool_input as { command?: unknown; description?: unknown; persistent?: unknown } | undefined
    const result = envelope.tool_response as { type?: unknown; taskId?: unknown; persistent?: unknown } | undefined
    if (offer.taskId === undefined && envelope.hook_event_name === 'PostToolUse' && envelope.tool_name === 'monitor' &&
        input?.command === commandFor(sessionId, offer.ticket) && input.description === MONITOR_DESCRIPTION && input.persistent === true &&
        result?.type === 'Monitor' && result.persistent === true && typeof result.taskId === 'string' && SESSION_ID.test(result.taskId) &&
        grokHostOwner(sessionId, env, binding.record.incarnation) !== undefined) {
      return { ...state, grok_monitor: { ...offer, taskId: result.taskId } }
    }
    return state
  })
  if (ticket === undefined) return undefined
  const parameters = { command: commandFor(sessionId, ticket), description: MONITOR_DESCRIPTION, persistent: true }
  return 'If Grok’s native monitor tool is available, call it once with ' + JSON.stringify(parameters) +
    ' so Notifai can wake this Agent Session for Session Notes and Answer Edits. Leave it running. ' +
    'If a permission prompt appears, let the User decide in Grok. If the User ends the monitor, leave it stopped. ' +
    'The wake carries no User input. Run notifai receive once when it arrives and follow the result.'
}

/** Runs under Grok’s monitor shell. No service calls, no User words on stdout. */
export async function grokWatchCommand(deps: CommandDeps, sessionId: string, ticket: string): Promise<number> {
  if (!SESSION_ID.test(sessionId) || !TICKET.test(ticket) || currentProcessIdentity() === null) return 0
  const { env } = deps
  const initial = liveOffer(sessionId, env, readSessionState(sessionId, env))
  if (initial?.offer?.ticket !== ticket || initial.offer.started === true ||
      grokHostOwner(sessionId, env, initial.record.incarnation) === undefined ||
      processIdentityLiveness(initial.owner) !== 'alive') return 0
  const { owner, record } = initial
  const file = claimPath(sessionId, env, ticket)
  const token = acquireClaimFile(file, { key: record.key })
  if (token === null) return 0
  const stop = new AbortController()
  const onSignal = (): void => stop.abort()
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const
  for (const signal of signals) process.once(signal, onSignal)
  try {
    let started = false
    updateSessionState(sessionId, env, state => {
      const offer = liveOffer(sessionId, env, state)?.offer
      if (offer?.ticket !== ticket || offer.started === true) return state
      started = true
      return { ...state, grok_monitor: { ...offer, started: true } }
    })
    if (!started) return 0
    const logger = log(deps)
    logger.bind({ session: sessionId })
    let lastBatch = ''
    const mayWake = () => {
      const binding = liveOffer(sessionId, env, readSessionState(sessionId, env))
      return !stop.signal.aborted && binding?.offer?.ticket === ticket && binding.owner.pid === owner.pid &&
        binding.owner.start === owner.start && readClaimFile(file)?.['token'] === token &&
        processIdentityLiveness(owner) === 'alive' ? binding : null
    }
    while (!stop.signal.aborted) {
      const binding = mayWake()
      if (binding === null) break
      const now = new Date()
      utimesSync(file, now, now)
      const lease = readAttendantLease(sessionId, env)
      if (binding.offer?.taskId !== undefined && lease?.incarnation === binding.record.incarnation) {
        const batch = () => pendingSessionInputs(sessionId, env, lease).messages.map(message => message.message_id).join(' ')
        const pending = batch()
        if (pending !== '' && pending !== lastBatch && !readDeliveryJournal(sessionId, env).some(entry =>
          entry.stage === 'claimed' && entry.reported === undefined && processIdentityLiveness(entry.writer) === 'alive')) {
          await wakeSessionInputs(sessionId, env, async text => {
            const current = readAttendantLease(sessionId, env)
            if (mayWake() === null || current?.incarnation !== lease.incarnation || current.generation !== lease.generation ||
                batch() !== pending) return 'not-attempted'
            deps.io.out(text)
            lastBatch = pending
            return 'written'
          }, logger, { unique: true, scope: ticket })
        }
      }
      await sleep(POLL_MS, undefined, { signal: stop.signal }).catch(() => undefined)
    }
  } finally {
    releaseClaimFile(file, token)
    for (const signal of signals) process.removeListener(signal, onSignal)
  }
  return 0
}
