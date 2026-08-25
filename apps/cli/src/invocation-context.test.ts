import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildSourceContext,
  inferInvocationContext,
  portableBasename,
  projectSlugFrom,
  truncateContext,
  type GitCommand,
} from './invocation-context.js'

function fixtureGit(values: Record<string, string | null>): GitCommand {
  return (_cwd, args) => values[args.join(' ')] ?? null
}

function stateEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    XDG_STATE_HOME: mkdtempSync(path.join(os.tmpdir(), 'notifai-source-context-')),
    ...overrides,
  }
}

describe('projectSlugFrom', () => {
  it.each([
    ['My Project', 'my-project'],
    ['.Hidden Repo', 'hidden-repo'],
    ['API_v2.0', 'api_v2.0'],
    ['---', null],
    ['项目', null],
  ])('turns %s into %s', (name, expected) => {
    expect(projectSlugFrom(name)).toBe(expected)
  })

  it('keeps the Project identifier inside its 64-character bound', () => {
    expect(projectSlugFrom(`repo-${'x'.repeat(100)}`)).toHaveLength(64)
  })
})

describe('portableBasename', () => {
  it.each([
    ['/Users/person/code/notifai/', 'notifai'],
    ['C:\\Users\\Person\\code\\notifai\\', 'notifai'],
    ['\\\\server\\share\\worktrees\\release\\', 'release'],
  ])('extracts the basename from %s', (value, expected) => {
    expect(portableBasename(value)).toBe(expected)
  })
})

describe('inferInvocationContext', () => {
  it('uses the common-directory parent for a repository from a nested cwd', () => {
    const context = inferInvocationContext(
      '/code/Signal Garden/packages/api',
      fixtureGit({
        'rev-parse --git-common-dir': '../../.git',
        'rev-parse --git-dir': '../../.git',
        'rev-parse --show-toplevel': '/code/Signal Garden',
        'rev-parse --abbrev-ref HEAD': 'feature/alerts',
      }),
    )
    expect(context).toEqual({ project: 'signal-garden', branch: 'feature/alerts' })
  })

  it('keeps one Project across linked worktrees and exposes only the worktree basename', () => {
    const context = inferInvocationContext(
      '/Users/name/worktrees/notifai-release/apps/cli',
      fixtureGit({
        'rev-parse --git-common-dir': '/Users/name/code/notifai/.git',
        'rev-parse --git-dir': '/Users/name/code/notifai/.git/worktrees/notifai-release',
        'rev-parse --show-toplevel': '/Users/name/worktrees/notifai-release/',
        'rev-parse --abbrev-ref HEAD': 'release/content',
      }),
    )
    expect(context).toEqual({
      project: 'notifai',
      branch: 'release/content',
      worktree: 'notifai-release',
    })
    expect(JSON.stringify(context)).not.toContain('/Users/name')
  })

  it('handles drive-letter paths and compares them case-insensitively', () => {
    const context = inferInvocationContext(
      'D:\\Worktrees\\Alerts\\src',
      fixtureGit({
        'rev-parse --git-common-dir': 'C:\\Code\\Notifai\\.git\\',
        'rev-parse --git-dir': 'c:\\code\\notifai\\.git\\worktrees\\Alerts',
        'rev-parse --show-toplevel': 'D:\\Worktrees\\Alerts\\',
        'rev-parse --abbrev-ref HEAD': 'feature/windows',
      }),
    )
    expect(context).toEqual({
      project: 'notifai',
      branch: 'feature/windows',
      worktree: 'Alerts',
    })
    expect(JSON.stringify(context)).not.toContain('D:\\Worktrees')
    expect(JSON.stringify(context)).not.toContain('C:\\Code')
  })

  it('handles a UNC common directory and trailing separators', () => {
    const context = inferInvocationContext(
      '\\\\server\\share\\trees\\topic\\src',
      fixtureGit({
        'rev-parse --git-common-dir': '\\\\server\\share\\Notifai\\.git\\',
        'rev-parse --git-dir': '\\\\server\\share\\Notifai\\.git\\worktrees\\topic\\',
        'rev-parse --show-toplevel': '\\\\server\\share\\trees\\topic\\',
        'rev-parse --abbrev-ref HEAD': 'topic',
      }),
    )
    expect(context).toEqual({ project: 'notifai', branch: 'topic', worktree: 'topic' })
  })

  it('falls back to the cwd basename outside Git', () => {
    expect(inferInvocationContext('/tmp/My Scratch/', fixtureGit({}))).toEqual({
      project: 'my-scratch',
    })
  })

  it('omits an unusable Project instead of inventing one', () => {
    expect(inferInvocationContext('/tmp/项目', fixtureGit({}))).toEqual({ project: null })
  })

  it('omits branch and worktree on detached HEAD in an ordinary checkout', () => {
    expect(
      inferInvocationContext(
        '/code/repo',
        fixtureGit({
          'rev-parse --git-common-dir': '.git',
          'rev-parse --git-dir': '.git',
          'rev-parse --show-toplevel': '/code/repo',
          'rev-parse --abbrev-ref HEAD': 'HEAD',
        }),
      ),
    ).toEqual({ project: 'repo' })
  })

  it('bounds branch and worktree display strings without leaking their parents', () => {
    const longBranch = `feature/${'界'.repeat(140)}`
    const longWorktree = `tree-${'x'.repeat(80)}`
    const context = inferInvocationContext(
      '/private/work/tree/src',
      fixtureGit({
        'rev-parse --git-common-dir': '/private/main/repo/.git',
        'rev-parse --git-dir': '/private/main/repo/.git/worktrees/tree',
        'rev-parse --show-toplevel': `/private/work/${longWorktree}`,
        'rev-parse --abbrev-ref HEAD': longBranch,
      }),
    )
    expect(Array.from(context.branch ?? '')).toHaveLength(128)
    expect(Array.from(context.worktree ?? '')).toHaveLength(64)
    expect(context.branch).toMatch(/…$/)
    expect(context.worktree).toMatch(/…$/)
    expect(JSON.stringify(context)).not.toContain('/private/')
  })
})

