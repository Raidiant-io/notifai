import type { ReleaseInventory } from './release-distribution.js'

/** Change this identity when concurrent local readers/writers no longer share
 * state, owner entrypoints, claims, fencing and cleanup semantics. Release
 * evidence must cover all retained generations, not just adjacent versions. */
export const LOCAL_CONTINUITY = 'notifai-session-state-v1'
// Add exact historical signed inventories only with retained-owner artifact
// evidence reviewed in the release. An empty list grants no legacy overlap.
export const LOCAL_CONTINUITY_READERS: readonly string[] = []
export interface LocalContinuity {
  contract: string
  /** Exact signed historical inventories whose concurrent behavior was audited.
   * These are retained readers only, never eligible rollback destinations. */
  legacy_inventories: string[]
}

export function localContinuity(value: unknown): LocalContinuity {
  const item = value as Partial<LocalContinuity> | null
  if (!item || typeof item.contract !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.contract) ||
      !Array.isArray(item.legacy_inventories) || item.legacy_inventories.length > 128 ||
      item.legacy_inventories.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) ||
      new Set(item.legacy_inventories).size !== item.legacy_inventories.length) throw new Error('Invalid local continuity contract')
  return { contract: item.contract, legacy_inventories: [...item.legacy_inventories] }
}

export function canShareLocalState(candidate: ReleaseInventory, owner: ReleaseInventory, signedOwnerDigest: string): boolean {
  if (candidate.schema !== 2 || !candidate.local_continuity) return false
  return owner.schema === 2
    ? owner.local_continuity?.contract === candidate.local_continuity.contract
    : candidate.local_continuity.legacy_inventories.includes(signedOwnerDigest)
}

export class ContinuityPending extends Error {
  readonly code = 'continuity_pending'
  constructor(readonly build: string, reason: string) {
    super(`The candidate is staged; existing work is preserved. ${reason}`)
  }
}
