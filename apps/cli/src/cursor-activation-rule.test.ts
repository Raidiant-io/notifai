import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cursorActivationRuleFile,
  cursorActivationRuleProblems,
  inspectCursorActivationRule,
  installCursorActivationRule,
  removeCursorActivationRule,
  renderCursorActivationRule,
} from './cursor-activation-rule.js'
import { findInstallations } from './install-hooks.js'

function freshEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cursor-rule-'))
  return { HOME: root, USERPROFILE: root }
}

describe('Cursor activation rule', () => {
  it('is an always-applied skill that stays short and defers to delivered session context', () => {
    const rule = renderCursorActivationRule()
    // Cursor turns a skill with `alwaysApply: true` into a rule for every workspace.
    expect(rule).toMatch(/^---\nname: notifai-activation\ndescription: [^\n]+\nalwaysApply: true\n---\n/)
    // The whole file rides every Cursor conversation on the machine.
    expect(rule.length).toBeLessThan(1_500)
    expect(rule).toContain('"Notifai is enabled for this Project"')
    expect(rule).toContain('`notifai project status`')
    expect(rule).toContain('`notifai guidance`')
    expect(rule).toMatch(/does not act|do not act on this rule again/i)
  })

  it('writes once, reports drift, and leaves a file Notifai did not write alone', () => {
    const env = freshEnv()
    const file = cursorActivationRuleFile(env, 'darwin')
    expect(file).toBe(path.join(env.HOME!, '.cursor', 'skills', 'notifai-activation', 'SKILL.md'))
    expect(cursorActivationRuleProblems(env, 'darwin')).toEqual([expect.stringContaining('is missing')])

    expect(installCursorActivationRule(env, 'darwin')).toBe(true)
    expect(installCursorActivationRule(env, 'darwin')).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(renderCursorActivationRule())
    expect(cursorActivationRuleProblems(env, 'darwin')).toEqual([])

    writeFileSync(file, renderCursorActivationRule().replace('Notifai is installed', 'Notifai was installed'))
    expect(inspectCursorActivationRule(env, 'darwin').condition).toBe('outdated')
    expect(cursorActivationRuleProblems(env, 'darwin')).toEqual([expect.stringContaining('is outdated')])
    expect(installCursorActivationRule(env, 'darwin')).toBe(true)
    expect(inspectCursorActivationRule(env, 'darwin').condition).toBe('current')

    writeFileSync(file, '---\nname: someone-else\n---\nTheirs.\n')
    expect(inspectCursorActivationRule(env, 'darwin').condition).toBe('foreign')
    expect(() => installCursorActivationRule(env, 'darwin')).toThrow(/Notifai did not write it/)
    expect(removeCursorActivationRule(env, 'darwin')).toBe('foreign')
    expect(readFileSync(file, 'utf8')).toBe('---\nname: someone-else\n---\nTheirs.\n')
  })

  it('removes its directory only when nothing else lives there', () => {
    const env = freshEnv()
    const file = cursorActivationRuleFile(env, 'darwin')
    expect(removeCursorActivationRule(env, 'darwin')).toBe('absent')

    installCursorActivationRule(env, 'darwin')
    expect(removeCursorActivationRule(env, 'darwin')).toBe('removed')
    expect(existsSync(path.dirname(file))).toBe(false)

    installCursorActivationRule(env, 'darwin')
    writeFileSync(path.join(path.dirname(file), 'notes.md'), 'kept')
    expect(removeCursorActivationRule(env, 'darwin')).toBe('removed')
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(path.join(path.dirname(file), 'notes.md'), 'utf8')).toBe('kept')
  })

  it('makes a Machine Cursor installation without the rule a fault doctor reports', () => {
    const env = freshEnv()
    const hooks = path.join(env.HOME!, '.cursor', 'hooks.json')
    mkdirSync(path.dirname(hooks), { recursive: true })
    writeFileSync(hooks, JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ command: '/opt/notifai hook session-start --owner notifai --harness cursor' }] },
    }))
    const cursor = () => findInstallations(env, undefined, 'darwin').find((entry) => entry.harness === 'cursor')
    expect(cursor()?.problems).toEqual(expect.arrayContaining([expect.stringContaining('notifai-activation/SKILL.md is missing')]))

    installCursorActivationRule(env, 'darwin')
    expect(cursor()?.problems ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining('notifai-activation')]))
  })
})
