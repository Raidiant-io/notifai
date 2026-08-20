import { describe, expect, it } from 'vitest'
import { readOrcaSessionTitle, type OrcaCommand } from './orca-session-title.js'

const worktreeId = 'repo-123::/worktrees/semantic-session-implementation'

function response(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    result: {
      worktree: {
        id: worktreeId,
        path: '/worktrees/semantic-session-implementation',
        displayName: 'Worker - semantic session implementation',
        ...overrides,
      },
    },
  })
}

describe('Orca semantic session title', () => {
  it('accepts only the display name returned for the exact managed worktree', () => {
    const calls: { executable: string; args: readonly string[] }[] = []
    const command: OrcaCommand = (executable, args) => {
      calls.push({ executable, args })
      return response()
    }

    expect(
      readOrcaSessionTitle(
        { TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: worktreeId },
        command,
      ),
    ).toBe('Worker - semantic session implementation')
    expect(calls).toEqual([
      {
        executable: 'orca',
        args: ['worktree', 'show', '--worktree', `id:${worktreeId}`, '--json'],
      },
    ])
  })

  it('uses Orca-provided executable selection without invoking a shell', () => {
    const calls: string[] = []
    expect(
      readOrcaSessionTitle(
        {
          TERM_PROGRAM: 'Orca',
          ORCA_WORKTREE_ID: worktreeId,
          ORCA_CLI_COMMAND: '/mnt/c/Program Files/Orca/orca.exe',
        },
        (executable) => {
          calls.push(executable)
          return response()
        },
      ),
    ).toBe('Worker - semantic session implementation')
    expect(calls).toEqual(['/mnt/c/Program Files/Orca/orca.exe'])
  })

  it('ignores non-Orca and malformed selectors without running a command', () => {
    const command: OrcaCommand = () => {
      throw new Error('must not run')
    }
    expect(readOrcaSessionTitle({ ORCA_WORKTREE_ID: worktreeId }, command)).toBeUndefined()
    expect(
      readOrcaSessionTitle(
        { TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: '/private/untrusted' },
        command,
      ),
    ).toBeUndefined()
    expect(
      readOrcaSessionTitle(
        { TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: 'repo-123::relative/path' },
        command,
      ),
    ).toBeUndefined()
  })

  it.each([
    ['command failure', () => null],
    ['thrown command failure', () => { throw new Error('offline') }],
    ['malformed JSON', () => '{not json}'],
    ['failed response', () => JSON.stringify({ ok: false })],
    ['different worktree id', () => response({ id: 'repo-123::/worktrees/other' })],
    ['different worktree path', () => response({ path: '/private/untrusted' })],
    ['blank display name', () => response({ displayName: '   ' })],
  ])('fails closed for %s', (_name, command) => {
    expect(
      readOrcaSessionTitle(
        { TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: worktreeId },
        command,
      ),
    ).toBeUndefined()
  })
})
