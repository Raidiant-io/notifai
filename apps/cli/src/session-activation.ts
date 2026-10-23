import type { HookHarness } from './hook-types.js'
import { Buffer } from 'node:buffer'
import { guidanceDigest, guidanceText, guidanceGeneration, installedSkill } from './guidance-currency.js'
import { GUIDANCE_CONTEXT_MAX_BYTES, lifecycleGuidance } from './guidance-render.js'
import type { PendingNotice } from './pending-notice.js'

/** Words only the root activation carries; a plugin finds the activation in a conversation by them. */
export const ROOT_ACTIVATION_MARK = 'You own Notification Requests unless your assignment delegates them elsewhere.'

/**
 * The root activation. `skillFile` is the bundled skill, a pointer that works
 * where the harness has no copy installed; the digest uses the text without it.
 */
function rootOwnership(skillFile: string | null, request = false): string {
  return `${request ? 'Notifai guidance for this Notification Request.' : 'Notifai is enabled for this Project.'} ${ROOT_ACTIVATION_MARK} ` +
    'If another agent started this Agent Session with a task brief, that agent owns them unless the brief delegates them to you: report Agent Events to it and send none yourself. ' +
    `${skillFile === null ? 'Repair the Notifai skill with \`notifai init --skills\`, then load its verified copy' : `Read the Notifai skill at \`${skillFile}\``} before your first Notification Request; when your job changes completely, load it again and rename this Agent Session. ` +
    'The guidance below governs; unless it says otherwise, when work you own or coordinate needs a User decision, approval, sign-in, credential setup or physical action, register it with `notifai ask` in the same turn you ask it in the conversation: conversation alone misses an away User. ' +
    'When you brief an agent in its own Agent Session, name the Notification Request owner. Delegate the work the answers unblock with its Notification Requests. Ask the User from your own Agent Session when you will act on the answer. ' +
    'If you ask, do the work the answer unblocks before you report back, even when a brief says to end after asking. ' +
    'Ask for readiness, never for a credential. Harness permission prompts stay in the harness.'
}

const rootOwnershipText = (cwd: string, env: NodeJS.ProcessEnv, request = false): string => rootOwnership(installedSkill(cwd, env).file, request)

/** The digest of what a root Agent Session is given here (`guidance-currency.ts`). */
export function rootGuidanceDigest(cwd: string, env: NodeJS.ProcessEnv): string {
  return guidanceDigest({ cwd, env, activation: [rootOwnership(null), WORKER_ACTIVATION_CONTEXT,
    lifecycleGuidance({ cwd, env }).content].join('\n\n') })
}

/** Fresh effective text; never persisted in a receipt. */
export function rootGuidanceText(cwd: string, env: NodeJS.ProcessEnv) {
  return guidanceText({ cwd, env, activation: rootOwnership(null) + '\n\n' + WORKER_ACTIVATION_CONTEXT })
}

/** Delivery data shared by every lifecycle carrier. */
export function rootGuidanceDelivery(cwd: string, env: NodeJS.ProcessEnv, harness?: HookHarness, sessionId?: string) {
  const generation = sessionId === undefined ? undefined : guidanceGeneration(sessionId, env)
  return { generation, digest: rootGuidanceDigest(cwd, env), text: rootGuidanceText(cwd, env), skill: installedSkill(cwd, env),
    initialContext: rootActivationContext(cwd, env, [], harness === 'hermes' ? HERMES_SECTION_MAX_BYTES : GUIDANCE_CONTEXT_MAX_BYTES) }
}

export const WORKER_ACTIVATION_CONTEXT =
  'Notifai worker context: report Agent Events (work finished, failed, blocked, or needing the User) to your parent, which decides what reaches the User. Send no Notification Request yourself unless your assignment delegates them to you; then load the Notifai skill and run `notifai guidance` before your first one. If you ask, follow what `ask` prints.'

function workerActivationContext(_currency?: string): string {
  return WORKER_ACTIVATION_CONTEXT
}

export const MISSING_LIFECYCLE_GUIDANCE_CONTEXT =
  'Notifai lifecycle guidance could not be loaded, so Project Enablement is unverified. Run `notifai doctor --json` to check setup, then `notifai guidance` before deciding whether or how to notify.'

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
 * Ownership first, then what the session must reload (`currency`), then the
 * notices that still fit, then the guidance. The guidance is sized before any
 * notice, so a notice can never push a topic out; a notice without room stays
 * due for a later session instead of being spent.
 */
function rootActivationContext(
  cwd: string,
  env: NodeJS.ProcessEnv,
  notices: readonly PendingNotice[] = [],
  maxBytes = GUIDANCE_CONTEXT_MAX_BYTES,
  currency?: string,
  request = false,
): string {
  const head = [rootOwnershipText(cwd, env, request), ...(currency === undefined ? [] : [currency])].join('\n\n')
  const guidance = lifecycleGuidance({ cwd, env, maxBytes: maxBytes - bytes(`${head}\n\n`) }).content
  const shown = claimNotices(notices, maxBytes - bytes(`${head}\n\n${guidance}`))
  return [head, ...shown, guidance].join('\n\n')
}

/** Explicit reads do not assert lifecycle enablement: first use and
 * Projectless requests need guidance before any permission or sending step. */
export function requestGuidanceContext(cwd: string, env: NodeJS.ProcessEnv, currency?: string): string {
  return rootActivationContext(cwd, env, [], GUIDANCE_CONTEXT_MAX_BYTES, currency, true)
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
function hermesRootSections(cwd: string, env: NodeJS.ProcessEnv, notices: readonly PendingNotice[],
  currency?: string): HermesActivationSections {
  const guidance = lifecycleGuidance({ cwd, env, maxBytes: HERMES_SECTION_MAX_BYTES }).content
  const ownership = [rootOwnershipText(cwd, env), ...(currency === undefined ? [] : [currency])].join('\n\n')
  const head = `${ownership}\n\n${HERMES_GUIDANCE_MISSING_POINTER}`
  const room = Math.min(HERMES_SECTION_MAX_BYTES, HERMES_SECTIONS_MAX_BYTES - bytes(guidance)) - bytes(head)
  const shown = claimNotices(notices, room)
  return {
    activation: [ownership, ...shown, HERMES_GUIDANCE_MISSING_POINTER].join('\n\n'),
    guidance,
  }
}

/** Grok caps model-visible hook feedback at 10,000 characters. Leave room for
 * the harness wrapper and bound the effective guidance before serialization. */
export const GROK_ACTIVATION_MAX_BYTES = 9_000

/** Grok's bounded activation, retaining unclaimed notices for a later turn. */
export function grokActivationContext(cwd: string, env: NodeJS.ProcessEnv, worker: boolean,
  notices: readonly PendingNotice[] = [], currency?: string): string {
  return worker ? workerActivationContext(currency) : rootActivationContext(cwd, env, notices, GROK_ACTIVATION_MAX_BYTES, currency)
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
  /** What a starting root session must reload (`guidance-currency.ts`). */
  currency?: string,
): string | undefined {
  if (harness === 'hermes' && hermesSections) {
    const sections: HermesActivationSections = hookEventName === 'SubagentStart'
      ? { activation: workerActivationContext(currency), guidance: '' }
      : hermesRootSections(cwd, env, notices, currency)
    return JSON.stringify(sections)
  }
  const context = hookEventName === 'SubagentStart'
    ? workerActivationContext(currency)
    : rootActivationContext(cwd, env, notices, harness === 'hermes' ? HERMES_SECTION_MAX_BYTES : GUIDANCE_CONTEXT_MAX_BYTES, currency)
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
