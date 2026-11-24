import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'
import { withFileLock } from './file-lock.js'
import type { SessionIncarnation } from './hook-session-state.js'
import type { ProcessIdentity } from './process-identity.js'

interface TerminalStart {
  key: string
  monotonic: string
}

export function grokTerminalStartPath(owner: ProcessIdentity, env: NodeJS.ProcessEnv): string {
  const identity = createHash('sha256').update(owner.pid + ':' + owner.start).digest('hex')
  return path.join(stateDir(env), 'sessions', 'grok-terminal-' + identity + '.json')
}

function readTerminalStart(file: string): TerminalStart | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<TerminalStart> | null
    return typeof value?.key === 'string' && typeof value.monotonic === 'string' && /^\d{1,30}$/u.test(value.monotonic)
      ? { key: value.key, monotonic: value.monotonic } : null
  } catch { return null }
}

/**
 * Grok's standalone TUI can replace the foreground conversation while
 * retaining its old actor and monitor. A native root SessionStart transfers
 * the terminal's wake ownership. This marker never uses a cwd or a title.
 */
export function recordGrokTerminalStart(owner: ProcessIdentity, env: NodeJS.ProcessEnv, record: SessionIncarnation): void {
  const file = grokTerminalStartPath(owner, env)
  withFileLock(file + '.lock', () => {
    const previous = readTerminalStart(file)
    if (previous !== null && BigInt(previous.monotonic) >= BigInt(record.start.mono)) return
    atomicWriteFileSync(file, JSON.stringify({ key: record.key, monotonic: record.start.mono }))
  })
}

export function grokTerminalStartKey(owner: ProcessIdentity, env: NodeJS.ProcessEnv): string | null {
  return readTerminalStart(grokTerminalStartPath(owner, env))?.key ?? null
}
