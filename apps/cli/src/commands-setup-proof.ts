import { type EvidenceSnapshot } from '@raidiant/notifai-protocol'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { stateDir } from './config.js'
import type { CommandDeps } from './commands-core.js'

interface SetupProofRecord {
  request_id: string
  device_id: string
  project: string | null
  started_at: string
}

function setupProofPath(deps: CommandDeps): string {
  let projectDir = path.resolve(deps.cwd)
  try {
    projectDir = realpathSync(projectDir)
  } catch {
    // A deleted or not-yet-created cwd cannot collide with a real directory:
    // the resolved absolute path is still a stable local identity for it.
  }
  const digest = createHash('sha256').update(projectDir).digest('hex').slice(0, 32)
  return path.join(stateDir(deps.env), 'setup-proofs', `${digest}.json`)
}

export function readSetupProof(deps: CommandDeps): SetupProofRecord | null {
  const file = setupProofPath(deps)
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
  const file = setupProofPath(deps)
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
  const receipt = delivery?.events.find((event) => event.stage === 'companion_received')
  return delivery && receipt ? { delivery, observedAt: receipt.occurred_at } : null
}
