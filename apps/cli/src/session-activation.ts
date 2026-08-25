import type { HookHarness } from './hooks.js'

/**
 * Model-visible session bootstrap. It names the installed capability and its
 * authoritative sources without restating any notification policy that the
 * user may have overridden.
 */
export const SESSION_ACTIVATION_CONTEXT =
  'Notifai is active for this session, even when the user did not mention it. ' +
  'Before beginning task work, use the Notifai skill and run `notifai guidance`; its resolved guidance governs notification decisions for Agent Events. ' +
  'Missing skill or CLI readiness is handled through `notifai init` and its diagnosis. ' +
  'For delegated work, the parent owns User-visible Notification Requests unless it explicitly delegates that ownership; workers report Agent Events to the parent and do not send independently.'

/** One lifecycle meaning, encoded for each harness output contract. */
export function sessionActivationOutput(
  harness: HookHarness | undefined,
  hookEventName: 'SessionStart' | 'SubagentStart' | 'UserPromptSubmit',
): string | undefined {
  if (harness === 'cursor') {
    return JSON.stringify({ additional_context: SESSION_ACTIVATION_CONTEXT })
  }
  if (harness === 'claude-code' || harness === 'codex') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext: SESSION_ACTIVATION_CONTEXT,
      },
    })
  }
  return undefined
}

/**
 * Cursor currently accepts sessionStart context without reliably delivering it
 * to the model. Its native post-Stop follow-up is the narrow fallback and is
 * claimed once per conversation by the hook-state layer.
 */
export function cursorStopActivationOutput(): string {
  return JSON.stringify({
    followup_message: SESSION_ACTIVATION_CONTEXT.replace(
      'Before beginning task work,',
      'Before finalizing the Agent Event from the turn that just ended,',
    ),
  })
}
