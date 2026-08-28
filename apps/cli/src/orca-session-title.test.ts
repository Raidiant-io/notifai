import { describe, expect, it } from 'vitest'
import { readOrcaSessionTitle, type OrcaCommand } from './orca-session-title.js'

const worktreeId = 'repo-123::/worktrees/agent-session-labels'

function response(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    result: {
      worktree: {
        id: worktreeId,
        path: '/worktrees/agent-session-labels',
        displayName: 'Agent Session context labels',
        ...overrides,
      },
    },
  })
}

describe('Orca Agent Session title context', () => {
  it('accepts only the User-facing title returned for the exact managed worktree', () => {
    const calls: { executable: string; args: readonly string[] }[] = []
    const command: OrcaCommand = (executable, args) => {
      calls.push({ executable, args })
      return response()
    }

    expect(
      readOrcaSessionTitle({ TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: worktreeId }, command),
    ).toBe('Agent Session context labels')
    expect(calls).toEqual([
      {
        executable: 'orca',
        args: ['worktree', 'show', '--worktree', `id:${worktreeId}`, '--json'],
      },
    ])
  })

  it.each([
    ['command failure', () => null],
    ['malformed JSON', () => '{not json}'],
    ['failed response', () => JSON.stringify({ ok: false })],
    ['different worktree id', () => response({ id: 'repo-123::/worktrees/other' })],
    ['different worktree path', () => response({ path: '/private/untrusted' })],
    ['blank display name', () => response({ displayName: '   ' })],
  ])('leaves the generated fallback exceptional when context is unavailable: %s', (_name, command) => {
    expect(
      readOrcaSessionTitle(
        { TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: worktreeId },
        command,
      ),
    ).toBeUndefined()
  })
})
