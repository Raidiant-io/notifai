/**
 * How many bytes each Project's name and avatar take in a phone push, as the
 * service last reported them (`project_identity_push_bytes` on a submission
 * receipt). The CLI cannot see a Project's display name or avatar, so this is
 * how `ask` sizes a form for the Project it is in. A Project it has not
 * heard about yet is sized for the longest identity; the service still checks
 * every draft.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync, ensurePrivateDirectory } from './atomic-file.js'
import { stateDir } from './config.js'

export interface ProjectIdentityPushBytes {
  ios: number
  android: number
}

const FILE = 'project-push-identity.json'
/** Recently used Projects only; an evicted one is sized for the longest identity again. */
const LIMIT = 64

type Remembered = Record<string, ProjectIdentityPushBytes>

function file(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), FILE)
}

function key(baseUrl: string, project: string): string {
  return `${baseUrl}\n${project}`
}

function isBytes(value: unknown): value is ProjectIdentityPushBytes {
  if (typeof value !== 'object' || value === null) return false
  const { ios, android } = value as Record<string, unknown>
  return [ios, android].every((bytes) => typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0)
}

function read(env: NodeJS.ProcessEnv): Remembered {
  try {
    const value = JSON.parse(readFileSync(file(env), 'utf8')) as { projects?: unknown }
    if (typeof value.projects !== 'object' || value.projects === null) return {}
    return Object.fromEntries(Object.entries(value.projects).filter(([, bytes]) => isBytes(bytes))) as Remembered
  } catch {
    return {}
  }
}

/** The bytes the service last reported for this Project, if any. */
export function rememberedProjectIdentityPushBytes(
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  project: string,
): ProjectIdentityPushBytes | undefined {
  return read(env)[key(baseUrl, project)]
}

/** Notes what the service reported. Never throws: a send never fails for want of this note. */
export function rememberProjectIdentityPushBytes(
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  project: string,
  bytes: unknown,
): void {
  if (!isBytes(bytes)) return
  try {
    const entry = key(baseUrl, project)
    const current = read(env)
    const previous = current[entry]
    if (previous?.ios === bytes.ios && previous.android === bytes.android) return
    // Newest last, so the oldest go first when the list is full.
    const kept = Object.entries(current).filter(([name]) => name !== entry).slice(-(LIMIT - 1))
    ensurePrivateDirectory(stateDir(env))
    atomicWriteFileSync(
      file(env),
      `${JSON.stringify({ projects: Object.fromEntries([...kept, [entry, { ios: bytes.ios, android: bytes.android }]]) })}\n`,
    )
  } catch { /* Only the next form's size check is less exact. */ }
}
