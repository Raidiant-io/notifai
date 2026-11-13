import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { lifecycleGuidance } from './guidance-render.js'
import { HERMES_SECTION_MAX_BYTES, userPromptContextOutput } from './session-activation.js'

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

it('keeps the default session guidance whole inside the smallest carrier, with room for the User', () => {
  // Hermes renders a prompt section of at most 3,900 bytes. When the default
  // topics outgrow it, every Hermes session silently gets the overflow
  // fallback instead of the guidance, and a slightly longer User topic does too.
  const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-guidance-budget-'))
  try {
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state') }
    const guidance = lifecycleGuidance({ cwd: home, env }).content
    expect(guidance).toContain('# Questions')
    expect(Buffer.byteLength(guidance, 'utf8')).toBeLessThanOrEqual(HERMES_SECTION_MAX_BYTES - 150)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it('keeps the skill short enough to survive being re-read after compaction', () => {
  // Harnesses re-attach a loaded skill within a bounded budget, so a long
  // skill is cut in exactly the long sessions that need it. Rules owned by a
  // guidance topic or a reference stay there.
  const skill = readFileSync(new URL('../../../skills/notifai/SKILL.md', import.meta.url), 'utf8')
  expect(skill.length).toBeLessThanOrEqual(15_840)
})
