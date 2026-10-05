/**
 * The local classic CLI plugin owns this child for one exact Hermes session.
 * Its pipe is an in-process writer bridge, not a second Hermes connection:
 * the plugin checks its attached CLI's session id again at every injection.
 */
import { nativeUninstallPending } from './native-uninstall-barrier.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { AttendanceMessage } from '@raidiant/notifai-protocol'
import { log, makeClient, type CommandDeps } from './commands-core.js'
import { waitForReply } from './commands-send-support.js'
import { loadConfig } from './config.js'
import { hermesPluginCurrent } from './hermes-plugin.js'
import { acquireClaimFile, claimHolderMayRun, readClaimFile, releaseClaimFile } from './hook-question-lock.js'
import {
  beginSessionIncarnation, lifecycleStamp, readSessionIncarnation,
  readSessionState, refreshSessionMarkers, rotateSessionIncarnation, sessionNotified,
} from './hook-session-state.js'
import { handleSessionEnd, runEscalationWaiter } from './hook-lifecycle.js'
import type { EscalationDeliveryRoute, HookContext } from './hook-types.js'
import type { Logger } from './logging.js'
import { currentProcessIdentity, processStartTime } from './process-identity.js'
import { projectBinding, projectEnabled } from './project-enablement.js'
import { runSessionAttendant, systemAttendantClock, type AttendantHandle, type GateResult, type HarnessProbe } from './session-attendant.js'
import { attendantClaimPath, attendantStatusPath, readAttendantLease, writeAttendantStatus } from './session-attendant-state.js'
import { handOffSessionMessages } from './session-message-handoff.js'
import type { ApiClient } from './client.js'
import type { SessionWriteResult } from './session-handoff.js'
import type { WriteGuard } from './wake-support.js'

type Hello = { type: 'hello'; session_id: string; cwd: string; pid: number }
type State = { type: 'state'; session_id: string; activity: 'idle' | 'working' }
type Result = { type: 'result'; id: number; accepted: boolean; reason?: string }
type End = { type: 'end'; session_id: string }
type Inbound = Hello | State | Result | End

const STATE_MAX_AGE_MS = 5_000
const INITIAL_FRAME_TIMEOUT_MS = 5_000

/** Framed, bounded IPC to the plugin thread that owns PluginContext. */
export class HermesWriterBridge {
  private lines: readline.Interface
  private helloValue: Hello | null = null
  private currentSession: string | null = null
  private activity: 'idle' | 'working' = 'idle'
  private stateAt = 0
  private closed = false
  private ended = false
  private nextId = 0
  private pending = new Map<number, (result: Result | null) => void>()
  private onHello: ((hello: Hello | null) => void) | null = null

  constructor(private input: Readable, private output: Writable, private now = Date.now) {
    this.lines = readline.createInterface({ input, crlfDelay: Infinity })
    this.lines.on('line', line => this.receive(line))
    this.lines.on('close', () => this.close())
  }

