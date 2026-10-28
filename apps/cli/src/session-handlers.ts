/**
 * One question for every harness, asked by doctor and by `update --resume`:
 * which of Notifai's installed handlers is this Agent Session running, and
 * which is it missing? The answer and its wording are shared; only the
 * evidence differs, and it lives here.
 *
 * - Codex reads its hooks file when a thread starts and keeps what it read,
 *   and it approves each handler by its exact bytes. Its SessionStart records
 *   a fingerprint per handler (`codexHandlerFingerprints`), so the comparison
 *   names each handler the session lacks without anything stamped into the
 *   approved commands.
 * - Every other harness carries the definition's revision in each callback
 *   (`integration-revision.ts`); a callback with the current revision proves
 *   the running host loaded it. That names no single handler.
 */
import { readFileSync } from 'node:fs'
import type { ActiveHarnessSession } from './commands-harness-context.js'
import { readSessionIncarnation, readSessionState, sessionHasEnded } from './hook-session-state.js'
import { codexHandlerFingerprints, codexHandlerName, handlerEvent, type Installation } from './install-hooks.js'
import { loadedIntegrationObserved, sourceIntegrationRevision } from './integration-revision.js'

/** What a missing handler takes away from this session. */
export type HandlerFeature = 'questions' | 'tool' | 'card'

export interface SessionHandlers {
  harness: Installation['harness']
  label: string
  /** `unknown`: no evidence yet of which definition this session loaded. */
  state: 'current' | 'stale' | 'unknown'
  /** Codex only: handlers installed now that the session never loaded. */
  missing: string[]
  /** Codex only: handlers the session holds an older copy of. */
  changed: string[]
  /** Features this session lacks until a new session loads the handlers. */
  blocking: HandlerFeature[]
}

const FEATURE_OF_ROLE: Record<string, HandlerFeature> = {
  stop: 'questions',
  'user-prompt-submit': 'tool',
  'post-tool-use': 'tool',
  'pre-tool-use': 'card',
}

const FEATURE_WORDS: Record<HandlerFeature, string> = {
  questions: 'answers to its questions',
  tool: 'Notes and answers during a busy turn',
  card: 'Codex question cards',
}

/** The revision a non-Codex definition carries on disk. */
export function installedRevision(installation: Installation): string | null {
  try {
    return sourceIntegrationRevision(['hermes', 'openclaw', 'opencode'].includes(installation.harness)
      ? readFileSync(installation.file, 'utf8') : JSON.stringify(installation.handlers))
  } catch {
    return null
  }
}

/**
 * The handlers `session` runs against what `installations` hold now.
 * `loaded` stands in for a Codex session's record when it has none: the
 * definition on disk when the session already ran, before a repair rewrote it.
 * `expected` is the revision a repair wrote, for the other harnesses.
 */
export function sessionHandlers(
  env: NodeJS.ProcessEnv,
  session: ActiveHarnessSession & { sessionId: string },
  installations: Installation[],
  options: { loaded?: Record<string, string>; expected?: string } = {},
): SessionHandlers {
  const base = { harness: session.harness as Installation['harness'], label: session.label, missing: [], changed: [], blocking: [] }
  const own = installations.filter((installation) => installation.harness === session.harness)
  if (sessionHasEnded(session.sessionId, env) || own.length === 0) return { ...base, state: 'unknown' }
  const state = readSessionState(session.sessionId, env)
  if (session.harness === 'codex') {
    const recorded = state.harness === 'codex' ? state.codex_handler_fingerprints : undefined
    const loaded = recorded ?? options.loaded
    if (loaded === undefined) return { ...base, state: 'unknown' }
    const current = codexHandlerFingerprints(own, env)
    const missing = Object.keys(current).filter((name) => loaded[name] === undefined)
    const changed = Object.keys(current).filter((name) => loaded[name] !== undefined && loaded[name] !== current[name])
    const roles = new Map(own.flatMap((installation) => installation.handlers)
      .map((handler) => [codexHandlerName(handler), handlerEvent(handler.command) ?? ''] as const))
    const blocking = [...new Set([...missing, ...changed]
      .map((name) => FEATURE_OF_ROLE[roles.get(name) ?? ''])
      .filter((feature): feature is HandlerFeature => feature !== undefined))]
    return { ...base, state: missing.length + changed.length === 0 ? 'current' : 'stale', missing, changed, blocking }
  }
  const revision = options.expected ?? (own.length === 1 ? installedRevision(own[0]!) : null)
  if (revision === null) return { ...base, state: 'unknown' }
  if (loadedIntegrationObserved(session.sessionId, revision, env)) return { ...base, state: 'current' }
  const observed = state.integration_observation
  const incarnation = readSessionIncarnation(session.sessionId, env)
  return { ...base, state: observed !== undefined && observed.incarnation === incarnation?.key ? 'stale' : 'unknown' }
}

const list = (names: string[]) => names.length <= 1 ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

/** The one sentence doctor and `update --resume` both say; null when current. */
export function sessionHandlersLine(result: SessionHandlers): string | null {
  if (result.state === 'current') return null
  if (result.harness !== 'codex') {
    return `The changed ${result.label} definition has not been observed in this Agent Session. Preserve existing work and verify a real lifecycle callback after the harness loads the repaired definition.`
  }
  if (result.state === 'unknown') {
    return "Notifai can't tell which of its handlers this Codex session loaded, because it started before Notifai recorded them. A new Codex session picks up the current ones."
  }
  const names = [...result.missing, ...result.changed]
  const one = names.length === 1
  const features = result.blocking.map((feature) => FEATURE_WORDS[feature])
  return `This Codex session is not running Notifai's ${list(names)} ${one ? 'handler' : 'handlers'}: ${one ? 'it was' : 'they were'} added or changed after the session started. A new Codex session picks ${one ? 'it' : 'them'} up${features.length === 0 ? '; this one keeps working without ' + (one ? 'it' : 'them') : `; until then this session has no ${list(features)}`}.`
}
