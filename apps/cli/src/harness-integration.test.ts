import { readFileSync } from 'node:fs'
import { describe,expect,it } from 'vitest'
import {
resolveActiveHarness,
sourceContextHarnessSession,
} from './commands-harness-context.js'

const PINNED = JSON.parse(
  readFileSync(new URL('./fixtures/hermes-0.20.6-classic-cli-local.json', import.meta.url), 'utf8'),
) as {
  durableSessionId: string
  observedToolSubprocessEnv: { HERMES_SESSION_ID: string }
  instance: { harness: 'hermes'; surface: 'classic-cli'; terminalBackend: 'local' }
  cwd: { invocation: string }
  evidence: {
    nativeHostOs: 'macos'
    portableFixtureFamilies: ['posix', 'windows']
    nativeOsUnrun: ['linux', 'windows']
  }
  compression: {
    defaultMode: 'in-place'
    sessionIdBefore: string
    sessionIdAfter: string
    legacyRotatingSessionId: string
  }
}

const SYNTHETIC_GATEWAY_SESSION_KEY = 'synthetic-gateway-route-key-not-a-session-id'



describe('Hermes classic CLI/local Source Context seam', () => {
  it('attributes an uncontested HERMES_SESSION_ID as the durable Agent Session', () => {
    const cwd = PINNED.cwd.invocation
    const now = 1
    const resolution = resolveActiveHarness(
      { HERMES_SESSION_ID: PINNED.observedToolSubprocessEnv.HERMES_SESSION_ID },
      cwd,
      now,
    )
    expect(resolution.contested).toEqual([])
    expect(resolution.active).toMatchObject({
      harness: 'hermes',
      sessionId: PINNED.durableSessionId,
    })
    expect(sourceContextHarnessSession({ HERMES_SESSION_ID: PINNED.durableSessionId }, cwd, now)).toEqual(
      resolution.active,
    )
  })

  it('never treats HERMES_SESSION_KEY as Agent Session identity', () => {
    const cwd = '/workspace'
    const now = 1
    const keyOnly = resolveActiveHarness(
      { HERMES_SESSION_KEY: SYNTHETIC_GATEWAY_SESSION_KEY },
      cwd,
      now,
    )
    expect(keyOnly.active).toBeNull()

    const gatewayEnv = {
      HERMES_SESSION_ID: PINNED.observedToolSubprocessEnv.HERMES_SESSION_ID,
      HERMES_SESSION_KEY: SYNTHETIC_GATEWAY_SESSION_KEY,
    }
    const both = resolveActiveHarness(gatewayEnv, cwd, now)
    expect(both.active?.sessionId).toBe(PINNED.durableSessionId)
    expect(both.active?.sessionId).not.toBe(SYNTHETIC_GATEWAY_SESSION_KEY)
    expect(sourceContextHarnessSession(gatewayEnv, cwd, now)).toBeNull()
  })
})

describe('Grok Source Context', () => {
  it('uses only an exact non-empty Grok session marker', () => {
    expect(sourceContextHarnessSession({ GROK_SESSION_ID: '  grok-session  ' }, '/workspace', 1))
      .toMatchObject({ harness: 'grok', label: 'Grok', sessionId: 'grok-session' })
    expect(sourceContextHarnessSession({ GROK_HOME: '/isolated/grok' }, '/workspace', 1)).toBeNull()
    expect(sourceContextHarnessSession({ GROK_SESSION_ID: '  ' }, '/workspace', 1)).toBeNull()
  })
})

describe('OpenClaw agent-local Source Context seam', () => {
  const PINNED_OPENCLAW = JSON.parse(
    readFileSync(new URL('./fixtures/openclaw-2026.7.1-2-agent-local.json', import.meta.url), 'utf8'),
  ) as {
    durableSessionKey: string
    rotatingSessionId: string
    observedPluginEnv: { NOTIFAI_ACTIVE_HARNESS: 'openclaw'; NOTIFAI_ACTIVE_SESSION_ID: string }
    instance: { harness: 'openclaw'; surface: 'agent-local'; execHost: 'gateway' }
    hooks: {
      proven: { activation: string; stop: string; execMarkers: string }
      unprovenOnThisSurface: { presence: string; sessionEnd: string }
    }
    deferred: string[]
  }

  it('pins only the probed agent-local surface, not Gateway-embedded', () => {
    expect(PINNED_OPENCLAW.instance).toEqual({
      harness: 'openclaw',
      surface: 'agent-local',
      execHost: 'gateway',
    })
    expect(PINNED_OPENCLAW.durableSessionKey).toBe('agent:main:probe-owner')
    expect(PINNED_OPENCLAW.observedPluginEnv.NOTIFAI_ACTIVE_SESSION_ID).toBe(
      PINNED_OPENCLAW.durableSessionKey,
    )
    expect(PINNED_OPENCLAW.hooks.proven).toEqual({
      activation: 'before_prompt_build',
      stop: 'agent_end',
      execMarkers: 'resolve_exec_env',
    })
    expect(PINNED_OPENCLAW.hooks.unprovenOnThisSurface).toEqual({
      presence: 'message_received',
      sessionEnd: 'session_end',
    })
    expect(PINNED_OPENCLAW.deferred).toContain('gateway-embedded')
  })
})
