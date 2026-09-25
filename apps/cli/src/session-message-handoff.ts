/**
 * How the Session Attendant hands Session Messages — Session Notes and
 * post-delivery Answer Edits — into its running Agent Session.
 *
 * Each message is one claimed hand-off through the session's delivery
 * sequencer, in the order the User sent them: claim under the attendant's
 * lease generation, record the acknowledgement it is owed, write the
 * structured context in place, report. Nothing is written without a claim,
 * nothing after the claim deadline or the attendant's own write margin, and an
 * `unconfirmed` message is never written again.
 */
import type { AttendanceMessage } from '@raidiant/notifai-protocol'
import { clearAcknowledgementObligation, recordMessageAcknowledgementDue } from './hook-acknowledgements.js'
import { sessionMessageContext } from './injection-render.js'
import { answerWriterGone, beginHandOff, type SequencerDeps } from './session-delivery.js'
import type { AttendantHandle } from './session-attendant.js'
import type { SessionWriteResult } from './session-handoff.js'

/**
 * - `done`: every message was handed off, settled elsewhere, or waits for the
 *   next exchange (which returns every message still claimable).
 * - `retry-soon`: a message waits on something that resolves in seconds (its
 *   fenced answer's outcome, the delivery lock, a lease renewal); ask again
 *   without holding the exchange open.
 */
export type MessageHandOffResult = 'done' | 'retry-soon'

export interface MessageHandOffDeps {
  sequencer: SequencerDeps
  /** The in-place write; `begin` is its commit point. */
  write(text: string, begin: () => boolean): Promise<SessionWriteResult>
}

export async function handOffSessionMessages(
  messages: readonly AttendanceMessage[],
  attendant: AttendantHandle,
  deps: MessageHandOffDeps,
): Promise<MessageHandOffResult> {
  const { sequencer } = deps
  const log = sequencer.log
  const ordered = [...messages].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id),
  )
  for (const message of ordered) {
    const generation = attendant.generation()
    if (generation === null || !attendant.mayWrite()) return 'retry-soon'
    const handOff = await beginHandOff(sequencer, {
      lease: { incarnation: attendant.incarnation(), generation },
      subjects: [{ type: 'session_message', message_id: message.message_id }],
      earlierAnswerWriterGone: () =>
        message.kind === 'answer_edit' &&
        answerWriterGone(sequencer.sessionId, sequencer.env, message.request_id, sequencer.liveness),
      mayWrite: () => attendant.mayWrite(),
    })
    if (handOff === null) return 'retry-soon'
    const refusal = handOff.refused[0]
    if (refusal !== undefined) {
      await handOff.finish('not-written')
      switch (refusal.reason) {
        case 'awaiting_earlier_answer':
        case 'unavailable':
          // Later messages keep their order behind this one.
          return 'retry-soon'
        case 'generation_fenced':
          // The lease moved; the attendant re-acquires before anything else.
          return 'done'
        case 'not_claimable':
        case 'not_found':
          continue
      }
    }

    let owed = false
    let result: SessionWriteResult
    try {
      result = await deps.write(sessionMessageContext(message), () => {
        recordMessageAcknowledgementDue(sequencer.sessionId, sequencer.env, {
          message_id: message.message_id,
          recorded_at: sequencer.wall(),
          text_required: message.agent_acknowledgement_text_required,
        })
        owed = true
        if (handOff.begin()) return true
        clearAcknowledgementObligation(sequencer.sessionId, sequencer.env, message.message_id)
        owed = false
        return false
      })
    } catch (err) {
      // Thrown before the write (state I/O): nothing reached the harness.
      if (owed) clearAcknowledgementObligation(sequencer.sessionId, sequencer.env, message.message_id)
      await handOff.finish('not-written')
      throw err
    }
    log?.info('delivery.handoff', {
      message_id: message.message_id,
      kind: message.kind,
      write: result.status,
      ...(result.status === 'unavailable' || result.status === 'failed' ? { reason: result.reason } : {}),
    })
    switch (result.status) {
      case 'written':
        await handOff.finish('written')
        continue
      case 'failed':
        // It may have arrived: the debt stays and the service hears `unconfirmed`.
        await handOff.finish('failed')
        continue
      case 'cancelled':
        await handOff.finish('not-written')
        return 'retry-soon'
      case 'unavailable':
      case 'stopped':
        await handOff.finish('not-written')
        return 'done'
    }
  }
  return 'done'
}
