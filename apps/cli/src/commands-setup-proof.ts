import { type EvidenceSnapshot } from '@raidiant/notifai-protocol'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { stateDir } from './config.js'
import type { CommandDeps } from './commands-core.js'
import { inferInvocationContext } from './invocation-context.js'

export interface SetupProofRecord {
  request_id: string
  device_id: string
  project: string | null
  started_at: string
}

export function setupProofProject(deps: CommandDeps, configured: string | null): string | null {
  return configured ?? inferInvocationContext(deps.cwd).project
}

function setupProofPath(deps: CommandDeps, project: string | null): string | null {
  const credential = deps.store.load()
  if (credential === null) return null
  const approval = createHash('sha256')
    .update('notifai-setup-proof-approval-v1\0')
    .update(credential.secret)
    .digest('base64url')
  const digest = createHash('sha256')
    .update(JSON.stringify({ project, machine_id: credential.machineId, service: credential.baseUrl, approval }))
    .digest('hex')
    .slice(0, 32)
  return path.join(stateDir(deps.env), 'setup-proofs', `${digest}.json`)
}

export function readSetupProof(deps: CommandDeps, project: string | null): SetupProofRecord | null {
  const file = setupProofPath(deps, project)
  if (file === null) return null
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SetupProofRecord>
    return typeof parsed.request_id === 'string' &&
      typeof parsed.device_id === 'string' &&
      (typeof parsed.project === 'string' || parsed.project === null) &&
      typeof parsed.started_at === 'string'
      ? (parsed as SetupProofRecord)
      : null
  } catch {
    // Corrupt local evidence is not readiness. A fresh proof replaces it.
    return null
  }
}

export function writeSetupProof(deps: CommandDeps, proof: SetupProofRecord): boolean {
  const file = setupProofPath(deps, proof.project)
  if (file === null) {
    deps.io.err('Could not save setup proof without an Approved Machine credential.')
    return false
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
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
  const started = Date.parse(proof.started_at)
  return Number.isFinite(started) && now - started > SETUP_PROOF_STALE_MS
}

export function setupProofApplies(
  proof: SetupProofRecord | null,
  project: string | null,
  deviceIds: readonly string[],
): proof is SetupProofRecord {
  return proof !== null && proof.project === project && deviceIds.includes(proof.device_id)
}

/**
 * Persist ordinary send/status Companion Receipts as the project's delivery
 * proof so doctor does not demand a second verification request.
 */
export function recordObservedDeliveryProof(
  deps: CommandDeps,
  snapshot: EvidenceSnapshot,
  project: string | null,
): boolean {
  for (const delivery of snapshot.deliveries) {
    const observed = observedCompanionReceipt(snapshot, delivery.device_id)
    if (observed === null) continue
    return writeSetupProof(deps, {
      request_id: snapshot.request_id,
      device_id: delivery.device_id,
      project,
      started_at: observed.observedAt,
    })
  }
  return false
}