  async hello(): Promise<Hello | null> {
    if (this.helloValue !== null || this.closed) return this.helloValue
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.onHello = null
        resolve(null)
      }, INITIAL_FRAME_TIMEOUT_MS)
      this.onHello = value => {
        clearTimeout(timer)
        resolve(value)
      }
    })
  }

  private receive(line: string): void {
    if (line.length > 256 * 1024 || this.closed) return
    let frame: Partial<Inbound>
    try { frame = JSON.parse(line) as Partial<Inbound> } catch { return }
    if (frame.type === 'hello' && this.helloValue === null &&
      typeof frame.session_id === 'string' && typeof frame.cwd === 'string' &&
      typeof frame.pid === 'number') {
      this.helloValue = frame as Hello
      this.onHello?.(this.helloValue)
      this.onHello = null
      return
    }
    if (this.helloValue === null) return
    if (frame.type === 'state' && typeof frame.session_id === 'string' &&
      (frame.activity === 'idle' || frame.activity === 'working')) {
      this.currentSession = frame.session_id
      this.activity = frame.activity
      this.stateAt = this.now()
    } else if (frame.type === 'end' && frame.session_id === this.helloValue.session_id) {
      this.ended = true
      this.currentSession = null
      for (const settle of this.pending.values()) settle(null)
      this.pending.clear()
    } else if (frame.type === 'result' && typeof frame.id === 'number' &&
      typeof frame.accepted === 'boolean') {
      this.pending.get(frame.id)?.(frame as Result)
      this.pending.delete(frame.id)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.onHello?.(null)
    this.onHello = null
    for (const settle of this.pending.values()) settle(null)
    this.pending.clear()
    this.lines.close()
    this.input.destroy()
  }

  probe(sessionId: string): HarnessProbe {
    if (this.ended) return { state: 'ended', reason: 'session-end-hook' }
    if (this.closed || process.ppid !== this.helloValue?.pid) return { state: 'ended', reason: 'harness-gone' }
    if (this.currentSession !== null && this.currentSession !== sessionId) {
      return { state: 'ended', reason: 'session-replaced' }
    }
    if (this.currentSession !== sessionId || this.now() - this.stateAt > STATE_MAX_AGE_MS) {
      return { state: 'uncertain', reason: 'plugin-writer-unconfirmed' }
    }
    return { state: 'running', activity: this.activity }
  }

  async write(sessionId: string, text: string, begin: () => boolean, guard: WriteGuard): Promise<SessionWriteResult> {
    if (this.probe(sessionId).state !== 'running') return { status: 'unavailable', reason: 'Hermes plugin writer is not current' }
    if (!begin()) return { status: 'cancelled' }
    if (!guard.writable()) return { status: 'aborted', reason: 'claim or lease lapsed before Hermes injection' }
    const budget = Math.floor(Math.min(5_000, guard.remainingMs()))
    if (!Number.isFinite(budget) || budget <= 0) {
      return { status: 'aborted', reason: 'claim or lease lapsed before Hermes injection' }
    }
    const id = ++this.nextId
    const result = new Promise<Result | null>(resolve => this.pending.set(id, resolve))
    try {
      // The plugin checks this again immediately before calling inject_message.
      // A queued pipe write must not outlive the delivery claim.
      this.output.write(`${JSON.stringify({ type: 'write', id, session_id: sessionId, text,
        deadline_ms: Date.now() + budget })}\n`)
    } catch (error) {
      this.pending.delete(id)
      return { status: 'failed', reason: 'Hermes writer pipe failed', error }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const reply = await Promise.race([
      result,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), budget) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    this.pending.delete(id)
    if (reply === null) return { status: 'failed', reason: 'Hermes injection was not confirmed', error: new Error('writer response missing') }
    if (!reply.accepted) return { status: 'aborted', reason: reply.reason ?? 'Hermes rejected the exact session' }
    return { status: 'written', route: 'session-queue' }
  }
}

/** The only Hermes answer route: the plugin's attached classic CLI instance. */
export function hermesAnswerRoute(bridge: HermesWriterBridge, sessionId: string): EscalationDeliveryRoute {
  return {
    kind: 'session-queue',
    deliver: async event => {
      if (event.writeGuard === undefined) return { acknowledgement: 'held', notes: [] }
      const result = await bridge.write(sessionId, event.context, () => event.commitDelivery(), event.writeGuard)
      if (result.status === 'written') return {
        acknowledgement: 'delivered', notes: [],
        log: { route: 'session-queue', stage: 'plugin-injection' },
      }
      return {
        acknowledgement: 'held', notes: [],
        log: { reason: result.status === 'failed' ? 'write-unconfirmed' : result.status === 'aborted' ? 'write-aborted' : result.status },
      }
    },
  }
}

function hermesGates(deps: CommandDeps, cwd: string, sessionId: string): GateResult {
  if (nativeUninstallPending(deps.env)) return { ok: false, reason: 'uninstall-in-progress' }
  try {
    const config = loadConfig({ cwd, env: deps.env, sessionId })
    if (!projectEnabled(projectBinding(cwd, deps.env, config.project.value))) {
      return { ok: false, reason: 'project-disabled' }
    }
  } catch {
    return { ok: false, reason: 'enablement-unavailable' }
  }
  if (!hermesPluginCurrent(deps.hookAdapterHome, deps.env)) {
    return { ok: false, reason: 'hermes-plugin-removed-or-replaced' }
  }
  return { ok: true }
}

export async function hermesAttendCommand(deps: CommandDeps, input: Readable, output: Writable): Promise<number> {
  const bridge = new HermesWriterBridge(input, output)
  const hello = await bridge.hello()
  if (hello === null || hello.pid !== process.ppid ||
    hello.session_id === '' || hello.session_id !== deps.env['HERMES_SESSION_ID'] ||
    !path.isAbsolute(hello.cwd) || !existsSync(hello.cwd)) {
    bridge.close()
    return 0
  }

  const { session_id: sessionId, cwd } = hello
  const gate = () => hermesGates(deps, cwd, sessionId)
  if (!gate().ok) {
    bridge.close()
    return 0
  }
  const start = processStartTime(hello.pid)
  const writer = currentProcessIdentity()
  if (start === null || writer === null) {
    bridge.close()
    return 0
  }
  const logger: Logger = log(deps)
  logger.bind({ cmd: 'hook hermes-attend', session: sessionId })
  const claimFile = attendantClaimPath(sessionId, deps.env)
  const record = beginSessionIncarnation(sessionId, deps.env, {
    stamp: lifecycleStamp(), harnessProcess: { pid: hello.pid, start }, clearEarlierEnd: true,
  })
  let token = acquireClaimFile(claimFile, { incarnation: record.incarnation }, Date.now())
  const claimDeadline = systemAttendantClock.monotonic() + 6_000
  while (token === null && systemAttendantClock.monotonic() < claimDeadline) {
    const holder = readClaimFile(claimFile)
    if (holder?.['incarnation'] === record.incarnation && claimHolderMayRun(holder)) break
    await systemAttendantClock.sleep(250, new AbortController().signal)
    token = acquireClaimFile(claimFile, { incarnation: record.incarnation }, Date.now())
  }
  if (token === null) {
    bridge.close()
    return 0
  }
  let client: ApiClient | null | undefined
  let serviceIdentity: HookContext['service_identity']
  const connect = (): ApiClient | null => {
    if (client !== undefined) return client
    const credential = deps.store.load()
    if (credential !== null) serviceIdentity = { base_url: credential.baseUrl, machine_id: credential.machineId }
    client = credential
      ? makeClient(deps, credential.baseUrl, `Bearer nfm_${credential.machineId}.${credential.secret}`)
      : null
    return client
  }
  let observer: Promise<void> | null = null
  const observeQuestions = (): void => {
    const probe = bridge.probe(sessionId)
    if (observer !== null || probe.state !== 'running' || probe.activity !== 'idle') return
    const state = readSessionState(sessionId, deps.env)
    if (state.harness !== 'hermes' ||
        ((state.pending?.length ?? 0) === 0 && state.accepted === undefined)) return
    const api = connect()
    if (api === null) return
    const now = deps.now ?? Date.now
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
    const ctx: HookContext = {
      client: api, config: loadConfig({ cwd, env: deps.env, sessionId }), env: deps.env,
      ...(serviceIdentity === undefined ? {} : { service_identity: serviceIdentity }),
      now, sleep, harness: 'hermes', log: logger,
      waitForFirstReply: async (requestId, timeoutSeconds) => {
        const result = await waitForReply(api, requestId, { timeoutSeconds, afterSeq: 0, now, sleep })
        return { replies: result.response.replies, timedOut: result.timedOut, degraded: result.degraded }
      },
      answerClaims: {
        lease: () => readAttendantLease(sessionId, deps.env), writer,
        monotonic: () => systemAttendantClock.monotonic(),
      },
    }
    observer = runEscalationWaiter(ctx, {
      sessionId, envelope: { session_id: sessionId, cwd },
      route: hermesAnswerRoute(bridge, sessionId), recordStop: false,
    }).then(() => undefined).catch(err => {
      logger.error('hook.end', { hook: 'hermes-question', outcome: 'failed', reason: String(err) })
    }).finally(() => { observer = null })
  }
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
      probe: () => bridge.probe(sessionId),
      claimHeld: () => token !== null && readClaimFile(claimFile)?.['token'] === token,
      notified: () => sessionNotified(sessionId, deps.env),
      gates: gate,
      client: connect,
      serverSupportsAttendance: async api =>
        (await api.compatibility()).server_capabilities.includes('session_attendance'),
      acceptsMessages: true,
      publishProbeStatus: true,
      onProbe: probe => { if (probe.state === 'running' && probe.activity === 'idle') observeQuestions() },
      onMessages: (messages: AttendanceMessage[], attendant: AttendantHandle) => {
        const api = connect()
        if (api === null) return Promise.resolve('done')
        return handOffSessionMessages(messages, attendant, {
          sequencer: {
            sessionId, env: deps.env, client: api,
            monotonic: () => systemAttendantClock.monotonic(),
            wall: () => systemAttendantClock.wall(),
            sleep: ms => systemAttendantClock.sleep(ms, new AbortController().signal),
            writer, log: logger,
          },
          write: (text, begin, guard) => bridge.write(sessionId, text, begin, guard),
        })
      },
      clock: systemAttendantClock,
      logger,
      writeStatus: status => writeAttendantStatus(sessionId, deps.env, status),
      heartbeat: () => refreshSessionMarkers(sessionId, deps.env, Date.now(), [claimFile, attendantStatusPath(sessionId, deps.env)]),
    })
  } finally {
    bridge.close()
    handleSessionEnd(deps.env, { session_id: sessionId, cwd }, Date.now(), false)
    await observer
    if (token !== null) releaseClaimFile(claimFile, token)
  }
  return 0
}
