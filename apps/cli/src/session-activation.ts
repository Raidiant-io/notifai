import type { HookHarness } from './hook-types.js'
import { Buffer } from 'node:buffer'
import { GUIDANCE_CONTEXT_MAX_BYTES, boundedEffectiveGuidance } from './guidance-render.js'

const ROOT_OWNERSHIP =
  'Notifai is enabled for this Project. You own Notification Requests unless explicitly assigned elsewhere. Load the Notifai skill before your first Notification Request. ' +
  'Follow the effective guidance below. Under it, when owned or coordinated work needs a User decision, approval, sign-in, credential setup or physical action, register with `notifai ask` in the same turn as the conversation question; conversation alone misses an away User. Ask for safe setup or readiness, never for credentials. Harness permission prompts stay in the harness. ' +
  'Missing readiness: `notifai init --json`.'

export const WORKER_ACTIVATION_CONTEXT =
  'Notifai worker context: an Agent Event is a meaningful occurrence in your work; a Notification Request is a deliberate User-visible message about one. Report Agent Events to the parent and do not send Notification Requests unless the parent explicitly delegated that ownership. If delegated, load the Notifai skill and run `notifai guidance` before composing one.'

export const MISSING_LIFECYCLE_GUIDANCE_CONTEXT =
  'Notifai lifecycle guidance could not be loaded, so Project Enablement is unverified. Run `notifai init --json` to check setup, then `notifai guidance` before deciding whether or how to send a Notification Request.'

function rootActivationContext(cwd: string, env: NodeJS.ProcessEnv, notice?: string): string {
  const opening = notice === undefined ? ROOT_OWNERSHIP : `${ROOT_OWNERSHIP}\n\n${notice}`
  const guidance = boundedEffectiveGuidance({
    cwd,
    env,
    maxBytes: GUIDANCE_CONTEXT_MAX_BYTES - Buffer.byteLength(`${opening}\n\n`, 'utf8'),
  })
  return `${opening}\n\n${guidance.ok ? guidance.content : guidance.fallback}`
}

/** One lifecycle meaning, encoded for each harness output contract. */
export function sessionActivationOutput(
  harness: HookHarness | undefined,
  hookEventName: 'SessionStart' | 'SubagentStart',
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  notice?: string,
): string | undefined {
  const context = hookEventName === 'SubagentStart'
    ? WORKER_ACTIVATION_CONTEXT
    : rootActivationContext(cwd, env, notice)
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
  notice?: string,
): string {
  return JSON.stringify({
    followup_message: rootActivationContext(cwd, env, notice),
  })
}
