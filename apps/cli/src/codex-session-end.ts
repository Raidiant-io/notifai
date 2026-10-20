/**
 * What a Codex `SessionEnd` means.
 *
 * Codex reports `reason: "other"` for every end, so the reason cannot tell a
 * close from a reload or an unload. The hub decides after its end
 * confirmation. A thread its host holds again by then (the shared server
 * reloads a thread in place when a terminal resumes it) was never closed. An
 * unload of a conversation the Codex app (or the Codex IDE extension) still
 * lists, while that app runs, leaves the conversation open: its questions
 * stay answerable and an answer waits in it until the User opens it again.
 * Every other end is a close, and a closed session's questions expire.
 *
 * The evidence after the confirmation, in order:
 * 1. the thread's rollout is gone (archived or deleted): closed;
 * 2. the host process (the process that ran the hook) is gone: closed, which
 *    covers quitting the app;
 * 3. the thread was started by the Codex app or IDE extension and is hosted
 *    by that client's own app-server, which is still running: dormant-open;
 * 4. anything else, including evidence that cannot be read: closed.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readlinkSync, readSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Rollout originators of the Codex app and the Codex IDE extension. The
 * originator is the app-server client's own name, written once into the
 * rollout's first line when the thread starts.
 */
const DORMANT_ORIGINATORS: Readonly<Record<string, 'app' | 'ide'>> = {
  'Codex Desktop': 'app',
  codex_work_desktop: 'app',
  codex_vscode: 'ide',
}

/** The rollout's first line can carry long base instructions; read no further than this. */
const MAX_META_BYTES = 1024 * 1024

export type CodexHostKind = 'app-server' | 'other' | 'unknown'

export interface CodexEndEvidence {
  /** The rollout named by the hook: still at its path, or moved away (archive) or deleted. */
  transcript: 'present' | 'missing'
  host: 'alive' | 'gone'
  /** The rollout's recorded originator; null when it cannot be read. */
  originator: string | null
  hostKind: CodexHostKind
}

export type CodexEndVerdict =
  | { state: 'ended'; reason: 'session-archived' | 'harness-gone' | 'session-end-hook' }
  | { state: 'dormant-open'; surface: 'app' | 'ide' }

/** The surface a thread belongs to, from its originator alone; null for CLI and unknown clients. */
export function codexDormantSurface(originator: string | null): 'app' | 'ide' | null {
  return originator === null ? null : DORMANT_ORIGINATORS[originator] ?? null
}

export function classifyCodexSessionEnd(evidence: CodexEndEvidence): CodexEndVerdict {
  if (evidence.transcript === 'missing') return { state: 'ended', reason: 'session-archived' }
  if (evidence.host === 'gone') return { state: 'ended', reason: 'harness-gone' }
  const surface = codexDormantSurface(evidence.originator)
  if (surface !== null && evidence.hostKind === 'app-server') return { state: 'dormant-open', surface }
  return { state: 'ended', reason: 'session-end-hook' }
}

/** The `originator` recorded in a rollout's first line (its session metadata), or null. */
export function readCodexThreadOriginator(transcriptPath: string | null | undefined): string | null {
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
    const first = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { type?: unknown; payload?: { originator?: unknown } }
    return first.type === 'session_meta' && typeof first.payload?.originator === 'string' ? first.payload.originator : null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

export function codexTranscriptState(transcriptPath: string | null | undefined): 'present' | 'missing' | 'unknown' {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return 'unknown'
  return existsSync(transcriptPath) ? 'present' : 'missing'
}

/**
 * Whether the host is an app-server a client started for itself (the Codex
 * app's, or the IDE extension's), rather than a terminal or the shared
 * background server, which a closed terminal leaves behind.
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
  const serving = words.includes('app-server')
  const shared = words.includes('daemon') || words.includes('--listen') || words.includes('remote-control')
  return serving && !shared ? 'app-server' : 'other'
}

/** Codex's per-thread writer lock: held open by the process that has the thread loaded. */
export function codexThreadWriterLockPath(codexHome: string | null, threadId: string): string {
  return path.join(codexHome ?? path.join(os.homedir(), '.codex'), 'thread-writer-locks', `${threadId}.lock`)
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
