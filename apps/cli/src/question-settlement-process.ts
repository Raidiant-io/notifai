import { launchSelf } from './launch-self.js'
import { retainSessionRuntime } from './runtime-build-retention.js'
import type { HookInstallableHarness } from './harnesses.js'
import type { HookEnvelope } from './hook-types.js'
import { hubSupported } from './hub-ipc.js'
import { handToHub } from './hub-client.js'
import { finishBeforeExit } from './exit-work.js'

/** Private handoff to detached question submission or answer ownership. */
export const QUESTION_SETTLEMENT_INPUT_ENV = 'NOTIFAI_INTERNAL_QUESTION_SETTLEMENT_INPUT'

export interface QuestionSettlementLaunch {
  envelope: Pick<HookEnvelope, 'session_id' | 'cwd'>
  harness: HookInstallableHarness
  /** Submission never consumes an answer or writes discarded harness stdout. */
  purpose?: 'submission'
  /** Internal callers already inside the session lock must not reacquire it. */
  sessionLockHeld?: boolean
  /** A hook's share of its harness timeout for the Windows detach hand-off. */
  detachTimeoutMs?: number
}

/**
 * Give question submission or answer ownership to its long-lived owner.
 *
 * Where the hub runs (macOS, Linux), the hub owns it in-process: one shared
 * process instead of one detached process per question. The request is sent
 * after the caller's own work; if no hub can be reached in time, the detached
 * owner starts exactly as before, so a question is never left without one.
 * Elsewhere the detached owner starts directly.
 */
export function spawnQuestionSettlement(launch: QuestionSettlementLaunch): void {
  if (!hubSupported() || launch.envelope.session_id === undefined) {
    launchDetachedSettlement(launch)
    return
  }
  const env = process.env
  finishBeforeExit(handToHub(env, {
    type: 'settle',
    session_id: launch.envelope.session_id,
    harness: launch.harness,
    ...(launch.envelope.cwd === undefined ? {} : { cwd: launch.envelope.cwd }),
    purpose: launch.purpose === 'submission' ? 'submission' : 'settlement',
  }, { startWaitMs: 3_000 }).then((reply) => {
    if (reply?.['type'] !== 'ok') launchDetachedSettlement({ ...launch, sessionLockHeld: false })
  }).catch(() => {
    launchDetachedSettlement({ ...launch, sessionLockHeld: false })
  }))
}

/** Launch the exact installed CLI build as a detached owner. */
function launchDetachedSettlement(launch: QuestionSettlementLaunch): void {
  launchSelf(['hook', launch.purpose === 'submission' ? 'question-submission' : 'question-settlement',
    '--owner', 'notifai', '--harness', launch.harness], {
    cwd: launch.envelope.cwd ?? process.cwd(),
    env: { ...process.env, [QUESTION_SETTLEMENT_INPUT_ENV]: JSON.stringify(launch.envelope) },
    ...(launch.detachTimeoutMs === undefined ? {} : { detachTimeoutMs: launch.detachTimeoutMs }),
    retain(reference) {
      if (reference === null) return
      if (!launch.envelope.session_id) throw new Error('Resident work requires an Agent Session')
      retainSessionRuntime(launch.envelope.session_id, process.env, reference, launch.sessionLockHeld)
    },
  })
}
