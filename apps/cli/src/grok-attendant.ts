/** Grok has no asynchronous hooks. A short native hook starts this retained
 * observer. An existing leader's exact resident roster admits Session
 * Messages. A session outside any leader (an ACP host such as an Orca chat
 * starts `grok agent stdio` itself) runs in its own Grok process, which then
 * hosts exactly this session. When the app that started that process can wake
 * the exact chat or thread and the binding verifies (`grok-host-route.ts`),
 * the observer stages notes and sends the app a content-free wake; the
 * session reads them with `notifai receive`. Otherwise it attends
 * presence-only, so the User sees it running and that it takes no notes. */
import type { CommandDeps } from './commands-core.js'
import { makeClient } from './commands-core.js'
import { attendantGates } from './commands-hook-attend.js'
import { GROK_NO_LEADER_REASON, GrokLeaderSession, hasGrokLeader } from './grok-leader.js'
import { acquireClaimFile, claimHolderMayRun, processCommandLine, readClaimFile, releaseClaimFile } from './hook-question-lock.js'
import { readSessionIncarnation, readSessionState, refreshSessionMarkers, rotateSessionIncarnation, sessionHasEnded, sessionNotified, updateSessionState } from './hook-session-state.js'
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
import { GROK_ORCA_BOT_REASON, GrokHostRouteWatch, grokHostCandidate, isOrcaBotChat, sendGrokHostWake, systemGrokHostSystem, verifyGrokHostRoute, type GrokHostSystem } from './grok-host-route.js'
import { hasSessionInputs, stageSessionMessages, wakeSessionInputs } from './session-inputs.js'
import { readDeliveryJournal } from './session-delivery.js'
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

/** How long a session must sit idle before an accepted but unseen wake counts as lost. */
const IDLE_BEFORE_WAKE_REPLACEMENT_MS = 30_000

