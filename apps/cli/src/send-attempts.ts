import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import path from 'node:path'
import type { NotificationDraftT } from '@raidiant/notifai-protocol'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'
import type { MachineCredential } from './credentials.js'

interface SendAttemptRecord {
  version: 1
  attempt_id: string
  fingerprint: string
  idempotency_key: string
  credential_tag: string
  machine_id: string
  service: string
  created_at: string
  expires_at: string
}

export const SEND_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000

/** Stable pre-upload media identities used only inside the keyed draft digest. */
export function semanticMediaIds(images: readonly string[], cwd: string): string[] {
  return images.map((image) => {
    if (image.startsWith('med_')) return image
    const digest = createHash('sha256')
    if (/^https?:\/\//i.test(image)) digest.update(`url\0${image}`)
    else digest.update('file\0').update(readFileSync(path.resolve(cwd, image)))
    return `med_retry_${digest.digest('base64url')}`
  })
}

function directory(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'send-attempts')
}

function credentialTag(credential: MachineCredential): string {
  return createHmac('sha256', credential.secret)
    .update('notifai-send-attempt-credential-v1')
    .digest('base64url')
}

/** A keyed digest proves equality without persisting notification content. */
export function sendDraftFingerprint(
  draft: NotificationDraftT,
  credential: MachineCredential,
): string {
  return createHmac('sha256', credential.secret)
    .update('notifai-send-draft-v1\0')
    .update(JSON.stringify(draft))
    .digest('base64url')
}

function parseRecord(file: string): SendAttemptRecord | null {
  let descriptor: number | undefined
  try {
    const before = lstatSync(file)
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (before.isSymbolicLink() || !before.isFile() || (uid !== undefined && before.uid !== uid)) {
      return null
    }
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    descriptor = openSync(file, flags)
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return null
    const value = JSON.parse(readFileSync(descriptor, 'utf8')) as Partial<SendAttemptRecord>
    return value.version === 1 &&
      typeof value.attempt_id === 'string' &&
      typeof value.fingerprint === 'string' &&
      typeof value.idempotency_key === 'string' &&
      typeof value.credential_tag === 'string' &&
      typeof value.machine_id === 'string' &&
      typeof value.service === 'string' &&
      typeof value.created_at === 'string' &&
      typeof value.expires_at === 'string'
      ? value as SendAttemptRecord
      : null
  } catch {
    return null
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function liveRecords(
  env: NodeJS.ProcessEnv,
  credential: MachineCredential,
  now: number,
): SendAttemptRecord[] {
  const dir = directory(env)
  if (!existsSync(dir)) return []
  const directoryStat = lstatSync(dir)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    (uid !== undefined && directoryStat.uid !== uid)
  ) return []
  const tag = credentialTag(credential)
  const records: SendAttemptRecord[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    const record = parseRecord(file)
    const expired = record === null || Date.parse(record.expires_at) <= now
    const rotated = record !== null && (
      record.machine_id !== credential.machineId ||
      record.service !== credential.baseUrl ||
      record.credential_tag !== tag
    )
    if (expired || rotated) {
      rmSync(file, { force: true })
      continue
    }
    records.push(record)
  }
  return records
}

export type BeginAttempt =
  | { ok: true; attemptId: string; idempotencyKey: string; replay: boolean }
  | { ok: false; code: 'retry_not_found' | 'retry_ambiguous'; message: string }

export function beginSendAttempt(options: {
  env: NodeJS.ProcessEnv
  credential: MachineCredential
  fingerprint: string
  retry: boolean
  idempotencyKey?: string
  now?: number
}): BeginAttempt {
  const now = options.now ?? Date.now()
  const live = liveRecords(options.env, options.credential, now)
  if (options.retry) {
    const matches = live.filter((record) => record.fingerprint === options.fingerprint)
    if (matches.length === 0) {
      return {
        ok: false,
        code: 'retry_not_found',
        message: 'No unresolved opaque attempt matches this exact send on the current Approved Machine.',
      }
    }
    if (matches.length > 1) {
      return {
        ok: false,
        code: 'retry_ambiguous',
        message: 'More than one unresolved opaque attempt matches this exact send; refusing to guess or create another notification.',
      }
    }
    const match = matches[0]!
    return { ok: true, attemptId: match.attempt_id, idempotencyKey: match.idempotency_key, replay: true }
  }

  const attemptId = `sat_${randomBytes(12).toString('base64url')}`
  const idempotencyKey = options.idempotencyKey ?? `cli-${randomBytes(12).toString('base64url')}`
  const record: SendAttemptRecord = {
    version: 1,
    attempt_id: attemptId,
    fingerprint: options.fingerprint,
    idempotency_key: idempotencyKey,
    credential_tag: credentialTag(options.credential),
    machine_id: options.credential.machineId,
    service: options.credential.baseUrl,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + SEND_ATTEMPT_TTL_MS).toISOString(),
  }
  atomicWriteFileSync(
    path.join(directory(options.env), `${attemptId}.json`),
    `${JSON.stringify(record)}\n`,
    { mode: 0o600, directoryMode: 0o700, requireCurrentUserOwner: true },
  )
  return { ok: true, attemptId, idempotencyKey, replay: false }
}

export function settleSendAttempt(env: NodeJS.ProcessEnv, attemptId: string): void {
  rmSync(path.join(directory(env), `${attemptId}.json`), { force: true })
}
