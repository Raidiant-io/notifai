/** Foreground input consumption, shared by prompt hooks and an explicit wake. */
import { resolveCommandSession } from './command-session.js'
import { EXIT, makeClient, log, type CommandDeps } from './commands-core.js'
import { readSessionIncarnation, sessionHasEnded } from './hook-session-state.js'
import { currentProcessIdentity, processIdentityLiveness } from './process-identity.js'
import { readAttendantLease } from './session-attendant-state.js'
import { drainSessionInputs, hasSessionInputs, observeSessionInputWake, sessionInputWake } from './session-inputs.js'

export async function receiveSessionInputs(deps: CommandDeps, sessionId: string, write: (text: string) => void): Promise<boolean> {
  const lease = readAttendantLease(sessionId, deps.env)
  const incarnation = readSessionIncarnation(sessionId, deps.env)
  const owner = incarnation?.harness_process
  if (!hasSessionInputs(sessionId, deps.env, lease)) return false
  const mayWrite = (): boolean => {
    const current = readAttendantLease(sessionId, deps.env)
    if (sessionHasEnded(sessionId, deps.env)) return false
    if (lease === null) return current === null
    return incarnation?.incarnation === lease.incarnation && owner !== undefined && current?.incarnation === lease.incarnation &&
      current.generation === lease.generation && readSessionIncarnation(sessionId, deps.env)?.incarnation === lease.incarnation &&
      processIdentityLiveness(owner) === 'alive'
  }
  if (!mayWrite()) return false
  const credential = deps.store.load()
  const writer = currentProcessIdentity()
  if (credential === null || writer === null) return false
  const now = deps.now ?? Date.now
  const deadlineAt = now() + 2_000
  const client = makeClient(deps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`, {
    timeoutMs: 750, deadlineAt, now,
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
  log(deps).bind({ session: current.sessionId })
  observeSessionInputWake(current.sessionId, deps.env, sessionInputWake())
  const received = await receiveSessionInputs(deps, current.sessionId, (text) => deps.io.out(text))
  if (!received) {
    const pending = hasSessionInputs(current.sessionId, deps.env, readAttendantLease(current.sessionId, deps.env))
    deps.io.out(pending
      ? 'User input is pending but could not be handed over yet. It remains queued. Inspect notifai logs for the claim or delivery failure; do not treat this as an empty inbox or acknowledge unseen input.'
      : 'No user input is pending in the local inbox for this session. Continue your work.')
  }
  return EXIT.ok
}