export async function grokAttendHook(deps: CommandDeps, envelope: HookEnvelope, cwd: string, logger: Logger,
  hostSystem: GrokHostSystem = systemGrokHostSystem(deps.env), startupMs?: number): Promise<number> {
  const sessionId = envelope.session_id
  if (!sessionId || envelope.subagentType) return 0
  const skipped = (reason: string): number => {
    logger.info('hook.end', { hook: 'attend', outcome: 'skipped', reason })
    return 0
  }
  const record = readSessionIncarnation(sessionId, deps.env)
  if (record === null || record.key !== envelope.grok_incarnation_key) return skipped('incarnation-replaced')
  if (sessionHasEnded(sessionId, deps.env)) return skipped('session-ended')
  const runningVersion = deps.runningVersion === undefined ? packageVersion() : deps.runningVersion
  const gate = () => attendantGates(deps, cwd, 'grok', runningVersion)
  const opened = gate()
  if (!opened.ok) return skipped(opened.reason)
  const writer = currentProcessIdentity()
  if (writer === null) return skipped('writer-identity-unavailable')
  const leader = hasGrokLeader(deps.env) ? await GrokLeaderSession.discover(sessionId, cwd, deps.env) : null
  // Without the roster, only the session's own Grok process says it runs.
  const host = leader === null && envelope.grok_host?.role === 'session' &&
    processIdentityLiveness(envelope.grok_host) === 'alive' ? envelope.grok_host : null
  if (leader === null && host === null) {
    logger.info('hook.end', { hook: 'attend', outcome: 'unsupported', reason: 'grok-live-leader-unavailable' })
    return 0
  }
  // Claim first: verifying a starting session can take a while, and a later
  // prompt must not start a second attendant meanwhile.
  const claimFile = attendantClaimPath(sessionId, deps.env)
  let token = acquireClaimFile(claimFile, { incarnation: record.incarnation }, Date.now())
  if (token === null) { leader?.close(); return skipped('claim-held') }
  // A leader-owned session never falls back to host mail: only a process that
  // hosts exactly this session can say which chat or thread it runs in.
  const candidate = leader === null && host !== null ? grokHostCandidate(deps.env) : null
  const verifyNow = () => verifyGrokHostRoute(candidate!, sessionId, host!.pid, deps.env, hostSystem)
  const started = candidate === null ? null : await GrokHostRouteWatch.start(verifyNow, () => systemAttendantClock.monotonic(),
    ms => systemAttendantClock.sleep(ms, new AbortController().signal).catch(() => undefined), startupMs)
  const watch = started instanceof GrokHostRouteWatch ? started : null
  const hostRoute = watch?.route ?? null
  if (hostRoute !== null) {
    // `notifai receive` hands input in only under this exact Grok process.
    const owner = { incarnation: record.incarnation, pid: host!.pid, start: host!.start, route: hostRoute.kind }
    updateSessionState(sessionId, deps.env, state => ({ ...state, grok_host_owner: owner }))
  }
  const unavailable = started !== null && !(started instanceof GrokHostRouteWatch) ? started.unavailable
    : isOrcaBotChat(deps.env) ? GROK_ORCA_BOT_REASON : GROK_NO_LEADER_REASON
  if (leader === null) logger.info('attendant.state', hostRoute !== null
    ? { messages: 'host-wake', route: hostRoute.kind }
    : { messages: 'unavailable', reason: unavailable })
  const ownProbe = (): HarnessProbe => {
    if (host === null) return leader!.probe()
    if (processIdentityLiveness(host) === 'gone') return { state: 'ended', reason: 'harness-gone' }
    // The app took the conversation away while Grok runs on: take no more notes.
    if (watch?.lost() != null) return { state: 'ended', reason: 'session-replaced' }
    const state = readSessionState(sessionId, deps.env)
    return { state: 'running', activity: (state.last_prompt_at ?? 0) > (state.last_stop_at ?? 0) ? 'working' : 'idle' }
  }
  let client: ApiClient | null = null
  let credential: MachineCredential | null = null
  const connect = (): ApiClient | null => {
    const next = deps.store.load()
    if (next?.machineId === credential?.machineId && next?.baseUrl === credential?.baseUrl && next?.secret === credential?.secret) return client
    credential = next
    client = next ? makeClient(deps, next.baseUrl, `Bearer nfm_${next.machineId}.${next.secret}`) : null
    return client
  }
  let idleSince: number | null = null
  let lostLogged = false
  const settledIdle = (): boolean => idleSince !== null && systemAttendantClock.monotonic() - idleSince >= IDLE_BEFORE_WAKE_REPLACEMENT_MS
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
        if (token !== null && hostRoute !== null) updateSessionState(sessionId, deps.env, state =>
          state.grok_host_owner?.incarnation === expected ? { ...state, grok_host_owner: { ...state.grok_host_owner, incarnation: next.incarnation } } : state)
        return token === null ? null : next.incarnation
      },
      probe: () => sessionHasEnded(sessionId, deps.env)
        ? { state: 'ended', reason: 'session-end-hook' } : ownProbe(),
      claimHeld: () => token !== null && readClaimFile(claimFile)?.['token'] === token,
      notified: () => sessionNotified(sessionId, deps.env),
      gates: gate,
      client: connect,
      serverSupportsAttendance: async api => (await api.compatibility()).server_capabilities.includes('session_attendance'),
      acceptsMessages: leader !== null || hostRoute !== null,
      onProbe: observed => {
        if (observed.state === 'running' && observed.activity === 'idle') idleSince ??= systemAttendantClock.monotonic()
        else idleSince = null
        if (observed.state === 'running') void watch?.poll().then(() => {
          const lost = watch.lost()
          if (lost !== null && !lostLogged) { lostLogged = true; logger.info('attendant.state', { messages: 'host-route-lost', reason: lost }) }
        })
      },
      ...(leader !== null ? {
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
      } satisfies Partial<SessionAttendantOptions> : hostRoute !== null ? {
        overdue: { env: deps.env, harness: 'grok', cwd, heldAnswers: true },
        onMessages: async (messages, attendant) => {
          const generation = attendant.generation()
          if (generation === null || !attendant.mayWrite()) return 'retry-soon'
          const lease = { incarnation: attendant.incarnation(), generation }
          stageSessionMessages(sessionId, deps.env, lease, messages)
          if (!hasSessionInputs(sessionId, deps.env, lease)) return 'done'
          await wakeSessionInputs(sessionId, deps.env, async (text, abort) => {
            // Recheck just before the host accepts anything: the input may
            // have been read since, and the chat or thread may have moved on.
            if (!attendant.mayWrite() || !hasSessionInputs(sessionId, deps.env, lease)) return 'not-attempted'
            // A live `notifai receive` holding a claim is presenting it now;
            // a wake would only start an empty turn. A dead claimant's input
            // is woken for as usual.
            if (readDeliveryJournal(sessionId, deps.env).some(entry => entry.stage === 'claimed' && entry.reported === undefined &&
              processIdentityLiveness(entry.writer) === 'alive')) return 'not-attempted'
            const checked = await verifyNow()
            const current = watch!.observe(checked)
            if (current === null) {
              logger.info('delivery.handoff', { route: 'input-wake', stage: 'host-unverified',
                reason: 'unavailable' in checked ? checked.unavailable : 'host-route-lost', definite: watch!.lost() !== null })
              return 'not-attempted'
            }
            if (abort.aborted || !attendant.mayWrite()) return 'not-attempted'
            return sendGrokHostWake(current, text, deps.env, hostSystem, abort, logger)
          }, logger, { unique: true, replaceLost: settledIdle, now: () => systemAttendantClock.wall() })
          return 'done'
        },
      } satisfies Partial<SessionAttendantOptions> : {
        messagesUnavailableReason: unavailable,
      }),
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
