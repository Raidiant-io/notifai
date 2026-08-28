import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HARNESS_CAPABILITIES,
  HARNESS_LABELS,
  HERMES_CLASSIC_CLI_LOCAL_CAPABILITY,
  HERMES_QUESTION_ROUTING_UNAVAILABLE,
  HOOK_INSTALLABLE_HARNESSES,
  SOURCE_CONTEXT_HARNESSES,
  hermesClassicCliLocalInstance,
  isHookInstallableHarness,
  questionRoutingCapability,
} from './harnesses.js'

const PINNED_HERMES_TRACE = JSON.parse(
  readFileSync(new URL('./fixtures/hermes-0.20.6-classic-cli-local.json', import.meta.url), 'utf8'),
) as {
  instance: { harness: 'hermes'; surface: 'classic-cli'; terminalBackend: 'local' }
  observedToolSubprocessEnv: { HERMES_SESSION_ID: string }
  supported: string[]
  unsupported: string[]
  deferred: string[]
}

/**
 * This file used to hold a verbatim copy of the table below it, which meant
 * changing a harness contract required changing the same words twice and the
 * test could never disagree with the code — only with whoever forgot the second
 * edit. What is worth asserting is the shape the rest of the CLI assumes.
 */
describe('harness contract', () => {
  it('describes every shipped Source Context harness, and only those', () => {
    expect(Object.keys(HARNESS_LABELS).sort()).toEqual([...SOURCE_CONTEXT_HARNESSES].sort())
  })

  it('keeps managed hook installation a strict subset of Source Context', () => {
    expect(HOOK_INSTALLABLE_HARNESSES).toEqual(['claude-code', 'codex', 'cursor', 'opencode'])
    expect(SOURCE_CONTEXT_HARNESSES).toContain('hermes')
    expect(HOOK_INSTALLABLE_HARNESSES).not.toContain('hermes')
    expect(Object.keys(HARNESS_CAPABILITIES).sort()).toEqual([...HOOK_INSTALLABLE_HARNESSES].sort())
    for (const harness of HOOK_INSTALLABLE_HARNESSES) {
      expect(isHookInstallableHarness(harness)).toBe(true)
    }
    expect(isHookInstallableHarness('hermes')).toBe(false)
  })

  it('gives a harness that cannot continue a turn no route to pretend with', () => {
    // `ask` fails closed on these, and the reason it can is that the two facts
    // agree. A harness claiming a delivery route while declaring it cannot
    // continue would accept an answer into a void.
    for (const harness of HOOK_INSTALLABLE_HARNESSES) {
      const capability = questionRoutingCapability(harness)
      if (capability.stopContinuation !== 'unsupported') continue
      expect(capability.deliveryRoutes, harness).toEqual(['unsupported'])
    }
    expect(HERMES_QUESTION_ROUTING_UNAVAILABLE.deliveryRoutes).toEqual(['unsupported'])
  })

  it('gives a harness that can continue a turn at least one real route', () => {
    for (const harness of HOOK_INSTALLABLE_HARNESSES) {
      const capability = HARNESS_CAPABILITIES[harness]
      if (capability.stopContinuation === 'unsupported') continue
      expect(capability.deliveryRoutes.length, harness).toBeGreaterThan(0)
      expect(capability.deliveryRoutes, harness).not.toContain('unsupported')
      // The journal is the floor under every supported route: without it an
      // answer that misses its turn has nowhere to wait.
      expect(capability.deliveryRoutes, harness).toContain('hold-for-next-turn')
    }
  })

  it('explains each harness in prose an operator can act on', () => {
    for (const harness of HOOK_INSTALLABLE_HARNESSES) {
      expect(questionRoutingCapability(harness).deliveryContract.length, harness).toBeGreaterThan(40)
    }
    expect(HERMES_QUESTION_ROUTING_UNAVAILABLE.deliveryContract.length).toBeGreaterThan(40)
  })

  it('keeps Claude Code, Codex, Cursor, and OpenCode continuation contracts unchanged', () => {
    expect(HARNESS_CAPABILITIES['claude-code'].stopContinuation).toBe('decision-block')
    expect(HARNESS_CAPABILITIES['claude-code'].deliveryRoutes).toEqual([
      'hook-continuation',
      'inbox-socket',
      'cold-resume',
      'hold-for-next-turn',
    ])
    expect(HARNESS_CAPABILITIES.codex.stopContinuation).toBe('decision-block')
    expect(HARNESS_CAPABILITIES.codex.deliveryRoutes).toEqual([
      'hook-continuation',
      'cold-resume',
      'hold-for-next-turn',
    ])
    expect(HARNESS_CAPABILITIES.cursor).toEqual({
      stopContinuation: 'unsupported',
      deliveryRoutes: ['unsupported'],
      deliveryContract: HARNESS_CAPABILITIES.cursor.deliveryContract,
    })
    expect(HARNESS_CAPABILITIES.opencode.stopContinuation).toBe('unsupported')
    expect(HARNESS_CAPABILITIES.opencode.deliveryRoutes).toEqual(['unsupported'])
  })

  it('treats the pinned Hermes classic CLI/local trace as send-only', () => {
    expect(HERMES_CLASSIC_CLI_LOCAL_CAPABILITY.instance).toEqual(PINNED_HERMES_TRACE.instance)
    expect(PINNED_HERMES_TRACE.supported).toContain('deliberate-send')
    expect(PINNED_HERMES_TRACE.unsupported).toContain('question-routing')
    expect(PINNED_HERMES_TRACE.deferred).toContain('gateway')
    expect(HERMES_CLASSIC_CLI_LOCAL_CAPABILITY.sourceContext).toBe(
      'hermes-session-id-and-invocation-cwd',
    )
    expect(HERMES_QUESTION_ROUTING_UNAVAILABLE.stopContinuation).toBe('unsupported')
    expect(HERMES_QUESTION_ROUTING_UNAVAILABLE.deliveryRoutes).toEqual(['unsupported'])
  })

  it('resolves only the pinned classic CLI/local marker envelope', () => {
    expect(
      hermesClassicCliLocalInstance({
        HERMES_SESSION_ID: PINNED_HERMES_TRACE.observedToolSubprocessEnv.HERMES_SESSION_ID,
      }),
    ).toEqual(PINNED_HERMES_TRACE.instance)
    expect(
      hermesClassicCliLocalInstance({
        HERMES_SESSION_ID: PINNED_HERMES_TRACE.observedToolSubprocessEnv.HERMES_SESSION_ID,
        HERMES_SESSION_SOURCE: 'cli',
        TERMINAL_ENV: 'local',
      }),
    ).toEqual(PINNED_HERMES_TRACE.instance)
    for (const env of [
      { HERMES_SESSION_KEY: 'gateway-key' },
      { HERMES_SESSION_PLATFORM: 'api_server' },
      { HERMES_SESSION_SOURCE: 'tui' },
      { TERMINAL_ENV: 'docker' },
      { TERMINAL_ENV: 'ssh' },
    ]) {
      expect(
        hermesClassicCliLocalInstance({
          HERMES_SESSION_ID: PINNED_HERMES_TRACE.observedToolSubprocessEnv.HERMES_SESSION_ID,
          ...env,
        }),
      ).toBeNull()
    }
  })
})
