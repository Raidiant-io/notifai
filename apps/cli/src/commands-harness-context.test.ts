import { describe, expect, it, vi } from 'vitest'
import { resolveActiveHarness, sourceContextHarnessSession } from './commands-harness-context.js'
import { beginSessionIncarnation, lifecycleStamp } from './hook-session-state.js'
import { processStartTime } from './process-identity.js'

describe('Cursor shell identity', () => {
  it('uses the native conversation marker, not the per-turn request id', () => {
    expect(sourceContextHarnessSession({ CURSOR_AGENT: '1', CURSOR_CONVERSATION_ID: 'agent-conversation', CURSOR_REQUEST_ID: 'turn-a' }, '/project', 0))
      .toEqual({ harness: 'cursor', label: 'Cursor', sessionId: 'agent-conversation' })
  })
  it('keeps older shells detection-only', () => {
    expect(sourceContextHarnessSession({ CURSOR_AGENT: '1', CURSOR_REQUEST_ID: 'turn-a' }, '/project', 0))
      .toEqual({ harness: 'cursor', label: 'Cursor' })
  })
  it('does not attribute an inherited marker to an unrelated harness', () => {
    const env = { CURSOR_AGENT: '1', CURSOR_CONVERSATION_ID: 'agent-conversation', CODEX_THREAD_ID: 'other-thread' }
    expect(resolveActiveHarness(env, '/project', 0).contested).toHaveLength(2)
    expect(sourceContextHarnessSession(env, '/project', 0)).toBeNull()
  })
})

describe('an agent app started from another agent app\'s shell', () => {
  const claude = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'claude-session', CLAUDE_PID: '200' }
  const codex = { CODEX_THREAD_ID: 'codex-thread' }
  async function resolveUnder(chain: { pid: number; name: string }[] | null, env: NodeJS.ProcessEnv) {
    vi.resetModules()
    vi.doMock('./process-ancestry.js', () => ({ processAncestry: () => chain }))
    try {
      const harness = await import('./commands-harness-context.js')
      return { active: harness.resolveActiveHarness(env, '/project', 0), source: harness.sourceContextHarnessSession(env, '/project', 0) }
    } finally {
      vi.doUnmock('./process-ancestry.js')
    }
  }

  it('belongs to Codex when Codex runs between the command and Claude Code', async () => {
    const { active, source } = await resolveUnder([
      { pid: 400, name: 'node' }, { pid: 300, name: 'zsh' }, { pid: 250, name: 'codex' },
      { pid: 220, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 1, name: 'launchd' },
    ], { ...claude, ...codex })
    expect(active).toEqual({ active: { harness: 'codex', label: 'Codex', sessionId: 'codex-thread' }, contested: [] })
    expect(source?.sessionId).toBe('codex-thread')
  })

  it('belongs to Claude Code when Claude Code runs between the command and Codex', async () => {
    const { active, source } = await resolveUnder([
      { pid: 400, name: 'node' }, { pid: 300, name: 'zsh' }, { pid: 200, name: 'claude' },
      { pid: 220, name: 'zsh' }, { pid: 250, name: 'codex' }, { pid: 1, name: 'launchd' },
    ], { ...claude, ...codex })
    expect(active).toEqual({ active: { harness: 'claude-code', label: 'Claude Code', sessionId: 'claude-session' }, contested: [] })
    expect(source?.sessionId).toBe('claude-session')
  })

  it('belongs to whichever harness process is nearest, for any pair of harnesses', async () => {
    const cursor = { CURSOR_AGENT: '1', CURSOR_CONVERSATION_ID: 'cursor-conversation' }
    // Codex started from a Cursor agent's shell; Cursor's CLI is placed by its executable.
    const inCursor = await resolveUnder([
      { pid: 400, name: 'node' }, { pid: 250, name: 'codex' }, { pid: 220, name: 'zsh' }, { pid: 210, name: 'cursor-agent' },
    ], { ...cursor, ...codex })
    expect(inCursor.active.contested).toEqual([])
    expect(inCursor.source?.sessionId).toBe('codex-thread')
    // Claude Code started from a Hermes session, whose host its attendant recorded.
    const env = { ...claude, HERMES_SESSION_ID: `hermes-${process.pid}`, HOME: process.env['HOME'] }
    const hermes = process.ppid
    beginSessionIncarnation(env.HERMES_SESSION_ID, env, { stamp: lifecycleStamp(), harnessProcess: { pid: hermes, start: processStartTime(hermes)! } })
    const tree = [{ pid: 400, name: 'node' }, { pid: 200, name: 'claude' }, { pid: 230, name: 'zsh' }, { pid: hermes, name: 'python3' }]
    expect((await resolveUnder(tree, env)).active).toEqual({
      active: { harness: 'claude-code', label: 'Claude Code', sessionId: 'claude-session' }, contested: [],
    })
    // Hermes running from Claude Code's shell instead.
    expect((await resolveUnder([tree[0]!, tree[3]!, tree[2]!, tree[1]!], env)).active.active?.harness).toBe('hermes')
  })

  it('stays contested where the process tree cannot order them', async () => {
    // A recorded host that has exited (or whose pid now belongs to another process) places nothing.
    const stale = { ...claude, HERMES_SESSION_ID: `hermes-stale-${process.pid}`, HOME: process.env['HOME'] }
    beginSessionIncarnation(stale.HERMES_SESSION_ID, stale, { stamp: lifecycleStamp(), harnessProcess: { pid: process.ppid, start: 'Thu Jan  1 00:00:00 1970' } })
    expect((await resolveUnder([{ pid: 400, name: 'node' }, { pid: 200, name: 'claude' }, { pid: process.ppid, name: 'python3' }], stale)).active.contested).toHaveLength(2)
    // Grok names and records no process of its own.
    const grok = { GROK_SESSION_ID: 'grok-session' }
    expect((await resolveUnder([{ pid: 400, name: 'node' }, { pid: 200, name: 'claude' }], { ...claude, ...grok })).active.contested).toHaveLength(2)
    const tree = [{ pid: 400, name: 'node' }, { pid: 200, name: 'claude' }, { pid: 1, name: 'launchd' }]
    // No Codex process in the tree to place the Codex marker.
    expect((await resolveUnder(tree, { ...claude, ...codex })).active.contested).toHaveLength(2)
    // Claude Code names no process of its own.
    const unnamed = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'claude-session', ...codex }
    expect((await resolveUnder([{ pid: 400, name: 'node' }, { pid: 250, name: 'codex' }], unnamed)).active.contested).toHaveLength(2)
    // The tree cannot be read at all (Windows).
    expect((await resolveUnder(null, { ...claude, ...codex })).source).toBeNull()
  })
})
