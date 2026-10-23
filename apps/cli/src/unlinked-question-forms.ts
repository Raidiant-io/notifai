/** Unlinked form guidance and Grok's before-open question-card gate.
 * Codex's synchronous form is warned after it returns; Grok can deny first.
 */
import type { CommandDeps } from './commands-core.js'
import { buildQuestions } from './commands-ask.js'
import { readSessionState } from './hook-session-state.js'
import { findOpenEqualQuestion } from './question-guard.js'
import { withoutRecommendedSuffix } from './claude-question-bindings.js'
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
    'the work still needs one and it is not already registered, register that question with notifai ask and ask it in plain conversation. ' +
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

/** Refuse an unlinked Grok card before it opens; an exact registered question stays local. */
export function grokQuestionFormGate(
  deps: Pick<CommandDeps, 'env' | 'store' | 'io'>, envelope: HookEnvelope, cwd: string,
): void {
  if (unlinkedQuestionFormContext(deps, envelope, 'grok', cwd) === undefined) return
  const raw = envelope.tool_input
  if (typeof raw === 'object' && raw !== null && envelope.session_id !== undefined) {
    const record = raw as Record<string, unknown>
    const entries = Array.isArray(record['questions']) ? record['questions'] : [record]
    const questions = entries.map(entry => {
      if (typeof entry !== 'object' || entry === null) return null
      const item = entry as Record<string, unknown>
      const options = item['options']
      return { text: item['question'], ...(Array.isArray(options) && options.length > 0 ? {
        choices: options.map(option => {
          const label = typeof option === 'string' ? option : (option as { label?: unknown })?.label
          return typeof label === 'string' ? (withoutRecommendedSuffix(label) ?? label) : label
        }),
      } : {}), ...(item['multiSelect'] === true || item['multiple'] === true ? { multi: true } : {}) }
    })
    const built = buildQuestions({ form: JSON.stringify({ summary: 'Grok question', questions }) }, undefined)
    if (built.ok && findOpenEqualQuestion(readSessionState(envelope.session_id, deps.env), built.questions) !== undefined) return
  }
  deps.io.out(JSON.stringify({ decision: 'deny', reason:
    "Notifai cannot carry Grok's question card to the User's devices. Register this question with notifai ask and ask it in the conversation; if it is already registered, do not ask it again." }))
}
