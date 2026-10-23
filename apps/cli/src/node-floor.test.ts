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
