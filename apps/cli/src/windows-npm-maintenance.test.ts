import { describe, expect, it } from 'vitest'
import { assertNpmMaintenanceQuiet, parseNpmAppObservation, type NpmMaintenanceScope, type WindowsReaderCensus } from './windows-npm-maintenance.js'
import type { RuntimeOwnerInspection } from './runtime-retention.js'

const coordinator = { pid: 10, start: 'windows-filetime:100' }
const manager = { pid: 20, start: 'windows-filetime:200' }
const producer = { pid: 30, start: 'windows-filetime:300', executable: 'C:\\Apps\\Codex\\codex.exe' }
const observation = { schema: 1 as const, source: 'affected-shell' as const, command: 'C:\\Tools\\npm\\notifai.ps1',
  prefix: 'C:\\Tools\\npm', state_roots: ['C:\\State\\notifai'], producers: [producer], consumer: 'windows-direct-cli' as const }
const scope: NpmMaintenanceScope = { observation, prefix: { path: observation.prefix, identity: '1:2' },
  states: [{ path: observation.state_roots[0]!, identity: '1:3' }] }
const clear = (): RuntimeOwnerInspection => ({ status: 'clear', stateRoots: observation.state_roots,
  hosts: [], residents: [], sessions: [], unattributedPending: false })
const reader = (identity = coordinator) => ({ ...identity, executable: 'C:\\Tools\\node.exe' })
function check(census: WindowsReaderCensus, owners = [clear()], liveness: 'gone' | 'unknown' | 'alive' = 'gone') {
  return () => assertNpmMaintenanceQuiet({ scope, coordinator, manager, census, owners, liveness: () => liveness })
}

describe('observed Windows npm replacement window', () => {
  it('requires an actual direct command observation and preserves its state scope', () => {
    expect(parseNpmAppObservation(observation)).toEqual(observation)
    expect(() => parseNpmAppObservation({ ...observation, source: 'external-shell' })).toThrow(/actual-shell/)
    expect(() => parseNpmAppObservation({ ...observation, command: 'C:\\Elsewhere\\wrapper.ps1' })).toThrow(/direct command/)
    expect(() => parseNpmAppObservation({ ...observation, state_roots: ['\\\\host\\shared\\notifai'] })).toThrow(/local npm/)
    const packaged = { ...observation, command: 'C:\\AppView\\npm\\notifai.ps1', physical_command: observation.command }
    expect(parseNpmAppObservation(packaged)).toEqual(packaged)
    expect(() => parseNpmAppObservation({ ...packaged, command: 'C:\\AppView\\npm\\wrapper.ps1' })).toThrow(/direct command/)
  })
  it('admits only the exact coordinator and suspended manager', () => {
    expect(check({ readers: [reader(), reader(manager)], uncertain: false })).not.toThrow()
    expect(check({ readers: [reader({ ...manager, start: 'windows-filetime:201' })], uncertain: false })).toThrow(/possible legacy reader/)
  })
  it('refuses a restarted producer or detached reader without script-name guesses', () => {
    expect(check({ readers: [{ ...producer, pid: 31, start: 'windows-filetime:301' }], uncertain: false })).toThrow(/possible legacy reader/)
    expect(check({ readers: [reader({ pid: 99, start: 'windows-filetime:999' })], uncertain: false })).toThrow(/possible legacy reader/)
  })
  it('refuses uncertainty even when the observed list is empty', () => {
    expect(check({ readers: [], uncertain: true })).toThrow(/incomplete/)
    expect(check({ readers: [], uncertain: false }, [clear()], 'unknown')).toThrow(/producer/)
  })
  it('approval cannot substitute for an observed producer exit', () => {
    expect(check({ readers: [], uncertain: false }, [clear()], 'alive')).toThrow(/producer/)
  })
  it('checks every assessed state root and its independent debt', () => {
    expect(check({ readers: [], uncertain: false }, [])).toThrow(/session work/)
    expect(check({ readers: [], uncertain: false }, [{ ...clear(), status: 'uncertain' }])).toThrow(/session work/)
    expect(check({ readers: [], uncertain: false }, [{ ...clear(), unattributedPending: true }])).toThrow(/session work/)
    expect(check({ readers: [], uncertain: false }, [{ ...clear(), status: 'waiting_for_questions' }])).toThrow(/session work/)
  })
  it('does not discard resident owners after their producer exits', () => {
    const owner = { pid: 40, start: 'windows-filetime:400' }
    expect(() => assertNpmMaintenanceQuiet({ scope, coordinator, census: { readers: [], uncertain: false },
      owners: [{ ...clear(), residents: [{ file: 'owner.json', identity: owner, runtime: null }] }],
      liveness: identity => identity.pid === producer.pid ? 'gone' : 'unknown' })).toThrow(/session work/)
  })
})
