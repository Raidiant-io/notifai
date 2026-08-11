import { randomBytes } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

/**
 * Serialize a short cross-process filesystem transaction.
 *
 * The lock contains an ownership token so a holder never removes a replacement
 * it does not own. A crashed holder is recoverable after 30 seconds, and
 * acquisition is deliberately bounded because both harness hooks and logging
 * must fail open rather than hold an agent turn indefinitely.
 */
const FILE_LOCK_STALE_MS = 30_000
const FILE_LOCK_WAIT_MS = 1_000
const FILE_LOCK_POLL_MS = 5
const lockSleep = new Int32Array(new SharedArrayBuffer(4))

export function withFileLock<T>(file: string, action: () => T): T {
  mkdirSync(path.dirname(file), { recursive: true })
  const token = randomBytes(12).toString('base64url')
  const deadline = Date.now() + FILE_LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = openSync(file, 'wx', 0o600)
      try {
        writeFileSync(handle, `${JSON.stringify({ token, at: Date.now() })}\n`)
      } finally {
        closeSync(handle)
      }
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      let stale = false
      try {
        const held = JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown }
        stale = typeof held.at !== 'number' || Date.now() - held.at >= FILE_LOCK_STALE_MS
      } catch {
        stale = true
      }
      if (stale) rmSync(file, { force: true })
      else if (Date.now() >= deadline) throw new Error(`timed out waiting for file lock ${file}`)
      else Atomics.wait(lockSleep, 0, 0, FILE_LOCK_POLL_MS)
    }
  }
  try {
    return action()
  } finally {
    try {
      const held = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown }
      if (held.token === token) rmSync(file, { force: true })
    } catch {
      // A replaced or externally removed lock is no longer ours to release.
    }
  }
}
