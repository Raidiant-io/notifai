/** When a staged answer or note may be woken into a Codex session. */
import { codexHostKind, type CodexHostKind } from './codex-session-end.js'
import { readSessionIncarnation, readSessionState, sessionHasEnded } from './hook-session-state.js'
import { processIdentityLiveness, type ProcessIdentity } from './process-identity.js'
import { codexTurnInterrupted, observedCodexTurnActivity } from './session-attendant-state.js'

/**
 * The longest a running turn delays a wake. Hooks hand input in during a turn,
 * and a wake written meanwhile would only be blocked later, so waiting avoids
 * that noise. It is never more than a delay: `codex queue` is safe at any moment
 * (Codex stores the wake until the turn ends), and the running turn may be a
 * hook Notifai never saw end.
 */
export const CODEX_WAKE_DELAY_MS = 60_000

/** Why a wake is not being written right now. Each is logged when it starts. */
export type CodexWakeHold =
  | 'session-gone'
  | 'host-not-showing'
  | 'turn-running'
  | 'paused-after-interrupt'

/**
 * The idle-wake rule without a way to tell whether a terminal shows the
 * thread: never on Codex's shared server. That server keeps a closed
 * terminal's thread loaded, idle and clientless for about 30 minutes and
 * tells no one, so a wake there could start a turn nobody sees; the input
 * waits for the User's next prompt instead. The hub, which can tell, passes
 * its own rule. A process's command line is fixed for its life, so the host
 * is asked once per process (an unknown answer is asked again, and wakes).
 */
export function hostKindIdleWake(hostKind: (pid: number) => CodexHostKind = codexHostKind): (owner: ProcessIdentity) => boolean {
  let host: { pid: number; start: string; wakes: boolean } | undefined
  return (owner) => {
    if (host?.pid !== owner.pid || host.start !== owner.start) {
      const kind = hostKind(owner.pid)
      if (kind === 'unknown') return true
      host = { pid: owner.pid, start: owner.start, wakes: kind !== 'shared-server' }
    }
    return host.wakes
  }
}

/** One session's wake rule. `idleWake` decides whether its current host may be woken. */
export function codexInputObserver(
  sessionId: string, env: NodeJS.ProcessEnv, expectedKey: string,
  alive: (owner: ProcessIdentity) => boolean = (owner) => processIdentityLiveness(owner) === 'alive',
  idleWake: (owner: ProcessIdentity) => boolean = hostKindIdleWake(),
  wall: () => number = Date.now,
): { hold: () => CodexWakeHold | null; mayWake: () => boolean } {
  const hold = (): CodexWakeHold | null => {
    const owner = readSessionIncarnation(sessionId, env)
    if (owner?.key !== expectedKey || sessionHasEnded(sessionId, env) ||
        owner.harness_process === undefined || !alive(owner.harness_process)) return 'session-gone'
    if (!idleWake(owner.harness_process)) return 'host-not-showing'
    // Codex holds its queue after an interrupt until the next prompt, and that
    // prompt's own hook hands the input in, so a wake here could only go stale.
    if (codexTurnInterrupted(sessionId, env, expectedKey)) return 'paused-after-interrupt'
    if (observedCodexTurnActivity(sessionId, env, expectedKey) === 'working') {
      const since = readSessionState(sessionId, env).input_waiting?.since
      const elapsed = since === undefined ? 0 : wall() - since
      if (elapsed < CODEX_WAKE_DELAY_MS) return 'turn-running'
    }
    return null
  }
  return { hold, mayWake: () => hold() === null }
}
