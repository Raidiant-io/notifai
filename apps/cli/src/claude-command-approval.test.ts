import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe,expect,it } from 'vitest'
import {
addClaudeCommandRules,
CLAUDE_COMMAND_RULES,
claudeCommandReadiness,
claudeCommandRulesFile,
claudeCommandRulesInstalled,
claudeLegacyCommandRulesOnly,
installClaudeCommandRules,
LEGACY_CLAUDE_COMMAND_RULES,
removeClaudeCommandRules,
upgradeClaudeCommandRules
} from './claude-command-approval.js'

function claudeEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), 'claude-rules-'))
  return { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude') }
}

function writeSettings(env: NodeJS.ProcessEnv, document: unknown): string {
  const file = claudeCommandRulesFile(env)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`)
  return file
}

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as { permissions?: { allow?: string[]; deny?: string[]; ask?: string[] } }

/** The User's own rules, which Notifai never touches, including ones about notifai. */
const userRules = { allow: ['Bash(git status)', 'Bash(notifai-dev *)', 'Read(~/notes/**)'], deny: ['Bash(notifai logout)'], ask: ['Bash(notifai config *)'] }

describe('Claude Code command rules', () => {
  it('cover every Notifai command, with or without arguments', () => {
    expect(CLAUDE_COMMAND_RULES).toEqual(['Bash(notifai)', 'Bash(notifai *)'])
  })

  it('refuses to guess at a malformed permissions block', () => {
    expect(() => addClaudeCommandRules({ permissions: 'all' })).toThrow(/not an object/)
    expect(() => addClaudeCommandRules({ permissions: { allow: 'Bash' } })).toThrow(/not a list/)
  })

  it('replace an earlier Notifai list in place, keeping every rule of the User\'s', () => {
    const env = claudeEnv()
    const file = writeSettings(env, { model: 'opus', permissions: { ...userRules, allow: [userRules.allow[0], ...LEGACY_CLAUDE_COMMAND_RULES, ...userRules.allow.slice(1)] } })
    expect(claudeCommandRulesInstalled(env)).toBe(false)
    expect(claudeLegacyCommandRulesOnly(env)).toBe(true)
    expect(upgradeClaudeCommandRules(env)).toBe(true)
    expect(read(file)).toEqual({ model: 'opus', permissions: { ...userRules, allow: [...userRules.allow, ...CLAUDE_COMMAND_RULES] } })
    expect(claudeCommandRulesInstalled(env)).toBe(true)
    expect(claudeLegacyCommandRulesOnly(env)).toBe(false)
    expect(upgradeClaudeCommandRules(env)).toBe(false)
    expect(installClaudeCommandRules(env)).toBe(false)
  })

  it('never widen a partial earlier list unasked, and grant nothing where the User never did', () => {
    // A list missing entries may be the User's own narrowing; only setup widens it.
    const partial = claudeEnv()
    const narrowed = LEGACY_CLAUDE_COMMAND_RULES.filter((rule) => rule !== 'Bash(notifai init *)')
    const file = writeSettings(partial, { permissions: { allow: ['Bash(git status)', ...narrowed] } })
    const partialBefore = readFileSync(file, 'utf8')
    expect(claudeLegacyCommandRulesOnly(partial)).toBe(false)
    expect(upgradeClaudeCommandRules(partial)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(partialBefore)
    expect(installClaudeCommandRules(partial)).toBe(true)
    expect(read(file).permissions?.allow).toEqual(['Bash(git status)', ...CLAUDE_COMMAND_RULES])

    const never = claudeEnv()
    const untouched = writeSettings(never, { permissions: userRules })
    const before = readFileSync(untouched, 'utf8')
    expect(upgradeClaudeCommandRules(never)).toBe(false)
    expect(readFileSync(untouched, 'utf8')).toBe(before)
    expect(upgradeClaudeCommandRules(claudeEnv())).toBe(false)
  })

  it('leave with the wiring, current and earlier alike, and nothing else', () => {
    const document = { permissions: { ...userRules, allow: [...userRules.allow, ...LEGACY_CLAUDE_COMMAND_RULES, ...CLAUDE_COMMAND_RULES] } }
    expect(removeClaudeCommandRules(document)).toEqual({ document: { permissions: userRules }, changed: true })
    expect(removeClaudeCommandRules({ permissions: { allow: [...CLAUDE_COMMAND_RULES] } })).toEqual({ document: {}, changed: true })
    expect(removeClaudeCommandRules({ permissions: userRules })).toEqual({ document: { permissions: userRules }, changed: false })
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

  it('offers to widen an earlier Notifai list without a new consent question', () => {
    const state = claudeCommandReadiness(false, { permissionMode: 'default' }, true)
    expect(state).toMatchObject({ status: 'optional-gap', remedy: offer, technical: { earlier_rules: true } })
    expect(state.detail).toMatch(/^an earlier Notifai allowed only some/)
    expect(claudeCommandReadiness(false, { permissionMode: 'bypassPermissions' }, true).status).toBe('ready')
    expect(claudeCommandReadiness(true, null, false).detail).toBe('Claude Code runs every Notifai command without asking first')
  })
})
