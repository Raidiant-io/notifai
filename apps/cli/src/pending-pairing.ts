import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'

/**
 * A machine approval this computer started and has not heard the end of.
 *
 * Approval happens in the User's browser, and the command that started it is
 * not always still running when they get there. An agent's shell tool times
 * out, a terminal is closed, a remote session drops — and the approval then
 * creates an Approved Machine whose credential nobody kept, so the next run
 * asks the User to approve a second computer that is the same computer.
 *
 * Keeping the handshake on disk between runs is what makes "approve it, then
 * run setup again" a true sentence. The file holds the credential-to-be, so
 * it lives in the private state directory with owner-only permissions, is
 * discarded the moment the pairing resolves, and is never read once the
 * service says it expired.
 */
export interface PendingPairing {
  pairing_id: string
  code: string
  /** The approval page, confirmation secret included. Safe to show the User. */
  approve_url: string
  base_url: string
  machine_name: string
  /** The machine credential the approval will activate. */
  secret: string
  poll_verifier: string
  expires_at: string
  poll_interval_seconds: number
}

export function pendingPairingPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(stateDir(env, platform), 'pending-pairing.json')
}

function isPendingPairing(value: unknown): value is PendingPairing {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['pairing_id'] === 'string' &&
    typeof record['code'] === 'string' &&
    typeof record['approve_url'] === 'string' &&
    typeof record['base_url'] === 'string' &&
    typeof record['machine_name'] === 'string' &&
    typeof record['secret'] === 'string' &&
    typeof record['poll_verifier'] === 'string' &&
    typeof record['expires_at'] === 'string' &&
    typeof record['poll_interval_seconds'] === 'number'
  )
}

/**
 * How long after its own expiry a handshake is still asked about. The
 * service answers `approved` for an approved pairing even after its expiry,
 * and the User who approved at minute nine and said so at minute twelve must
 * not be handed a second code. Only the service's answer — expired, denied,
 * unknown — discards a handshake; the local clock only stops asking about
 * files nobody could still be approving.
 */
const RESUME_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * The handshake still worth asking about, or null. Anything unreadable, or
 * long past the point where an approval could still be pending, is removed
 * on the way out.
 */
export function readPendingPairing(env: NodeJS.ProcessEnv, nowMs: number): PendingPairing | null {
  const file = pendingPairingPath(env)
  if (!existsSync(file)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    clearPendingPairing(env)
    return null
  }
  if (!isPendingPairing(parsed) || !(Date.parse(parsed.expires_at) + RESUME_GRACE_MS > nowMs)) {
    clearPendingPairing(env)
    return null
  }
  return parsed
}

export function writePendingPairing(env: NodeJS.ProcessEnv, pairing: PendingPairing): void {
  atomicWriteFileSync(pendingPairingPath(env), `${JSON.stringify(pairing, null, 2)}\n`, {
    mode: 0o600,
    requireCurrentUserOwner: true,
  })
}

export function clearPendingPairing(env: NodeJS.ProcessEnv): void {
  try {
    unlinkSync(pendingPairingPath(env))
  } catch {
    // Already gone, which is the state this asks for.
  }
}
