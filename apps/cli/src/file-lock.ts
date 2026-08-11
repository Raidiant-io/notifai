import { randomBytes } from 'node:crypto'
import {
  closeSync,
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
 * Acquisition is deliberately bounded because both harness hooks and logging
 * must fail open rather than hold an agent turn indefinitely.
 */
const FILE_LOCK_WAIT_MS = 1_000
const FILE_LOCK_POLL_MS = 5
const FILE_LOCK_TOKEN_BYTES = 12
const ENTRY_PATTERN = /^(choosing|ticket-(\d+))-(\d+)-([0-9a-f]+)$/
const lockSleep = new Int32Array(new SharedArrayBuffer(4))

export type FileLockObservation =
  | { phase: 'choosing-published'; entry: string }
  | { phase: 'stale-entry'; entry: string }
  | { phase: 'waiting'; blockers: string[] }

interface FileLockOptions {
  waitMs?: number
  observe?: (observation: FileLockObservation) => void
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

/** Live protocol entries, pruning only unique paths whose process is gone. */
function liveEntries(
  directory: string,
  observe: FileLockOptions['observe'],
): LockEntry[] {
  const live: LockEntry[] = []
  for (const name of readdirSync(directory)) {
    const entry = parseEntry(name)
    if (entry === null) continue
    if (processIsAlive(entry.pid)) {
      live.push(entry)
      continue
    }
    observe?.({ phase: 'stale-entry', entry: name })
    try {
      unlinkSync(path.join(directory, name))
    } catch {
      // Another contender already recovered this exact dead owner's unique path.
    }
  }
  return live
}

function publishEmpty(file: string): void {
  const handle = openSync(file, 'wx', 0o600)
  closeSync(handle)
}

function publishChoosing(
  directory: string,
  name: string,
  deadline: number,
  observe: FileLockOptions['observe'],
): string {
  const file = path.join(directory, name)
  for (;;) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      // Recover before registration so a delayed stale cleanup can only name an
      // old owner's unique path, never this contender's future one.
      liveEntries(directory, observe)
      publishEmpty(file)
      return file
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      // The previous holder removed an empty rendezvous directory between our
      // mkdir and publication. Recreate it; once our entry exists, no cooperating
      // releaser can remove the non-empty directory underneath us.
      if (Date.now() >= deadline) {
        throw new Error(`timed out publishing file lock contender in ${directory}`)
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

  try {
    ownedPath = publishChoosing(file, choosingName, deadline, options.observe)
    options.observe?.({ phase: 'choosing-published', entry: choosingName })
    let highest = 0n
    for (const entry of liveEntries(file, options.observe)) {
      if (entry.kind === 'ticket' && entry.ticket > highest) highest = entry.ticket
    }
    const ticket = highest + 1n
    const ticketName = `ticket-${ticket}-${pid}-${token}`
    const ticketPath = path.join(file, ticketName)

    // The rename is the doorway: observers see either a chooser or its complete
    // ticket, never a gap in which a live contender has no published state.
    renameSync(ownedPath, ticketPath)
    ownedPath = ticketPath

    for (;;) {
      const blockers: string[] = []
      for (const entry of liveEntries(file, options.observe)) {
        if (entry.pid === pid && entry.token === token) continue
        if (entry.kind === 'choosing' || comesBefore(entry, ticket, pid, token)) {
          blockers.push(entry.name)
        }
      }
      if (blockers.length === 0) return action()
      options.observe?.({ phase: 'waiting', blockers })
      if (Date.now() >= deadline) throw new Error(`timed out waiting for file lock ${file}`)
      Atomics.wait(lockSleep, 0, 0, FILE_LOCK_POLL_MS)
    }
  } finally {
    if (ownedPath !== null) {
      try {
        unlinkSync(ownedPath)
      } catch {
        // External cleanup cannot turn a release failure into a caller failure.
      }
    }
    try {
      rmdirSync(file)
    } catch {
      // Another contender has published, or external cleanup already removed it.
    }
  }
}
