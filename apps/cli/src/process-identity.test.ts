import { describe, expect, it } from 'vitest'
import { processIdentityLiveness, windowsProcessStart } from './process-identity.js'

describe('Windows process start', () => {
  const FILETIME = '134255407523148123'

  it('reads the start as the FILETIME Claude Code writes in its descriptor', () => {
    const asked: Array<[number, string]> = []
    const start = windowsProcessStart(9001, (pid, property) => {
      asked.push([pid, property])
      return FILETIME
    }, () => 0, () => true)
    expect(start).toBe(FILETIME)
    expect(asked).toEqual([[9001, 'StartTime.ToFileTimeUtc()']])
    expect(processIdentityLiveness({ pid: 9001, start: FILETIME }, () => start, () => true)).toBe('alive')
  })

  it('accepts nothing but a plain integer', () => {
    for (const output of [null, '', '5/10/2026 08:17:53', 'Get-Process : Cannot find a process']) {
      expect(windowsProcessStart(9002, () => output, () => 0, () => true)).toBeNull()
    }
  })

  it('reuses a recent answer only while the PID still exists', () => {
    let reads = 0
    let clock = 1_000
    let alive = true
    const read = (): string => { reads++; return String(FILETIME) }
    const start = (): string | null => windowsProcessStart(9003, read, () => clock, () => alive)

    expect(start()).toBe(FILETIME)
    clock += 4_000
    expect(start()).toBe(FILETIME)
    expect(reads).toBe(1)

    // The window passed: a reused PID must not inherit the old start.
    clock += 2_000
    expect(start()).toBe(FILETIME)
    expect(reads).toBe(2)

    // The process ended within the window: ask again rather than vouch for it.
    alive = false
    expect(start()).toBe(FILETIME)
    expect(reads).toBe(3)
  })
})
