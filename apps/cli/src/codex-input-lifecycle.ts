/** Exact native activity used by the existing input scheduler. */
import { readNativeTurnSnapshot } from './codex-native-turn.js'
import { codexHostKind, type CodexHostKind } from './codex-session-end.js'
import { readSessionIncarnation, readSessionState, sessionHasEnded, updateSessionState } from './hook-session-state.js'
import { processIdentityLiveness, type ProcessIdentity } from './process-identity.js'
import { reconcileNativeTurn } from './session-attendant-state.js'

export type CodexInputActivity = 'working' | 'idle' | 'aborted' | 'unknown'

/** Never infers idle from missing callbacks or a Stop hook. */
export function refreshCodexInputActivity(
  sessionId: string, env: NodeJS.ProcessEnv, expectedKey: string, transcriptPath?: string,
  /** Kernel evidence the harness still runs; the hub's session child supplies it without spawning `ps`. */
  alive: (owner: ProcessIdentity) => boolean = (owner) => processIdentityLiveness(owner) === 'alive',
): CodexInputActivity {
  const owner = readSessionIncarnation(sessionId, env)
  const owns = (): boolean => owner !== null && owner.key === expectedKey && !sessionHasEnded(sessionId, env) &&
    readSessionIncarnation(sessionId, env)?.key === expectedKey &&
    readSessionIncarnation(sessionId, env)?.incarnation === owner.incarnation &&
    owner.harness_process !== undefined && alive(owner.harness_process)
  if (!owns() || owner === null) return 'unknown'
  const proof = readSessionState(sessionId, env).codex_native_turn
  const file = transcriptPath ?? (proof?.key === owner.key ? proof.transcript_path : undefined)
  const native = readNativeTurnSnapshot(file, sessionId, env)
  if (native === null) return 'unknown'
  try {
    if (!reconcileNativeTurn(sessionId, env, owner.key, native.latest.id, native, owns)) return 'unknown'
    updateSessionState(sessionId, env, state => !owns() ? state : ({ ...state, codex_native_turn: {
      key: owner.key, turn_id: native.latest.id, transcript_path: native.file, observed_at: Date.now(),
    } }))
  } catch { return 'unknown' }
  if (!owns()) return 'unknown'
  return native.latest.ended ? native.latest.outcome === 'aborted' ? 'aborted' : 'idle' : 'working'
}

/**
 * Whether an idle thread on this host may be woken. Codex's shared server
 * keeps a closed terminal's thread loaded, idle and with no client for about
 * 30 minutes, and tells no one the terminal closed: a wake there would start a
 * turn nobody sees. Such a session is never woken while idle; its input waits
 * for the User's next prompt, which its hooks drain. Unknown keeps the wake.
 */
export function codexHostWakesIdle(kind: CodexHostKind): boolean {
  return kind !== 'shared-server'
}

/** One observer owns the grace interval across probes and final wake checks.
 * Only a continuous read failure permits the bounded queue fallback. */
export function codexInputObserver(
  sessionId: string, env: NodeJS.ProcessEnv, expectedKey: string, monotonic: () => number,
  transcriptPath?: string,
  alive: (owner: ProcessIdentity) => boolean = (owner) => processIdentityLiveness(owner) === 'alive',
  hostKind: (pid: number) => CodexHostKind = codexHostKind,
): { observe: () => CodexInputActivity; mayWake: () => boolean; unknownAllowed: () => boolean } {
  let unknownSince: number | undefined
  // A process's command line is fixed for its life: ask once per host.
  let host: { pid: number; start: string; wakes: boolean } | undefined
  const hostWakesIdle = (owner: ProcessIdentity): boolean => {
    if (host?.pid !== owner.pid || host.start !== owner.start) {
      const kind = hostKind(owner.pid)
      if (kind === 'unknown') return codexHostWakesIdle(kind)
      host = { pid: owner.pid, start: owner.start, wakes: codexHostWakesIdle(kind) }
    }
    return host.wakes
  }
  const observe = (): CodexInputActivity => {
    const activity = refreshCodexInputActivity(sessionId, env, expectedKey, transcriptPath, alive)
    if (activity === 'unknown') unknownSince ??= monotonic()
    else unknownSince = undefined
    return activity
  }
  return {
    observe,
    unknownAllowed: () => unknownSince !== undefined && monotonic() - unknownSince >= 6_000,
    mayWake: () => {
      if (readSessionIncarnation(sessionId, env)?.key !== expectedKey || sessionHasEnded(sessionId, env)) return false
      const activity = observe()
      const owner = readSessionIncarnation(sessionId, env)
      if (owner?.key !== expectedKey || sessionHasEnded(sessionId, env) ||
          owner.harness_process === undefined || !alive(owner.harness_process) ||
          !hostWakesIdle(owner.harness_process)) return false
      // Aborting fences its turn; it does not cancel pending User input.
      return activity === 'idle' || activity === 'aborted' ||
        (activity === 'unknown' && monotonic() - unknownSince! >= 6_000)
    },
  }
}
