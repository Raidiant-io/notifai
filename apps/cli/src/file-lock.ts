import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import path from 'node:path'

/**
 * Serialize a short cross-process filesystem transaction.
 *
 * Each contender publishes all of its ownership in one unique filename. A
 * two-phase bakery lock then orders live contenders by ticket and process
 * identity. Because paths are never reused, recovering an entry left by a dead
 * process cannot remove a later owner's entry; because process liveness, rather
 * than age, decides recovery, a delayed holder is never mistaken for a dead one.
 *
 * The rendezvous directory lives only as long as it has entries: the last
 * contender out removes it, so an idle machine keeps no lock state. That makes
 * the directory itself a contended resource. A contender registering while
 * another releases can find it gone, half-deleted, or already replaced by a
 * third contender, and none of those is a broken lock — so publication retries
 * within the caller's deadline and pins its rendezvous only once its own entry
 * is in the directory, which is the moment removal becomes impossible.
 *
 * Acquisition is deliberately bounded because both harness hooks and logging
 * must fail open rather than hold an agent turn indefinitely.
 */
const FILE_LOCK_WAIT_MS = 1_000
const FILE_LOCK_POLL_MS = 5
const FILE_LOCK_TOKEN_BYTES = 12
const ENTRY_PATTERN = /^(choosing|ticket-(\d+))-(\d+)-([0-9a-f]+)$/
const lockSleep = new Int32Array(new SharedArrayBuffer(4))

export type FileLockObservation =
  /** The rendezvous has been scanned and this contender is about to publish. */
  | { phase: 'registering'; entry: string }
  | { phase: 'choosing-published'; entry: string }
  | { phase: 'stale-entry'; entry: string }
  | { phase: 'waiting'; blockers: string[] }

interface FileLockOptions {
  waitMs?: number
  observe?: (observation: FileLockObservation) => void
  /** Installer transactions report lock replacement after a successful action. */
  strictRelease?: boolean
}

interface FileIdentity {
  dev: number
  ino: number
}

/**
 * Identity for one published lock entry.
 *
 * Linux can immediately reuse an inode after an unlinked entry is replaced at
 * the same path. The creation/change timestamp keeps that replacement distinct
 * even when its device and inode numbers happen to match the removed entry.
 */
interface EntryIdentity {
  dev: bigint
  ino: bigint
  ctimeNs: bigint
}

interface ChoosingEntry {
  kind: 'choosing'
  name: string
  pid: number
  token: string
}

interface TicketEntry {
  kind: 'ticket'
  name: string
  pid: number
  token: string
  ticket: bigint
}

type LockEntry = ChoosingEntry | TicketEntry

function parseEntry(name: string): LockEntry | null {
  const match = ENTRY_PATTERN.exec(name)
  if (match === null) return null
  const pid = Number(match[3])
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const token = match[4]!
  if (match[1] === 'choosing') return { kind: 'choosing', name, pid, token }
  try {
    const ticket = BigInt(match[2]!)
    if (ticket <= 0n) return null
    return { kind: 'ticket', name, pid, token, ticket }
  } catch {
    return null
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    // EPERM means the process exists but is owned by somebody else. Unknown
    // failures are also treated as live: losing recovery is safer than allowing
    // two holders into the transaction.
    return true
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

function assertOwnedDirectory(directory: string): FileIdentity {
  const stat = lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${directory} is not a regular directory; refusing to use it as a file lock.`)
  }
  const uid = currentUid()
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${directory} is owned by uid ${stat.uid}, not the current user.`)
  }
  return { dev: stat.dev, ino: stat.ino }
}

/**
 * The rendezvous a contender was using is no longer the directory at that path.
 *
 * Fatal once an entry is published — a contender's own entry makes the
 * directory non-empty, so no cooperating releaser can remove it. Before
 * publication it means only that a releaser removed an empty rendezvous while
 * this contender was registering in it, which is ordinary contention.
 */
class RendezvousReplaced extends Error {}

function assertSameDirectory(directory: string, expected: FileIdentity): void {
  const current = lstatSync(directory)
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new RendezvousReplaced(`${directory} changed while the file lock was active.`)
  }
}

