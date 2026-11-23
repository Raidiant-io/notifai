/** Grok has no asynchronous hooks. A short native hook starts this retained
 * observer. Only an existing leader's exact resident roster admits Session
 * Messages. A session outside any leader (an ACP host such as an Orca chat
 * starts `grok agent stdio` itself) runs in its own Grok process, which then
 * hosts exactly this session: the observer attends it presence-only, so the
 * User sees it running and that it takes no notes. */
import type { CommandDeps } from './commands-core.js'
import { makeClient } from './commands-core.js'
import { attendantGates } from './commands-hook-attend.js'
import { GROK_NO_LEADER_REASON, GrokLeaderSession, hasGrokLeader } from './grok-leader.js'
import { acquireClaimFile, claimHolderMayRun, processCommandLine, readClaimFile, releaseClaimFile } from './hook-question-lock.js'
import { readSessionIncarnation, readSessionState, refreshSessionMarkers, rotateSessionIncarnation, sessionHasEnded, sessionNotified } from './hook-session-state.js'
import type { HookEnvelope } from './hook-types.js'
import { launchSelf } from './launch-self.js'
import type { Logger } from './logging.js'
import { processAncestry, type AncestorProcess } from './process-ancestry.js'
import { currentProcessIdentity, processIdentityLiveness, processStartTime } from './process-identity.js'
import { packageVersion } from './release.js'
import { retainSessionRuntime } from './runtime-build-retention.js'
import { runSessionAttendant, systemAttendantClock, type HarnessProbe, type SessionAttendantOptions } from './session-attendant.js'
import { attendantClaimPath, attendantStatusPath, writeAttendantStatus } from './session-attendant-state.js'
import { handOffSessionMessages } from './session-message-handoff.js'
import type { ApiClient } from './client.js'
import type { MachineCredential } from './credentials.js'

export const GROK_ATTEND_INPUT_ENV = 'NOTIFAI_INTERNAL_GROK_ATTEND_INPUT'

export type GrokHost = NonNullable<HookEnvelope['grok_host']>

/**
 * The Grok process that runs this hook: the nearest `grok` ancestor, never a
 * shell between it and the hook. A leader hosts many sessions, so only its
 * roster can prove one; any other Grok process hosts exactly this session.
 */
export function grokHostOf(
  chain: readonly AncestorProcess[] | null,
  commandLine: (pid: number) => string | null,
  startOf: (pid: number) => string | null,
): GrokHost | null {
  const host = chain?.slice(1).find(ancestor => /^grok(?:-native)?(?:\.exe)?$/i.test(ancestor.name))
  if (host === undefined) return null
  const command = commandLine(host.pid)
  const start = startOf(host.pid)
  if (command === null || start === null) return null
  // `grok agent leader` hosts the shared sessions; a `--leader` client hosts none.
  const args = command.trim().split(/\s+/)
  const agent = args.indexOf('agent')
  const role = args.includes('--leader') || (agent >= 0 && args.slice(agent + 1).includes('leader')) ? 'leader' : 'session'
  return { pid: host.pid, start, role }
}

export function startGrokAttendant(envelope: HookEnvelope, cwd: string, env: NodeJS.ProcessEnv): void {
  const sessionId = envelope.session_id
  if (!sessionId || envelope.subagentType || sessionHasEnded(sessionId, env)) return
  const host = grokHostOf(processAncestry(), processCommandLine, processStartTime)
  if (!hasGrokLeader(env) && host?.role !== 'session') return
  const record = readSessionIncarnation(sessionId, env)
  if (record === null) return
  const holder = readClaimFile(attendantClaimPath(sessionId, env))
  if (holder?.['incarnation'] === record.incarnation && claimHolderMayRun(holder)) return
  launchSelf(['hook', 'attend', '--owner', 'notifai', '--harness', 'grok'], {
    cwd,
    env: { ...env, [GROK_ATTEND_INPUT_ENV]: JSON.stringify({
      session_id: sessionId, cwd, grok_incarnation_key: record.key, ...(host === null ? {} : { grok_host: host }),
    }) },
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
  const leader = hasGrokLeader(deps.env) ? await GrokLeaderSession.discover(sessionId, cwd, deps.env) : null
  // Without the roster, only the session's own Grok process says it runs.
  const host = leader === null && envelope.grok_host?.role === 'session' &&
    processIdentityLiveness(envelope.grok_host) === 'alive' ? envelope.grok_host : null
  if (leader === null && host === null) {
    logger.info('hook.end', { hook: 'attend', outcome: 'unsupported', reason: 'grok-live-leader-unavailable' })
    return 0
  }
  if (leader === null) logger.info('attendant.state', { messages: 'unavailable', reason: GROK_NO_LEADER_REASON })
  const ownProbe = (): HarnessProbe => {
    if (host === null) return leader!.probe()
    if (processIdentityLiveness(host) === 'gone') return { state: 'ended', reason: 'harness-gone' }
    const state = readSessionState(sessionId, deps.env)
    return { state: 'running', activity: (state.last_prompt_at ?? 0) > (state.last_stop_at ?? 0) ? 'working' : 'idle' }
  }
  const claimFile = attendantClaimPath(sessionId, deps.env)
  let token = acquireClaimFile(claimFile, { incarnation: record.incarnation }, Date.now())
  if (token === null) { leader?.close(); return 0 }
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
      labelContext: { env: deps.env, harness: 'grok' },
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
        ? { state: 'ended', reason: 'session-end-hook' } : ownProbe(),
      claimHeld: () => token !== null && readClaimFile(claimFile)?.['token'] === token,
      notified: () => sessionNotified(sessionId, deps.env),
      gates: gate,
      client: connect,
      serverSupportsAttendance: async api => (await api.compatibility()).server_capabilities.includes('session_attendance'),
      acceptsMessages: leader !== null,
      ...(leader === null ? { messagesUnavailableReason: GROK_NO_LEADER_REASON } : {
        publishProbeStatus: true,
        overdue: { env: deps.env, harness: 'grok', cwd, heldAnswers: true },
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
      } satisfies Partial<SessionAttendantOptions>),
      clock: systemAttendantClock, logger, signalled,
      writeStatus: status => writeAttendantStatus(sessionId, deps.env, status),
      heartbeat: () => refreshSessionMarkers(sessionId, deps.env, Date.now(), [claimFile, attendantStatusPath(sessionId, deps.env)]),
    })
  } finally {
    leader?.close()
    if (token !== null) releaseClaimFile(claimFile, token)
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.removeListener(name, onSignal)
  }
  return 0
}
