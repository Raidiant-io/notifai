/**
 * What a Codex `SessionEnd` means.
 *
 * Codex reports `reason: "other"` for every end, so the reason cannot tell a
 * close from an unload. An unload of a conversation the Codex app (or the
 * Codex IDE extension) still lists, while that app runs, leaves the
 * conversation open: its questions stay answerable and an answer waits in it
 * until the User opens it again. Every other end is a close, and a closed
 * session's questions expire.
 *
 * The evidence, in order:
 * 1. the thread's rollout is gone (archived or deleted): closed;
 * 2. the host process (the process that ran the hook) is gone: closed, which
 *    covers quitting the app;
 * 3. the thread was started by the Codex app or IDE extension and is hosted
 *    by that client's own app-server, which is still running: dormant-open;
 * 4. anything else, including evidence that cannot be read: closed.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync } from 'node:fs'

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
