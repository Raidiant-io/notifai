import { describe,expect,it } from 'vitest'
import { linuxStartTicks,processIdentityLiveness,processStartTime,windowsProcessStart } from './process-identity.js'

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
})

it('compares tagged native FILETIME with the bare Claude Code descriptor clock', () => {
  expect(processIdentityLiveness({ pid: 9004, start: '134255407523148123' },
    () => 'windows-filetime:134255407523148123', () => true)).toBe('alive')
  expect(processIdentityLiveness({ pid: 9004, start: 'windows-filetime:134255407523148123' },
    () => '134255407523148124', () => true)).toBe('gone')
})

describe('Claude Code descriptor start', () => {

  it('reads Linux start ticks past a name holding spaces and parentheses', () => {
    const stat = '4242 (claude (main) x) S 4100 4242 4100 34816 4242 4194560 1 2 3 4 5 6 7 8 20 0 12 0 9613 1000 200 18446744073709551615'
    expect(linuxStartTicks(4242, () => stat)).toBe('9613')
    expect(linuxStartTicks(4242, () => { throw new Error('gone') })).toBeNull()
  })
})

describe.runIf(process.platform === 'linux')('Linux process start', () => {
  it('is the boot and kernel start ticks, which no wall-clock step moves', () => {
    const start = processStartTime(process.ppid)
    expect(start).toMatch(/^linux:[0-9a-f-]+:\d+$/)
    expect(start!.endsWith(`:${linuxStartTicks(process.ppid)}`)).toBe(true)
  })
})
