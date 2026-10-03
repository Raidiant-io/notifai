/** A trusted Codex tool boundary observes the turn and drains shared pending input. */
import { drainSessionInputs, hasSessionInputs } from './session-inputs.js'
import { type CommandDeps, makeClient } from './commands-core.js'
import { readSessionIncarnation, readSessionState, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import type { HookEnvelope } from './hook-types.js'
import type { Logger } from './logging.js'
import { codexHookIdentityHash, codexTrustKey, codexTrustProblems, findInstallations, handlerEvent } from './install-hooks.js'
import { currentProcessIdentity, processIdentityLiveness } from './process-identity.js'
import { currentCodexTurn, readAttendantLease, recordTurnStart } from './session-attendant-state.js'
import { codexInputLifecycleEnabled, refreshCodexInputActivity } from './codex-input-lifecycle.js'

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
  const incarnation = readSessionIncarnation(sessionId, deps.env)
  const turn = incarnation === null ? null : currentCodexTurn(sessionId, deps.env, incarnation.key)
  return fingerprint !== null && proof?.fingerprint === fingerprint &&
    proof.incarnation === incarnation?.incarnation && proof.root_observed !== undefined &&
    (turn === null || proof.root_observed.turn_id === turn)
}

export const CODEX_TOOL_HOOK_RECOVERY = 'Wait for a real tool callback in this turn. If tools complete but this remains unverified, Codex may retain an older hook configuration in memory even when /hooks lists trusted, active definitions. In the existing session, open /hooks and toggle only the already-trusted Notifai PostToolUse handler off and back on to refresh it, then verify the next callback. Do not change approvals or end the Agent Session. The ordinary queue can wait until the active turn finishes; queue acceptance does not prove busy delivery.'

/** Notes and answers share one bounded stdout document at the trusted boundary. */
export async function deliverCodexToolMessage(
  deps: CommandDeps, envelope: HookEnvelope, logger: Logger,
): Promise<void> {
  const sessionId = envelope.session_id
  if (sessionId === undefined || envelope.hook_event_name !== 'PostToolUse' ||
      typeof envelope.turn_id !== 'string' || envelope.turn_id === '') return
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
  if (fingerprint === null || sessionHasEnded(sessionId, deps.env) ||
      processIdentityLiveness(owner) !== 'alive') return
  // Automatic continuations need not emit UserPromptSubmit. A trusted,
  // synchronous tool callback from this exact owner is also a turn observation.
  // recordTurnStart ignores previously seen/ended turns, so a late callback
  // cannot resurrect an interrupted turn or replace a newer observed turn.
  if (currentCodexTurn(sessionId, deps.env, incarnation.key) !== envelope.turn_id) {
    recordTurnStart(sessionId, deps.env, incarnation.key, envelope.turn_id)
  }
  if (!mayWrite()) return
  if (codexInputLifecycleEnabled(deps.env)) refreshCodexInputActivity(sessionId, deps.env, incarnation.key, envelope.transcript_path)
  const proof = readSessionState(sessionId, deps.env).codex_tool_hook
  if (proof?.incarnation !== lease.incarnation || proof.fingerprint !== fingerprint ||
      proof.root_observed?.turn_id !== envelope.turn_id) {
    updateSessionState(sessionId, deps.env, (state) => ({
      ...state, codex_tool_hook: { incarnation: lease.incarnation, fingerprint,
        root_observed: { turn_id: envelope.turn_id!, at: (deps.now ?? Date.now)() } },
    }))
  }
  if (!hasSessionInputs(sessionId, deps.env, lease) || !mayWrite()) return
  const credential = deps.store.load()
  const writer = currentProcessIdentity()
  if (credential === null || writer === null) return
  const now = deps.now ?? Date.now
  const deadlineAt = now() + 2_000
  const client = makeClient(deps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`, {
    timeoutMs: 750, deadlineAt, now,
  })
  await drainSessionInputs({
    lease,
    mayWrite: () => now() < deadlineAt && mayWrite(),
    sequencer: {
      sessionId, env: deps.env, client, writer, log: logger,
      monotonic: () => performance.now(), wall: now,
      recoveryDeadline: performance.now() + 500,
      sleep: async (ms) => { if (now() < deadlineAt) await new Promise((resolve) => setTimeout(resolve, Math.min(ms, deadlineAt - now()))) },
    },
    write: (text) => deps.io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })),
  })
}
