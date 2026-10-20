import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeRunElsewhere } from './commands-hook-run.js'
import { beginSessionIncarnation, lifecycleStamp } from './hook-session-state.js'
import { claudePlaceOf, claudePlaceSignals, placeReceives } from './session-place.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Claude Code place', () => {
  it('names each entrypoint\'s place', () => {
    expect(claudePlaceOf({ entrypoint: 'cli' })).toBe('terminal')
    expect(claudePlaceOf({ entrypoint: 'cli', sessionKind: 'bg' })).toBe('claude-background')
    expect(claudePlaceOf({ entrypoint: 'claude-desktop' })).toBe('claude-desktop')
    expect(claudePlaceOf({ entrypoint: 'claude-desktop-3p' })).toBe('claude-desktop')
    expect(claudePlaceOf({ entrypoint: 'claude-vscode' })).toBe('claude-ide')
    expect(claudePlaceOf({ entrypoint: 'sdk-cli' })).toBe('headless')
    expect(claudePlaceOf({ entrypoint: 'sdk-ts' })).toBe('headless')
    expect(claudePlaceOf({ entrypoint: 'sdk-ts', orcaStructured: true })).toBe('orca-chat')
    expect(claudePlaceOf({ entrypoint: 'local-agent' })).toBe('unknown')
  })

  it('treats a child that reports no entrypoint as before (interactive)', () => {
    expect(claudePlaceOf({})).toBe('unreported')
    expect(claudePlaceOf({ entrypoint: null })).toBe('unreported')
    expect(claudePlaceOf({ entrypoint: '' })).toBe('unreported')
    expect(placeReceives('unreported')).toBe(true)
  })

  it('hands held answers and notes only to interactive places', () => {
    for (const place of ['terminal', 'claude-desktop', 'claude-ide', 'claude-background', 'orca-chat'] as const) expect(placeReceives(place)).toBe(true)
    expect(placeReceives('headless')).toBe(false)
    expect(placeReceives('unknown')).toBe(false)
  })

  it('reads the signals from a hook environment', () => {
    expect(claudePlaceOf(claudePlaceSignals({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', ORCA_STRUCTURED_SESSION: '1' }))).toBe('orca-chat')
    expect(claudePlaceOf(claudePlaceSignals({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_KIND: 'bg' }))).toBe('claude-background')
    expect(claudePlaceOf(claudePlaceSignals({}))).toBe('unreported')
  })
})

describe('a prompt in a scripted run of a conversation another process hosts', () => {
  const SESSION = '11111111-2222-3333-4444-555555555555'
  function env(entrypoint?: string): NodeJS.ProcessEnv {
    const root = mkdtempSync(path.join(os.tmpdir(), 'r2-place-'))
    roots.push(root)
    const value: NodeJS.ProcessEnv = { XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config'),
      ...(entrypoint === undefined ? {} : { CLAUDE_CODE_ENTRYPOINT: entrypoint }) }
    beginSessionIncarnation(SESSION, value, { stamp: lifecycleStamp(), harnessProcess: { pid: 4242, start: 'Tue Oct 20 10:00:00 2026' } })
    return value
  }

  it('receives nothing held for it, while the hosting place and any interactive place do', () => {
    expect(claudeRunElsewhere(SESSION, env('sdk-cli'), 5151)).toBe(true)
    expect(claudeRunElsewhere(SESSION, env('local-agent'), 5151)).toBe(true)
    // The scripted run that is the conversation's own host still receives (its own questions).
    expect(claudeRunElsewhere(SESSION, env('sdk-cli'), 4242)).toBe(false)
    expect(claudeRunElsewhere(SESSION, env('cli'), 5151)).toBe(false)
    expect(claudeRunElsewhere(SESSION, env(), 5151)).toBe(false)
  })
})
