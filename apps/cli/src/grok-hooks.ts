/** Native Grok hook identity and model-visible activation. Passive startup and
 * prompt hooks never carry context; tool results and genuine Stop do. */
import { createHash } from 'node:crypto'
import type { ContinuationEvent, EscalationDeliveryRoute, HookEnvelope } from './hook-types.js'
import { updateSessionState } from './hook-session-state.js'
import { grokActivationContext, rootGuidanceDigest, rootGuidanceDelivery } from './session-activation.js'
import { claimGuidanceChange, invalidateGuidanceRead, recordGuidanceGiven } from './guidance-currency.js'
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

/** Re-arm activation for the next tool boundary; `compacted` when a compaction summarized it away. */
export function resetGrokActivation(sessionId: string, env: NodeJS.ProcessEnv, compacted = false): void {
  if (compacted) invalidateGuidanceRead(sessionId, env)
  updateSessionState(sessionId, env, current => {
    const next = { ...current }
    delete next.grok_activation_context
    if (compacted) next.grok_compacted = true
    else delete next.grok_compacted
    return next
  })
}

/** A Grok subagent: it reports to its parent and gets the worker context. */
export function grokWorker(envelope: HookEnvelope): boolean {
  return typeof envelope.subagentType === 'string' && envelope.subagentType !== ''
}

/** The digest deduplicates unchanged guidance while allowing current User
 * guidance, a changed skill and role changes to reach the model at its next
 * tool boundary. A root activation sent again after a compaction or a change
 * of guidance says what to reload (`guidance-currency.ts`). */
export function claimGrokActivation(envelope: HookEnvelope, cwd: string, env: NodeJS.ProcessEnv,
  notices: readonly PendingNotice[] = []): string | undefined {
  const sessionId = envelope.session_id
  if (sessionId === undefined) return undefined
  const worker = grokWorker(envelope)
  const plain = grokActivationContext(cwd, env, worker)
  const digest = createHash('sha256').update(worker ? plain : rootGuidanceDigest(cwd, env)).digest('hex')
  let claimed = false
  let currency: string | undefined
  const guidance = worker ? undefined : rootGuidanceDigest(cwd, env)
  updateSessionState(sessionId, env, current => {
    if (current.grok_activation_context === digest) return current
    if (guidance !== undefined) {
      currency = claimGuidanceChange(sessionId, env, guidance, false, { ...rootGuidanceDelivery(cwd, env), compacted: current.grok_compacted === true })
      if (!recordGuidanceGiven(sessionId, env, guidance, rootGuidanceDelivery(cwd, env).text)) return current
    }
    claimed = true
    const next = { ...current, grok_activation_context: digest }
    delete next.grok_compacted
    return next
  })
  if (!claimed) return undefined
  if (worker) return plain
  return currency === undefined && notices.length === 0 ? plain : grokActivationContext(cwd, env, false, notices, currency)
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
    : 'Notifai has answers for this Agent Session. Run each command below to read every complete answer, then follow each result\'s acknowledgement_command before resuming work. ' +
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
