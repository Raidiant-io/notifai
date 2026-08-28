import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { stateDir } from './config.js'
import {
  formatSessionFirstSeen,
  renameStoredSessionLabel,
  resolveSessionLabel,
} from './session-labels.js'

function fixture(): { env: NodeJS.ProcessEnv; now: number } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-session-labels-'))
  return {
    env: { XDG_STATE_HOME: root },
    now: new Date(2026, 7, 20, 14, 5).getTime(),
  }
}

describe('semantic session labels', () => {
  it('freezes the first explicit task label for the immutable session', () => {
    const { env, now } = fixture()
    expect(
      resolveSessionLabel({
        env,
        now,
        sessionId: 'opaque-session-one',
        harness: 'claude-code',
        explicitLabel: '  Semantic   session names  ',
      }),
    ).toEqual({ ok: true, label: 'Semantic session names', source: 'explicit' })

    expect(
      resolveSessionLabel({
        env,
        now: now + 1_000,
        sessionId: 'opaque-session-one',
        harness: 'claude-code',
        explicitLabel: 'A later unrelated label',
      }),
    ).toEqual({ ok: true, label: 'Semantic session names', source: 'explicit' })
    expect(
      resolveSessionLabel({
        env,
        now: now + 2_000,
        sessionId: 'opaque-session-one',
        harness: 'claude-code',
        explicitLabel: 'x'.repeat(100),
      }),
    ).toEqual({ ok: true, label: 'Semantic session names', source: 'explicit' })
  })

  it('prefers the environment-supplied title over an explicit label, making the flag safe everywhere', () => {
    // An agent must never need to know which environments name their own
    // sessions: where one does, the explicit label is simply not used.
    const { env, now } = fixture()
    expect(
      resolveSessionLabel({
        env,
        now,
        sessionId: 'managed-session',
        harness: 'opencode',
        harnessLabel: 'NotifAI question lifecycle',
        explicitLabel: 'Agent-chosen name',
      }),
    ).toEqual({ ok: true, label: 'NotifAI question lifecycle', source: 'harness' })
  })

  it('upgrades a frozen fallback to the environment title even when an explicit label rides along', () => {
    const { env, now } = fixture()
    const frozen = resolveSessionLabel({ env, now, sessionId: 'late-title' })
    expect(frozen).toMatchObject({ ok: true, source: 'fallback' })
    expect(
      resolveSessionLabel({
        env,
        now: now + 1,
        sessionId: 'late-title',
        harness: 'opencode',
        harnessLabel: 'Worktree semantic title',
        explicitLabel: 'Agent-chosen name',
      }),
    ).toEqual({ ok: true, label: 'Worktree semantic title', source: 'harness' })
  })

  it('uses a trusted harness title when no explicit task label exists', () => {
    const { env, now } = fixture()
    expect(
      resolveSessionLabel({
        env,
        now,
        sessionId: 'opencode-session',
        harness: 'opencode',
        harnessLabel: 'NotifAI question lifecycle',
      }),
    ).toEqual({ ok: true, label: 'NotifAI question lifecycle', source: 'harness' })
  })

  it('replaces a frozen generated fallback when a managed semantic title appears later', () => {
    const { env, now } = fixture()
    const frozen = resolveSessionLabel({
      env,
      now,
      sessionId: 'claude-session-before-orca-metadata',
      harness: 'claude-code',
    })
    expect(frozen.ok && frozen.source).toBe('fallback')

    expect(
      resolveSessionLabel({
        env,
        now: now + 1_000,
        sessionId: 'claude-session-before-orca-metadata',
        harness: 'claude-code',
        harnessLabel: 'Worker - semantic session implementation',
      }),
    ).toEqual({
      ok: true,
      label: 'Worker - semantic session implementation',
      source: 'harness',
    })
  })

  it('replaces a frozen generated fallback with a later explicit task name, once', () => {
    const { env, now } = fixture()
    const frozen = resolveSessionLabel({ env, now, sessionId: 'late-named', harness: 'codex' })
    expect(frozen.ok && frozen.source).toBe('fallback')

    expect(
      resolveSessionLabel({
        env,
        now: now + 1_000,
        sessionId: 'late-named',
        harness: 'codex',
        explicitLabel: 'Fix checkout retries',
      }),
    ).toEqual({ ok: true, label: 'Fix checkout retries', source: 'explicit' })
    expect(
      resolveSessionLabel({
        env,
        now: now + 2_000,
        sessionId: 'late-named',
        harness: 'codex',
        explicitLabel: 'A different later name',
      }),
    ).toEqual({ ok: true, label: 'Fix checkout retries', source: 'explicit' })
  })

  it('disambiguates an upgraded name against every other stored session', () => {
    const { env, now } = fixture()
    expect(
      resolveSessionLabel({
        env,
        now,
        sessionId: 'other-session',
        harness: 'codex',
        explicitLabel: 'Release preparation',
      }),
    ).toEqual({ ok: true, label: 'Release preparation', source: 'explicit' })
    const frozen = resolveSessionLabel({ env, now, sessionId: 'upgraded', harness: 'codex' })
    expect(frozen.ok && frozen.source).toBe('fallback')

    expect(
      resolveSessionLabel({
        env,
        now: now + 1_000,
        sessionId: 'upgraded',
        harness: 'codex',
        explicitLabel: 'Release preparation',
      }),
    ).toEqual({ ok: true, label: 'Release preparation · Codex', source: 'explicit' })
  })

  it('rejects an invalid explicit name instead of silently keeping the fallback', () => {
    const { env, now } = fixture()
    const frozen = resolveSessionLabel({ env, now, sessionId: 'still-fallback', harness: 'codex' })
    expect(frozen.ok && frozen.source).toBe('fallback')

    expect(
      resolveSessionLabel({
        env,
        now: now + 1_000,
        sessionId: 'still-fallback',
        harness: 'codex',
        explicitLabel: 'x'.repeat(65),
      }),
    ).toEqual({
      ok: false,
      error: '--session-label (or NOTIFAI_SESSION_LABEL) must be at most 64 characters.',
    })
    expect(
      resolveSessionLabel({ env, now: now + 2_000, sessionId: 'still-fallback', harness: 'codex' }),
    ).toEqual(frozen)
  })

  it('does not freeze OpenCode placeholder titles before the semantic title arrives', () => {
    const { env, now } = fixture()
    const file = path.join(stateDir(env), 'session-labels.json')
    expect(
      resolveSessionLabel({
        env,
        now,
        sessionId: 'opencode-pending',
        harness: 'opencode',
        harnessLabel: 'New session - 2026-08-20T13:05:00.000Z',
        harnessLabelPending: true,
      }),
    ).toEqual({
      ok: false,
      error:
        "OpenCode is still generating this session's title; retry shortly or pass --session-label.",
    })
    expect(existsSync(file)).toBe(false)

    expect(
      resolveSessionLabel({
        env,
        now: now + 1_000,
        sessionId: 'opencode-pending',
        harness: 'opencode',
        harnessLabel: 'Semantic session names',
      }),
    ).toEqual({ ok: true, label: 'Semantic session names', source: 'harness' })
  })

  it('allows an explicit task name while a native title is still pending', () => {
    const { env, now } = fixture()
    expect(
      resolveSessionLabel({
        env,
        now,
        sessionId: 'opencode-pending',
        harness: 'opencode',
        harnessLabelPending: true,
        explicitLabel: 'Verify release candidate',
      }),
    ).toEqual({ ok: true, label: 'Verify release candidate', source: 'explicit' })
  })

  it('falls back to a stable generated name without exposing the session id', () => {
    const { env, now } = fixture()
    const resolved = resolveSessionLabel({
      env,
      now,
      sessionId: 'opaque-thread-1234567890',
      harness: 'codex',
    })
    expect(resolved).toEqual({
      ok: true,
      label: 'Ivory Koala',
      source: 'fallback',
    })

    const stored = readFileSync(path.join(stateDir(env), 'session-labels.json'), 'utf8')
    expect(stored).not.toContain('opaque-thread-1234567890')
  })

  it('migrates a frozen date fallback when no semantic candidate exists', () => {
    const { env, now } = fixture()
    const file = path.join(stateDir(env), 'session-labels.json')
    expect(
      resolveSessionLabel({ env, now, sessionId: 'opaque-thread-1234567890', harness: 'codex' }),
    ).toEqual({ ok: true, label: 'Ivory Koala', source: 'fallback' })

    const store = JSON.parse(readFileSync(file, 'utf8')) as {
      sessions: Record<string, { label: string }>
    }
    const key = Object.keys(store.sessions)[0]
    const record = key === undefined ? undefined : store.sessions[key]
    if (record === undefined) throw new Error('expected one stored session')
    record.label = 'Codex session · Aug 20, 2026 14:05'
    writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`)

    expect(
      resolveSessionLabel({
        env,
        now: now + 1_000,
        sessionId: 'opaque-thread-1234567890',
        harness: 'codex',
      }),
    ).toEqual({ ok: true, label: 'Ivory Koala', source: 'fallback' })
    expect(readFileSync(file, 'utf8')).not.toContain('Codex session ·')

    expect(
      resolveSessionLabel({
        env,
        now: now + 2_000,
        sessionId: 'opaque-thread-1234567890',
        harness: 'codex',
        explicitLabel: 'Late semantic override',
      }),
    ).toEqual({ ok: true, label: 'Late semantic override', source: 'explicit' })
  })

  it('disambiguates repeated semantic titles without changing session identity', () => {
    const { env, now } = fixture()
    const labels = ['one', 'two', 'three', 'four'].map((sessionId) =>
      resolveSessionLabel({
        env,
        now,
        sessionId,
        harness: 'codex',
        explicitLabel: 'Release preparation',
      }),
    )
    expect(labels).toEqual([
      { ok: true, label: 'Release preparation', source: 'explicit' },
      { ok: true, label: 'Release preparation · Codex', source: 'explicit' },
      {
        ok: true,
        label: 'Release preparation · Codex · Aug 20, 2026 14:05',
        source: 'explicit',
      },
      {
        ok: true,
        label: 'Release preparation · Codex · Aug 20, 2026 14:05 · 2',
        source: 'explicit',
      },
    ])
  })

  it('adds only an ordinal when generated fallback labels collide', () => {
    const { env, now } = fixture()
    const first = resolveSessionLabel({ env, now, sessionId: 'collision-8', harness: 'codex' })
    const second = resolveSessionLabel({
      env,
      now,
      sessionId: 'collision-112',
      harness: 'codex',
    })
    expect(first).toEqual({
      ok: true,
      label: 'Winter Dolphin',
      source: 'fallback',
    })
    expect(second).toEqual({
      ok: true,
      label: 'Winter Dolphin · 2',
      source: 'fallback',
    })
  })

  it('keeps astral native and disambiguated labels inside the wire bound', () => {
    const { env, now } = fixture()
    const long = '😀'.repeat(100)
    const first = resolveSessionLabel({
      env,
      now,
      sessionId: 'first',
      harness: 'opencode',
      harnessLabel: long,
    })
    const second = resolveSessionLabel({
      env,
      now,
      sessionId: 'second',
      harness: 'opencode',
      harnessLabel: long,
    })
    expect(first.ok && first.label.length).toBeLessThanOrEqual(64)
    expect(second.ok && second.label.length).toBeLessThanOrEqual(64)
    expect(first.ok && first.label.endsWith('…')).toBe(true)
  })

  it('rejects blank and oversized explicit labels before storing them', () => {
    const { env, now } = fixture()
    expect(
      resolveSessionLabel({ env, now, sessionId: 'blank', explicitLabel: '   ' }),
    ).toEqual({
      ok: false,
      error: '--session-label (or NOTIFAI_SESSION_LABEL) must not be empty.',
    })
    expect(
      resolveSessionLabel({ env, now, sessionId: 'long', explicitLabel: 'x'.repeat(65) }),
    ).toEqual({
      ok: false,
      error: '--session-label (or NOTIFAI_SESSION_LABEL) must be at most 64 characters.',
    })
    expect(
      resolveSessionLabel({ env, now, sessionId: 'emoji', explicitLabel: '😀'.repeat(33) }),
    ).toEqual({
      ok: false,
      error: '--session-label (or NOTIFAI_SESSION_LABEL) must be at most 64 characters.',
    })
  })

  it('rejects explicit identifiers and paths and never promotes unsafe native titles', () => {
    const { env, now } = fixture()
    env['HOME'] = '/Users/example'
    const error =
      '--session-label (or NOTIFAI_SESSION_LABEL) must not contain a session identifier, hash, or filesystem path.'

    expect(
      resolveSessionLabel({
        env,
        now,
        sessionId: 'ses_opaque123456',
        explicitLabel: 'ses_opaque123456',
      }),
    ).toEqual({ ok: false, error })
    expect(
      resolveSessionLabel({
        env,
        now,
        sessionId: 'safe-session',
        explicitLabel: 'Fix /Users/example/private-client',
      }),
    ).toEqual({ ok: false, error })
    expect(
      resolveSessionLabel({
        env,
        now,
        sessionId: 'native-session',
        harness: 'opencode',
        harnessLabel: 'Fix /Users/example/private-client',
      }),
    ).toEqual({
      ok: true,
      label: 'Violet Crane',
      source: 'fallback',
    })
  })

  it('isolates an unreadable name store before creating a clean one', () => {
    const { env, now } = fixture()
    const file = path.join(stateDir(env), 'session-labels.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{not json}\n')

    expect(
      resolveSessionLabel({
      env,
      now,
      sessionId: 'new-session',
      explicitLabel: 'Do not overwrite me',
      }),
    ).toEqual({ ok: true, label: 'Do not overwrite me', source: 'explicit' })
    expect(readFileSync(file, 'utf8')).not.toBe('{not json}\n')
    const backups = readdirSync(path.dirname(file)).filter((name) =>
      /^session-labels\.invalid-[a-f0-9]{64}\.json$/u.test(name),
    )
    expect(backups).toHaveLength(1)
    expect(readFileSync(path.join(path.dirname(file), backups[0]!), 'utf8')).toBe('{not json}\n')
  })

  it('formats first seen using the machine local calendar', () => {
    const now = new Date(2026, 0, 2, 3, 4).getTime()
    expect(formatSessionFirstSeen(now)).toBe('Jan 2, 2026 03:04')
  })

  it('explicitly replaces a semantic or fallback label after an authorized rename', () => {
    const { env, now } = fixture()
    resolveSessionLabel({
      env,
      now,
      sessionId: 'rename-me',
      harness: 'codex',
      explicitLabel: 'Old job',
    })

    expect(
      renameStoredSessionLabel({
        env,
        now: now + 1_000,
        sessionId: 'rename-me',
        harness: 'codex',
        label: '  Completely   different job  ',
      }),
    ).toEqual({ ok: true, label: 'Completely different job', source: 'explicit' })
    expect(resolveSessionLabel({ env, now: now + 2_000, sessionId: 'rename-me' })).toEqual({
      ok: true,
      label: 'Completely different job',
      source: 'explicit',
    })
  })
})
