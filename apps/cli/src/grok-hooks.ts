/** Native Grok hook identity and model-visible activation. Passive startup and
 * prompt hooks never carry context; tool results and genuine Stop do. */
import { createHash } from 'node:crypto'
import type { ContinuationEvent, EscalationDeliveryRoute, HookEnvelope } from './hook-types.js'
import { updateSessionState } from './hook-session-state.js'
import { grokActivationContext } from './session-activation.js'
import type { PendingNotice } from './pending-notice.js'
import { stopAnswerOutput } from './hook-acknowledgements.js'
import { GrokLeaderSession } from './grok-leader.js'

export function grokHookEnvelope(input: HookEnvelope): HookEnvelope | null {
  const native = input.sessionId
  const alias = input.session_id
  if (native !== undefined && (typeof native !== 'string' || native.trim() === '')) return null
  if (alias !== undefined && (typeof alias !== 'string' || alias.trim() === '')) return null
  if (native !== undefined && alias !== undefined && native !== alias) return null
  const sessionId = native ?? alias
  if (sessionId === undefined) return null
  const childGate = input.hook_event_name === 'SubagentStop' && input.phase === 'gate' &&
    input.subagentId === sessionId && typeof input.subagentType === 'string' && input.subagentType !== ''
  return {
    ...input,
    session_id: sessionId,
    ...(input.tool_name === undefined && input.toolName !== undefined ? { tool_name: input.toolName } : {}),
    ...(input.tool_input === undefined && input.toolInput !== undefined ? { tool_input: input.toolInput } : {}),
    ...(childGate ? { reason: 'end_turn' } : {}),
    ...(input.stopHookActive === undefined ? {} : { stop_hook_active: input.stopHookActive }),
  }
}

export function resetGrokActivation(sessionId: string, env: NodeJS.ProcessEnv): void {
  updateSessionState(sessionId, env, current => {
    const next = { ...current }
    delete next.grok_activation_context
    return next
  })
}

/** A Grok subagent: it reports to its parent and gets the worker context. */
export function grokWorker(envelope: HookEnvelope): boolean {
  return typeof envelope.subagentType === 'string' && envelope.subagentType !== ''
}

/** The digest deduplicates unchanged guidance while allowing current User
 * guidance and role changes to reach the model at its next tool boundary.
 * It covers the guidance alone: a notice is shown once, so it must neither
 * repeat unchanged guidance nor be spent by an activation that is not shown.
 * A root activation carries the due notices that fit; a worker's carries none. */
export function claimGrokActivation(envelope: HookEnvelope, cwd: string, env: NodeJS.ProcessEnv,
  notices: readonly PendingNotice[] = []): string | undefined {
  if (envelope.session_id === undefined) return undefined
  const worker = grokWorker(envelope)
  const context = grokActivationContext(cwd, env, worker)
  const digest = createHash('sha256').update(context).digest('hex')
  let claimed = false
  updateSessionState(envelope.session_id, env, current => {
    if (current.grok_activation_context === digest) return current
    claimed = true
    return { ...current, grok_activation_context: digest }
  })
  if (!claimed) return undefined
  return worker || notices.length === 0 ? context : grokActivationContext(cwd, env, worker, notices)
}

/** Grok clips Stop feedback. Large answers travel by their immutable request
 * pointers so neither the answer's tail nor its acknowledgement can disappear. */
export function grokContinuationRoute(): EscalationDeliveryRoute {
  return {
    kind: 'hook-continuation',
    deliver: async event => {
      return {
        stdout: stopAnswerOutput(grokAnswerContext(event)),
        commitStdout: event.commitDelivery,
        notes: [],
        acknowledgement: 'stdout',
      }
    },
  }
}

function grokAnswerContext(event: ContinuationEvent): string {
  return event.context.length <= 9_000 ? event.context
    : 'Notifai has answers for this Agent Session. Read every complete answer below, then follow each result\'s acknowledgement_command before resuming work. ' +
      'This notice itself contains no answer or approval.\n' +
      event.request_ids.map(id => `- Run \`notifai replies ${id} --json\`.`).join('\n')
}

/** Interjection avoids Grok's eight blocking-Stop continuations per turn.
 * Pin the resident owner before waiting, then recheck its identity at write.
 * Without a leader the native Stop remains the only proven answer route.
 * Qualified live on grok 1.0.62: a genuine `end_turn` Stop's `decision: block`
 * continues the same session, the leader roster admits interjection into an
 * idle resident session, and passive events' stdout never reaches the model.
 * The vendor's web hook page (only PreToolUse blocks) predates that build's
 * shipped guide, which documents Stop decision control. */
export async function grokQuestionRoute(sessionId: string | undefined, cwd: string, env: NodeJS.ProcessEnv): Promise<EscalationDeliveryRoute> {
  const leader = sessionId === undefined ? null : await GrokLeaderSession.discover(sessionId, cwd, env, { watch: false })
  if (leader === null) return grokContinuationRoute()
  return {
    kind: 'session-queue',
    deliver: async event => {
      // A missing claim never becomes an unguarded write or a different route.
      if (event.writeGuard === undefined) return { acknowledgement: 'held', notes: [], log: { reason: 'grok-answer-claim-unavailable' } }
      const result = await leader.write(grokAnswerContext(event), () => event.commitDelivery(), event.writeGuard)
      return result.status === 'written'
        ? { acknowledgement: 'delivered', notes: [], log: { route: 'session-queue', stage: 'leader-interjection' } }
        : { acknowledgement: 'held', notes: [], log: { reason: result.status === 'failed' ? 'write-unconfirmed' : result.status === 'aborted' ? 'write-aborted' : result.status } }
    },
  }
}
