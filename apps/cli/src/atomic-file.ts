import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export interface AtomicWriteOptions {
  /** Mode for a newly created file. Existing regular files keep their mode. */
  mode?: number
  /** False when a managed executable must keep the requested mode on repair. */
  preserveMode?: boolean
  /** Reject a target owned by another user instead of replacing it. */
  requireCurrentUserOwner?: boolean
}

/**
 * Replace one regular file without exposing a truncated intermediate state.
 *
 * The temporary file is a unique sibling, so rename is atomic on every
 * supported filesystem. The contents are flushed before the rename, and a
 * symlink target is refused instead of silently writing through it.
 */
export function atomicWriteFileSync(
  file: string,
  contents: string,
  options: AtomicWriteOptions = {},
): void {
  const directory = path.dirname(file)
  mkdirSync(directory, { recursive: true })
  const parent = safeDirectory(directory, options.requireCurrentUserOwner ?? false)
  const target = targetMetadata(
    file,
    options.mode ?? 0o600,
    options.preserveMode ?? true,
    options.requireCurrentUserOwner ?? false,
  )
  const temp = path.join(
    directory,
    `.${path.basename(file)}.notifai-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
  )
  let handle: number | undefined
  try {
    handle = openSync(temp, 'wx', target.mode)
    writeFileSync(handle, contents)
    fsyncSync(handle)
    closeSync(handle)
    handle = undefined
    chmodSync(temp, target.mode)
    assertSameDirectory(directory, parent)
    assertUnchangedTarget(file, target)
    renameSync(temp, file)
  } catch (err) {
    if (handle !== undefined) closeSync(handle)
    try {
      unlinkSync(temp)
    } catch {
      // Preserve the original error; the temp may not have been created.
    }
    throw err
  }
}

/** Mode to preserve, or the mode for a new file. Refuses a non-regular target. */
interface TargetMetadata {
  mode: number
  identity: { dev: number; ino: number } | null
}

function targetMetadata(
  file: string,
  fallback: number,
  preserveMode: boolean,
  requireCurrentUserOwner: boolean,
): TargetMetadata {
  let stat
  try {
    stat = lstatSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { mode: fallback, identity: null }
    }
    throw err
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `${file} is a symlink; refusing to write through it. Replace it with a regular file, ` +
        'or use a different state directory.',
    )
  }
  if (!stat.isFile()) throw new Error(`${file} is not a regular file; refusing to replace it.`)
  if (requireCurrentUserOwner) assertCurrentUserOwns(file, stat.uid)
  return {
    mode: preserveMode ? stat.mode & 0o777 : fallback,
    identity: { dev: stat.dev, ino: stat.ino },
  }
}

function assertUnchangedTarget(file: string, target: TargetMetadata): void {
  let current
  try {
    current = lstatSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && target.identity === null) return
    throw new Error(`${file} changed during the atomic write; refusing to replace it.`)
  }
  if (
    target.identity === null ||
    current.dev !== target.identity.dev ||
    current.ino !== target.identity.ino
  ) {
    throw new Error(`${file} changed during the atomic write; refusing to replace it.`)
  }
}

function safeDirectory(
  directory: string,
  requireCurrentUserOwner: boolean,
): { dev: number; ino: number } {
  const stat = lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${directory} is not a regular directory; refusing to write inside it.`)
  }
  if (requireCurrentUserOwner) assertCurrentUserOwns(directory, stat.uid)
  return { dev: stat.dev, ino: stat.ino }
}

function assertSameDirectory(directory: string, expected: { dev: number; ino: number }): void {
  const current = lstatSync(directory)
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new Error(`${directory} changed during the write; refusing to publish the file.`)
  }
}

function assertCurrentUserOwns(file: string, owner: number): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && owner !== uid) {
    throw new Error(`${file} is owned by uid ${owner}, not the current user; refusing to replace it.`)
  }
}

export interface FileLockOptions {
  /** How long another live Notifai operation may hold the lock. */
  timeoutMs?: number
  /** Locks older than this are abandoned operation residue and may be reclaimed. */
  staleMs?: number
}

/**
 * Serialize Notifai read/merge/write operations for one shared settings file.
 *
 * Atomic rename prevents partial files but cannot prevent two installers from
 * both reading the same original and losing one merge. The sibling lock makes
 * that whole transaction one operation. A symlink, non-file, or foreign-owned
 * lock is never followed or removed; only an old regular lock owned by this
 * user is eligible for stale recovery.
 */
export function withFileLockSync<T>(
  file: string,
  action: () => T,
  options: FileLockOptions = {},
): T {
  const lock = path.join(path.dirname(file), `.${path.basename(file)}.notifai.lock`)
  const timeoutMs = options.timeoutMs ?? 5_000
  const staleMs = options.staleMs ?? 30_000
  const deadline = Date.now() + timeoutMs
  const waitCell = new Int32Array(new SharedArrayBuffer(4))
  const directory = path.dirname(file)
  mkdirSync(directory, { recursive: true })
  const parent = safeDirectory(directory, true)

  let handle: number | undefined
  let acquired: { dev: number; ino: number } | undefined
  for (;;) {
    try {
      assertSameDirectory(directory, parent)
      handle = openSync(lock, 'wx', 0o600)
      const stat = fstatSync(handle)
      acquired = { dev: stat.dev, ino: stat.ino }
      writeFileSync(handle, `${process.pid}:${randomBytes(8).toString('hex')}\n`)
      fsyncSync(handle)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const pathStat = lstatSync(lock)
      if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
        throw new Error(`${lock} is not a regular lock file; refusing to follow or remove it.`)
      }
      const observed = openSync(lock, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = fstatSync(observed)
      const lease = readFileSync(observed, 'utf8')
      closeSync(observed)
      if (!stat.isFile()) {
        throw new Error(`${lock} is not a regular lock file; refusing to follow or remove it.`)
      }
      assertCurrentUserOwns(lock, stat.uid)
      const ownerPid = Number(/^([0-9]+):/.exec(lease)?.[1] ?? Number.NaN)
      if (Date.now() - stat.mtimeMs > staleMs && !processIsAlive(ownerPid)) {
        // Recheck the inode immediately before removal. This prevents a second
        // stale-lock contender from deleting the fresh lease acquired by the
        // first one in the ordinary recovery race.
        const current = lstatSync(lock)
        if (current.dev !== stat.dev || current.ino !== stat.ino) continue
        try {
          unlinkSync(lock)
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for another Notifai operation on ${file}.`)
      }
      Atomics.wait(waitCell, 0, 0, Math.min(25, Math.max(1, deadline - Date.now())))
    }
  }

  try {
    return action()
  } finally {
    if (handle !== undefined) closeSync(handle)
    if (acquired !== undefined) {
      const current = lstatSync(lock)
      if (current.dev !== acquired.dev || current.ino !== acquired.ino) {
        throw new Error(`${lock} changed while held; refusing to remove the replacement.`)
      }
      unlinkSync(lock)
    }
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
