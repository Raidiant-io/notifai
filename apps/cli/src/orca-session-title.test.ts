import { describe, expect, it } from 'vitest'
import { readOrcaSessionTitle, type OrcaCommand } from './orca-session-title.js'

const worktreeId = 'repo-123::/worktrees/agent-session-labels'
const paneKey = 'tab-123:leaf-456'

function response(
  worktreeOverrides: Record<string, unknown> = {},
  agentOverrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    ok: true,
    result: {
      worktrees: [
        {
          worktreeId,
          path: '/worktrees/agent-session-labels',
          displayName: 'agent-session-labels',
          agents: [
            {
              paneKey,
              taskTitle: 'Agent Session context labels',
              ...agentOverrides,
            },
          ],
          ...worktreeOverrides,
        },
      ],
    },
  })
}

describe('Orca Agent Session title context', () => {
  it('accepts only the task title for the exact managed worktree and pane', () => {
    const calls: { executable: string; args: readonly string[] }[] = []
    const command: OrcaCommand = (executable, args) => {
      calls.push({ executable, args })
      return response()
    }

    expect(
      readOrcaSessionTitle(
        { TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: worktreeId, ORCA_PANE_KEY: paneKey },
        command,
      ),
    ).toBe('Agent Session context labels')
    expect(calls).toEqual([
      {
        executable: 'orca',
        args: ['worktree', 'ps', '--json'],
      },
    ])
  })

  it.each([
    ['command failure', () => null],
    ['malformed JSON', () => '{not json}'],
    ['failed response', () => JSON.stringify({ ok: false })],
    ['missing worktree list', () => JSON.stringify({ ok: true, result: {} })],
    ['different worktree id', () => response({ worktreeId: 'repo-123::/worktrees/other' })],
    ['different worktree path', () => response({ path: '/private/untrusted' })],
    ['different pane', () => response({}, { paneKey: 'tab-other:leaf-other' })],
    ['blank task title', () => response({}, { taskTitle: '   ' })],
    [
      'ambiguous pane',
      () =>
        response({
          agents: [
            { paneKey, taskTitle: 'First title' },
            { paneKey, taskTitle: 'Second title' },
          ],
        }),
    ],
  ])('leaves the generated fallback exceptional when context is unavailable: %s', (_name, command) => {
    expect(
      readOrcaSessionTitle(
        { TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: worktreeId, ORCA_PANE_KEY: paneKey },
        command,
      ),
    ).toBeUndefined()
  })

  it('never promotes the worktree display name when no exact task title exists', () => {
    expect(
      readOrcaSessionTitle(
        { TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: worktreeId, ORCA_PANE_KEY: paneKey },
        () => response({}, { taskTitle: undefined }),
      ),
    ).toBeUndefined()
  })

  it.each([
    ['not Orca', { TERM_PROGRAM: 'other', ORCA_WORKTREE_ID: worktreeId, ORCA_PANE_KEY: paneKey }],
    ['missing worktree', { TERM_PROGRAM: 'Orca', ORCA_PANE_KEY: paneKey }],
    ['missing pane', { TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: worktreeId }],
    [
      'invalid pane',
      { TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: worktreeId, ORCA_PANE_KEY: 'pane\nkey' },
    ],
  ])('does not call Orca when the current Agent Session selector is invalid: %s', (_name, env) => {
    let called = false
    expect(
      readOrcaSessionTitle(env, () => {
        called = true
        return response()
      }),
    ).toBeUndefined()
    expect(called).toBe(false)
  })
})
