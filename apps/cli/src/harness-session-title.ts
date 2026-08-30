import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { configHome } from './install-hooks.js'
import type { ActiveHarnessSession } from './commands-harness-context.js'
import { readOrcaSessionTitle, type OrcaSessionTitleLookup } from './orca-session-title.js'

const SESSION_INDEX_MAX_BYTES = 64 * 1024 * 1024

export type CodexSessionTitleLookup = (
  env: NodeJS.ProcessEnv,
  sessionId: string,
) => string | undefined

interface SessionTitleAdapters {
  orca?: OrcaSessionTitleLookup
  codex?: CodexSessionTitleLookup
}

function safeSessionId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint < 32 || codePoint === 127
    })
  )
}

/**
 * Read Codex's own append-only Agent Session title index.
 *
 * Codex writes one JSONL row for every title update and its consumers scan
 * newest-first. Missing, oversized, or malformed local state is ordinary
 * adapter failure: callers retain the generated fallback path.
 */
export function readCodexSessionTitle(
  env: NodeJS.ProcessEnv,
  sessionId: string,
): string | undefined {
  if (!safeSessionId(sessionId)) return undefined
  const file = path.join(configHome(env, 'CODEX_HOME', '.codex'), 'session_index.jsonl')
  try {
    const size = statSync(file).size
    if (size <= 0 || size > SESSION_INDEX_MAX_BYTES) return undefined
    const lines = readFileSync(file, 'utf8').split(/\r?\n/u)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!.trim()
      if (line.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof parsed !== 'object' || parsed === null) continue
      const entry = parsed as { id?: unknown; thread_name?: unknown }
      if (entry.id !== sessionId || typeof entry.thread_name !== 'string') continue
      const title = entry.thread_name.trim()
      return title.length > 0 ? title : undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Resolve semantic title adapters without making any host a prerequisite.
 * Managed harness output is authoritative, Orca may enrich an exact pane, and
 * Codex Desktop/CLI can name its own exact thread with no Orca environment.
 */
export function readHarnessSessionTitle(
  env: NodeJS.ProcessEnv,
  active: ActiveHarnessSession | null,
  adapters: SessionTitleAdapters = {},
): string | undefined {
  if (active?.sessionLabel !== undefined) return active.sessionLabel
  if (active?.sessionId === undefined) return undefined

  const orca = (adapters.orca ?? readOrcaSessionTitle)(env)
  if (orca !== undefined) return orca
  if (active.harness !== 'codex') return undefined
  return (adapters.codex ?? readCodexSessionTitle)(env, active.sessionId)
}
