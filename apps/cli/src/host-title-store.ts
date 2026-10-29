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
