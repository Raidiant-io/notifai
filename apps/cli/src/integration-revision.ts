import { decodeWindowsCodexCommand, encodeWindowsCodexCommand, windowsCodexCommandsInSource } from './windows-codex-command.js'
/** A loaded definition carries its revision literally. Reading the current
 * definition from disk inside a callback would falsely prove a host reload. */
import { createHash } from 'node:crypto'
import { readSessionIncarnation, readSessionState, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import type { HookHarness } from './hook-types.js'

export const INTEGRATION_REVISION_PLACEHOLDER = '__NOTIFAI_INTEGRATION_REVISION__'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export function stampIntegrationSource(source: string, scope = ''): string {
  if (!source.includes(INTEGRATION_REVISION_PLACEHOLDER)) throw new Error('Missing loaded integration revision')
  return source.replaceAll(INTEGRATION_REVISION_PLACEHOLDER, hash(`${scope}\n${source}`))
}
export function stampHookDefinition<T extends object>(definition: T, scope = ''): T {
  const revision = hash(`${scope}\n${JSON.stringify(definition)}`)
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    const args = (value as Record<string, unknown>)['args']
    if (Array.isArray(args) && typeof (value as Record<string, unknown>)['command'] === 'string') {
      // Exec form: the revision is one more argument, never part of the executable.
      args.push('--integration-revision', revision)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === 'command' && typeof item === 'string') {
        const decoded = decodeWindowsCodexCommand(item)
        const stamped = `${decoded ?? item} --integration-revision ${revision}`
        ;(value as Record<string, unknown>)[key] = decoded === null ? stamped : encodeWindowsCodexCommand(stamped)
      }
      else visit(item)
    }
  }
  visit(definition)
  return definition
}
export function sourceIntegrationRevision(source: string): string | null {
  source += `\n${windowsCodexCommandsInSource(source).join("\n")}`
  // Shell form names the revision after a space; exec form keeps it as the
  // next element of the JSON `args` array.
  const revisions = new Set([...source.matchAll(/(?:--integration-revision(?:\s+|"\s*,\s*")|NOTIFAI_INTEGRATION_REVISION = ")([a-f0-9]{64})/g)].map(match => match[1]!))
  return revisions.size === 1 ? [...revisions][0]! : null
}
export function observeLoadedIntegration(sessionId: string, harness: HookHarness,
  revision: string | undefined, env: NodeJS.ProcessEnv): void {
  if (!revision || !/^[a-f0-9]{64}$/.test(revision) || sessionHasEnded(sessionId, env)) return
  const incarnation = readSessionIncarnation(sessionId, env)
  if (!incarnation) return
  const prior = readSessionState(sessionId, env).integration_observation
  if (prior?.incarnation === incarnation.key && prior.revision === revision) return
  updateSessionState(sessionId, env, state => {
    if (state.harness !== harness || readSessionIncarnation(sessionId, env)?.key !== incarnation.key) return state
    const prior = state.integration_observation
    return prior?.incarnation === incarnation.key && prior.revision === revision ? state : {
      ...state, integration_observation: { incarnation: incarnation.key, revision },
    }
  })
}
export function loadedIntegrationObserved(sessionId: string, revision: string, env: NodeJS.ProcessEnv): boolean {
  const incarnation = readSessionIncarnation(sessionId, env)
  const proof = readSessionState(sessionId, env).integration_observation
  return !sessionHasEnded(sessionId, env) && incarnation !== null && proof?.incarnation === incarnation.key && proof.revision === revision
}
