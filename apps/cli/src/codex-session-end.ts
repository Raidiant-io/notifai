/**
 * What Codex leaves on disk and in the process table about a thread, read
 * after its end: where its rollout is, what hosts it, who holds it loaded.
 *
 * Codex reports `reason: "other"` for every `SessionEnd`, so the reason cannot
 * tell a close from a reload, an unload or an archive. The hub decides after
 * its end confirmation from this evidence (see `session-close-classifier.ts`).
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync, type Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CodexHostKind } from './session-place.js'

export type { CodexHostKind } from './session-place.js'

/**
 * Rollout originators of the Codex app and the Codex IDE extension. The
 * originator is the app-server client's own name, written once into the
 * rollout's first line when the thread starts.
 */
const APP_ORIGINATORS: Readonly<Record<string, 'app' | 'ide'>> = {
  'Codex Desktop': 'app',
  codex_work_desktop: 'app',
  codex_vscode: 'ide',
}

/** The rollout's first line can carry long base instructions; read no further than this. */
const MAX_META_BYTES = 1024 * 1024
/** A rollout search reads at most this many directory entries (Codex files them by day). */
const ROLLOUT_SCAN_LIMIT = 50_000

/** The app a thread was born in, from its originator alone; null for CLI and every other client. */
export function codexAppSurface(originator: string | null): 'app' | 'ide' | null {
  return originator === null ? null : APP_ORIGINATORS[originator] ?? null
}

export interface CodexSessionMeta {
  originator: string | null
  /** The thread this one was forked from, when Codex recorded it. */
  forkedFrom: string | null
}

/** A rollout's first line (its session metadata), or null when it cannot be read. */
export function readCodexSessionMeta(transcriptPath: string | null | undefined): CodexSessionMeta | null {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return null
  let fd: number
  try { fd = openSync(transcriptPath, 'r') } catch { return null }
  try {
    const chunks: Buffer[] = []
    let total = 0
    const chunk = Buffer.alloc(64 * 1024)
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, total)
      if (read <= 0) break
      const slice = Buffer.from(chunk.subarray(0, read))
      const newline = slice.indexOf(0x0a)
      chunks.push(newline >= 0 ? slice.subarray(0, newline) : slice)
      total += read
      if (newline >= 0 || total >= MAX_META_BYTES) break
    }
    const first = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { type?: unknown; payload?: Record<string, unknown> }
    if (first.type !== 'session_meta' || typeof first.payload !== 'object' || first.payload === null) return null
    const text = (value: unknown): string | null => typeof value === 'string' && value !== '' && value.length <= 256 ? value : null
    return { originator: text(first.payload['originator']), forkedFrom: text(first.payload['forked_from_id']) }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** The `originator` recorded in a rollout's first line (its session metadata), or null. */
export function readCodexThreadOriginator(transcriptPath: string | null | undefined): string | null {
  return readCodexSessionMeta(transcriptPath)?.originator ?? null
}

/** Where a thread's rollout is: still in `sessions/`, moved to `archived_sessions/`, gone, or unknown. */
export type RolloutPlace = 'sessions' | 'archived' | 'missing' | 'unknown'

/** The Codex home a rollout lives under (`<home>/sessions/…` or `<home>/archived_sessions/…`), or null. */
export function codexHomeOfRollout(transcriptPath: string): string | null {
  const parts = transcriptPath.split(path.sep)
  const index = Math.max(parts.lastIndexOf('sessions'), parts.lastIndexOf('archived_sessions'))
  return index > 0 ? parts.slice(0, index).join(path.sep) || path.sep : null
}

/**
 * Where a thread's rollout is now, found by its id: an archive moves it from
 * `sessions/…` to `archived_sessions/…` (and an unarchive back), while the
 * hook still names the old path. The recorded path is tried first, so the
 * common case reads one file. Unknown when neither directory can be read.
 */
export function locateCodexRollout(codexHome: string | null, threadId: string, recorded: string | null | undefined): { place: RolloutPlace; path: string | null } {
  const home = codexHome ?? (typeof recorded === 'string' && recorded !== '' ? codexHomeOfRollout(recorded) : null)
  if (typeof recorded === 'string' && recorded !== '') {
    try {
      if (statSync(recorded).isFile()) {
        const archived = home !== null && recorded.startsWith(path.join(home, 'archived_sessions') + path.sep)
        return { place: archived ? 'archived' : 'sessions', path: recorded }
      }
    } catch { /* look it up by id */ }
  }
  if (home === null) return { place: 'unknown', path: null }
  const suffix = `-${threadId}.jsonl`
  let scanned = 0
  let readable = false
  const find = (directory: string, depth: number): string | null => {
    let entries: Dirent[]
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return null }
    readable = true
    for (const entry of entries) {
      if (++scanned > ROLLOUT_SCAN_LIMIT) return null
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) return path.join(directory, entry.name)
    }
    if (depth <= 0) return null
    // Newest first: Codex files rollouts under year, month and day.
    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const found = find(path.join(directory, entry.name), depth - 1)
      if (found !== null || scanned > ROLLOUT_SCAN_LIMIT) return found
    }
    return null
  }
  const live = find(path.join(home, 'sessions'), 3)
  if (live !== null) return { place: 'sessions', path: live }
  const sessionsReadable = readable
  readable = false
  const archived = find(path.join(home, 'archived_sessions'), 3)
  if (archived !== null) return { place: 'archived', path: archived }
  if (scanned > ROLLOUT_SCAN_LIMIT) return { place: 'unknown', path: null }
  return { place: sessionsReadable || readable ? 'missing' : 'unknown', path: null }
}