describe('truncateContext', () => {
  it('counts Unicode characters rather than UTF-16 code units', () => {
    expect(truncateContext('A😀BC', 3)).toBe('A😀…')
  })
})

describe('buildSourceContext', () => {
  const invocation = { project: 'repo', branch: 'main', worktree: 'topic' }
  const now = new Date(2026, 7, 20, 14, 5).getTime()

  it('applies flag, environment, then inferred precedence per session field', () => {
    const built = buildSourceContext({
      env: stateEnv({
        NOTIFAI_SESSION_ID: 'env-id',
        NOTIFAI_SESSION_LABEL: 'Environment Label',
      }),
      invocation,
      sessionId: 'flag-id',
      sessionLabel: 'Flag Label',
      activeHarness: { harness: 'claude-code', sessionId: 'flag-id' },
      now,
    })
    expect(built).toEqual({
      ok: true,
      source: {
        session_id: 'flag-id',
        session_label: 'Flag Label',
        harness: 'claude-code',
        branch: 'main',
        worktree: 'topic',
      },
    })
  })

  it('uses environment values ahead of an inferred exact session', () => {
    expect(
      buildSourceContext({
        env: stateEnv({
          NOTIFAI_SESSION_ID: 'env-id',
          NOTIFAI_SESSION_LABEL: 'Environment Label',
        }),
        invocation: { project: 'repo' },
        activeHarness: { harness: 'codex', sessionId: 'env-id' },
        now,
      }),
    ).toEqual({
      ok: true,
      source: {
        session_id: 'env-id',
        session_label: 'Environment Label',
        harness: 'codex',
      },
    })
  })

  it('uses and freezes a trusted harness-native title', () => {
    const env = stateEnv()
    const sessionId = 'opencode-thread'
    expect(
      buildSourceContext({
        env,
        invocation: { project: 'repo', branch: 'main' },
        activeHarness: {
          harness: 'opencode',
          sessionId,
          sessionLabel: 'Semantic session names',
        },
        now,
      }),
    ).toEqual({
      ok: true,
      source: {
        session_id: sessionId,
        session_label: 'Semantic session names',
        harness: 'opencode',
        branch: 'main',
      },
    })
    expect(
      buildSourceContext({
        env,
        invocation: { project: 'repo' },
        activeHarness: { harness: 'opencode', sessionId, sessionLabel: 'Changed title' },
        now: now + 1_000,
      }),
    ).toEqual({
      ok: true,
      source: {
        session_id: sessionId,
        session_label: 'Semantic session names',
        harness: 'opencode',
      },
    })
  })

  it('does not freeze an OpenCode placeholder while its semantic title is pending', () => {
    expect(
      buildSourceContext({
        env: stateEnv(),
        invocation: { project: 'repo' },
        activeHarness: {
          harness: 'opencode',
          sessionId: 'pending-session',
          sessionLabelPending: true,
        },
        now,
      }),
    ).toEqual({
      ok: false,
      error:
        "OpenCode is still generating this session's title; retry shortly or pass --session-label.",
    })
  })

  it('uses a stable generated fallback when no semantic name exists', () => {
    const env = stateEnv()
    const sessionId = 'opaque-thread-1234567890'
    const expected = {
      ok: true,
      source: {
        session_id: sessionId,
        session_label: 'Ivory Koala',
        harness: 'opencode' as const,
        branch: 'main',
      },
    }
    expect(
      buildSourceContext({
        env,
        invocation: { project: 'repo', branch: 'main' },
        activeHarness: { harness: 'opencode', sessionId },
        now,
      }),
    ).toEqual(expected)
    expect(expected.source.session_label).not.toContain('1234567890')
  })

  it('does not borrow harness identity or title for an explicit different session id', () => {
    expect(
      buildSourceContext({
        env: stateEnv(),
        invocation: { project: 'repo' },
        sessionId: 'other-session',
        activeHarness: {
          harness: 'claude-code',
          sessionId: 'current-session',
          sessionLabel: 'Current work',
        },
        now,
      }),
    ).toEqual({
      ok: true,
      source: {
        session_id: 'other-session',
        session_label: 'Golden Lynx',
      },
    })
  })

  it('does not emit a harness or label when no exact session id is available', () => {
    expect(
      buildSourceContext({
        env: stateEnv(),
        invocation: { project: 'repo', branch: 'main' },
        activeHarness: { harness: 'cursor' },
        now,
      }),
    ).toEqual({ ok: true, source: { branch: 'main' } })
  })

  it('ignores the deleted NOTIFAI_SESSION variable', () => {
    expect(
      buildSourceContext({
        env: stateEnv({ NOTIFAI_SESSION: 'legacy-id' }),
        invocation: { project: 'repo' },
        now,
      }),
    ).toEqual({ ok: true })
  })

  it('rejects a display label without an exact session id', () => {
    expect(
      buildSourceContext({
        env: stateEnv(),
        invocation: { project: 'repo' },
        sessionLabel: 'Unbound Label',
        now,
      }),
    ).toEqual({
      ok: false,
      error: '--session-label (or NOTIFAI_SESSION_LABEL) needs an exact session id.',
    })
  })
})
