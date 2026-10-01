import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { HookInstallableHarness } from './harnesses.js'
import type { HookEnvelope } from './hook-types.js'

/** Private handoff to detached question submission or answer ownership. */
export const QUESTION_SETTLEMENT_INPUT_ENV = 'NOTIFAI_INTERNAL_QUESTION_SETTLEMENT_INPUT'

export interface QuestionSettlementLaunch {
  envelope: Pick<HookEnvelope, 'session_id' | 'cwd'>
  harness: HookInstallableHarness
  /** Submission never consumes an answer or writes discarded harness stdout. */
  purpose?: 'submission'
}

/**
 * Launch the exact installed CLI build as a detached owner.
 *
 * Ask and prompt hooks pay only process startup. Submission owns admission;
 * settlement separately observes the complete answer window.
 */
export function spawnQuestionSettlement(launch: QuestionSettlementLaunch): void {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./main.js', import.meta.url)),
      'hook',
      launch.purpose === 'submission' ? 'question-submission' : 'question-settlement',
      '--owner',
      'notifai',
      '--harness',
      launch.harness,
    ],
    {
      cwd: launch.envelope.cwd ?? process.cwd(),
      detached: true,
      env: {
        ...process.env,
        [QUESTION_SETTLEMENT_INPUT_ENV]: JSON.stringify(launch.envelope),
      },
      stdio: 'ignore',
      windowsHide: true,
    },
  )
  // Spawn failures are diagnosed by the next ordinary lifecycle hook, which
  // still owns the durable registration. Never turn one into a prompt delay.
  child.once('error', () => undefined)
  child.unref()
}
