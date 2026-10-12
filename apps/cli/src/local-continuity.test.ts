import { expect, it } from 'vitest'
import { canShareLocalState, HISTORICAL_LOCAL_CONTINUITY, installedRuntime, LOCAL_CONTINUITY } from './local-continuity.js'
import type { ReleaseInventory } from './release-distribution.js'

it.each(['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-arm64', 'bun-linux-x64', 'bun-windows-arm64', 'bun-windows-x64'])(
  'recognizes owned historical identity without granting equal-contract access on %s', target => {
    expect(installedRuntime({ runtime: { target, contract: HISTORICAL_LOCAL_CONTINUITY } })).toEqual({ target, contract: HISTORICAL_LOCAL_CONTINUITY })
    expect(installedRuntime({ runtime: { target, contract: LOCAL_CONTINUITY } })).toEqual({ target, contract: LOCAL_CONTINUITY })
    expect(installedRuntime({ target })).toEqual({ target })
    const inventory = (contract: string) => ({ schema: 2, local_continuity: { contract } }) as ReleaseInventory
    expect(canShareLocalState(inventory(LOCAL_CONTINUITY), inventory(HISTORICAL_LOCAL_CONTINUITY))).toBe(false)
    expect(canShareLocalState(inventory(LOCAL_CONTINUITY), inventory(LOCAL_CONTINUITY))).toBe(true)
  })

it.each([null, [], { target: 'bun-linux-x64', runtime: { target: 'bun-linux-x64', contract: LOCAL_CONTINUITY } },
  { runtime: { target: 'bun-linux-x64', contract: 'unknown' } }, { runtime: null }, { runtime: [] },
  { runtime: { contract: LOCAL_CONTINUITY } }, { target: undefined, runtime: { target: 'bun-linux-x64', contract: HISTORICAL_LOCAL_CONTINUITY } },
])('rejects ambiguous and unsupported historical identity %j', record => {
  expect(installedRuntime(record)).toBeNull()
})
