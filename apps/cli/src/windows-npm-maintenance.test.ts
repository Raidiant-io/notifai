import { describe,expect,it } from 'vitest'
import type { RuntimeOwnerInspection } from './runtime-retention.js'
import { assertNpmMaintenanceQuiet,parseNpmAppObservation,type NpmMaintenanceScope,type WindowsReaderCensus } from './windows-npm-maintenance.js'

const coordinator = { pid: 10, start: 'windows-filetime:100' }
const manager = { pid: 20, start: 'windows-filetime:200' }
const producer = { pid: 30, start: 'windows-filetime:300', executable: 'C:\\Apps\\Codex\\codex.exe' }
const observation = { schema: 1 as const, source: 'affected-shell' as const, command: 'C:\\Tools\\npm\\notifai.ps1',
  prefix: 'C:\\Tools\\npm', state_roots: ['C:\\State\\notifai'], producers: [producer], consumer: 'windows-direct-cli' as const }
const scope: NpmMaintenanceScope = { observation, prefix: { path: observation.prefix, identity: '1:2' },
  states: [{ path: observation.state_roots[0]!, identity: '1:3' }] }
const clear = (): RuntimeOwnerInspection => ({ status: 'clear', stateRoots: observation.state_roots,
  hosts: [], residents: [], sessions: [], unattributedPending: false })
const reader = (identity = coordinator) => ({ ...identity, executable: 'C:\\Tools\\node.exe', reason: 'package' as const })
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
  it('refuses a restarted producer or detached reader without script-name guesses', () => {
    expect(check({ readers: [{ ...producer, pid: 31, start: 'windows-filetime:301', reason: 'application' }], uncertain: false })).toThrow(/application: PID 31/)
    expect(check({ readers: [reader({ pid: 99, start: 'windows-filetime:999' })], uncertain: false })).toThrow(/package: PID 99/)
  })
})
