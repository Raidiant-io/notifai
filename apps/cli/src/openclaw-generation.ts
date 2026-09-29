/** Durable generation fence shared by OpenClaw's Gateway and agent hook runners. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { sanitizeSessionId, stateDir } from './config.js'

export interface OpenclawGeneration {
  id: string
  sessionId?: string
  /** OpenClaw's native reset identity; sessionId can stay unchanged across /reset. */
  lifecycleRevision?: string
  resumedFrom?: string
  startSeen: boolean
  resetPending: boolean
  activated: boolean
  ended: boolean
  /** Transcript IDs replaced under this stable sessionKey; late hooks cannot restore them. */
  supersededSessionIds?: string[]
  /** Native revisions replaced under a stable sessionKey, including same-ID resets. */
  supersededLifecycleRevisions?: string[]
}

function generationPath(sessionKey: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'sessions', `${sanitizeSessionId(sessionKey)}.openclaw-generation.json`)
}

export function openclawGenerationLockPath(sessionKey: string, env: NodeJS.ProcessEnv): string {
  return `${generationPath(sessionKey, env)}.lock`
}

/** Callers hold openclawGenerationLockPath through the complete lifecycle action. */
export function readOpenclawGeneration(
  sessionKey: string,
  env: NodeJS.ProcessEnv,
): OpenclawGeneration | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(generationPath(sessionKey, env), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const state = parsed as Record<string, unknown>
    if (
      typeof state['id'] !== 'string' ||
      typeof state['startSeen'] !== 'boolean' ||
      typeof state['resetPending'] !== 'boolean' ||
      typeof state['activated'] !== 'boolean' ||
      typeof state['ended'] !== 'boolean'
    ) return null
    return {
      id: state['id'],
      ...(typeof state['sessionId'] === 'string' ? { sessionId: state['sessionId'] } : {}),
      ...(typeof state['lifecycleRevision'] === 'string' ? { lifecycleRevision: state['lifecycleRevision'] } : {}),
      ...(typeof state['resumedFrom'] === 'string' ? { resumedFrom: state['resumedFrom'] } : {}),
      startSeen: state['startSeen'],
      resetPending: state['resetPending'],
      activated: state['activated'],
      ended: state['ended'],
      ...(Array.isArray(state['supersededSessionIds']) &&
        state['supersededSessionIds'].every((id) => typeof id === 'string')
        ? { supersededSessionIds: state['supersededSessionIds'] as string[] } : {}),
      ...(Array.isArray(state['supersededLifecycleRevisions']) &&
        state['supersededLifecycleRevisions'].every((id) => typeof id === 'string')
        ? { supersededLifecycleRevisions: state['supersededLifecycleRevisions'] as string[] } : {}),
    }
  } catch {
    return null
  }
}

export function writeOpenclawGeneration(
  sessionKey: string,
  env: NodeJS.ProcessEnv,
  state: OpenclawGeneration,
): void {
  atomicWriteFileSync(generationPath(sessionKey, env), `${JSON.stringify(state)}\n`)
}

function fresh(
  sessionId?: string,
  resumedFrom?: string,
  previous?: OpenclawGeneration,
  lifecycleRevision?: string,
): OpenclawGeneration {
  const superseded = previous?.supersededSessionIds ?? []
  const priorId = previous?.sessionId
  const supersededSessionIds = priorId !== undefined && priorId !== sessionId &&
    !superseded.includes(priorId) ? [...superseded, priorId] : superseded
  const oldRevisions = previous?.supersededLifecycleRevisions ?? []
  const priorRevision = previous?.lifecycleRevision
  const supersededLifecycleRevisions = priorRevision !== undefined && lifecycleRevision !== undefined &&
    priorRevision !== lifecycleRevision && !oldRevisions.includes(priorRevision)
    ? [...oldRevisions, priorRevision] : oldRevisions
  return {
    id: randomUUID(),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(lifecycleRevision === undefined ? {} : { lifecycleRevision }),
    ...(resumedFrom === undefined ? {} : { resumedFrom }),
    startSeen: false,
    resetPending: false,
    activated: false,
    ended: false,
    ...(supersededSessionIds.length === 0 ? {} : { supersededSessionIds }),
    ...(supersededLifecycleRevisions.length === 0 ? {} : { supersededLifecycleRevisions }),
  }
}

function isSuperseded(current: OpenclawGeneration, sessionId?: string): boolean {
  return sessionId !== undefined && sessionId !== current.sessionId &&
    (current.supersededSessionIds?.includes(sessionId) === true ||
      current.resumedFrom === sessionId)
}

export function observeOpenclawStart(
  current: OpenclawGeneration | null,
  sessionId?: string,
  resumedFrom?: string,
): OpenclawGeneration {
  if (current !== null && isSuperseded(current, sessionId)) return { ...current }
  const next = current === null || current.ended || current.resetPending ||
    (sessionId !== undefined && current.sessionId !== undefined && sessionId !== current.sessionId) ||
    (current.lifecycleRevision === undefined && current.startSeen &&
      resumedFrom !== undefined && current.resumedFrom !== resumedFrom)
    ? fresh(sessionId, resumedFrom, current ?? undefined, current?.lifecycleRevision)
    : { ...current }
  if (next.sessionId === undefined && sessionId !== undefined) next.sessionId = sessionId
  if (resumedFrom !== undefined) next.resumedFrom = resumedFrom
  next.startSeen = true
  return next
}

export function observeOpenclawPrompt(
  current: OpenclawGeneration | null,
  sessionId?: string,
  lifecycleRevision?: string,
): OpenclawGeneration {
  // Hook JSON may come from older generated plugins; malformed null is absence.
  const revision = typeof lifecycleRevision === 'string' && lifecycleRevision !== ''
    ? lifecycleRevision : undefined
  if (current !== null && isSuperseded(current, sessionId)) return { ...current }
  if (current !== null && revision !== undefined &&
    current.supersededLifecycleRevisions?.includes(revision)) return { ...current }
  const next = current === null || current.ended || current.resetPending ||
    (revision !== undefined && current.lifecycleRevision !== undefined &&
      revision !== current.lifecycleRevision) ||
    (sessionId !== undefined && current.sessionId !== undefined && sessionId !== current.sessionId)
    ? fresh(sessionId, undefined, current ?? undefined, revision)
    : { ...current }
  if (next.sessionId === undefined && sessionId !== undefined) next.sessionId = sessionId
  if (next.lifecycleRevision === undefined && revision !== undefined) next.lifecycleRevision = revision
  return next
}
