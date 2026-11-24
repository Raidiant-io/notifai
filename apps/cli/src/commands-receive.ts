/** Foreground input consumption, shared by prompt hooks and an explicit wake. */
import { resolveCommandSession } from './command-session.js'
import { setTimeout as sleep } from 'node:timers/promises'
import { EXIT, makeClient, log, type CommandDeps } from './commands-core.js'
import { readSessionIncarnation, readSessionState, sessionHasEnded } from './hook-session-state.js'
import { grokTerminalStartKey } from './grok-terminal-session.js'
import { processAncestry } from './process-ancestry.js'
import { currentProcessIdentity, processIdentityLiveness, type ProcessIdentity } from './process-identity.js'
import { readAttendantLease } from './session-attendant-state.js'
import { drainSessionInputs, forgetQueuedInputWake, hasSessionInputs } from './session-inputs.js'

/**
 * The Grok process a verified route wakes, when this process runs under it.
 * Grok records no harness process of its own; its attendant records this one.
 */
export function grokHostOwner(sessionId: string, env: NodeJS.ProcessEnv, incarnation: string | undefined,
  ancestors: () => readonly { pid: number }[] | null = () => processAncestry()): ProcessIdentity | undefined {
  const owner = readSessionState(sessionId, env).grok_host_owner
  if (owner === undefined || incarnation === undefined || owner.incarnation !== incarnation) return undefined
  if (owner.terminal === true && grokTerminalStartKey(owner, env) !== readSessionIncarnation(sessionId, env)?.key) return undefined
  return ancestors()?.slice(1).some((ancestor) => ancestor.pid === owner.pid) === true ? { pid: owner.pid, start: owner.start } : undefined
}

export async function receiveSessionInputs(
  deps: CommandDeps, sessionId: string, write: (text: string) => void,
  context: 'hook' | 'command' = 'hook', commandDeadline?: number,
): Promise<boolean> {
  const lease = readAttendantLease(sessionId, deps.env)
  const incarnation = readSessionIncarnation(sessionId, deps.env)
  const owner = incarnation?.harness_process ?? grokHostOwner(sessionId, deps.env, incarnation?.incarnation)
  const terminalOwner = readSessionState(sessionId, deps.env).grok_host_owner?.terminal === true
  if (!hasSessionInputs(sessionId, deps.env, lease)) return false
  const mayWrite = (): boolean => {
    const current = readAttendantLease(sessionId, deps.env)
    if (sessionHasEnded(sessionId, deps.env)) return false
    if (lease === null) return current === null
    return incarnation?.incarnation === lease.incarnation && owner !== undefined && current?.incarnation === lease.incarnation &&
      current.generation === lease.generation && readSessionIncarnation(sessionId, deps.env)?.incarnation === lease.incarnation &&
      (!terminalOwner || grokTerminalStartKey(owner, deps.env) === incarnation.key) &&
      processIdentityLiveness(owner) === 'alive'
  }
  if (!mayWrite()) return false
  const credential = deps.store.load()
  const writer = currentProcessIdentity()
  if (credential === null || writer === null) return false
  const now = deps.now ?? Date.now
  // A foreground read can wait for an ordinary slow link. Synchronous prompt
  // hooks still have to yield quickly, leaving undelivered inputs queued.
  const deadlineAt = commandDeadline ?? now() + (context === 'command' ? 30_000 : 2_000)
  const client = makeClient(deps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`, {
    timeoutMs: context === 'command' ? 20_000 : 750, deadlineAt, now,
  })
  return drainSessionInputs({
    lease, mayWrite: () => now() < deadlineAt && mayWrite(), write,
    sequencer: { sessionId, env: deps.env, client, writer, log: log(deps),
      wall: now, monotonic: () => performance.now(), recoveryDeadline: performance.now() + 500,
      sleep: async () => undefined },
  })
}

export async function receiveCommand(deps: CommandDeps): Promise<number> {
  const current = resolveCommandSession(deps)
  if (current?.source !== 'exact-harness') {
    deps.io.err('Exact Agent Session identity could not be resolved; no input was read.')
    return EXIT.usage
  }
  const { sessionId } = current
  const { env } = deps
  log(deps).bind({ session: sessionId })
  forgetQueuedInputWake(sessionId, env)
  const now = deps.now ?? Date.now
  const deadline = now() + 30_000
  const receive = () => receiveSessionInputs(deps, sessionId, (text) => deps.io.out(text), 'command', deadline)
  const pending = () => hasSessionInputs(sessionId, env, readAttendantLease(sessionId, env))
  let received = await receive()
  if (!received && readSessionState(sessionId, env).grok_host_owner?.route === 'monitor' && now() < deadline && pending()) {
    // An indeterminate local owner check can clear on a loaded machine. Retry
    // the read once within this invocation, keeping the monitor at one wake.
    await sleep(250)
    received = await receive()
  }
  if (!received) {
    deps.io.out(pending()
      ? 'User input is pending but could not be handed over yet. It remains queued. Inspect notifai logs for the claim or delivery failure; do not treat this as an empty inbox or acknowledge unseen input.'
      // A wake that started an idle turn asks for nothing: end that turn rather
      // than resume finished work. A wake seen mid-turn leaves the work running.
      : 'No user input is pending in the local inbox for this session. If a Notifai wake started this turn, end the turn; if you were already working, carry on with that work.')
  }
  return EXIT.ok
}
