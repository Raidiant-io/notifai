/** Registry of live Agent Sessions addressable from a Project invocation. */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { atomicWriteFileSync } from './atomic-file.js'
import { projectSessionPointerPath } from './config.js'
import { withFileLock } from './file-lock.js'
import { HOOK_INSTALLABLE_HARNESSES } from './harnesses.js'
import { sessionStatePath } from './hook-session-state.js'
import type { HookHarness } from './hook-types.js'
interface StoredProjectSessionPointer extends ProjectSessionPointer {
  updatedAt: number
}

interface StoredProjectSessionDocument {
  root: Record<string, unknown>
  sessions: unknown[]
}

export interface ProjectSessionPointer {
  sessionId: string
  harness: HookHarness
}

function storedProjectSessionPointer(candidate: unknown): StoredProjectSessionPointer | null {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null
  const entry = candidate as {
    session_id?: unknown
    updated_at?: unknown
    harness?: unknown
  }
  if (typeof entry.session_id !== 'string' || entry.session_id === '') return null
  if (typeof entry.updated_at !== 'number') return null
  if (!(HOOK_INSTALLABLE_HARNESSES as readonly unknown[]).includes(entry.harness)) return null
  return {
    sessionId: entry.session_id,
    updatedAt: entry.updated_at,
    harness: entry.harness as HookHarness,
  }
}

function readStoredProjectSessionDocument(file: string): StoredProjectSessionDocument {
  if (!existsSync(file)) return { root: {}, sessions: [] }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { root: {}, sessions: [] }
    }
    const root = parsed as Record<string, unknown>
    return {
      root,
      sessions: Array.isArray(root['sessions']) ? root['sessions'] : [],
    }
  } catch {
    return { root: {}, sessions: [] }
  }
}

/** Records every live session working in a directory, for `notifai ask`. */
export function writeProjectSession(
  cwd: string,
  env: NodeJS.ProcessEnv,
  sessionId: string,
  now: number,
  harness: HookHarness,
): void {
  const file = projectSessionPointerPath(cwd, env)
  withFileLock(`${file}.lock`, () => {
    const stored = readStoredProjectSessionDocument(file)
    const existing: unknown[] = []
    let refreshed: Record<string, unknown> = {}
    for (const candidate of stored.sessions) {
      const entry = storedProjectSessionPointer(candidate)
      if (entry?.sessionId === sessionId) {
        refreshed = { ...refreshed, ...(candidate as Record<string, unknown>) }
      } else if (entry === null || now - entry.updatedAt <= 24 * 3600 * 1000) {
        existing.push(candidate)
      }
    }
    atomicWriteFileSync(
      file,
      `${JSON.stringify({
        ...stored.root,
        sessions: [
          ...existing,
          { ...refreshed, session_id: sessionId, updated_at: now, harness },
        ],
      })}\n`,
    )
  })
}

function readStoredProjectSessionPointers(file: string): StoredProjectSessionPointer[] {
  return readStoredProjectSessionDocument(file).sessions.flatMap(
    (candidate): StoredProjectSessionPointer[] => {
      const entry = storedProjectSessionPointer(candidate)
      return entry === null ? [] : [entry]
    },
  )
}

/**
 * Resolves the session working in `cwd`. Stale pointers are ignored rather than
 * trusted: an id left by a session that ended days ago would send the question
 * into state nothing is watching.
 */
export function readProjectSession(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: number,
  maxAgeMs = 24 * 3600 * 1000,
): string | null {
  return readProjectSessionPointer(cwd, env, now, maxAgeMs)?.sessionId ?? null
}

/** A live pointer keeps when it was last written, so callers can rank by it. */
export interface LiveProjectSessionPointer extends ProjectSessionPointer {
  updatedAt: number
}

/**
 * Every session that has fired a hook in this directory recently, newest first.
 *
 * This is the only local record of which harness sessions are actually alive
 * here, which makes it the tiebreaker when the environment alone cannot say
 * which harness owns the current shell.
 */
export function readLiveProjectSessionPointers(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: number,
  maxAgeMs = 24 * 3600 * 1000,
): LiveProjectSessionPointer[] {
  const file = projectSessionPointerPath(cwd, env)
  return readStoredProjectSessionPointers(file)
    .filter((entry) => now - entry.updatedAt <= maxAgeMs)
    .filter((entry) => {
      try {
        // A pointer is routing evidence only while its session state still
        // exists and parses. SessionEnd and explicit cleanup therefore
        // invalidate it even when a crash prevented removal from this index.
        const sessionFile = sessionStatePath(entry.sessionId, env)
        if (!existsSync(sessionFile)) return false
        const state: unknown = JSON.parse(readFileSync(sessionFile, 'utf8'))
        return typeof state === 'object' && state !== null && !Array.isArray(state)
      } catch {
        return false
      }
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((entry) => ({
      sessionId: entry.sessionId,
      harness: entry.harness,
      updatedAt: entry.updatedAt,
    }))
}

export function readProjectSessionPointer(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: number,
  maxAgeMs = 24 * 3600 * 1000,
): ProjectSessionPointer | null {
  const latest = readLiveProjectSessionPointers(cwd, env, now, maxAgeMs)[0]
  return latest === undefined ? null : { sessionId: latest.sessionId, harness: latest.harness }
}

export function readMatchingProjectSessionPointer(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: number,
  sessionId: string,
  harness: HookHarness,
  maxAgeMs = 24 * 3600 * 1000,
): ProjectSessionPointer | null {
  const match = readLiveProjectSessionPointers(cwd, env, now, maxAgeMs).find(
    (entry) => entry.sessionId === sessionId && entry.harness === harness,
  )
  return match === undefined ? null : { sessionId: match.sessionId, harness: match.harness }
}

export function clearMatchingProjectSession(
  cwd: string,
  env: NodeJS.ProcessEnv,
  sessionId: string,
): void {
  const file = projectSessionPointerPath(cwd, env)
  withFileLock(`${file}.lock`, () => {
    const stored = readStoredProjectSessionDocument(file)
    const remaining = stored.sessions.filter((candidate) => {
      const entry = storedProjectSessionPointer(candidate)
      return entry === null || entry.sessionId !== sessionId
    })
    const hasUnknownRootFields = Object.keys(stored.root).some((key) => key !== 'sessions')
    if (remaining.length === 0 && !hasUnknownRootFields) {
      rmSync(file, { force: true })
      return
    }
    atomicWriteFileSync(
      file,
      `${JSON.stringify({
        ...stored.root,
        sessions: remaining,
      })}\n`,
    )
  })
}
