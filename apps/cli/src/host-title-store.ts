/** Optional, read-only host metadata. No host database is ever created or migrated. */
import { createRequire } from 'node:module'
import path from 'node:path'
import { configHome } from './install-hooks.js'
import type { SourceContextHarness } from './harnesses.js'

interface TitleDatabase {
  prepare(sql: string): { all(...parameters: string[]): unknown[] }
  exec(sql: string): void
  close(): void
}
const require = createRequire(import.meta.url)

function openReadOnly(file: string): TitleDatabase {
  if ('Bun' in globalThis) {
    const sqlite = require('bun:sqlite') as { Database: new (file: string, options: { readonly: true }) => TitleDatabase }
    return new sqlite.Database(file, { readonly: true })
  }
  const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string, options: { readOnly: true }) => TitleDatabase }
  return new sqlite.DatabaseSync(file, { readOnly: true })
}

/** Missing runtime support, locked stores, and schema drift all mean no title. */
function readTitle(file: string, sql: string, parameters: string[]): string | undefined {
  return readColumn(file, sql, parameters, 'title')
}

/** One column of the one row a query returns; anything else (no row, two rows, an error) is absent. */
function readColumn(file: string, sql: string, parameters: string[], column: string): string | undefined {
  let db: TitleDatabase | undefined
  try {
    db = openReadOnly(file)
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 25;')
    const rows = db.prepare(sql).all(...parameters)
    if (rows.length !== 1) return undefined
    const row = rows[0] as Record<string, unknown> | null
    if (typeof row !== 'object' || row === null || !(column in row)) return undefined
    const value = row[column]
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined
  } catch {
    return undefined
  } finally {
    try { db?.close() } catch { /* Host metadata never blocks the caller. */ }
  }
}

/** `title` is a first-prompt preview; only `name` is an explicit thread name. */
export function readCodexNamedThread(env: NodeJS.ProcessEnv, sessionId: string): string | undefined {
  return readTitle(path.join(configHome(env, 'CODEX_HOME', '.codex'), 'state_5.sqlite'),
    'SELECT name AS title FROM threads WHERE id = ? LIMIT 2', [sessionId])
}

const T3_DRIVERS: Partial<Record<SourceContextHarness, string>> = {
  codex: 'codex', 'claude-code': 'claudeAgent', cursor: 'cursor', grok: 'grok',
}

/**
 * T3's CLI addresses app threads, not native sessions. Its versioned local
 * projection is the narrow read-only fallback: require a strong native ref,
 * matching driver, and exactly one app thread. Never join by cwd or branch.
 * Fixed tables/columns guard the schema; a future incompatible shape is absent.
 */
export function readT3SessionTitle(env: NodeJS.ProcessEnv, harness: SourceContextHarness, sessionId: string): string | undefined {
  return readT3Thread(env, harness, sessionId, 'title')
}

/** The T3 thread a native session runs in, by the same strict match: what `t3 thread send` addresses. */
export function readT3ThreadId(env: NodeJS.ProcessEnv, harness: SourceContextHarness, sessionId: string): string | undefined {
  return readT3Thread(env, harness, sessionId, 'thread_id')
}

/** What T3 Code's record says of a Grok native session's thread, read now. */
export type T3GrokThread = { thread: string } | 'none' | 'ambiguous' | 'unreadable'

/**
 * The thread a Grok wake may address: the same strict match, and also a
 * thread that is not archived or deleted and whose active provider thread is
 * still this native session (not one a newer provider session replaced).
 * `none` is a readable record that names no such thread: the thread was
 * archived, deleted or moved on (or is not recorded yet). `unreadable` says
 * nothing either way.
 */
export function readT3GrokThread(env: NodeJS.ProcessEnv, sessionId: string): T3GrokThread {
  let db: TitleDatabase | undefined
  try {
    db = openReadOnly(path.join(configHome(env, 'T3CODE_HOME', '.t3'), 'userdata', 'statev2.sqlite'))
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 25;')
    const rows = db.prepare(`
      SELECT DISTINCT t.thread_id
      FROM orchestration_v2_projection_provider_threads p
      JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
      WHERE p.driver = 'grok'
        AND json_extract(p.payload_json, '$.nativeThreadRef.driver') = 'grok'
        AND json_extract(p.payload_json, '$.nativeThreadRef.strength') = 'strong'
        AND json_extract(p.payload_json, '$.nativeThreadRef.nativeId') = ?
        AND t.active_provider_thread_id = p.provider_thread_id
        AND t.deleted_at IS NULL
        AND t.archived_at IS NULL
      LIMIT 2`).all(sessionId) as Array<Record<string, unknown> | null>
    if (rows.length === 0) return 'none'
    if (rows.length > 1) return 'ambiguous'
    const thread = rows[0]?.['thread_id']
    return typeof thread === 'string' && thread.trim() !== '' ? { thread } : 'unreadable'
  } catch {
    return 'unreadable'
  } finally {
    try { db?.close() } catch { /* Host metadata never blocks the caller. */ }
  }
}

/** The thread a Grok wake may address, when the record names exactly one. */
export function readT3ActiveGrokThread(env: NodeJS.ProcessEnv, sessionId: string): string | undefined {
  const found = readT3GrokThread(env, sessionId)
  return typeof found === 'object' ? found.thread : undefined
}

function readT3Thread(env: NodeJS.ProcessEnv, harness: SourceContextHarness, sessionId: string, column: 'title' | 'thread_id'): string | undefined {
  const driver = T3_DRIVERS[harness]
  if (driver === undefined) return undefined
  return readColumn(path.join(configHome(env, 'T3CODE_HOME', '.t3'), 'userdata', 'statev2.sqlite'), `
    SELECT DISTINCT t.thread_id, t.title
    FROM orchestration_v2_projection_provider_threads p
    JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
    WHERE p.driver = ?
      AND json_extract(p.payload_json, '$.nativeThreadRef.driver') = ?
      AND json_extract(p.payload_json, '$.nativeThreadRef.strength') = 'strong'
      AND json_extract(p.payload_json, '$.nativeThreadRef.nativeId') = ?
      AND t.deleted_at IS NULL
    LIMIT 2`, [driver, driver, sessionId], column)
}
