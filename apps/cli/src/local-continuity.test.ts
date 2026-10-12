import { expect, it } from 'vitest'
import { acceptsLocalContract, localContinuity, LOCAL_CONTINUITY_CAPABILITIES, canShareLocalState, HISTORICAL_LOCAL_CONTINUITY, installedRuntime, LOCAL_CONTINUITY } from './local-continuity.js'
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


it.each(['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-arm64', 'bun-linux-x64', 'bun-windows-arm64', 'bun-windows-x64'])(
  'requires an authenticated exact-target predecessor declaration: %s', target => {
    const inventory = (continuity: unknown) => ({ schema: 2, local_continuity: continuity, artifacts: [{ target }] }) as ReleaseInventory
    const candidate = inventory(localContinuity(LOCAL_CONTINUITY_CAPABILITIES))
    const historical = inventory({ contract: HISTORICAL_LOCAL_CONTINUITY })
    expect(canShareLocalState(candidate, historical, target)).toBe(!target.includes('linux'))
    expect(canShareLocalState(inventory({ contract: LOCAL_CONTINUITY }), historical, target)).toBe(false)
    expect(canShareLocalState(candidate, historical)).toBe(false)
    expect(canShareLocalState(candidate, { ...historical, artifacts: [] }, target)).toBe(false)
    expect(canShareLocalState(historical, candidate, target)).toBe(false)
    expect(acceptsLocalContract(LOCAL_CONTINUITY_CAPABILITIES, 'toString', target)).toBe(false)
  })

it.each([null, [], { 'notifai-session-state-v1': ['bun-linux-x64', 'bun-linux-x64'] },
  { 'notifai-session-state-v1': ['darwin'] }, { 'notifai-session-state-v1': [] },
  { 'notifai-session-state-v1': 'bun-darwin-arm64' }, { 'notifai-session-state-v2': ['bun-darwin-arm64'] },
])('rejects malformed signed compatibility declarations %j', compatible => {
  expect(() => localContinuity({ contract: LOCAL_CONTINUITY, compatible })).toThrow(/compatibility/)
})
