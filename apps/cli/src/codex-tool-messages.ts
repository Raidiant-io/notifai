/**
 * Busy Codex Notes wait here, unclaimed, for the next synchronous tool hook.
 * This is a cache of the service's ordered batch, not a second delivery queue.
 * Both tool stdout and idle queue writes claim through the same sequencer;
 * an ambiguous write is never retried through the other route.
 */
import type { AttendanceMessage } from '@raidiant/notifai-protocol'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { type CommandDeps, makeClient } from './commands-core.js'
import { sanitizeSessionId, stateDir } from './config.js'
import { readSessionIncarnation, readSessionState, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import type { HookEnvelope } from './hook-types.js'
import type { Logger } from './logging.js'
import { codexHookIdentityHash, codexTrustKey, codexTrustProblems, findInstallations, handlerEvent } from './install-hooks.js'
import { currentProcessIdentity, processIdentityLiveness } from './process-identity.js'
import { currentCodexTurn, readAttendantLease } from './session-attendant-state.js'
import { readDeliveryJournal, type DeliveryLease } from './session-delivery.js'
import { handOffSessionMessages } from './session-message-handoff.js'

export function codexToolMessagesPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionId)}.tool-messages.json`)
}

/** Missing, disabled, changed or untrusted hooks retain ordinary queue delivery. */
function toolHookFingerprint(deps: Pick<CommandDeps, 'env' | 'hookAdapterHome' | 'hookPlatform'>): string | null {
  const installations = findInstallations(deps.env, deps.hookAdapterHome, deps.hookPlatform)
    .filter((installation) => installation.harness === 'codex')
  if (installations.some((installation) => (installation.problems ?? []).length > 0)) return null
  const hooks = installations.flatMap((installation) => installation.handlers
    .filter((handler) => ['post-tool-use', 'user-prompt-submit'].includes(handlerEvent(handler.command) ?? ''))
    .map((handler) => ({ installation, handler })))
  if (hooks.length !== 2 || !['PostToolUse', 'UserPromptSubmit'].every((event) => hooks.some(({ handler }) => handler.event === event))) return null
  if (hooks.some(({ installation, handler }) => handler.async === true || handler.asyncRewake === true ||
    codexTrustProblems([{ ...installation, handlers: [handler] }], deps.env).length !== 0)) return null
  return hooks.map(({ installation, handler }) => `${codexTrustKey(installation, handler)}:${codexHookIdentityHash(handler)}`).sort().join('|')
}

export function codexToolHookReady(
  deps: Pick<CommandDeps, 'env' | 'hookAdapterHome' | 'hookPlatform'>, sessionId: string,
): boolean {
  const fingerprint = toolHookFingerprint(deps)
  const proof = readSessionState(sessionId, deps.env).codex_tool_hook
  return fingerprint !== null && proof?.fingerprint === fingerprint &&
    proof.incarnation === readSessionIncarnation(sessionId, deps.env)?.incarnation
}

export function stageCodexToolMessages(
  sessionId: string, env: NodeJS.ProcessEnv, lease: DeliveryLease,
  messages: readonly AttendanceMessage[],
): void {
  atomicWriteFileSync(codexToolMessagesPath(sessionId, env), JSON.stringify({
    session_id: sessionId, ...lease, messages,
  }))
}

function isMessage(value: unknown): value is AttendanceMessage {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  return typeof m['message_id'] === 'string' && /^sm_[A-Za-z0-9_-]+$/.test(m['message_id']) &&
    typeof m['created_at'] === 'string' && typeof m['agent_acknowledgement_text_required'] === 'boolean' &&
    ((m['kind'] === 'note' && typeof m['body'] === 'string') ||
      (m['kind'] === 'answer_edit' && typeof m['request_id'] === 'string' &&
        typeof m['text'] === 'string' && Array.isArray(m['answers'])))
}

export function readCodexToolMessages(
  sessionId: string, env: NodeJS.ProcessEnv, lease: DeliveryLease,
): AttendanceMessage[] {
  try {
    const data = JSON.parse(readFileSync(codexToolMessagesPath(sessionId, env), 'utf8')) as Record<string, unknown>
    if (data['session_id'] !== sessionId || data['incarnation'] !== lease.incarnation ||
        data['generation'] !== lease.generation || !Array.isArray(data['messages']) ||
        !data['messages'].every(isMessage)) return []
    return data['messages']
  } catch {
    return []
  }
}

/** One Note per boundary keeps stdout a single JSON document and the hook bounded. */
export async function deliverCodexToolMessage(
  deps: CommandDeps, envelope: HookEnvelope, logger: Logger,
): Promise<void> {
  const sessionId = envelope.session_id
  if (sessionId === undefined || envelope.hook_event_name !== 'PostToolUse' ||
      typeof envelope.turn_id !== 'string') return
  const incarnation = readSessionIncarnation(sessionId, deps.env)
  const lease = readAttendantLease(sessionId, deps.env)
  const sourcePid = Number(deps.env['NOTIFAI_HOOK_SOURCE_PID'])
  const owner = incarnation?.harness_process
  if (incarnation === null || lease === null || owner === undefined ||
      owner.pid !== sourcePid || lease.incarnation !== incarnation.incarnation) return
  const mayWrite = (): boolean => {
    const current = readAttendantLease(sessionId, deps.env)
    return !sessionHasEnded(sessionId, deps.env) &&
      readSessionIncarnation(sessionId, deps.env)?.incarnation === lease.incarnation &&
      current?.incarnation === lease.incarnation && current.generation === lease.generation &&
      currentCodexTurn(sessionId, deps.env, incarnation.key) === envelope.turn_id &&
      processIdentityLiveness(owner) === 'alive'
  }
  // Seeing a definition on disk does not prove an already-running Codex loaded
  // it. Only this exact session's real tool invocation enables busy delivery.
  const fingerprint = toolHookFingerprint(deps)
  if (fingerprint === null || !mayWrite()) return
  const proof = readSessionState(sessionId, deps.env).codex_tool_hook
  if (proof?.incarnation !== lease.incarnation || proof.fingerprint !== fingerprint) {
    updateSessionState(sessionId, deps.env, (state) => ({
      ...state, codex_tool_hook: { incarnation: lease.incarnation, fingerprint },
    }))
  }
  const attempted = new Set(readDeliveryJournal(sessionId, deps.env)
    .filter((entry) => ['writing', 'written', 'failed'].includes(entry.stage))
    .flatMap((entry) => entry.subject.type === 'session_message' ? [entry.subject.message_id] : []))
  const message = readCodexToolMessages(sessionId, deps.env, lease)
    .find((entry) => !attempted.has(entry.message_id))
  if (message === undefined || !mayWrite()) return
  const credential = deps.store.load()
  const writer = currentProcessIdentity()
  if (credential === null || writer === null) return
  const now = deps.now ?? Date.now
  const deadlineAt = now() + 2_000
  const client = makeClient(deps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`, {
    timeoutMs: 750, deadlineAt, now,
  })
  await handOffSessionMessages([message], {
    mayWrite: () => now() < deadlineAt && mayWrite(),
    generation: () => lease.generation,
    incarnation: () => lease.incarnation,
  }, {
    lockWaitMs: 0,
    sequencer: {
      sessionId, env: deps.env, client, writer, log: logger,
      monotonic: () => performance.now(), wall: now,
      recoveryDeadline: performance.now() + 500,
      sleep: async (ms) => { if (now() < deadlineAt) await new Promise((resolve) => setTimeout(resolve, Math.min(ms, deadlineAt - now()))) },
    },
    write: async (text, begin, guard) => {
      const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })
      if (!guard.writable() || !begin()) return { status: 'cancelled' }
      if (!guard.writable()) return { status: 'aborted', reason: 'tool-hook-fenced' }
      try {
        deps.io.out(output)
      } catch (error) {
        return { status: 'failed', reason: 'tool-hook-output-failed', error }
      }
      return { status: 'written', route: 'tool-hook' }
    },
  })
}
