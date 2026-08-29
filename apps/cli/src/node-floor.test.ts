import { describe, expect, it } from 'vitest'
import { NODE_MAJOR_FLOOR, belowNodeFloor, nodeFloorMessage, nodeMajor } from './node-floor.js'

describe('the Node runtime floor', () => {
  it('turns away a runtime below the floor', () => {
    expect(belowNodeFloor('v20.11.1')).toBe(true)
    expect(belowNodeFloor('v18.0.0')).toBe(true)
  })

  it('admits the floor and everything above it', () => {
    expect(belowNodeFloor(`v${NODE_MAJOR_FLOOR}.0.0`)).toBe(false)
    expect(belowNodeFloor('v24.3.0')).toBe(false)
  })

  it('does not strand a reader whose version it cannot read', () => {
    expect(nodeMajor('bun-1.2')).toBeNull()
    expect(belowNodeFloor('bun-1.2')).toBe(false)
  })

  it('says what is wrong and exactly one thing to do', () => {
    const [problem, next] = nodeFloorMessage('v20.11.1')
    expect(problem).toContain('Node 22 or newer')
    expect(problem).toContain('v20.11.1')
    expect(next).toMatch(/^next: /)
    expect(next).toContain('nodejs.org')
  })
})
