import { describe, expect, it } from 'vitest'
import { refreshAfterMenuAction } from './readiness.js'

describe('refreshAfterMenuAction', () => {
  it('does not re-assess after doctor, a test send, or a device list', () => {
    expect(refreshAfterMenuAction('doctor', true)).toBeNull()
    expect(refreshAfterMenuAction('test', true)).toBeNull()
    expect(refreshAfterMenuAction('devices', true)).toBeNull()
  })

  it('does not re-assess when the action changed nothing', () => {
    expect(refreshAfterMenuAction('account', false)).toBeNull()
    expect(refreshAfterMenuAction('settings', false)).toBeNull()
    expect(refreshAfterMenuAction('routing', false)).toBeNull()
    expect(refreshAfterMenuAction('setup', false)).toBeNull()
  })

  it('re-probes the service only after an action that can change it', () => {
    expect(refreshAfterMenuAction('setup', true)).toEqual(['local', 'remote'])
    expect(refreshAfterMenuAction('account', true)).toEqual(['local', 'remote'])
    expect(refreshAfterMenuAction('settings', true)).toEqual(['local'])
    expect(refreshAfterMenuAction('routing', true)).toEqual(['local'])
    expect(refreshAfterMenuAction('settings', true, { remote: true })).toEqual(['local', 'remote'])
  })
})
