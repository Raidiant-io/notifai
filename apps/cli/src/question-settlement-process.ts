import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { HookInstallableHarness } from './harnesses.js'
import type { HookEnvelope } from './hooks.js'

/** Private handoff from the short prompt hook to its detached question owner. */
export const QUESTION_SETTLEMENT_INPUT_ENV = 'NOTIFAI_INTERNAL_QUESTION_SETTLEMENT_INPUT'

export interface QuestionSettlementLaunch {
  envelope: Pick<HookEnvelope, 'session_id' | 'cwd'>
  harness: HookInstallableHarness
}

/**
 * Launch the exact installed CLI build as a detached owner.
 *
 * UserPromptSubmit sits in front of the User's new turn, so it may only pay the
 * process-spawn cost. The child owns submission and the complete answer window.
 */
export function spawnQuestionSettlement(launch: QuestionSettlementLaunch): void {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./main.js', import.meta.url)),
      'hook',
      'question-settlement',
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
