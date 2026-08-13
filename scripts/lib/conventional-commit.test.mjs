import { describe, expect, it } from 'vitest'
import { lintCommit, parseCommit } from './conventional-commit.mjs'

describe('parseCommit', () => {
  it('parses a scoped feature', () => {
    const result = parseCommit('feat(cli): wake Claude sessions through the inbox socket')
    expect(result).toEqual({
      ok: true,
      commit: {
        type: 'feat',
        scope: 'cli',
        breaking: false,
        description: 'wake Claude sessions through the inbox socket',
        body: '',
        footers: [],
      },
    })
  })

  it('parses a breaking change via bang and footer', () => {
    const bang = parseCommit('feat(cli)!: remove the presence gate')
    expect(bang.ok).toBe(true)
    if (bang.ok) expect(bang.commit.breaking).toBe(true)

    const footer = parseCommit(
      [
        'fix(protocol): reject the old reply shape',
        '',
        'The single-question pair is gone.',
        '',
        'BREAKING CHANGE: senders must submit a question set.',
      ].join('\n'),
    )
    expect(footer.ok).toBe(true)
    if (footer.ok) {
      expect(footer.commit.breaking).toBe(true)
      expect(footer.commit.body).toBe('The single-question pair is gone.')
      expect(footer.commit.footers).toEqual([
        { token: 'BREAKING CHANGE', value: 'senders must submit a question set.' },
      ])
    }
  })

  it('rejects the mistakes agents actually make', () => {
    expect(lintCommit('Add the thing')[0]).toMatch(/not a conventional commit/)
    expect(lintCommit('feature(cli): add the thing')[0]).toMatch(/unknown type/)
    expect(lintCommit('feat(server): add the thing')[0]).toMatch(/unknown scope/)
    expect(lintCommit('feat(cli): add the thing.')[0]).toMatch(/period/)
    expect(lintCommit('feat(cli): add the thing\nbody without a blank line')[0]).toMatch(/blank line/)
    expect(lintCommit('feat(cli): close NotifAI-fg6p')[0]).toMatch(/internal tracker/)
    expect(lintCommit('Feat(cli): add the thing')[0]).toMatch(/lowercase/)
    expect(lintCommit('')[0]).toMatch(/empty/)
  })

  it('accepts an unscoped chore', () => {
    const result = parseCommit('chore: derive the skill pin from the package version')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.commit.scope).toBeNull()
  })
})
