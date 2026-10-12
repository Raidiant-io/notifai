import type { ReleaseInventory } from './release-distribution.js'

/** Change this identity when concurrent local readers/writers no longer share
 * state, owner entrypoints, claims, fencing and cleanup semantics. Release
 * evidence must cover all retained generations, not just adjacent versions,
 * and generated integration definitions they may still publish after activation.
 * Pending host setup receipts retain that obligation independently of a PID.
 * v2 includes durable Linux credential authority and clear markers. Older v1
 * writers on Linux do not understand those markers. Other platforms explicitly
 * retain v1 admission; their credential authorities and shared state did not change. */
export const LOCAL_CONTINUITY = 'notifai-session-state-v2'
export const HISTORICAL_LOCAL_CONTINUITY = 'notifai-session-state-v1'
export type InstalledLocalContinuity = typeof LOCAL_CONTINUITY | typeof HISTORICAL_LOCAL_CONTINUITY

/** Identity-only consumers retain the schema1 envelope. Native writer identity
 * now lives in runtime; absence of the old top-level target permanently fences
 * released writers that require it. Recognition is ownership, not concurrent
 * writer admission: callers granting state access must require their compiled
 * contract. Never relabel a historical record or publish both representations. */
export function installedRuntime(value: unknown): { target: string; contract?: InstalledLocalContinuity } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (!Object.hasOwn(item, 'runtime')) return typeof item['target'] === 'string' ? { target: item['target'] } : null
  if (Object.hasOwn(item, 'target')) return null
  const runtime = item['runtime'] as Record<string, unknown> | null
  return runtime && typeof runtime === 'object' && !Array.isArray(runtime) && typeof runtime['target'] === 'string' &&
    (runtime['contract'] === LOCAL_CONTINUITY || runtime['contract'] === HISTORICAL_LOCAL_CONTINUITY)
    ? { target: runtime['target'], contract: runtime['contract'] } : null
}
export interface LocalContinuity {
  contract: string
  /** Authenticated predecessor contracts this build can serve on exact targets. */
  compatible?: Readonly<Record<string, readonly string[]>>
}

export const LOCAL_CONTINUITY_CAPABILITIES: LocalContinuity = Object.freeze({
  contract: LOCAL_CONTINUITY,
  compatible: Object.freeze({ [HISTORICAL_LOCAL_CONTINUITY]: Object.freeze([
    'bun-darwin-arm64', 'bun-darwin-x64', 'bun-windows-arm64', 'bun-windows-x64',
  ]) }),
})

export function acceptsLocalContract(continuity: LocalContinuity | undefined, contract: string | undefined, target: string): boolean {
  return contract !== undefined && continuity !== undefined && (continuity.contract === contract ||
    continuity.compatible !== undefined && Object.hasOwn(continuity.compatible, contract) &&
      continuity.compatible[contract]?.includes(target) === true)
}

export function localContinuity(value: unknown): LocalContinuity {
  const item = value as Partial<LocalContinuity> | null
  if (!item || typeof item.contract !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.contract)) throw new Error('Invalid local continuity contract')
  if (item.compatible === undefined) return { contract: item.contract }
  if (item.compatible === null || typeof item.compatible !== 'object' || Array.isArray(item.compatible) ||
      Object.keys(item.compatible).length > 8) throw new Error('Invalid local continuity compatibility')
  const compatible: Record<string, readonly string[]> = Object.create(null) as Record<string, readonly string[]>
  for (const [contract, targets] of Object.entries(item.compatible)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(contract) || contract === item.contract || !Array.isArray(targets) ||
        targets.length === 0 || targets.length > 6 || new Set(targets).size !== targets.length ||
        targets.some(target => typeof target !== 'string' || !/^bun-(darwin|linux|windows)-(arm64|x64)$/.test(target))) {
      throw new Error('Invalid local continuity compatibility')
    }
    compatible[contract] = Object.freeze([...targets])
  }
  return { contract: item.contract, compatible: Object.freeze(compatible) }
}

export function canShareLocalState(candidate: ReleaseInventory, owner: ReleaseInventory, target?: string): boolean {
  if (candidate.schema !== 2 || !candidate.local_continuity) return false
  if (owner.schema !== 2 || !owner.local_continuity) return false
  if (owner.local_continuity.contract === candidate.local_continuity.contract) return true
  return target !== undefined && candidate.artifacts.some(artifact => artifact.target === target) &&
    owner.artifacts.some(artifact => artifact.target === target) &&
    acceptsLocalContract(candidate.local_continuity, owner.local_continuity.contract, target)
}

export class ContinuityPending extends Error {
  readonly code = 'continuity_pending'
  constructor(readonly build: string, reason: string) {
    super(`The candidate is staged; existing work is preserved. ${reason}`)
  }
}
