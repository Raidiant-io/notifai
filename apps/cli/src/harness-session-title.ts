import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { configHome } from './install-hooks.js'
import type { ActiveHarnessSession } from './commands-harness-context.js'
import { readSessionState, updateSessionState } from './hook-session-state.js'
import { readOrcaSessionTitle, type OrcaSessionTitleLookup } from './orca-session-title.js'

import { readCodexNamedThread, readT3SessionTitle } from './host-title-store.js'

const SESSION_INDEX_MAX_BYTES = 64 * 1024 * 1024

export type ClaudeSessionTitleLookup = (
  env: NodeJS.ProcessEnv,
  sessionId: string,
) => string | undefined

const SESSION_TITLE_MAX_LENGTH = 200

/** One line of printable text, or undefined when nothing usable remains. */
function usableTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const title = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint >= 32 && codePoint !== 127
    })
    .join('')
    .trim()
    .slice(0, SESSION_TITLE_MAX_LENGTH)
    .trim()
  return title.length > 0 ? title : undefined
}

/**
 * Keep the custom title Claude Code reports on its SessionStart and
 * UserPromptSubmit hooks. It is present only when the User named the session
 * (`--name`, `/rename`, or a hook or SDK rename); a generated or
 * folder-derived name never appears, so this cannot turn a path into a label.
 * An event without the field says nothing, and the last reported title stands.
 */
export function recordClaudeSessionTitle(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  reported: unknown,
): void {
  const title = usableTitle(reported)
  if (title === undefined || !safeSessionId(sessionId)) return
  if (readSessionState(sessionId, env).harness_session_title === title) return
  updateSessionState(sessionId, env, (state) => ({ ...state, harness_session_title: title }))
}

export function readClaudeSessionTitle(env: NodeJS.ProcessEnv, sessionId: string): string | undefined {
  if (!safeSessionId(sessionId)) return undefined
  return usableTitle(readSessionState(sessionId, env).harness_session_title)
}

export type CodexSessionTitleLookup = (
  env: NodeJS.ProcessEnv,
  sessionId: string,
) => string | undefined

export type HostTitleSource = 'managed' | 'orca' | 't3' | 'claude' | 'codex'

interface SessionTitleAdapters {
  resolved?: (source: HostTitleSource) => void
  orca?: OrcaSessionTitleLookup
  codex?: CodexSessionTitleLookup
  claude?: ClaudeSessionTitleLookup
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
 * CLI title updates use this index; Desktop/app-server may only write the
 * explicit name in their state database. The index is scanned newest-first. Missing, oversized, or malformed local state is ordinary
 * adapter failure: callers retain the fallback path.
 */
function readCodexIndexTitle(
  env: NodeJS.ProcessEnv,
  sessionId: string,
): string | undefined {
  if (!safeSessionId(sessionId)) return undefined
  const file = path.join(configHome(env, 'CODEX_HOME', '.codex'), 'session_index.jsonl')
  try {
    // CODEX_HOME is the active local harness's configuration authority and
    // the basename is fixed; Notification Request input cannot select a path.
    const size = statSync(file).size // lgtm [js/path-injection]
    if (size <= 0 || size > SESSION_INDEX_MAX_BYTES) return undefined
    const lines = readFileSync(file, 'utf8').split(/\r?\n/u) // lgtm [js/path-injection]
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

export function readCodexSessionTitle(env: NodeJS.ProcessEnv, sessionId: string): string | undefined {
  if (!safeSessionId(sessionId)) return undefined
  return readCodexIndexTitle(env, sessionId) ?? readCodexNamedThread(env, sessionId)
}

/**
 * Resolve semantic title adapters without making any host a prerequisite.
 * Managed harness output is authoritative, Orca may enrich an exact pane, and
 * Claude Code and Codex can name their own exact session with no Orca environment.
 */
export function readHarnessSessionTitle(
  env: NodeJS.ProcessEnv,
  active: ActiveHarnessSession | null,
  adapters: SessionTitleAdapters = {},
): string | undefined {
  const found = (title: string | undefined, source: HostTitleSource): string | undefined => {
    if (title !== undefined) adapters.resolved?.(source)
    return title
  }
  if (active?.sessionLabel !== undefined) return found(active.sessionLabel, 'managed')
  if (active?.sessionId === undefined || !safeSessionId(active.sessionId)) return undefined

  const orca = (adapters.orca ?? readOrcaSessionTitle)(env)
  if (orca !== undefined) return found(orca, 'orca')
  const t3 = readT3SessionTitle(env, active.harness, active.sessionId)
  if (t3 !== undefined) return found(t3, 't3')
  if (active.harness === 'claude-code') return found((adapters.claude ?? readClaudeSessionTitle)(env, active.sessionId), 'claude')
  if (active.harness !== 'codex') return undefined
  return found((adapters.codex ?? readCodexSessionTitle)(env, active.sessionId), 'codex')
}

const TITLE_ENV_KEYS = ['T3CODE_HOME', 'TERM_PROGRAM', 'ORCA_WORKTREE_ID', 'ORCA_PANE_KEY', 'ORCA_CLI_COMMAND', 'ORCA_DEV_REPO_ROOT'] as const

/** Only this exact foreground session may supply host selectors to the shared Hub. */
export function recordHarnessTitleEnvironment(sessionId: string, env: NodeJS.ProcessEnv): void {
  if (!safeSessionId(sessionId)) return
  const selectors: Record<string, string> = {}
  for (const key of TITLE_ENV_KEYS) {
    const value = env[key]
    if (value !== undefined && value.length <= 4_096) selectors[key] = value
  }
  if (JSON.stringify(readSessionState(sessionId, env).harness_title_env) === JSON.stringify(selectors)) return
  updateSessionState(sessionId, env, state => ({ ...state, harness_title_env: selectors }))
}

export function sessionTitleEnvironment(sessionId: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scoped = { ...env }
  const selectors = readSessionState(sessionId, env).harness_title_env
  for (const key of TITLE_ENV_KEYS) {
    delete scoped[key]
    const value = selectors?.[key]
    if (typeof value === 'string' && value.length <= 4_096) scoped[key] = value
  }
  return scoped
}
