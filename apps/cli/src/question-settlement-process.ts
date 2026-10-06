import { launchSelf } from './launch-self.js'
import { retainSessionRuntime } from './runtime-build-retention.js'
import type { HookInstallableHarness } from './harnesses.js'
import type { HookEnvelope } from './hook-types.js'

/** Private handoff to detached question submission or answer ownership. */
export const QUESTION_SETTLEMENT_INPUT_ENV = 'NOTIFAI_INTERNAL_QUESTION_SETTLEMENT_INPUT'

export interface QuestionSettlementLaunch {
  envelope: Pick<HookEnvelope, 'session_id' | 'cwd'>
  harness: HookInstallableHarness
  /** Submission never consumes an answer or writes discarded harness stdout. */
  purpose?: 'submission'
  /** Internal callers already inside the session lock must not reacquire it. */
  sessionLockHeld?: boolean
}

/**
 * Launch the exact installed CLI build as a detached owner.
 *
 * Ask and prompt hooks pay only process startup. Submission owns admission;
 * settlement separately observes the complete answer window.
 */
export function spawnQuestionSettlement(launch: QuestionSettlementLaunch): void {
  launchSelf(['hook', launch.purpose === 'submission' ? 'question-submission' : 'question-settlement',
    '--owner', 'notifai', '--harness', launch.harness], {
    cwd: launch.envelope.cwd ?? process.cwd(),
    env: { ...process.env, [QUESTION_SETTLEMENT_INPUT_ENV]: JSON.stringify(launch.envelope) },
    retain(reference) {
      if (reference === null) return
      if (!launch.envelope.session_id) throw new Error('Resident work requires an Agent Session')
      retainSessionRuntime(launch.envelope.session_id, process.env, reference, launch.sessionLockHeld)
    },
  })
}
