import { expect, it } from 'vitest'
import { inspectExecutionDomain, type WindowsProcessDomain } from './cli-execution-domain.js'

it('derives app candidates from observed package identities while keeping shell and other views unproven', () => {
  const processes: WindowsProcessDomain[] = [
    { pid: 30, parent: 20, start: 'windows-filetime:300', executable: 'C:\\tools\\notifai.exe', package_family: null },
    { pid: 20, parent: 10, start: 'windows-filetime:200', executable: 'C:\\apps\\harness.exe', package_family: 'Harness.Vendor_abcd1234' },
    { pid: 10, parent: 0, start: 'windows-filetime:100', executable: 'C:\\Windows\\explorer.exe', package_family: null },
  ]
  const result = inspectExecutionDomain({ LOCALAPPDATA: 'C:\\Users\\Fixture\\AppData\\Local' }, 'win32',
    pid => processes.find(item => item.pid === pid) ?? null, 30)
  expect(result.candidate_prefixes).toEqual(['C:\\Users\\Fixture\\AppData\\Local\\Packages\\Harness.Vendor_abcd1234\\LocalCache\\Roaming\\npm'])
  expect(result.coverage).toEqual({ path: 'invoking_process', ancestry: 'observed', shell_precedence: 'unobserved', other_applications: 'unobserved' })
})

it('does not borrow a recycled parent PID or guess a package storage root on denied observation', () => {
  const result = inspectExecutionDomain({ LOCALAPPDATA: 'C:\\Users\\Fixture\\AppData\\Local' }, 'win32', pid =>
    ({ pid, parent: pid === 30 ? 20 : 0, start: `windows-filetime:${pid === 30 ? 100 : 200}`,
      executable: 'C:\\tools\\command.exe', package_family: pid === 30 ? null : 'Unrelated.Application_abcd' }), 30)
  expect(result.ancestors).toHaveLength(1)
  expect(result.candidate_prefixes).toEqual([])
  expect(result.coverage.ancestry).toBe('partial')
  expect(inspectExecutionDomain({}, 'win32', () => null, 30).coverage.ancestry).toBe('partial')
})

it('does not search Windows app storage from a Linux or macOS execution domain', () => {
  const forbidden = () => { throw new Error('cross-domain inspection') }
  expect(inspectExecutionDomain({ LOCALAPPDATA: 'C:\\Users\\Fixture' }, 'linux', forbidden).candidate_prefixes).toEqual([])
  expect(inspectExecutionDomain({}, 'darwin', forbidden).coverage.ancestry).toBe('not_applicable')
})
