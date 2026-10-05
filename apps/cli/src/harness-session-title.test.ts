import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ActiveHarnessSession } from './commands-harness-context.js'
import { SOURCE_CONTEXT_HARNESSES, type SourceContextHarness } from './harnesses.js'
import { readClaudeSessionTitle, readCodexSessionTitle, readHarnessSessionTitle, recordClaudeSessionTitle } from './harness-session-title.js'
import { readSessionState } from './hook-session-state.js'

function fixture(): { env: NodeJS.ProcessEnv; codexHome: string } {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-session-index-'))
  return { env: { CODEX_HOME: codexHome }, codexHome }
}

describe('harness-neutral Agent Session titles', () => {
  it('routes only source-declared harnesses plus generic scripts', () => {
    const cases: Record<
      SourceContextHarness,
      { active: ActiveHarnessSession; expected: string | undefined }
    > = {
      'claude-code': {
        active: { harness: 'claude-code', label: 'Claude Code', sessionId: 'claude-session' },
        expected: undefined,
      },
      codex: {
        active: { harness: 'codex', label: 'Codex', sessionId: 'codex-session' },
        expected: 'Native Codex title',
      },
      cursor: {
        active: { harness: 'cursor', label: 'Cursor' },
        expected: undefined,
      },
      opencode: {
        active: {
          harness: 'opencode',
          label: 'OpenCode',
          sessionId: 'opencode-session',
          sessionLabel: 'Managed OpenCode title',
        },
        expected: 'Managed OpenCode title',
      },
      openclaw: {
        active: { harness: 'openclaw', label: 'OpenClaw', sessionId: 'openclaw-session' },
        expected: undefined,
      },
      hermes: {
        active: { harness: 'hermes', label: 'Hermes', sessionId: 'hermes-session' },
        expected: undefined,
      },
      grok: {
        active: { harness: 'grok', label: 'Grok', sessionId: 'grok-session' },
        expected: undefined,
      },
    }
    expect(Object.keys(cases).sort()).toEqual([...SOURCE_CONTEXT_HARNESSES].sort())

    for (const { active, expected } of Object.values(cases)) {
      expect(
        readHarnessSessionTitle({}, active, {
          orca: () => undefined,
          codex: (_env, sessionId) =>
            sessionId === 'codex-session' ? 'Native Codex title' : undefined,
        }),
        active.harness,
      ).toBe(expected)
    }
    expect(
      readHarnessSessionTitle({}, null, {
        orca: () => 'Must not name a generic script',
        codex: () => 'Must not name a generic script',
      }),
    ).toBeUndefined()
  })

  it('reads the newest exact Codex Desktop/CLI title without Orca context', () => {
    const { env, codexHome } = fixture()
    writeFileSync(
      path.join(codexHome, 'session_index.jsonl'),
      [
        JSON.stringify({ id: 'other-thread', thread_name: 'Other work', updated_at: '2026-08-30T10:00:00Z' }),
        JSON.stringify({ id: 'fixture-session-7409', thread_name: 'Initial synthetic task', updated_at: '2026-08-30T10:01:00Z' }),
        '{malformed',
        JSON.stringify({ id: 'fixture-session-7409', thread_name: 'Semantic desktop task', updated_at: '2026-08-30T10:02:00Z' }),
      ].join('\n'),
    )

    expect(env['TERM_PROGRAM']).toBeUndefined()
    expect(readCodexSessionTitle(env, 'fixture-session-7409')).toBe('Semantic desktop task')
    expect(
      readHarnessSessionTitle(env, {
        harness: 'codex',
        label: 'Codex',
        sessionId: 'fixture-session-7409',
      }),
    ).toBe('Semantic desktop task')
  })

  it('keeps Orca optional while preserving its exact-pane enrichment', () => {
    const active = { harness: 'codex', label: 'Codex', sessionId: 'thread-one' } as const
    expect(
      readHarnessSessionTitle({ TERM_PROGRAM: 'Orca' }, active, {
        orca: () => 'Orca task title',
        codex: () => 'Codex thread title',
      }),
    ).toBe('Orca task title')
    expect(
      readHarnessSessionTitle({}, active, {
        orca: () => undefined,
        codex: () => 'Codex thread title',
      }),
    ).toBe('Codex thread title')
  })

  it('fails back when Codex state is absent, malformed, oversized, or not exact', () => {
    const { env, codexHome } = fixture()
    expect(readCodexSessionTitle(env, 'missing')).toBeUndefined()

    writeFileSync(path.join(codexHome, 'session_index.jsonl'), '{malformed\n')
    expect(readCodexSessionTitle(env, 'missing')).toBeUndefined()

    truncateSync(path.join(codexHome, 'session_index.jsonl'), 64 * 1024 * 1024 + 1)
    expect(readCodexSessionTitle(env, 'missing')).toBeUndefined()

    writeFileSync(
      path.join(codexHome, 'session_index.jsonl'),
      JSON.stringify({ id: 'different', thread_name: 'Wrong session' }),
    )
    expect(readCodexSessionTitle(env, 'missing')).toBeUndefined()
  })
})

describe('Claude Code session titles', () => {
  const SESSION = '11111111-1111-4111-8111-111111111111'
  function home(): NodeJS.ProcessEnv {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-claude-title-'))
    return { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
  }
  const active: ActiveHarnessSession = { harness: 'claude-code', label: 'Claude Code', sessionId: SESSION }

  it('names the Agent Session with the title the User gave the Claude Code session', () => {
    const env = home()
    expect(readHarnessSessionTitle(env, active, { orca: () => undefined })).toBeUndefined()
    recordClaudeSessionTitle(SESSION, env, 'Checkout redesign')
    expect(readHarnessSessionTitle(env, active, { orca: () => undefined })).toBe('Checkout redesign')
    expect(readHarnessSessionTitle(env, { ...active, sessionId: 'another-session' }, { orca: () => undefined })).toBeUndefined()
  })

  it('follows a rename and keeps the last title when an event reports none', () => {
    const env = home()
    recordClaudeSessionTitle(SESSION, env, 'Checkout redesign')
    recordClaudeSessionTitle(SESSION, env, undefined)
    recordClaudeSessionTitle(SESSION, env, '   ')
    expect(readClaudeSessionTitle(env, SESSION)).toBe('Checkout redesign')
    recordClaudeSessionTitle(SESSION, env, 'Refund flow')
    expect(readClaudeSessionTitle(env, SESSION)).toBe('Refund flow')
  })

  it('keeps one bounded printable line', () => {
    const env = home()
    recordClaudeSessionTitle(SESSION, env, `  Line one\nLine\ttwo\u0007 ${'x'.repeat(400)}`)
    const title = readClaudeSessionTitle(env, SESSION)!
    expect(title.startsWith('Line oneLinetwo x')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(200)
    recordClaudeSessionTitle(SESSION, env, 42)
    expect(readSessionState(SESSION, env).harness_session_title).toBe(title)
  })

  it('lets an exact Orca pane title keep its precedence', () => {
    const env = home()
    recordClaudeSessionTitle(SESSION, env, 'Checkout redesign')
    expect(readHarnessSessionTitle(env, active, { orca: () => 'Orca pane title' })).toBe('Orca pane title')
  })
})
