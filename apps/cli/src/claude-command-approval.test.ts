import { describe, expect, it } from 'vitest'
import {
  CLAUDE_COMMAND_RULES,
  addClaudeCommandRules,
  missingClaudeCommandRules,
  removeClaudeCommandRules,
} from './claude-command-approval.js'

describe('Claude Code command rules', () => {
  it('covers sending, asking, reading and acknowledging, and nothing that changes setup', () => {
    for (const command of ['send', 'ask', 'receive', 'acknowledge', 'status', 'replies', 'close']) {
      expect(CLAUDE_COMMAND_RULES.some((rule) => rule.startsWith(`Bash(notifai ${command}`))).toBe(true)
    }
    for (const command of ['init', 'config', 'logout', 'auth', 'hooks', 'logs', 'update', 'project', 'guidance set', 'doctor']) {
      expect(CLAUDE_COMMAND_RULES.some((rule) => rule.startsWith(`Bash(notifai ${command} `) || rule === `Bash(notifai ${command})`)).toBe(false)
    }
    expect(CLAUDE_COMMAND_RULES.every((rule) => /^Bash\(notifai [a-z ]+( \*)?\)$/.test(rule))).toBe(true)
  })

  it('adds the rules beside what the User already allowed and denied', () => {
    const before = { model: 'x', permissions: { defaultMode: 'default', allow: ['Bash(git status)'], deny: ['Read(.env)'] } }
    const { document, changed } = addClaudeCommandRules(before)
    expect(changed).toBe(true)
    expect(document).toMatchObject({ model: 'x', permissions: { defaultMode: 'default', deny: ['Read(.env)'] } })
    expect((document['permissions'] as { allow: string[] }).allow).toEqual(['Bash(git status)', ...CLAUDE_COMMAND_RULES])
    expect(missingClaudeCommandRules(document)).toEqual([])
    expect(addClaudeCommandRules(document)).toEqual({ document, changed: false })
    expect(before.permissions.allow).toEqual(['Bash(git status)'])
  })

  it('adds only the rules that are missing', () => {
    const { document } = addClaudeCommandRules({ permissions: { allow: ['Bash(notifai send *)'] } })
    const allow = (document['permissions'] as { allow: string[] }).allow
    expect(allow.filter((rule) => rule === 'Bash(notifai send *)')).toHaveLength(1)
    expect(new Set(allow)).toEqual(new Set(CLAUDE_COMMAND_RULES))
  })

  it('removes exactly its rules and leaves no empty shell behind', () => {
    const granted = addClaudeCommandRules({ hooks: {}, permissions: { allow: ['Bash(git status)'], deny: ['Read(.env)'] } }).document
    expect(removeClaudeCommandRules(granted).document).toEqual({ hooks: {}, permissions: { allow: ['Bash(git status)'], deny: ['Read(.env)'] } })
    expect(removeClaudeCommandRules(addClaudeCommandRules({ hooks: {} }).document)).toEqual({ document: { hooks: {} }, changed: true })
    expect(removeClaudeCommandRules({ permissions: { allow: ['Bash(git status)'] } }).changed).toBe(false)
    expect(removeClaudeCommandRules({}).changed).toBe(false)
  })

  it('refuses to guess at a malformed permissions block', () => {
    expect(() => addClaudeCommandRules({ permissions: 'all' })).toThrow(/not an object/)
    expect(() => addClaudeCommandRules({ permissions: { allow: 'Bash' } })).toThrow(/not a list/)
  })
})
