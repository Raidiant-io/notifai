import { describe, expect, it } from 'vitest'
import { claudePlaceOf, claudePlaceSignals, placeReceives } from './session-place.js'

describe('Claude interactive place evidence', () => {
  it.each(['orca', 'sdk-cli', 'future-entrypoint', undefined])('recognizes a direct Orca host independently of entrypoint %s', (entrypoint) => {
    const signals = claudePlaceSignals({ CLAUDE_CODE_ENTRYPOINT: entrypoint, ORCA_STRUCTURED_SESSION: '1', CLAUDE_AGENT_SDK_VERSION: '0.3.319' })
    const place = claudePlaceOf({ ...signals, hostName: 'Orca' })
    expect(place).toBe('orca-chat')
    expect(placeReceives(place)).toBe(true)
    expect(claudePlaceOf({ entrypoint, hostName: 'Orca', orcaStructured: false })).toBe(place)
  })

  it.each(['bash', 'node', null])('does not let inherited Orca markers prove an interactive host (%s)', (hostName) => {
    const place = claudePlaceOf({ entrypoint: 'sdk-cli', orcaStructured: true, hostName })
    expect(place).toBe(hostName === null ? 'unknown' : 'headless')
    expect(placeReceives(place)).toBe(false)
  })

  it('keeps old missing metadata compatible and unknown entrypoints unproven', () => {
    expect(claudePlaceOf({})).toBe('unreported')
    expect(claudePlaceOf({ entrypoint: 'future-entrypoint', hostName: 'bash' })).toBe('unknown')
    expect(claudePlaceOf({ entrypoint: 'cli', hostName: 'bash' })).toBe('terminal')
    expect(claudePlaceOf({ entrypoint: 'cli', sessionKind: 'bg' })).toBe('claude-background')
    expect(claudePlaceOf({ entrypoint: 'claude-desktop' })).toBe('claude-desktop')
    expect(claudePlaceOf({ entrypoint: 'claude-vscode' })).toBe('claude-ide')
    expect(claudePlaceOf({ entrypoint: 'future-entrypoint', hostName: 'T3 Code' })).toBe('t3')
  })
})
