import { describe, expect, it } from 'vitest'
import { bumpFromCommits, bumpVersion, parseVersion } from './semver-policy.mjs'

describe('semver policy', () => {
  it('parses and bumps a strict triple', () => {
    expect(parseVersion('0.5.1')).toEqual({ major: 0, minor: 5, patch: 1 })
    expect(bumpVersion('0.5.1', 'patch')).toBe('0.5.2')
    expect(bumpVersion('0.5.1', 'minor')).toBe('0.6.0')
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0')
    expect(() => parseVersion('0.5.1-rc.1')).toThrow(/strict/)
  })

  it('treats 0.x breaking as minor so ^0.5.1 does not take it', () => {
    expect(bumpFromCommits([{ type: 'feat', breaking: true }], '0.5.1')).toBe('minor')
    expect(bumpFromCommits([{ type: 'feat', breaking: false }], '0.5.1')).toBe('patch')
    expect(bumpFromCommits([{ type: 'fix', breaking: false }], '0.5.1')).toBe('patch')
    expect(bumpFromCommits([{ type: 'chore', breaking: false }], '0.5.1')).toBeNull()
    expect(bumpFromCommits([{ type: 'chore', breaking: true }], '0.5.1')).toBe('minor')
  })

  it('uses SemVer 2.0.0 increments after 1.0.0', () => {
    expect(bumpFromCommits([{ type: 'feat', breaking: true }], '1.0.0')).toBe('major')
    expect(bumpFromCommits([{ type: 'feat', breaking: false }], '1.0.0')).toBe('minor')
    expect(bumpFromCommits([{ type: 'fix', breaking: false }], '1.0.0')).toBe('patch')
    expect(bumpFromCommits([{ type: 'docs', breaking: false }], '1.2.0')).toBeNull()
  })
})
