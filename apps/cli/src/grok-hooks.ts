/** Native Grok hook identity and model-visible activation. Passive startup and
 * prompt hooks never carry context; tool results and genuine Stop do. */
import { createHash } from 'node:crypto'
import type { EscalationDeliveryRoute, HookEnvelope } from './hook-types.js'
import { updateSessionState } from './hook-session-state.js'
import { grokActivationContext } from './session-activation.js'
import { stopAnswerOutput } from './hook-acknowledgements.js'

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

/** The digest deduplicates unchanged guidance while allowing current User
 * guidance and role changes to reach the model at its next tool boundary. */
export function claimGrokActivation(envelope: HookEnvelope, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  if (envelope.session_id === undefined) return undefined
  const context = grokActivationContext(cwd, env, typeof envelope.subagentType === 'string' && envelope.subagentType !== '')
  const digest = createHash('sha256').update(context).digest('hex')
  let claimed = false
  updateSessionState(envelope.session_id, env, current => {
    if (current.grok_activation_context === digest) return current
    claimed = true
    return { ...current, grok_activation_context: digest }
  })
  return claimed ? context : undefined
}

/** Grok clips Stop feedback. Large answers travel by their immutable request
 * pointers so neither the answer's tail nor its acknowledgement can disappear. */
export function grokContinuationRoute(): EscalationDeliveryRoute {
  return {
    kind: 'hook-continuation',
    deliver: async event => {
      const context = event.context.length <= 9_000 ? event.context
        : 'Notifai has answers for this Agent Session. Read every complete answer below, then follow each result\'s acknowledgement_command before resuming work. ' +
          'This notice itself contains no answer or approval.\n' +
          event.request_ids.map(id => `- Run \`notifai replies ${id} --json\`.`).join('\n')
      return {
        stdout: stopAnswerOutput(context),
        commitStdout: event.commitDelivery,
        notes: [],
        acknowledgement: 'stdout',
      }
    },
  }
}
