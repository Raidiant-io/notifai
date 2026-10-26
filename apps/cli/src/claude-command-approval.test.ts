import { describe,expect,it } from 'vitest'
import {
addClaudeCommandRules,
CLAUDE_COMMAND_RULES,
claudeCommandReadiness
} from './claude-command-approval.js'

describe('Claude Code command rules', () => {
  it('covers sending, asking, reading, acknowledging and rerunning setup, and nothing that changes configuration', () => {
    for (const command of ['send', 'ask', 'receive', 'acknowledge', 'status', 'replies', 'close', 'init']) {
      expect(CLAUDE_COMMAND_RULES.some((rule) => rule.startsWith(`Bash(notifai ${command}`))).toBe(true)
    }
    for (const command of ['config', 'logout', 'auth', 'hooks', 'logs', 'update', 'project', 'guidance set', 'doctor']) {
      expect(CLAUDE_COMMAND_RULES.some((rule) => rule.startsWith(`Bash(notifai ${command} `) || rule === `Bash(notifai ${command})`)).toBe(false)
    }
    expect(CLAUDE_COMMAND_RULES.every((rule) => /^Bash\(notifai [a-z ]+( \*)?\)$/.test(rule))).toBe(true)
  })

  it('refuses to guess at a malformed permissions block', () => {
    expect(() => addClaudeCommandRules({ permissions: 'all' })).toThrow(/not an object/)
    expect(() => addClaudeCommandRules({ permissions: { allow: 'Bash' } })).toThrow(/not a list/)
  })
})

describe('Claude Code command approval readiness', () => {
  const offer = { by: 'cli', command: 'notifai init --claude-commands' }

  // Every mode but bypassPermissions asks, refuses (dontAsk) or leaves the
  // command to a reviewer (auto, plan) when no rule matches; a matching rule
  // runs it at once in each of them.
  it.each([null, 'default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'someFutureMode'])('offers the rules in %s mode', (mode) => {
    for (const context of mode === null ? [null, { permissionMode: null }] : [{ permissionMode: mode }]) {
      const state = claudeCommandReadiness(false, context)
      expect(state).toMatchObject({ id: 'claude-commands', status: 'optional-gap', remedy: offer, harnesses: ['claude-code'] })
      expect(state.detail).toMatch(/^not granted/)
    }
  })
})
