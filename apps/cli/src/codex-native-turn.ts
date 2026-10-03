/** Read only typed lifecycle records from the transcript named by a native hook. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { configHome } from './install-hooks.js'

export interface NativeTurnSnapshot {
  file: string
  identity: string
  size: number
  latest: { id: string; offset: number; ended: boolean; outcome?: 'completed' | 'aborted' }
  positions: Map<string, number>
}

const HEADER_BYTES = 64 * 1024
const TAIL_BYTES = 8 * 1024 * 1024

/** Bounded filename discovery for an existing owner during an explicit update.
 * The reader below still verifies native metadata; filenames are not identity.
 */
export function findNativeTranscript(sessionId: string, env: NodeJS.ProcessEnv): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null
  const matches: string[] = []
  let remaining = 50_000
  const visit = (directory: string, depth: number): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (--remaining < 0) throw new Error('discovery-bound')
      const file = path.join(directory, entry.name)
      if (entry.isDirectory() && depth < 3) visit(file, depth + 1)
      else if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) matches.push(file)
    }
  }
  try {
    visit(path.join(configHome(env, 'CODEX_HOME', '.codex'), 'sessions'), 0)
    return matches.length === 1 ? matches[0]! : null
  } catch { return null }
}

/** Unknown, replaced, partial or unowned records never supply activity evidence. */
export function readNativeTurnSnapshot(
  file: unknown, sessionId: string, env: NodeJS.ProcessEnv,
): NativeTurnSnapshot | null {
  const observed = readNativeTranscript(file, sessionId, env, false)
  return observed !== null && 'latest' in observed ? observed : null
}

/** Ownership can be proved even when a long turn exceeds the activity bound. */
export function nativeTranscriptOwned(file: unknown, sessionId: string, env: NodeJS.ProcessEnv): boolean {
  return readNativeTranscript(file, sessionId, env, true) !== null
}

function readNativeTranscript(
  file: unknown, sessionId: string, env: NodeJS.ProcessEnv, identityOnly: boolean,
): NativeTurnSnapshot | Pick<NativeTurnSnapshot, 'file' | 'identity'> | null {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null
  let fd: number | undefined
  try {
    const sessions = realpathSync(path.join(configHome(env, 'CODEX_HOME', '.codex'), 'sessions'))
    const canonical = realpathSync(file)
    if (lstatSync(file).isSymbolicLink() || !canonical.startsWith(`${sessions}${path.sep}`)) return null
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size === 0) return null
    const read = (at: number, count: number): Buffer => {
      const bytes = Buffer.alloc(count)
      const length = readSync(fd!, bytes, 0, count, at)
      return bytes.subarray(0, length)
    }
    const header = read(0, Math.min(HEADER_BYTES, stat.size)).toString('utf8')
    const newline = header.indexOf('\n')
    if (newline < 0) return null
    const meta = JSON.parse(header.slice(0, newline)) as { type?: string; payload?: { id?: string; source?: unknown } }
    if (meta.type !== 'session_meta' || meta.payload?.id !== sessionId ||
        !['cli', 'vscode', 'exec'].includes(String(meta.payload.source))) return null
    if (identityOnly) return { file: canonical, identity: `${stat.dev}:${stat.ino}` }
    const at = Math.max(0, stat.size - TAIL_BYTES)
    const bytes = read(at, stat.size - at)
    // A trailing partial record may be a newer start: do not report an older one.
    if (bytes.length !== stat.size - at || bytes.at(-1) !== 10) return null
    let offset = at === 0 ? 0 : bytes.indexOf(10) + 1
    if (at > 0 && offset === 0) return null
    let latest: NativeTurnSnapshot['latest'] | undefined
    const positions = new Map<string, number>()
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset)
      if (end < 0) return null
      const line = bytes.subarray(offset, end).toString('utf8')
      // Conversation records are skipped without parsing or retaining their payload.
      if (line.includes('"event_msg"')) {
        const record = JSON.parse(line) as { type?: string; payload?: { type?: string; turn_id?: string } }
        const event = record.type === 'event_msg' ? record.payload : undefined
        if (event?.type === 'task_started' && typeof event.turn_id === 'string') {
          latest = { id: event.turn_id, offset: at + offset, ended: false }
          positions.set(event.turn_id, at + offset)
        } else if (latest !== undefined && event?.turn_id === latest.id &&
            ['task_complete', 'turn_aborted'].includes(event.type ?? '')) {
          latest.ended = true
          latest.outcome = event.type === 'turn_aborted' ? 'aborted' : 'completed'
        }
      }
      offset = end + 1
    }
    const after = fstatSync(fd)
    if (latest === undefined || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return null
    return { file: canonical, identity: `${stat.dev}:${stat.ino}`, size: stat.size, latest, positions }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
