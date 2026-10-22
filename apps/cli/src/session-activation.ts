import type { HookHarness } from './hook-types.js'
import { Buffer } from 'node:buffer'
import { GUIDANCE_CONTEXT_MAX_BYTES, lifecycleGuidance } from './guidance-render.js'
import type { PendingNotice } from './pending-notice.js'

const ROOT_OWNERSHIP =
  'Notifai is enabled for this Project. You own Notification Requests unless your assignment delegates them elsewhere. ' +
  'If another agent started this Agent Session with a task brief, that agent owns them unless the brief delegates them to you: report Agent Events to it and send none yourself. ' +
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
 * Hermes renders each plugin prompt section up to 4,000 characters; bytes are
 * counted here, which is never fewer, with a margin for the section frame.
 */
export const HERMES_SECTION_MAX_BYTES = 3_900

/**
 * Every plugin's prompt sections share 8,000 characters, frames included.
 * Notifai's two sections together stay within this, so they never crowd each
 * other out; only other plugins' sections can leave one out.
 */
export const HERMES_SECTIONS_MAX_BYTES = 7_700

/** Ends the first Hermes section, for when Hermes leaves the second one out. */
export const HERMES_GUIDANCE_MISSING_POINTER =
  'If Notifai\'s guidance is missing from this prompt, run `notifai guidance` before your first Notification Request or acknowledgement.'

/** The two Hermes prompt sections, in the order every other harness reads one context. */
export interface HermesActivationSections {
  /** Ownership, the notices that fit, and the pointer for a missing second section. */
  activation: string
  /** The trust text, terms, session topics and first-use pointer, or the overflow fallback; empty for a worker. */
  guidance: string
}

/**
 * Root context split across two Hermes sections, so Hermes carries the same
 * text as every other harness and still has room for notices and the User's
 * topics. Hermes may leave out either section, so each is safe alone: the
 * second is a whole lifecycle rendering, which opens with the trust text, and
 * the first carries only ownership, notices and a pointer to that rendering.
 */
function hermesRootSections(cwd: string, env: NodeJS.ProcessEnv, notices: readonly PendingNotice[]): HermesActivationSections {
  const guidance = lifecycleGuidance({ cwd, env, maxBytes: HERMES_SECTION_MAX_BYTES }).content
  const head = `${ROOT_OWNERSHIP}\n\n${HERMES_GUIDANCE_MISSING_POINTER}`
  const room = Math.min(HERMES_SECTION_MAX_BYTES, HERMES_SECTIONS_MAX_BYTES - bytes(guidance)) - bytes(head)
  const shown = claimNotices(notices, room)
  return {
    activation: [ROOT_OWNERSHIP, ...shown, HERMES_GUIDANCE_MISSING_POINTER].join('\n\n'),
    guidance,
  }
}

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
  /** Set by a Hermes plugin that renders two prompt sections; an older one renders one. */
  hermesSections = false,
): string | undefined {
  if (harness === 'hermes' && hermesSections) {
    const sections: HermesActivationSections = hookEventName === 'SubagentStart'
      ? { activation: WORKER_ACTIVATION_CONTEXT, guidance: '' }
      : hermesRootSections(cwd, env, notices)
    return JSON.stringify(sections)
  }
  const context = hookEventName === 'SubagentStart'
    ? WORKER_ACTIVATION_CONTEXT
    : rootActivationContext(cwd, env, notices, harness === 'hermes' ? HERMES_SECTION_MAX_BYTES : GUIDANCE_CONTEXT_MAX_BYTES)
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
