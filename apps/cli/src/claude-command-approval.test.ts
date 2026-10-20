import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_COMMAND_RULES,
  addClaudeCommandRules,
  claudeCommandReadiness,
  claudeCommandsNotWritten,
  claudeLaunchMode,
  claudeSessionPermissionMode,
  claudeSettingsDefaultMode,
  missingClaudeCommandRules,
  readClaudePermissionMode,
  recordClaudePermissionMode,
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

describe('Claude Code command approval readiness', () => {
  const offer = { by: 'cli', command: 'notifai init --claude-commands' }

  it('offers the rules at a terminal outside Claude Code and in a default-mode session', () => {
    for (const context of [null, { permissionMode: 'default' }]) {
      const state = claudeCommandReadiness(false, context)
      expect(state).toMatchObject({ id: 'claude-commands', status: 'optional-gap', remedy: offer, harnesses: ['claude-code'] })
      expect(state.detail).toContain('default mode')
    }
  })

  it.each(['auto', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'])('reports the rules as not applicable in %s mode, with no offer', (mode) => {
    const state = claudeCommandReadiness(false, { permissionMode: mode })
    expect(state).toMatchObject({ status: 'ready', technical: { permission_mode: mode, applicable: false } })
    expect(state.remedy).toBeUndefined()
    expect(state.detail).toContain(`\`${mode}\``)
    expect(state.detail).toMatch(/^not applicable/)
  })

  it('offers the rules inside a session nothing names a mode for, as in first-time setup', () => {
    const state = claudeCommandReadiness(false, { permissionMode: null })
    expect(state).toMatchObject({ status: 'optional-gap', remedy: offer, technical: { permission_mode: null, applicable: true } })
  })

  it('learns the mode from the hooks first, then the launch, then the settings', () => {
    expect(claudeSessionPermissionMode({ reported: 'default', launch: 'auto', settings: 'plan' })).toEqual({ mode: 'default', source: 'hook' })
    expect(claudeSessionPermissionMode({ reported: null, launch: 'bypassPermissions', settings: 'default' })).toEqual({ mode: 'bypassPermissions', source: 'launch' })
    expect(claudeSessionPermissionMode({ reported: null, launch: null, settings: 'auto' })).toEqual({ mode: 'auto', source: 'settings' })
    expect(claudeSessionPermissionMode({ reported: null, launch: null, settings: null })).toBeNull()
  })

  it('reads the launch mode from the Claude Code command line', () => {
    expect(claudeLaunchMode(['claude', '--dangerously-skip-permissions'])).toBe('bypassPermissions')
    expect(claudeLaunchMode(['claude', '--model', 'x', '--permission-mode', 'auto'])).toBe('auto')
    expect(claudeLaunchMode(['claude', '--permission-mode=plan'])).toBe('plan')
    expect(claudeLaunchMode(['claude', '--permission-mode', '$(x)'])).toBeNull()
    expect(claudeLaunchMode(['claude', '--resume', 'abc'])).toBeNull()
    expect(claudeLaunchMode(null)).toBeNull()
  })

  it('reads defaultMode from the most specific settings file that names one', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nf-claude-default-mode-'))
    const project = path.join(root, 'project')
    const env = { HOME: root, CLAUDE_CONFIG_DIR: path.join(root, 'claude') }
    mkdirSync(path.join(project, '.claude'), { recursive: true })
    mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
    expect(claudeSettingsDefaultMode(env, [project])).toBeNull()
    writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'auto' } }))
    expect(claudeSettingsDefaultMode(env, [project])).toBe('auto')
    writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'default' } }))
    expect(claudeSettingsDefaultMode(env, [project])).toBe('default')
    writeFileSync(path.join(project, '.claude', 'settings.local.json'), '{ not json')
    expect(claudeSettingsDefaultMode(env, [project])).toBe('default')
  })

  it('says plainly why an explicit yes added nothing', () => {
    const notApplicable = claudeCommandReadiness(false, { permissionMode: 'auto', source: 'launch' })
    expect(claudeCommandsNotWritten(notApplicable, false, false)).toBe(
      "Claude Code command approval was not added: this session runs in Claude Code's `auto` permission mode, and the approval is only for its default mode. To add it, run `notifai init --claude-commands` from a terminal or from a Claude Code session in its default mode.",
    )
    expect(claudeCommandsNotWritten(undefined, false, false)).toMatch(/^Claude Code command approval was not added: Notifai is not set up for Claude Code/)
    expect(claudeCommandsNotWritten(claudeCommandReadiness(false, null), false, false)).toMatch(/setup stopped before it got there/)
    expect(claudeCommandsNotWritten(claudeCommandReadiness(false, null), false, true)).toBeNull()
    expect(claudeCommandsNotWritten(claudeCommandReadiness(true, null), true, false)).toBeNull()
  })

  it('reports granted rules as ready in any mode', () => {
    for (const context of [null, { permissionMode: 'default' }, { permissionMode: 'auto' }]) {
      const state = claudeCommandReadiness(true, context)
      expect(state.status).toBe('ready')
      expect(state.remedy).toBeUndefined()
    }
  })

  it('keeps only a well-formed mode for its session', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nf-claude-mode-'))
    const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state') }
    expect(readClaudePermissionMode('s1', env)).toBeNull()
    recordClaudePermissionMode('s1', env, 'plan')
    recordClaudePermissionMode('s1', env, 42)
    recordClaudePermissionMode('s1', env, '$(rm -rf /)')
    expect(readClaudePermissionMode('s1', env)).toBe('plan')
    expect(readClaudePermissionMode('s2', env)).toBeNull()
  })
})
