import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { stateDir } from './config.js'
import { formatSessionFirstSeen, resolveSessionLabel } from './session-labels.js'

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

  it('falls back to an honest first-seen name without exposing the session id', () => {
    const { env, now } = fixture()
    const resolved = resolveSessionLabel({
      env,
      now,
      sessionId: 'opaque-thread-1234567890',
      harness: 'codex',
    })
    expect(resolved).toEqual({
      ok: true,
      label: 'Codex session · Aug 20, 2026 14:05',
      source: 'fallback',
    })

    const stored = readFileSync(path.join(stateDir(env), 'session-labels.json'), 'utf8')
    expect(stored).not.toContain('opaque-thread-1234567890')
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

  it('adds only an ordinal when neutral fallback labels collide', () => {
    const { env, now } = fixture()
    const first = resolveSessionLabel({ env, now, sessionId: 'first', harness: 'codex' })
    const second = resolveSessionLabel({ env, now, sessionId: 'second', harness: 'codex' })
    expect(first).toEqual({
      ok: true,
      label: 'Codex session · Aug 20, 2026 14:05',
      source: 'fallback',
    })
    expect(second).toEqual({
      ok: true,
      label: 'Codex session · Aug 20, 2026 14:05 · 2',
      source: 'fallback',
    })
  })

  it('keeps native and disambiguated labels inside the wire bound', () => {
    const { env, now } = fixture()
    const long = '界'.repeat(100)
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
    expect(first.ok && Array.from(first.label)).toHaveLength(64)
    expect(second.ok && Array.from(second.label).length).toBeLessThanOrEqual(64)
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
  })

  it('fails closed instead of replacing an unreadable name store', () => {
    const { env, now } = fixture()
    const file = path.join(stateDir(env), 'session-labels.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{not json}\n')

    const resolved = resolveSessionLabel({
      env,
      now,
      sessionId: 'new-session',
      explicitLabel: 'Do not overwrite me',
    })

    expect(resolved.ok).toBe(false)
    expect(!resolved.ok && resolved.error).toContain('session-name store is unreadable')
    expect(readFileSync(file, 'utf8')).toBe('{not json}\n')
  })

  it('formats first seen using the machine local calendar', () => {
    const now = new Date(2026, 0, 2, 3, 4).getTime()
    expect(formatSessionFirstSeen(now)).toBe('Jan 2, 2026 03:04')
  })
})
