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

export async function receiveCommand(deps: CommandDeps, flags: { session: string }): Promise<number> {
  const current = resolveCommandSession(deps)
  if (current?.source !== 'exact-harness' || current.sessionId !== flags.session) {
    deps.io.err('Pending input belongs to a different or unresolved Agent Session; no input was read.')
    return EXIT.usage
  }
  log(deps).bind({ session: current.sessionId })
  observeSessionInputWake(flags.session, deps.env, sessionInputWake(flags.session))
  const received = await receiveSessionInputs(deps, flags.session, (text) => deps.io.out(text))
  if (!received) deps.io.out('No user input is ready for this session. Continue your work; pending input will be offered at a later boundary.')
  return EXIT.ok
}
