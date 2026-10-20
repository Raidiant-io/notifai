import { describe, expect, it } from 'vitest'
import { currentProcessIdentity, descriptorStartMatches, linuxStartTicks, processIdentityLiveness, processStartTime, windowsProcessStart } from './process-identity.js'

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

  it.runIf(process.platform === 'win32')('reads this process from a real Windows host', () => {
    const start = processStartTime(process.pid)
    expect(start).toMatch(/^\d{17,19}$/)
    // FILETIME counts 100 ns ticks from 1601; this process started moments ago.
    const startedAt = Number(BigInt(start!) / 10_000n) - 11_644_473_600_000
    expect(Math.abs(Date.now() - startedAt)).toBeLessThan(10 * 60_000)
    expect(currentProcessIdentity()).toEqual({ pid: process.pid, start })
    expect(processIdentityLiveness({ pid: process.pid, start: start! })).toBe('alive')
    expect(processIdentityLiveness({ pid: process.pid, start: '1' })).toBe('gone')
  })
})

it('compares tagged native FILETIME with the bare Claude Code descriptor clock', () => {
  expect(processIdentityLiveness({ pid: 9004, start: '134255407523148123' },
    () => 'windows-filetime:134255407523148123', () => true)).toBe('alive')
  expect(processIdentityLiveness({ pid: 9004, start: 'windows-filetime:134255407523148123' },
    () => '134255407523148124', () => true)).toBe('gone')
})

describe('Claude Code descriptor start', () => {
  const LSTART = 'Mon Oct 19 22:14:03 2026'

  it('reads Linux start ticks past a name holding spaces and parentheses', () => {
    const stat = '4242 (claude (main) x) S 4100 4242 4100 34816 4242 4194560 1 2 3 4 5 6 7 8 20 0 12 0 9613 1000 200 18446744073709551615'
    expect(linuxStartTicks(4242, () => stat)).toBe('9613')
    expect(linuxStartTicks(4242, () => { throw new Error('gone') })).toBeNull()
  })

  it('matches ps text everywhere and start ticks only on Linux (what Claude Code 2.1.304 writes there)', () => {
    const identity = { pid: 4242, start: LSTART }
    expect(descriptorStartMatches(LSTART, identity, null, 'darwin')).toBe(true)
    expect(descriptorStartMatches('9613', identity, '9613', 'linux')).toBe(true)
    expect(descriptorStartMatches('9613', identity, '9614', 'linux')).toBe(false)
    expect(descriptorStartMatches('9613', identity, '9613', 'darwin')).toBe(false)
    expect(descriptorStartMatches('Tue Oct 20 22:14:03 2026', identity, '9613', 'linux')).toBe(false)
  })
})
