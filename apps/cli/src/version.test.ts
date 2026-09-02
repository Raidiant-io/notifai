import { describe, expect, it } from 'vitest'
import { compareVersions, isSemVer, parseVersion } from './version.js'

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
