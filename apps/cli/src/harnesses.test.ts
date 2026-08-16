import { describe, expect, it } from 'vitest'
import { HARNESS_CAPABILITIES, HARNESS_LABELS, HARNESSES } from './harnesses.js'

/**
 * This file used to hold a verbatim copy of the table below it, which meant
 * changing a harness contract required changing the same words twice and the
 * test could never disagree with the code — only with whoever forgot the second
 * edit. What is worth asserting is the shape the rest of the CLI assumes.
 */
describe('harness contract', () => {
  it('describes every shipped harness, and only those', () => {
    expect(Object.keys(HARNESS_CAPABILITIES).sort()).toEqual([...HARNESSES].sort())
    expect(Object.keys(HARNESS_LABELS).sort()).toEqual([...HARNESSES].sort())
  })

  it('gives a harness that cannot continue a turn no route to pretend with', () => {
    // `ask` fails closed on these, and the reason it can is that the two facts
    // agree. A harness claiming a delivery route while declaring it cannot
    // continue would accept an answer into a void.
    for (const [harness, capability] of Object.entries(HARNESS_CAPABILITIES)) {
      if (capability.stopContinuation !== 'unsupported') continue
      expect(capability.deliveryRoutes, harness).toEqual(['unsupported'])
    }
  })

  it('gives a harness that can continue a turn at least one real route', () => {
    for (const [harness, capability] of Object.entries(HARNESS_CAPABILITIES)) {
      if (capability.stopContinuation === 'unsupported') continue
      expect(capability.deliveryRoutes.length, harness).toBeGreaterThan(0)
      expect(capability.deliveryRoutes, harness).not.toContain('unsupported')
      // The journal is the floor under every supported route: without it an
      // answer that misses its turn has nowhere to wait.
      expect(capability.deliveryRoutes, harness).toContain('hold-for-next-turn')
    }
  })

  it('explains each harness in prose an operator can act on', () => {
    for (const [harness, capability] of Object.entries(HARNESS_CAPABILITIES)) {
      expect(capability.deliveryContract.length, harness).toBeGreaterThan(40)
    }
  })
})
