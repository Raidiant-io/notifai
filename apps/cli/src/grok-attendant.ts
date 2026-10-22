/** Grok has no asynchronous hooks. A short native hook starts this retained
 * observer; only an existing leader's exact resident roster admits it. */
import type { CommandDeps } from './commands-core.js'
import { makeClient } from './commands-core.js'
import { attendantGates } from './commands-hook-attend.js'
import { GrokLeaderSession, hasGrokLeader } from './grok-leader.js'
import { acquireClaimFile, claimHolderMayRun, readClaimFile, releaseClaimFile } from './hook-question-lock.js'
import { readSessionIncarnation, refreshSessionMarkers, rotateSessionIncarnation, sessionHasEnded, sessionNotified } from './hook-session-state.js'
import type { HookEnvelope } from './hook-types.js'
import { launchSelf } from './launch-self.js'
import type { Logger } from './logging.js'
import { currentProcessIdentity } from './process-identity.js'
import { packageVersion } from './release.js'
import { retainSessionRuntime } from './runtime-build-retention.js'
import { runSessionAttendant, systemAttendantClock } from './session-attendant.js'
import { attendantClaimPath, attendantStatusPath, writeAttendantStatus } from './session-attendant-state.js'
import { handOffSessionMessages } from './session-message-handoff.js'
import type { ApiClient } from './client.js'
import type { MachineCredential } from './credentials.js'

export const GROK_ATTEND_INPUT_ENV = 'NOTIFAI_INTERNAL_GROK_ATTEND_INPUT'

export function startGrokAttendant(envelope: HookEnvelope, cwd: string, env: NodeJS.ProcessEnv): void {
  const sessionId = envelope.session_id
  if (!sessionId || envelope.subagentType || sessionHasEnded(sessionId, env) || !hasGrokLeader(env)) return
  const record = readSessionIncarnation(sessionId, env)
  if (record === null) return
  const holder = readClaimFile(attendantClaimPath(sessionId, env))
  if (holder?.['incarnation'] === record.incarnation && claimHolderMayRun(holder)) return
  launchSelf(['hook', 'attend', '--owner', 'notifai', '--harness', 'grok'], {
    cwd,
    env: { ...env, [GROK_ATTEND_INPUT_ENV]: JSON.stringify({ session_id: sessionId, cwd, grok_incarnation_key: record.key }) },
    retain: reference => retainSessionRuntime(sessionId, env, reference),
  })
}

export async function grokAttendHook(deps: CommandDeps, envelope: HookEnvelope, cwd: string, logger: Logger): Promise<number> {
  const sessionId = envelope.session_id
  if (!sessionId || envelope.subagentType) return 0
  const record = readSessionIncarnation(sessionId, deps.env)
  if (record === null || record.key !== envelope.grok_incarnation_key || sessionHasEnded(sessionId, deps.env)) return 0
  const runningVersion = deps.runningVersion === undefined ? packageVersion() : deps.runningVersion
  const gate = () => attendantGates(deps, cwd, 'grok', runningVersion)
  if (!gate().ok) return 0
  const writer = currentProcessIdentity()
  if (writer === null) return 0
  const leader = await GrokLeaderSession.discover(sessionId, cwd, deps.env)
  if (leader === null) {
    logger.info('hook.end', { hook: 'attend', outcome: 'unsupported', reason: 'grok-live-leader-unavailable' })
    return 0
  }
  const claimFile = attendantClaimPath(sessionId, deps.env)
  let token = acquireClaimFile(claimFile, { incarnation: record.incarnation }, Date.now())
  if (token === null) { leader.close(); return 0 }
  let client: ApiClient | null = null
  let credential: MachineCredential | null = null
  const connect = (): ApiClient | null => {
    const next = deps.store.load()
    if (next?.machineId === credential?.machineId && next?.baseUrl === credential?.baseUrl && next?.secret === credential?.secret) return client
    credential = next
    client = next ? makeClient(deps, next.baseUrl, `Bearer nfm_${next.machineId}.${next.secret}`) : null
    return client
  }
  let signal!: () => void
  const signalled = new Promise<void>(resolve => { signal = resolve })
  const onSignal = (): void => signal()
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(name, onSignal)
  try {
    await runSessionAttendant({
      sessionId,
      incarnation: record.incarnation,
      incarnationNow: () => readSessionIncarnation(sessionId, deps.env)?.incarnation ?? null,
      rotateIncarnation: expected => {
        const next = rotateSessionIncarnation(sessionId, deps.env, expected)
        if (next === null) return null
        releaseClaimFile(claimFile, token!)
        token = acquireClaimFile(claimFile, { incarnation: next.incarnation }, Date.now())
        return token === null ? null : next.incarnation
      },
      probe: () => sessionHasEnded(sessionId, deps.env)
        ? { state: 'ended', reason: 'session-end-hook' } : leader.probe(),
      claimHeld: () => token !== null && readClaimFile(claimFile)?.['token'] === token,
      notified: () => sessionNotified(sessionId, deps.env),
      gates: gate,
      client: connect,
      serverSupportsAttendance: async api => (await api.compatibility()).server_capabilities.includes('session_attendance'),
      acceptsMessages: true,
      publishProbeStatus: true,
      onMessages: async (messages, attendant) => {
        const api = connect()
        if (api === null) return 'done'
        return handOffSessionMessages(messages, attendant, {
          sequencer: {
            sessionId, env: deps.env, client: api, writer, log: logger,
            monotonic: () => systemAttendantClock.monotonic(), wall: () => systemAttendantClock.wall(),
            sleep: ms => systemAttendantClock.sleep(ms, new AbortController().signal),
          },
          write: (text, begin, guard) => leader.write(text, begin, guard),
        })
      },
      clock: systemAttendantClock, logger, signalled,
      writeStatus: status => writeAttendantStatus(sessionId, deps.env, status),
      heartbeat: () => refreshSessionMarkers(sessionId, deps.env, Date.now(), [claimFile, attendantStatusPath(sessionId, deps.env)]),
    })
  } finally {
    leader.close()
    if (token !== null) releaseClaimFile(claimFile, token)
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.removeListener(name, onSignal)
  }
  return 0
}
