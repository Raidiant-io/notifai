import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveActiveHarness,
  sourceContextHarnessSession,
} from './commands-harness-context.js'
import {
  HARNESS_CAPABILITIES,
  HERMES_CLASSIC_CLI_LOCAL_CAPABILITY,
  HERMES_QUESTION_ROUTING_UNAVAILABLE,
} from './harnesses.js'
import { buildSourceContext, inferInvocationContext, type GitCommand } from './invocation-context.js'

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

function stateEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    XDG_STATE_HOME: mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-context-')),
    ...overrides,
  }
}

function fixtureGit(values: Record<string, string | null>): GitCommand {
  return (_cwd, args) => values[args.join(' ')] ?? null
}

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

  it('fails closed when Hermes markers nest with a hook-installable harness', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-nested-'))
    const env = {
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-orchestrator',
      HERMES_SESSION_ID: PINNED.durableSessionId,
    }
    const resolution = resolveActiveHarness(env, cwd, 42)
    expect(resolution.contested.map((candidate) => candidate.harness).sort()).toEqual([
      'claude-code',
      'hermes',
    ])
    expect(sourceContextHarnessSession(env, cwd, 42)).toBeNull()
  })

  it('does not apply the send-only mix rule to a Hermes-free Claude/Codex nest', () => {
    // Existing send attribution still uses declared order when nothing has
    // fired. Live-evidence ownership for ask lives in commands.test.ts.
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-claude-codex-pair-'))
    const env = {
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-orchestrator',
      CODEX_THREAD_ID: 'codex-current-thread',
    }
    const resolution = resolveActiveHarness(env, cwd, 42)
    expect(resolution.contested.map((candidate) => candidate.harness).sort()).toEqual([
      'claude-code',
      'codex',
    ])
    expect(sourceContextHarnessSession(env, cwd, 42)?.harness).toBe('claude-code')
  })

  it('builds Source Context from HERMES_SESSION_ID plus invocation cwd git/worktree', () => {
    const env = stateEnv({
      HERMES_SESSION_ID: PINNED.durableSessionId,
      HERMES_SESSION_KEY: SYNTHETIC_GATEWAY_SESSION_KEY,
    })
    const invocation = inferInvocationContext(
      '/worktrees/hermes-topic/apps/cli',
      fixtureGit({
        'rev-parse --git-common-dir': '/code/notifai/.git',
        'rev-parse --git-dir': '/code/notifai/.git/worktrees/hermes-topic',
        'rev-parse --show-toplevel': '/worktrees/hermes-topic/',
        'rev-parse --abbrev-ref HEAD': 'feature/hermes-send',
      }),
    )
    const active = resolveActiveHarness(env, '/worktrees/hermes-topic/apps/cli', Date.now()).active
    const built = buildSourceContext({
      env,
      invocation,
      ...(active === null ? {} : { activeHarness: active }),
      now: new Date(2026, 7, 28, 11, 13).getTime(),
    })
    expect(built).toMatchObject({
      ok: true,
      source: {
        session_id: PINNED.durableSessionId,
        harness: 'hermes',
        branch: 'feature/hermes-send',
        worktree: 'hermes-topic',
      },
    })
    if (built.ok) {
      expect(JSON.stringify(built.source)).not.toContain('gateway-route-key')
      expect(JSON.stringify(built.source)).not.toContain('/worktrees/')
      expect(JSON.stringify(built.source)).not.toContain('/code/')
    }
  })

  it('omits harness attribution when nested markers make ownership ambiguous', () => {
    const env = stateEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'claude-orchestrator',
      HERMES_SESSION_ID: PINNED.durableSessionId,
    })
    const invocation = inferInvocationContext('/workspace', fixtureGit({}))
    const active = sourceContextHarnessSession(env, '/workspace', 1)
    expect(active).toBeNull()
    expect(
      buildSourceContext({
        env,
        invocation,
        now: 1,
      }),
    ).toEqual({ ok: true })
  })

  it('does not invent a Question Routing route for the pinned Hermes instance', () => {
    expect(HERMES_CLASSIC_CLI_LOCAL_CAPABILITY.instance).toEqual(PINNED.instance)
    expect(HERMES_QUESTION_ROUTING_UNAVAILABLE.stopContinuation).toBe('unsupported')
    expect(Object.keys(HARNESS_CAPABILITIES)).not.toContain('hermes')
  })

  it('keeps unproven Hermes surfaces out of Source Context', () => {
    for (const extra of [
      { HERMES_SESSION_KEY: SYNTHETIC_GATEWAY_SESSION_KEY },
      { HERMES_SESSION_PLATFORM: 'api_server' },
      { HERMES_SESSION_SOURCE: 'tui' },
      { TERMINAL_ENV: 'docker' },
      { TERMINAL_ENV: 'ssh' },
    ]) {
      expect(
        sourceContextHarnessSession(
          { HERMES_SESSION_ID: PINNED.durableSessionId, ...extra },
          '/workspace',
          1,
        ),
      ).toBeNull()
    }
  })

  it('records the precise platform-fixture and compression evidence boundary', () => {
    expect(PINNED.evidence).toEqual({
      nativeHostOs: 'macos',
      portableFixtureFamilies: ['posix', 'windows'],
      nativeOsUnrun: ['linux', 'windows'],
    })
    expect(PINNED.compression.defaultMode).toBe('in-place')
    expect(PINNED.compression.sessionIdAfter).toBe(PINNED.compression.sessionIdBefore)
    expect(PINNED.compression.legacyRotatingSessionId).not.toBe(
      PINNED.compression.sessionIdBefore,
    )
  })
})
