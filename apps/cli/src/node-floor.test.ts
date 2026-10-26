import { spawnSync } from 'node:child_process'
import { describe,expect,it } from 'vitest'
import {
belowNodeFloor,
nodeMajor
} from './node-floor.js'

describe('the Node runtime floor', () => {
  it('turns away a runtime below the floor', () => {
    expect(belowNodeFloor('v20.11.1')).toBe(true)
    expect(belowNodeFloor('v18.0.0')).toBe(true)
  })

  it('does not strand a reader whose version it cannot read', () => {
    expect(nodeMajor('bun-1.2')).toBeNull()
    expect(belowNodeFloor('bun-1.2')).toBe(false)
  })
})


it.each([
  { args: ['hook', 'user-prompt-submit', '--harness', 'claude-code'], env: {} },
  { args: ['hook', 'permission-request', '--harness', 'claude-code'], env: {} },
  { args: ['hook', 'stop', '--harness', 'claude-code'], env: {} },
  { args: [], env: { CURSOR_VERSION: '1.0' } },
])('does not block a hook under an unsupported Node: $args', ({ args, env }) => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `Object.defineProperty(process, 'version', { value: 'v18.20.8' }); process.argv = ['node', 'notifai', ...${JSON.stringify(args)}]; await import(${JSON.stringify(new URL('../dist/main.js', import.meta.url).href)});`],
  { encoding: 'utf8', env: { ...process.env, ...env } })
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
})

it('still explains the Node floor for an explicit command', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `Object.defineProperty(process, 'version', { value: 'v18.20.8' }); process.argv = ['node', 'notifai', 'ask']; await import(${JSON.stringify(new URL('../dist/main.js', import.meta.url).href)});`],
  { encoding: 'utf8' })
  expect(result.status).toBe(2)
  expect(result.stderr).toContain('Notifai needs Node 20.12 or newer')
})
