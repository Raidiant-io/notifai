import { describe, expect, it } from 'vitest'
import { compareReleasePrecedence, compareVersions, isPrerelease, isSemVer, parseVersion } from './version.js'

describe('shared release version comparison', () => {
  it('orders CLI, harness, and Node release identities by their numeric core', () => {
    expect(compareVersions('10.1.7', '10.1.6')).toBe('after')
    expect(compareVersions('2.1.224-beta.1', '2.1.224')).toBe('equal')
    expect(compareVersions('v20.12.0', '20.12.1')).toBe('before')
  })

  it('makes malformed input explicit instead of converting it to zero', () => {
    expect(parseVersion('2.next.224')).toBeNull()
    expect(compareVersions('2.next.224', '2.1.224')).toBe('unparseable')
  })

  it('keeps package SemVer stricter than runtime version spelling', () => {
    expect(isSemVer('10.1.7-rc.1+build.9')).toBe(true)
    expect(isSemVer('v10.1.7')).toBe(false)
    expect(isSemVer('10.01.7')).toBe(false)
  })
})

describe('release precedence', () => {
  it('orders releases by full SemVer precedence', () => {
    // The SemVer 2.0.0 section 11 example, ascending.
    const ascending = [
      '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2',
      '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1-beta.1', '1.0.1', '1.10.0', '2.0.0',
    ]
    for (let index = 1; index < ascending.length; index += 1) {
      expect(compareReleasePrecedence(ascending[index - 1]!, ascending[index]!)).toBe('before')
      expect(compareReleasePrecedence(ascending[index]!, ascending[index - 1]!)).toBe('after')
    }
    expect(compareReleasePrecedence('11.4.0-beta.1', '11.4.0-beta.1')).toBe('equal')
  })

  it('compares numeric identifiers exactly beyond the safe integer range', () => {
    expect(compareReleasePrecedence('1.0.0-beta.9007199254740993', '1.0.0-beta.9007199254740992')).toBe('after')
    expect(compareReleasePrecedence('9007199254740993.0.0', '9007199254740992.0.0')).toBe('after')
  })

  it('ignores build metadata and refuses anything that is not strict SemVer', () => {
    expect(compareReleasePrecedence('1.0.0+build.2', '1.0.0+build.1')).toBe('equal')
    for (const malformed of ['v1.0.0', '1.0', '1.0.0-beta.01', '1.0.0-', 'latest']) {
      expect(compareReleasePrecedence(malformed, '1.0.0')).toBe('unparseable')
    }
  })

  it('identifies prerelease installations', () => {
    expect(isPrerelease('11.4.0-beta.1')).toBe(true)
    expect(isPrerelease('11.4.0+build.1')).toBe(false)
    expect(isPrerelease('11.4.0')).toBe(false)
    expect(isPrerelease('v11.4.0-beta.1')).toBe(false)
  })
})
