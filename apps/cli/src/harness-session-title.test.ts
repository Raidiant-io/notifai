import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ActiveHarnessSession } from './commands-harness-context.js'
import { SOURCE_CONTEXT_HARNESSES, type SourceContextHarness } from './harnesses.js'
import { readCodexSessionTitle, readHarnessSessionTitle } from './harness-session-title.js'

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
