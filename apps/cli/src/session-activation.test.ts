import { expect, it } from 'vitest'
import { userPromptContextOutput } from './session-activation.js'

it('formats prompt-time context only for harnesses whose prompt hook can reach the model', () => {
  // Cursor's beforeSubmitPrompt accepts only continue/user_message and
  // OpenClaw's message_received discards hook output: context printed there
  // would be spent unseen. OpenCode 2's adapter injects plain text.
  expect(userPromptContextOutput('opencode', 'answer')).toBe('answer')
  for (const harness of ['cursor', 'openclaw', 'grok', 'hermes', undefined] as const) {
    expect(userPromptContextOutput(harness, 'answer')).toBeUndefined()
  }
  for (const harness of ['claude-code', 'codex'] as const) {
    expect(JSON.parse(userPromptContextOutput(harness, 'answer')!)).toEqual(
      { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'answer' } })
  }
})
