import type { HookHarness } from './hook-types.js'
import { Buffer } from 'node:buffer'
import { GUIDANCE_CONTEXT_MAX_BYTES, lifecycleGuidance } from './guidance-render.js'
import type { PendingNotice } from './pending-notice.js'

const ROOT_OWNERSHIP =
  'Notifai is enabled for this Project. You own Notification Requests unless your assignment delegates them elsewhere. ' +
  'Load the Notifai skill before your first Notification Request; when your job changes completely, load it again and rename this Agent Session. ' +
  'The guidance below governs; unless it says otherwise, when work you own or coordinate needs a User decision, approval, sign-in, credential setup or physical action, register it with `notifai ask` in the same turn you ask it in the conversation: conversation alone misses an away User. ' +
  'Ask for readiness, never for a credential. Harness permission prompts stay in the harness.'

export const WORKER_ACTIVATION_CONTEXT =
  'Notifai worker context: report Agent Events (work finished, failed, blocked, or needing the User) to your parent, which decides what reaches the User. Send no Notification Request yourself unless your assignment delegates them to you; then load the Notifai skill and run `notifai guidance` before your first one.'

export const MISSING_LIFECYCLE_GUIDANCE_CONTEXT =
  'Notifai lifecycle guidance could not be loaded, so Project Enablement is unverified. Run `notifai init --json` to check setup, then `notifai guidance` before deciding whether or how to notify.'

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/** Claim the notices that fit in `room` bytes, in order; a notice without room stays due. */
function claimNotices(notices: readonly PendingNotice[], room: number): string[] {
  const shown: string[] = []
  for (const notice of notices) {
    const cost = bytes(`${notice.text}\n\n`)
    if (cost > room || !notice.claim()) continue
    shown.push(notice.text)
    room -= cost
  }
  return shown
}

/**
 * Ownership first, then the notices that still fit, then the guidance. The
 * guidance is sized before any notice, so a notice can never push a topic out;
 * a notice without room stays due for a later session instead of being spent.
 */
function rootActivationContext(
  cwd: string,
  env: NodeJS.ProcessEnv,
  notices: readonly PendingNotice[] = [],
  maxBytes = GUIDANCE_CONTEXT_MAX_BYTES,
): string {
  const guidance = lifecycleGuidance({ cwd, env, maxBytes: maxBytes - bytes(`${ROOT_OWNERSHIP}\n\n`) }).content
  const shown = claimNotices(notices, maxBytes - bytes(`${ROOT_OWNERSHIP}\n\n${guidance}`))
  return [ROOT_OWNERSHIP, ...shown, guidance].join('\n\n')
}

/**
 * Hermes prompt sections hold at most 4,000 characters; bytes are counted
 * here, which is never fewer, with a margin for the section frame.
 */
const HERMES_ACTIVATION_MAX_BYTES = 3_900

/** Grok caps model-visible hook feedback at 10,000 characters. Leave room for
 * the harness wrapper and bound the effective guidance before serialization. */
export function grokActivationContext(cwd: string, env: NodeJS.ProcessEnv, worker: boolean): string {
  return worker ? WORKER_ACTIVATION_CONTEXT : rootActivationContext(cwd, env, [], 9_000)
}

/** One lifecycle meaning, encoded for each harness output contract. */
export function sessionActivationOutput(
  harness: HookHarness | undefined,
  hookEventName: 'SessionStart' | 'SubagentStart',
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  notices: readonly PendingNotice[] = [],
): string | undefined {
  const context = hookEventName === 'SubagentStart'
    ? WORKER_ACTIVATION_CONTEXT
    : rootActivationContext(cwd, env, notices, harness === 'hermes' ? HERMES_ACTIVATION_MAX_BYTES : GUIDANCE_CONTEXT_MAX_BYTES)
  if (harness === 'opencode' || harness === 'openclaw' || harness === 'hermes') return context
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
