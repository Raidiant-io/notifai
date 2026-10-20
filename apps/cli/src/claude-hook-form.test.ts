import { describe, expect, it } from 'vitest'
import { CLAUDE_EXEC_FORM_MIN_VERSION, claudeHookForm, describeClaudeHookForm, probeClaudeCodeVersion } from './claude-hook-form.js'

describe('Claude Code hook form', () => {
  it('reads the version from `claude --version` output, and nothing from no answer', () => {
    expect(probeClaudeCodeVersion({}, () => '2.1.304 (Claude Code)\n')).toBe('2.1.304')
    expect(probeClaudeCodeVersion({}, () => null)).toBeNull()
    expect(probeClaudeCodeVersion({}, () => 'claude: command not found')).toBeNull()
  })

  it('writes exec form only for a known version at or past the floor', () => {
    expect(CLAUDE_EXEC_FORM_MIN_VERSION).toBe('2.1.139')
    expect(claudeHookForm('2.1.139')).toMatchObject({ form: 'exec', reason: 'version-supported' })
    expect(claudeHookForm('2.1.304')).toMatchObject({ form: 'exec', reason: 'version-supported' })
    expect(claudeHookForm('2.1.138')).toMatchObject({ form: 'shell', reason: 'version-below-floor' })
    expect(claudeHookForm('1.0.0', true)).toMatchObject({ form: 'shell', reason: 'version-below-floor' })
    expect(claudeHookForm(null)).toMatchObject({ form: 'shell', reason: 'version-unknown' })
  })

  it('keeps an existing exec-form definition when the version cannot be read now', () => {
    expect(claudeHookForm(null, true)).toMatchObject({ form: 'exec', reason: 'version-unknown-kept-exec' })
  })

  it('says which form and why, in plain words', () => {
    expect(describeClaudeHookForm(claudeHookForm('2.1.304'))).toMatch(/^exec form: Claude Code 2\.1\.304/)
    expect(describeClaudeHookForm(claudeHookForm('2.1.100'))).toMatch(/^shell form: Claude Code 2\.1\.100 is older than 2\.1\.139/)
    expect(describeClaudeHookForm(claudeHookForm(null))).toMatch(/^shell form: the Claude Code version could not be read/)
  })
})
