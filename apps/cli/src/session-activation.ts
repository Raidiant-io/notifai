import type { HookHarness } from './hook-types.js'
import { Buffer } from 'node:buffer'
import { GUIDANCE_CONTEXT_MAX_BYTES, boundedEffectiveGuidance } from './guidance-render.js'

const ROOT_OWNERSHIP =
  'Notifai is enabled for this Project. The effective, provenance-marked guidance below governs Notification Requests. ' +
  'Missing CLI readiness is handled through `notifai init --json`.'

export const WORKER_ACTIVATION_CONTEXT =
  'Notifai worker context: an Agent Event is a meaningful occurrence in your work; a Notification Request is a deliberate User-visible message about one. Report Agent Events to the parent and do not send Notification Requests unless the parent explicitly delegated that ownership. If delegated, load the Notifai skill and run `notifai guidance` before composing one.'

export const MISSING_LIFECYCLE_GUIDANCE_CONTEXT =
  'Notifai is active, but lifecycle guidance could not be loaded. Run `notifai guidance` once before deciding whether or how to send a Notification Request.'

function rootActivationContext(cwd: string, env: NodeJS.ProcessEnv): string {
  const guidance = boundedEffectiveGuidance({
    cwd,
    env,
    maxBytes: GUIDANCE_CONTEXT_MAX_BYTES - Buffer.byteLength(`${ROOT_OWNERSHIP}\n\n`, 'utf8'),
  })
  return `${ROOT_OWNERSHIP}\n\n${guidance.ok ? guidance.content : guidance.fallback}`
}

/** One lifecycle meaning, encoded for each harness output contract. */
export function sessionActivationOutput(
  harness: HookHarness | undefined,
  hookEventName: 'SessionStart' | 'SubagentStart',
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const context = hookEventName === 'SubagentStart'
    ? WORKER_ACTIVATION_CONTEXT
    : rootActivationContext(cwd, env)
  if (harness === 'opencode' || harness === 'openclaw') return context
  if (harness === 'cursor') {
    return JSON.stringify({ additional_context: context })
  }
  if (harness === 'claude-code' || harness === 'codex') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext: context,
      },
    })
  }
  return undefined
}

/** Inject a journaled device answer into the User's new turn. */
export function userPromptContextOutput(
  harness: HookHarness | undefined,
  context: string,
): string | undefined {
  if (harness === 'opencode' || harness === 'openclaw') return context
  if (harness === 'cursor') return JSON.stringify({ additional_context: context })
  if (harness === 'claude-code' || harness === 'codex') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
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
export function cursorStopActivationOutput(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return JSON.stringify({
    followup_message: rootActivationContext(cwd, env),
  })
}
