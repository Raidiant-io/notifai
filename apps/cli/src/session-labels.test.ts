import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

describe('unnamed Agent Session fallback', () => {
  it("names an unnamed session after its agent app, the same for every such session", () => {
    const env = environment()
    for (const sessionId of ['first-session', 'second-session']) {
      expect(resolveSessionLabel({ env, sessionId, harness: 'claude-code' })).toEqual({
        ok: true,
        label: 'Claude Code session',
        source: 'fallback',
      })
    }
    expect(resolveSessionLabel({ env, sessionId: 'codex-session', harness: 'codex' }))
      .toMatchObject({ label: 'Codex session', source: 'fallback' })
    expect(resolveSessionLabel({ env, sessionId: 'unidentified-session' }))
      .toMatchObject({ label: 'Agent session', source: 'fallback' })
  })

  it('gives way once to the name the agent later supplies', () => {
    const env = environment()
    resolveSessionLabel({ env, sessionId: 'session-one', harness: 'cursor' })
    expect(resolveSessionLabel({
      env, sessionId: 'session-one', harness: 'cursor', explicitLabel: 'Fix the parser',
    })).toEqual({ ok: true, label: 'Fix the parser', source: 'explicit', previousSource: 'fallback' })
  })

  it('keeps a generated name an installed session already shows, and moves a date fallback to the app name', () => {
    const env = environment()
    resolveSessionLabel({ env, sessionId: 'animal', harness: 'claude-code' })
    resolveSessionLabel({ env, sessionId: 'dated', harness: 'claude-code' })
    const store = JSON.parse(readFileSync(storeFile(env), 'utf8')) as {
      sessions: Record<string, { label: string }>
    }
    const [animal, dated] = Object.values(store.sessions)
    animal!.label = 'Yellow Bear'
    dated!.label = 'Claude Code session · Oct 24, 2026 09:30'
    mkdirSync(path.dirname(storeFile(env)), { recursive: true })
    writeFileSync(storeFile(env), JSON.stringify(store))

    expect(resolveSessionLabel({ env, sessionId: 'animal', harness: 'claude-code' }))
      .toMatchObject({ label: 'Yellow Bear', source: 'fallback' })
    expect(resolveSessionLabel({ env, sessionId: 'dated', harness: 'claude-code' }))
      .toMatchObject({ label: 'Claude Code session', source: 'fallback' })
  })
})
