import { type EvidenceSnapshot } from '@raidiant/notifai-protocol'
import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'
import type { CommandDeps } from './commands-core.js'

/**
 * Canonical setup proof state: one per Approved Machine. Delivery is a
 * property of this machine's credential reaching the Account's devices, not of
 * a Project or of which phone happened to answer, so a new Project or a phone
 * that re-registers never asks for proof again. On disk, provenance without a
 * Companion Receipt outcome represents unknown; only an actual observed
 * receipt adds the outcome to disk.
 */
export interface SetupProofRecord {
  request_id: string
  device_id: string
  started_at: string
  companion_receipt:
    | { state: 'unknown'; observed_at: null }
    | { state: 'observed'; observed_at: string }
}

function setupProofPath(deps: CommandDeps): string | null {
  const credential = deps.store.load()
  if (credential === null) return null
  const approval = createHash('sha256')
    .update('notifai-setup-proof-approval-v1\0')
    .update(credential.secret)
    .digest('base64url')
  const digest = createHash('sha256')
    .update(JSON.stringify({ machine_id: credential.machineId, service: credential.baseUrl, approval }))
    .digest('hex')
    .slice(0, 32)
  return path.join(stateDir(deps.env), 'machine-proofs', `${digest}.json`)
}

export function readSetupProof(deps: CommandDeps): SetupProofRecord | null {
  const file = setupProofPath(deps)
  if (file === null) return null
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SetupProofRecord>
    if (
      typeof parsed.request_id !== 'string' ||
      typeof parsed.device_id !== 'string' ||
      typeof parsed.started_at !== 'string'
    ) {
      return null
    }
    const receipt = parsed.companion_receipt
    const companionReceipt = receipt === undefined ||
      receipt.state === 'unknown' && receipt.observed_at === null
      ? { state: 'unknown' as const, observed_at: null }
      : receipt.state === 'observed' && typeof receipt.observed_at === 'string'
        ? { state: 'observed' as const, observed_at: receipt.observed_at }
        : null
    if (companionReceipt === null) return null
    return {
      request_id: parsed.request_id,
      device_id: parsed.device_id,
      started_at: parsed.started_at,
      companion_receipt: companionReceipt,
    }
  } catch {
    // Corrupt local evidence is not readiness. A fresh proof replaces it.
    return null
  }
}

export function writeSetupProof(deps: CommandDeps, proof: SetupProofRecord): boolean {
  const file = setupProofPath(deps)
  if (file === null) {
    deps.io.err('Could not save setup proof without an Approved Machine credential.')
    return false
  }
  try {
    const { companion_receipt: companionReceipt, ...provenance } = proof
    const stored = companionReceipt.state === 'observed'
      ? { ...provenance, companion_receipt: companionReceipt }
      : provenance
    atomicWriteFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, {
      mode: 0o600,
      preserveMode: false,
      requireCurrentUserOwner: true,
    })
    // Per-Project proofs are superseded by the machine proof just written.
    rmSync(path.join(stateDir(deps.env), 'setup-proofs'), { recursive: true, force: true })
    return true
  } catch (err) {
    deps.io.err(
      `Could not save setup proof ${proof.request_id} at ${file}: ${String(err)}`,
    )
    return false
  }
}

export function observedCompanionReceipt(
  snapshot: EvidenceSnapshot,
  deviceId: string,
): { delivery: EvidenceSnapshot['deliveries'][number]; observedAt: string } | null {
  const delivery = snapshot.deliveries.find((candidate) => candidate.device_id === deviceId)
  if (!delivery) return null
  if (delivery.companion_receipt.state === 'observed' && delivery.companion_receipt.observed_at) {
    return { delivery, observedAt: delivery.companion_receipt.observed_at }
  }
  const receipt = delivery.events.find((event) => event.stage === 'companion_received')
  return receipt ? { delivery, observedAt: receipt.occurred_at } : null
}

/** Replace an unknown setup proof after this age; recent in-flight proofs stay. */
export const SETUP_PROOF_STALE_MS = 24 * 60 * 60 * 1000

export function setupProofIsStale(proof: SetupProofRecord, now: number): boolean {
  if (proof.companion_receipt.state === 'observed') return false
  const started = Date.parse(proof.started_at)
  return Number.isFinite(started) && now - started > SETUP_PROOF_STALE_MS
}

export function observedSetupProof(
  proof: SetupProofRecord,
  observedAt: string,
): SetupProofRecord {
  return {
    ...proof,
    companion_receipt: { state: 'observed', observed_at: observedAt },
  }
}

/**
 * Whether a saved proof still speaks for this machine. An observed receipt
 * proved the machine once and for all; an unobserved one can only still be
 * observed while the device it was sent to is ready.
 */
export function setupProofApplies(
  proof: SetupProofRecord | null,
  deviceIds: readonly string[],
): proof is SetupProofRecord {
  if (proof === null) return false
  return proof.companion_receipt.state === 'observed' || deviceIds.includes(proof.device_id)
}

/**
 * Persist ordinary send/status Companion Receipts as this machine's delivery
 * proof so setup never sends a verification notification it no longer needs.
 */
export function recordObservedDeliveryProof(
  deps: CommandDeps,
  snapshot: EvidenceSnapshot,
): boolean {
  if (readSetupProof(deps)?.companion_receipt.state === 'observed') return true
  for (const delivery of snapshot.deliveries) {
    const observed = observedCompanionReceipt(snapshot, delivery.device_id)
    if (observed === null) continue
    return writeSetupProof(deps, {
      request_id: snapshot.request_id,
      device_id: delivery.device_id,
      started_at: observed.observedAt,
      companion_receipt: { state: 'observed', observed_at: observed.observedAt },
    })
  }
  return false
}