/** Codex options that take a value: what follows them is never the subcommand. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a',
  '--ask-for-approval', '-C', '--cd', '-i', '--image', '--add-dir', '--enable', '--disable', '--remote', '--local-provider'])

/** The subcommand in a `codex` command line (`exec`, `app-server`, `resume`…), or null for the plain TUI. */
export function codexSubcommand(words: readonly string[]): string | null {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!
    if (VALUE_OPTIONS.has(word)) { index += 1; continue }
    if (word.startsWith('-')) continue
    return word
  }
  return null
}

/**
 * What hosts a thread: an app-server a client started for itself (the Codex
 * app's, an IDE extension's, T3 Code's, an Orca chat's), a scripted
 * `codex exec` run, or anything else (a terminal, or the shared background
 * server a closed terminal leaves behind).
 */
export function codexHostKind(pid: number): CodexHostKind {
  if (process.platform === 'win32') return 'unknown'
  let args: string
  try {
    args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
  if (args === '') return 'unknown'
  const words = args.split(/\s+/)
  const subcommand = codexSubcommand(words)
  if (subcommand === 'exec' || subcommand === 'e') return 'exec'
  const serving = words.includes('app-server')
  const shared = words.includes('daemon') || words.includes('--listen') || words.includes('remote-control')
  return serving && !shared ? 'app-server' : 'other'
}

/** Codex's per-thread writer lock: held open by the process that has the thread loaded. */
export function codexThreadWriterLockPath(codexHome: string | null, threadId: string): string {
  return path.join(codexHome ?? path.join(os.homedir(), '.codex'), 'thread-writer-locks', `${threadId}.lock`)
}

/**
 * The processes that have the thread loaded now: they hold its writer lock
 * open. Unknown when it cannot be read (Windows, no `lsof`).
 */
export function codexThreadHolders(codexHome: string | null, threadId: string, platform: NodeJS.Platform = process.platform): number[] | 'unknown' {
  const lock = codexThreadWriterLockPath(codexHome, threadId)
  if (!existsSync(lock)) return []
  if (platform === 'linux') {
    let target: string
    try { target = realpathSync(lock) } catch { return 'unknown' }
    let pids: string[]
    try { pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name)) } catch { return 'unknown' }
    return pids.filter((pid) => {
      const fds = path.join('/proc', pid, 'fd')
      let names: string[]
      try { names = readdirSync(fds) } catch { return false }
      return names.some((fd) => { try { return readlinkSync(path.join(fds, fd)) === target } catch { return false } })
    }).map(Number)
  }
  if (platform !== 'darwin') return 'unknown'
  try {
    const output = execFileSync('lsof', ['-t', '--', lock], {
      encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/sbin:/usr/bin:/bin:/sbin', LC_ALL: 'C' },
    })
    return output.split(/\s+/).filter((pid) => /^\d+$/.test(pid)).map(Number)
  } catch (err) {
    // `lsof` exits 1 when nobody has the file open.
    return (err as { status?: unknown }).status === 1 ? [] : 'unknown'
  }
}

/** Whether any process has the thread loaded now; unknown when it cannot be read. */
export function codexThreadHeld(codexHome: string | null, threadId: string, platform: NodeJS.Platform = process.platform): boolean | 'unknown' {
  const holders = codexThreadHolders(codexHome, threadId, platform)
  return holders === 'unknown' ? 'unknown' : holders.length > 0
}

/**
 * Whether this exact process has the thread loaded now: it holds the
 * thread's writer lock open. The shared server reloading a thread in place
 * (a `codex resume` of a conversation no terminal shows) runs SessionEnd and
 * holds the lock again about two seconds later; a closed or unloaded thread's
 * lock is released. False when it cannot be read (Windows, no `lsof`).
 */
export function codexHostHoldsThread(codexHome: string | null, threadId: string, pid: number,
  platform: NodeJS.Platform = process.platform): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  const lock = codexThreadWriterLockPath(codexHome, threadId)
  if (!existsSync(lock)) return false
  if (platform === 'linux') {
    let target: string
    try { target = realpathSync(lock) } catch { return false }
    try {
      const fds = path.join('/proc', String(pid), 'fd')
      return readdirSync(fds).some((fd) => {
        try { return readlinkSync(path.join(fds, fd)) === target } catch { return false }
      })
    } catch {
      return false
    }
  }
  if (platform !== 'darwin') return false
  try {
    // One process only (`-a -p`): a few tens of milliseconds, not a scan of every process.
    const output = execFileSync('lsof', ['-t', '-a', '-p', String(pid), '--', lock], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/sbin:/usr/bin:/bin:/sbin', LC_ALL: 'C' },
    })
    return output.split(/\s+/).includes(String(pid))
  } catch {
    // `lsof` exits 1 when the process does not have the file open.
    return false
  }
}
