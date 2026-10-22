/**
 * Harness question forms Notifai cannot carry to the User's devices: Codex's
 * synchronous `request_user_input` and Grok's question card. Both harnesses
 * hand hook context to the model only with the tool's result, so the
 * already-installed PostToolUse handler is the earliest moment a hook can
 * speak without denying the form; a deny would change how the question
 * behaves, and a new Codex handler would need the User's `/hooks` approval.
 */
import type { CommandDeps } from './commands-core.js'
import { loadConfig } from './config.js'
import type { HookEnvelope, HookHarness } from './hook-types.js'
import { projectBinding, projectDisabled } from './project-enablement.js'

const UNLINKED_FORMS: Partial<Record<HookHarness, readonly string[]>> = {
  codex: ['request_user_input'],
  // `AskQuestion` is the same card under Grok's Cursor preset.
  grok: ['ask_user_question', 'AskQuestion'],
}

const CONTEXT: Partial<Record<HookHarness, string>> = {
  codex: 'Notifai does not carry request_user_input to the User\'s devices, so that question reached this terminal only. ' +
    'Ask your next question with notifai ask, so an away User sees it too, and follow what it hands back.',
  grok: 'Notifai does not carry Grok\'s question card to the User\'s devices. If the card closed without an answer and ' +
    'the work still needs one, register that question with notifai ask and ask it in plain conversation. ' +
    'Ask every later question the same way.',
}

/**
 * Context for the root agent that just used an unlinked form, only where
 * Notifai would otherwise have carried the question: a signed-in machine, a
 * Project the User has not disabled, and question notifications on.
 */
export function unlinkedQuestionFormContext(
  deps: Pick<CommandDeps, 'env' | 'store'>, envelope: HookEnvelope, harness: HookHarness | undefined, cwd: string,
): string | undefined {
  if (harness === undefined || typeof envelope.tool_name !== 'string' ||
      !(UNLINKED_FORMS[harness] ?? []).includes(envelope.tool_name)) return undefined
  if (envelope.agent_id !== undefined || envelope.agent_type !== undefined ||
      (typeof envelope.subagentType === 'string' && envelope.subagentType !== '')) return undefined
  const config = loadConfig({ cwd, env: deps.env, sessionId: envelope.session_id })
  if (projectDisabled(projectBinding(cwd, deps.env, config.project.value)) || !config.ask_notifications.value) return undefined
  return deps.store.load() === null ? undefined : CONTEXT[harness]
}
