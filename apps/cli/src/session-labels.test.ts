import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generatedSessionLabel } from './generated-session-label.js'
import { resolveSessionLabel } from './session-labels.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), 'session-labels-'))
  roots.push(root)
  return { HOME: root, XDG_STATE_HOME: path.join(root, 'state') }
}

function storeFile(env: NodeJS.ProcessEnv): string {
  return path.join(env.XDG_STATE_HOME!, 'notifai', 'session-labels.json')
}

/** Two distinct session ids whose generated names are the same. */
function collidingSessionIds(): [string, string] {
  const seen = new Map<string, string>()
  for (let index = 0; ; index += 1) {
    const sessionId = `session-${index}`
    const label = generatedSessionLabel(sessionId)
    const earlier = seen.get(label)
    if (earlier !== undefined) return [earlier, sessionId]
    seen.set(label, sessionId)
  }
}

describe('unnamed Agent Session fallback', () => {
  it('gives an unnamed session a generated name, numbering a second session that would share it', () => {
    const env = environment()
    const [first, second] = collidingSessionIds()
    const generated = generatedSessionLabel(first)
    expect(generated).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
    expect(resolveSessionLabel({ env, sessionId: first, harness: 'claude-code' }))
      .toEqual({ ok: true, label: generated, source: 'fallback' })
    expect(resolveSessionLabel({ env, sessionId: second, harness: 'claude-code' }))
      .toEqual({ ok: true, label: `${generated} · 2`, source: 'fallback' })
    // The name stays put for the session's later sends.
    expect(resolveSessionLabel({ env, sessionId: first, harness: 'claude-code' }))
      .toMatchObject({ label: generated, source: 'fallback' })
  })

  it('gives way once to the name the agent later supplies', () => {
    const env = environment()
    resolveSessionLabel({ env, sessionId: 'session-one', harness: 'cursor' })
    expect(resolveSessionLabel({
      env, sessionId: 'session-one', harness: 'cursor', explicitLabel: 'Fix the parser',
    })).toEqual({ ok: true, label: 'Fix the parser', source: 'explicit', previousSource: 'fallback' })
  })

  it('keeps an app-name fallback an installed session already shows until it is named, and moves a date fallback to a generated name', () => {
    const env = environment()
    resolveSessionLabel({ env, sessionId: 'app-named', harness: 'claude-code' })
    resolveSessionLabel({ env, sessionId: 'dated', harness: 'claude-code' })
    const store = JSON.parse(readFileSync(storeFile(env), 'utf8')) as {
      sessions: Record<string, { label: string }>
    }
    const [appNamed, dated] = Object.values(store.sessions)
    appNamed!.label = 'Claude Code session'
    dated!.label = 'Claude Code session · Oct 24, 2026 09:30'
    mkdirSync(path.dirname(storeFile(env)), { recursive: true })
    writeFileSync(storeFile(env), JSON.stringify(store))

    expect(resolveSessionLabel({ env, sessionId: 'app-named', harness: 'claude-code' }))
      .toMatchObject({ label: 'Claude Code session', source: 'fallback' })
    expect(resolveSessionLabel({ env, sessionId: 'dated', harness: 'claude-code' }))
      .toMatchObject({ label: generatedSessionLabel('dated'), source: 'fallback' })
    expect(resolveSessionLabel({
      env, sessionId: 'app-named', harness: 'claude-code', explicitLabel: 'Fix the parser',
    })).toMatchObject({ label: 'Fix the parser', source: 'explicit', previousSource: 'fallback' })
  })
})