function entryIdentity(stat: { dev: bigint; ino: bigint; ctimeNs: bigint }): EntryIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    ctimeNs: stat.ctimeNs,
  }
}

function sameEntryIdentity(file: string, expected: EntryIdentity): boolean {
  try {
    const current = lstatSync(file, { bigint: true })
    return (
      current.dev === expected.dev &&
      current.ino === expected.ino &&
      current.ctimeNs === expected.ctimeNs
    )
  } catch {
    return false
  }
}

/** Live protocol entries, pruning only unique paths whose process is gone. */
function liveEntries(
  directory: string,
  directoryIdentity: FileIdentity,
  observe: FileLockOptions['observe'],
): LockEntry[] {
  assertSameDirectory(directory, directoryIdentity)
  const live: LockEntry[] = []
  for (const name of readdirSync(directory)) {
    const entry = parseEntry(name)
    if (entry === null) continue
    const entryPath = path.join(directory, name)
    let stat
    try {
      stat = lstatSync(entryPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    const uid = currentUid()
    if (stat.isSymbolicLink() || !stat.isFile() || (uid !== undefined && stat.uid !== uid)) {
      throw new Error(`${entryPath} is not a current-user-owned regular file-lock entry.`)
    }
    if (processIsAlive(entry.pid)) {
      live.push(entry)
      continue
    }
    observe?.({ phase: 'stale-entry', entry: name })
    try {
      // Recheck the unique dead owner's inode so delayed recovery cannot reap
      // a replacement published at the same path by external interference.
      const current = lstatSync(entryPath)
      if (current.dev === stat.dev && current.ino === stat.ino) unlinkSync(entryPath)
    } catch {
      // Another contender already recovered this exact dead owner's unique path.
    }
  }
  return live
}

function publishEmpty(file: string): EntryIdentity {
  const handle = openSync(file, 'wx', 0o600)
  try {
    return entryIdentity(fstatSync(handle, { bigint: true }))
  } finally {
    closeSync(handle)
  }
}

/**
 * True when a publication attempt lost its rendezvous rather than found a
 * broken one.
 *
 * A releaser removes an empty rendezvous directory the moment the last entry
 * goes, so a contender registering at that instant sees the removal from
 * whichever side it reached first. All three are the same event: `ENOENT` when
 * the directory is already gone, `EINVAL` when APFS reports a directory that is
 * still being deleted, and a replaced identity when a third contender recreated
 * it first. None of them says anything about the lock's integrity, because a
 * contender with no published entry owns nothing yet.
 */
function lostTheRendezvous(err: unknown): boolean {
  if (err instanceof RendezvousReplaced) return true
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'EINVAL'
}

function publishChoosing(
  directory: string,
  name: string,
  deadline: number,
  observe: FileLockOptions['observe'],
): { file: string; fileIdentity: EntryIdentity; directoryIdentity: FileIdentity } {
  const file = path.join(directory, name)
  for (;;) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const registrar = assertOwnedDirectory(directory)
      chmodSync(directory, 0o700)
      // Recover before registration so a delayed stale cleanup can only name an
      // old owner's unique path, never this contender's future one.
      liveEntries(directory, registrar, observe)
      observe?.({ phase: 'registering', entry: name })
      const fileIdentity = publishEmpty(file)
      // Pin the rendezvous that holds the entry, not the one scanned before it
      // existed. `open` resolves the path atomically, so the entry lands in
      // whichever directory the path named at that instant — and from then on
      // that directory is non-empty, so no cooperating releaser can remove it.
      // Reading the identity here therefore names the contender's real
      // rendezvous even when the scanned one was removed and recreated
      // underneath it.
      const directoryIdentity = assertOwnedDirectory(directory)
      if (!sameEntryIdentity(file, fileIdentity)) {
        throw new RendezvousReplaced(`${directory} no longer holds ${name}.`)
      }
      return { file, fileIdentity, directoryIdentity }
    } catch (err) {
      if (!lostTheRendezvous(err)) throw err
      // Recreate it and register again; the deadline, not the number of losses,
      // decides when contention becomes a failure.
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out publishing file lock contender in ${directory}: ${(err as Error).message}`,
        )
      }
      Atomics.wait(lockSleep, 0, 0, FILE_LOCK_POLL_MS)
    }
  }
}

function comesBefore(entry: TicketEntry, ticket: bigint, pid: number, token: string): boolean {
  if (entry.ticket !== ticket) return entry.ticket < ticket
  if (entry.pid !== pid) return entry.pid < pid
  return entry.token < token
}

export function withFileLock<T>(file: string, action: () => T, options: FileLockOptions = {}): T {
  const waitMs = options.waitMs ?? FILE_LOCK_WAIT_MS
  const deadline = Date.now() + waitMs
  const pid = process.pid
  const token = randomBytes(FILE_LOCK_TOKEN_BYTES).toString('hex')
  const choosingName = `choosing-${pid}-${token}`
  let ownedPath: string | null = null
  let ownedIdentity: EntryIdentity | null = null
  let directoryIdentity: FileIdentity | null = null
  let operationFailed = false

  try {
    const published = publishChoosing(file, choosingName, deadline, options.observe)
    ownedPath = published.file
    ownedIdentity = published.fileIdentity
    directoryIdentity = published.directoryIdentity
    options.observe?.({ phase: 'choosing-published', entry: choosingName })
    let highest = 0n
    for (const entry of liveEntries(file, directoryIdentity, options.observe)) {
      if (entry.kind === 'ticket' && entry.ticket > highest) highest = entry.ticket
    }
    const ticket = highest + 1n
    const ticketName = `ticket-${ticket}-${pid}-${token}`
    const ticketPath = path.join(file, ticketName)

    // The rename is the doorway: observers see either a chooser or its complete
    // ticket, never a gap in which a live contender has no published state.
    renameSync(ownedPath, ticketPath)
    ownedPath = ticketPath
    ownedIdentity = entryIdentity(lstatSync(ticketPath, { bigint: true }))

    for (;;) {
      const blockers: string[] = []
      for (const entry of liveEntries(file, directoryIdentity, options.observe)) {
        if (entry.pid === pid && entry.token === token) continue
        if (entry.kind === 'choosing' || comesBefore(entry, ticket, pid, token)) {
          blockers.push(entry.name)
        }
      }
      if (blockers.length === 0) {
        assertSameDirectory(file, directoryIdentity)
        return action()
      }
      options.observe?.({ phase: 'waiting', blockers })
      if (Date.now() >= deadline) throw new Error(`timed out waiting for file lock ${file}`)
      Atomics.wait(lockSleep, 0, 0, FILE_LOCK_POLL_MS)
    }
  } catch (err) {
    operationFailed = true
    throw err
  } finally {
    let releaseChanged = false
    if (ownedPath !== null && ownedIdentity !== null) {
      try {
        if (sameEntryIdentity(ownedPath, ownedIdentity)) unlinkSync(ownedPath)
        else releaseChanged = true
      } catch {
        // External cleanup cannot turn a release failure into a caller failure.
      }
    }
    try {
      if (directoryIdentity !== null) assertSameDirectory(file, directoryIdentity)
      rmdirSync(file)
    } catch {
      // Another contender has published, or external cleanup already removed it.
    }
    if (releaseChanged && options.strictRelease === true && !operationFailed) {
      throw new Error(`${ownedPath ?? file} changed while held; refusing to remove the replacement.`)
    }
  }
}

/**
 * Serialize a read/merge/write transaction for one user-owned target file.
 *
 * This is the single installer-facing lock policy: the target's direct parent
 * is a real current-user-owned directory, remains the same inode throughout,
 * and the bakery rendezvous lives beside the target rather than inside it.
 */
export function withTargetFileLock<T>(
  target: string,
  action: () => T,
  options: Omit<FileLockOptions, 'strictRelease'> = {},
): T {
  const parent = path.dirname(target)
  mkdirSync(parent, { recursive: true })
  const parentIdentity = assertOwnedDirectory(parent)
  const lockDirectory = path.join(parent, `.${path.basename(target)}.notifai.lock`)
  return withFileLock(
    lockDirectory,
    () => {
      assertSameDirectory(parent, parentIdentity)
      return action()
    },
    { ...options, strictRelease: true },
  )
}
