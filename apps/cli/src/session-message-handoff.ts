/**
 * How the Session Attendant hands Session Messages — Session Notes and
 * post-delivery Answer Edits — into its running Agent Session.
 *
 * Each message is one claimed hand-off through the session's delivery
 * sequencer, in the order the service accepted them: claim under the attendant's
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
import type { WriteGuard } from './wake-support.js'

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
  /**
   * The in-place write: `begin` is its commit point and `guard` is checked at
   * the write itself, before the first byte. A write made by a harness
   * subprocess (`codex queue`) begins as `subprocess` and reports that
   * subprocess's process group through `writerGroup` as soon as it exists.
   */
  write(
    text: string,
    begin: (writer?: 'subprocess') => boolean,
    guard: WriteGuard,
    writerGroup: (pgid: number) => void,
  ): Promise<SessionWriteResult>
}

export async function handOffSessionMessages(
  messages: readonly AttendanceMessage[],
  attendant: AttendantHandle,
  deps: MessageHandOffDeps,
): Promise<MessageHandOffResult> {
  const { sequencer } = deps
  const log = sequencer.log
  // The service lists messages in acceptance (revision) order, which is the
  // User's order. Timestamps can tie and identifiers are random, so neither
  // may reorder them: a later edit must never land before an earlier one.
  for (const message of messages) {
    const generation = attendant.generation()
    if (generation === null || !attendant.mayWrite()) return 'retry-soon'
    const handOff = await beginHandOff(sequencer, {
      lease: { incarnation: attendant.incarnation(), generation },
      subjects: [{ type: 'session_message', message_id: message.message_id }],
      earlierAnswerWriterGone: () =>
        message.kind === 'answer_edit' &&
        answerWriterGone(
          sequencer.sessionId,
          sequencer.env,
          message.request_id,
          sequencer.liveness,
          sequencer.groupAlive,
        ),
      mayWrite: () => attendant.mayWrite(),
    })
    if (handOff === null) return 'retry-soon'
    const refusal = handOff.refused[0]
    if (refusal !== undefined) {
      await handOff.finish('not-written')
      switch (refusal.reason) {
        case 'awaiting_earlier_answer':
        case 'attempt_pending':
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
      result = await deps.write(sessionMessageContext(message), (writer) => {
        recordMessageAcknowledgementDue(sequencer.sessionId, sequencer.env, {
          message_id: message.message_id,
          recorded_at: sequencer.wall(),
          text_required: message.agent_acknowledgement_text_required,
          ...(writer === 'subprocess' ? { queued_context: sessionMessageContext(message) } : {}),
        })
        owed = true
        if (handOff.begin(undefined, { subprocess: writer === 'subprocess' })) return true
        clearAcknowledgementObligation(sequencer.sessionId, sequencer.env, message.message_id)
        owed = false
        return false
      }, {
        // The lease check probes the harness and can block: the claim
        // deadline is judged after it, at the last moment before the byte.
        writable: () => attendant.mayWrite() && handOff.writable(),
        remainingMs: () => handOff.remainingMs(),
      }, (pgid) => handOff.recordGroup(pgid))
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
      case 'aborted':
        // Stopped at the socket before any byte left: nothing arrived, nothing is owed.
        clearAcknowledgementObligation(sequencer.sessionId, sequencer.env, message.message_id)
        await handOff.finish('aborted')
        return 'retry-soon'
      case 'unavailable':
      case 'stopped':
        await handOff.finish('not-written')
        return 'done'
    }
  }
  return 'done'
}
