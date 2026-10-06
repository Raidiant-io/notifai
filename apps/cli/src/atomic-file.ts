import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
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
  /** Optional optimistic guard for edits derived from existing User content.
   * null requires absence; a digest must still match before publication. */
  expectedContentsSha256?: string | null
  /** Establish platform ownership on the private temporary file before publication. */
  prepareTemporary?: (file: string) => void
  /** Mode for a newly created file. Existing regular files keep their mode. */
  mode?: number
  /** False when a managed executable must keep the requested mode on repair. */
  preserveMode?: boolean
  /** Reject a target owned by another user instead of replacing it. */
  requireCurrentUserOwner?: boolean
  /**
   * POSIX directory mode applied to the parent. Defaults to 0o700 when
   * `requireCurrentUserOwner` is set so credential and config dirs match the
   * hook-adapter and log directories.
   */
  directoryMode?: number
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
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  const directory = path.dirname(file)
  const requireCurrentUserOwner = options.requireCurrentUserOwner ?? false
  const directoryMode = options.directoryMode ?? (requireCurrentUserOwner ? 0o700 : undefined)
  const parent = ensureDirectory(directory, {
    requireCurrentUserOwner,
    ...(directoryMode === undefined ? {} : { mode: directoryMode }),
  })
  const target = targetMetadata(
    file,
    options.mode ?? 0o600,
    options.preserveMode ?? true,
    options.requireCurrentUserOwner ?? false,
  )
  assertExpectedContents(file, options.expectedContentsSha256)
  const temp = path.join(
    directory,
    `.${path.basename(file)}.notifai-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
  )
  let handle: number | undefined
  try {
    handle = openSync(temp, 'wx', target.mode)
    options.prepareTemporary?.(temp)
    writeFileSync(handle, contents)
    fsyncSync(handle)
    closeSync(handle)
    handle = undefined
    // Creation may already have the exact mode. Avoid a redundant operation
    // that a sandbox can forbid while still allowing the private write.
    if ((lstatSync(temp).mode & 0o7777) !== target.mode) chmodSync(temp, target.mode)
    assertSameDirectory(directory, parent)
    assertUnchangedTarget(file, target)
    assertExpectedContents(file, options.expectedContentsSha256)
    renameSync(temp, file)
    syncDirectory(directory)
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

/**
 * Create (or tighten) a directory that must not be world-readable.
 *
 * `mkdir` mode applies only to a newly created leaf, so an existing 0755
 * credential directory would otherwise stay world-listable. POSIX chmod of
 * the leaf is the matching repair; Windows has no equivalent mode bits.
 */
export function ensurePrivateDirectory(directory: string): void {
  ensureDirectory(directory, { mode: 0o700, requireCurrentUserOwner: false })
}

function ensureDirectory(
  directory: string,
  options: { mode?: number; requireCurrentUserOwner: boolean },
): { dev: number; ino: number } {
  if (options.mode === undefined) mkdirSync(directory, { recursive: true })
  else mkdirSync(directory, { recursive: true, mode: options.mode })
  const parent = safeDirectory(directory, options.requireCurrentUserOwner)
  if (
    options.mode !== undefined &&
    process.platform !== 'win32' &&
    parent.mode !== options.mode
  ) {
    chmodSync(directory, options.mode)
  }
  return parent
}

/** Persist the published directory entry where the host supports directory fsync. */
function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const handle = openSync(directory, 'r')
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
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
): { dev: number; ino: number; mode: number } {
  const stat = lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${directory} is not a regular directory; refusing to write inside it.`)
  }
  if (requireCurrentUserOwner) assertCurrentUserOwns(directory, stat.uid)
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777 }
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


function assertExpectedContents(file: string, expected: string | null | undefined): void {
  if (expected === undefined) return
  if (expected !== null && !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid expected file digest')
  try {
    const stat = lstatSync(file)
    if (expected === null || !stat.isFile() || stat.isSymbolicLink() ||
        createHash('sha256').update(readFileSync(file)).digest('hex') !== expected) {
      throw new Error(`${file} changed since it was read; refusing to replace User content.`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && expected === null) return
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${file} changed since it was read; refusing to recreate it.`)
    throw error
  }
}
