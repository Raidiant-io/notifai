import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { globalConfigPath } from './config.js'
import { globalGuidanceDir } from './guidance.js'
import { lifecycleGuidance } from './guidance-render.js'
import { grokActivationContext, HERMES_SECTION_MAX_BYTES, ROOT_ACTIVATION_MARK, sessionActivationOutput, userPromptContextOutput } from './session-activation.js'

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

it('carries identity-free activation through every lifecycle encoding within its budget', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-activation-'))
  const cwd = path.join(root, 'work')
  mkdirSync(cwd)
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
  try {
    for (const oversized of [false, true]) {
      if (oversized) {
        mkdirSync(globalGuidanceDir(env), { recursive: true })
        writeFileSync(path.join(globalGuidanceDir(env), 'when-to-notify.md'), 'é'.repeat(8_000))
      }
      for (const harness of ['claude-code', 'codex', 'cursor', 'opencode', 'openclaw', 'hermes', 'grok'] as const) {
        const wire = harness === 'grok' ? grokActivationContext(cwd, env, false) : sessionActivationOutput(harness, 'SessionStart', cwd, env, [], harness === 'hermes')!
        const parsed = wire.startsWith('{') ? JSON.parse(wire) : wire
        const sections: string[] = harness === 'hermes' ? [parsed.activation, parsed.guidance]
          : [typeof parsed === 'string' ? parsed : parsed.additional_context ?? parsed.hookSpecificOutput.additionalContext]
        expect(sections.join('\n')).toContain(ROOT_ACTIVATION_MARK)
        expect(sections.join('\n')).toContain('--projectless')
        expect(sections.join('\n')).not.toMatch(/\bproject\b/i)
        if (harness === 'hermes') expect(sections.reduce((total, section) => total + Buffer.byteLength(section), 0)).toBeLessThanOrEqual(7_700)
        for (const section of sections) expect(Buffer.byteLength(section)).toBeLessThanOrEqual(harness === 'hermes' ? 3_900 : harness === 'grok' ? 9_000 : 10_000)
      }
    }
    execFileSync('git', ['init', '-q', cwd])
    expect(sessionActivationOutput('opencode', 'SessionStart', cwd, env)).toContain('Notifai is enabled for this Project.')
    mkdirSync(env.HOME, { recursive: true })
    writeFileSync(globalConfigPath(env), 'project = "configured-identity"\n')
    const configured = sessionActivationOutput('opencode', 'SessionStart', env.HOME, env)!
    expect(configured).toContain('Notifai is enabled for this Project.')
    expect(configured).not.toContain('--projectless')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
