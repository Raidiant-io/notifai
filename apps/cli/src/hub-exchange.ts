/**
 * The hub's service traffic: one batched long-poll for every attended Agent
 * Session, or, against a service without `session_attendance_batch`, one
 * per-session exchange per session (today's route, N connections).
 *
 * The driver owns transport and timing only; each session's lease rules live
 * in `SessionLease`, and the hub decides which sessions are eligible.
 */
import {
  ATTENDANCE_BATCH_MAX_SESSIONS,
  ATTENDANCE_MAX_WAIT_SECONDS,
  type AttendanceBatchEntryT,
  type AttendanceBatchResult,
  type AttendanceMessage,
  type AttendanceRequestT,
  type AttendanceResponse,
  type SessionActivity,
} from '@raidiant/notifai-protocol'
import { ApiCallError, type ApiClient } from './client.js'
import { HUB_MESSAGE_RETRY_MS, HUB_UNKNOWN_SESSION_RETRY_MS, type LeaseOutcome, type SessionLease } from './hub-lease.js'
import type { Logger } from './logging.js'

/** A wall-clock move this far from the monotonic clock means sleep or a clock jump. */
export const HUB_CLOCK_JUMP_MS = 5_000
const MAX_NETWORK_BACKOFF_MS = 30_000
/** Above this many exchanges in one second the driver pauses (the service budget is 600 a minute). */
const MAX_EXCHANGES_PER_SECOND = 8
/** How often an unsupported service is asked again. */
const UNSUPPORTED_RECHECK_MS = 30 * 60_000

export interface HubClock {
  monotonic(): number
  wall(): number
}

/** What the driver needs from one attended session. */
export interface AttendedSession {
  readonly id: string
  readonly lease: SessionLease
  /** Ready for a `running` exchange now: notified, fresh evidence running, not paused. */
  runnable(now: number): boolean
  activity(): SessionActivity
  acceptsMessages(): boolean
  /** Hands Session Messages in after an `attending` result. */
  attended(messages: AttendanceMessage[], acquired: boolean): Promise<'done' | 'retry-soon'>
  /** Any other lease outcome, for status and cleanup. */
  settled(outcome: LeaseOutcome): void
}

export interface ExchangeHost {
  sessions(): AttendedSession[]
  /** Authenticated client, stable until the credential changes; null when unpaired or signed out. */
  client(): ApiClient | null
  credentialKey(): string | null
  /** A 401 or 403: the credential is gone or revoked. */
  unauthorized(): void
  clock: HubClock
  logger: Logger
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

type Mode = 'unknown' | 'batch' | 'per-session' | 'unsupported'

export class ExchangeDriver {
  private mode: Mode = 'unknown'
  private cursor: string | undefined
  private epoch = 0
  private lastWall: number
  private lastMono: number
  /** Every exchange in flight; a change cuts each one short. */
  private readonly inFlight = new Set<AbortController>()
  private readonly wakers = new Set<() => void>()
  private readonly stopping = new AbortController()
  private readonly perSession = new Map<string, Promise<void>>()
  private backoff = 1_000
  private unsupportedUntil = 0
  /** Requests sent, for status (and the W1-R counts). */
  requests = 0
  lastSuccessAt: number | null = null

  constructor(private readonly host: ExchangeHost) {
    this.lastWall = host.clock.wall()
    this.lastMono = host.clock.monotonic()
  }

  get currentEpoch(): number {
    return this.epoch
  }

  get transport(): Mode {
    return this.mode
  }

  /**
   * Something an exchange waits on changed (a session joined, ended, changed
   * activity, or has local input): cut a held exchange and look again.
   */
  poke(): void {
    for (const exchange of this.inFlight) exchange.abort()
    const waiting = [...this.wakers]
    this.wakers.clear()
    for (const resolve of waiting) resolve()
  }

  /** The credential changed: forget the transport choice and every cursor. */
  reset(): void {
    this.mode = 'unknown'
    this.cursor = undefined
    this.poke()
  }

  stop(): void {
    this.stopping.abort()
    this.poke()
  }

  get stopped(): boolean {
    return this.stopping.signal.aborted
  }

  /** Sleep or a clock step voids every grant; nothing is written until a fresh exchange. */
  checkClock(): boolean {
    const wall = this.host.clock.wall()
    const mono = this.host.clock.monotonic()
    const jump = Math.abs(wall - this.lastWall - (mono - this.lastMono))
    this.lastWall = wall
    this.lastMono = mono
    if (jump <= HUB_CLOCK_JUMP_MS) return false
    this.epoch += 1
    this.cursor = undefined
    for (const session of this.host.sessions()) {
      session.lease.lose()
      session.lease.needsFresh = true
    }
    this.host.logger.info('hub.exchange', { event: 'clock-jump', epoch: this.epoch })
    for (const exchange of this.inFlight) exchange.abort()
    return true
  }

  async run(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      // Yield to I/O between exchanges: a service answering at once must
      // never starve the children's IPC; past the budget, slow down.
      await new Promise<void>((resolve) => setImmediate(resolve))
      await this.pace()
      this.checkClock()
      const client = this.host.client()
      if (client === null) {
        await this.nextChange()
        continue
      }
      const now = this.host.clock.monotonic()
      if (this.mode === 'unsupported' && now < this.unsupportedUntil) {
        await this.nextChange(this.unsupportedUntil - now)
        continue
      }
      if (this.mode === 'unknown' || this.mode === 'unsupported') {
        if (!this.work(now).some(Boolean)) { await this.nextChange(); continue }
        await this.discover(client)
        continue
      }
      if (this.mode === 'per-session') {
        this.superviseSessions(client)
        await this.nextChange(5_000)
        continue
      }
      await this.batchOnce(client)
    }
    await Promise.allSettled([...this.perSession.values()])
  }

  /** Whether there is anything to send: [final reports, runnable sessions]. */
  private work(now: number): [boolean, boolean] {
    const sessions = this.host.sessions()
    return [sessions.some((s) => s.lease.finalEntry(s.id) !== null), sessions.some((s) => s.runnable(now))]
  }

  private async discover(client: ApiClient): Promise<void> {
    try {
      const capabilities = (await client.compatibility()).server_capabilities as readonly string[]
      this.backoff = 1_000
      if (capabilities.includes('session_attendance_batch')) this.mode = 'batch'
      else if (capabilities.includes('session_attendance')) this.mode = 'per-session'
      else {
        this.mode = 'unsupported'
        this.unsupportedUntil = this.host.clock.monotonic() + UNSUPPORTED_RECHECK_MS
        for (const session of this.host.sessions()) {
          if (session.lease.setPhase('unsupported', 'service-has-no-session-attendance')) session.settled({ kind: 'withdrawn' })
        }
      }
      this.host.logger.info('hub.exchange', { event: 'transport', mode: this.mode })
    } catch (err) {
      if (this.isUnauthorized(err)) return
      await this.pause(this.backoff)
      this.backoff = Math.min(this.backoff * 2, MAX_NETWORK_BACKOFF_MS)
    }
  }

  private isUnauthorized(err: unknown): boolean {
    if (err instanceof ApiCallError && (err.status === 401 || err.status === 403)) {
      this.host.unauthorized()
      return true
    }
    return false
  }

  private async batchOnce(client: ApiClient): Promise<void> {
    const now = this.host.clock.monotonic()
    const sessions = this.host.sessions()
    const finals: { session: AttendedSession; entry: AttendanceBatchEntryT }[] = []
    const running: { session: AttendedSession; entry: AttendanceBatchEntryT }[] = []
    for (const session of sessions) {
      const final = session.lease.finalEntry(session.id)
      if (final !== null) finals.push({ session, entry: final })
      else if (session.runnable(now)) {
        running.push({ session, entry: session.lease.runningEntry(session.id, session.activity(), session.acceptsMessages()) })
      }
    }
    if (finals.length === 0 && running.length === 0) {
      const next = Math.min(...sessions.map((s) => s.lease.pausedUntil).filter((at) => at > now))
      await this.nextChange(Number.isFinite(next) ? next - now : undefined)
      return
    }
    const chosen = [...finals, ...running].slice(0, ATTENDANCE_BATCH_MAX_SESSIONS)
    const hold = this.cursor !== undefined && finals.length === 0 &&
      running.every(({ session }) => !session.lease.needsFresh && session.lease.messageRetries === 0) &&
      chosen.length === finals.length + running.length
    const current = new AbortController()
    this.inFlight.add(current)
    const sentAt = this.host.clock.monotonic()
    const sentEpoch = this.epoch
    const credential = this.host.credentialKey()
    this.counted()
    let response
    try {
      response = await client.attendBatch(
        { ...(this.cursor === undefined ? {} : { message_cursor: this.cursor }), sessions: chosen.map(({ entry }) => entry) },
        { waitSeconds: hold ? ATTENDANCE_MAX_WAIT_SECONDS : 0, signal: current.signal },
      )
    } catch (err) {
      this.inFlight.delete(current)
      if (this.stopping.signal.aborted || current.signal.aborted) return
      if (this.isUnauthorized(err)) return
      if (err instanceof ApiCallError && (err.status === 404 || (err.status === 409 && err.code === 'feature_unavailable'))) {
        // The service lost the batch route (rollback, or a capability list that
        // ran ahead of the route): today's per-session exchange still works.
        this.host.logger.info('hub.exchange', { event: 'transport', mode: 'per-session', reason: `batch-${err.status}` })
        this.mode = 'per-session'
        return
      }
      this.host.logger.info('hub.exchange', { event: 'failed', message: err instanceof Error ? err.message : String(err) })
      await this.pause(this.backoff)
      this.backoff = Math.min(this.backoff * 2, MAX_NETWORK_BACKOFF_MS)
      return
    }
    this.inFlight.delete(current)
    this.backoff = 1_000
    this.lastSuccessAt = this.host.clock.wall()
    this.cursor = response.message_cursor
    const byId = new Map(response.sessions.map((result) => [result.session_id, result]))
    const finalIds = new Set(finals.map(({ session }) => session.id))
    await Promise.all(chosen.map(async ({ session }) => {
      const result = byId.get(session.id)
      if (result === undefined) return
      await this.applyResult(session, result, sentAt, sentEpoch, credential, finalIds.has(session.id))
    }))
  }

  private async applyResult(
    session: AttendedSession,
    result: AttendanceResponse | AttendanceBatchResult,
    sentAt: number,
    sentEpoch: number,
    credential: string | null,
    sentFinal: boolean,
  ): Promise<void> {
    const outcome = session.lease.apply(result, sentAt, sentEpoch, this.epoch, credential, sentFinal)
    if (outcome.kind === 'attending') {
      if (outcome.acquired) this.host.logger.info('hub.lease', { event: 'acquired', session: session.id, generation: session.lease.generation })
      let handed: 'done' | 'retry-soon' = 'done'
      try {
        handed = await session.attended(outcome.messages, outcome.acquired)
      } catch (err) {
        this.host.logger.error('hub.lease', { event: 'message-handoff-failed', session: session.id,
          message: err instanceof Error ? err.message : String(err) })
      }
      if (handed === 'retry-soon') {
        // Ask again without holding, backing off to the ordinary hold so a
        // message that keeps waiting cannot spin the hub.
        const pauseMs = HUB_MESSAGE_RETRY_MS * 2 ** Math.min(session.lease.messageRetries, 4)
        session.lease.messageRetries += 1
        session.lease.pausedUntil = this.host.clock.monotonic() + Math.min(pauseMs, ATTENDANCE_MAX_WAIT_SECONDS * 1_000)
      } else {
        session.lease.messageRetries = 0
      }
      return
    }
    if (outcome.kind === 'owned') session.lease.pausedUntil = this.host.clock.monotonic() + outcome.retryAfterMs
    if (outcome.kind === 'unknown-session') session.lease.pausedUntil = this.host.clock.monotonic() + HUB_UNKNOWN_SESSION_RETRY_MS
    if (outcome.kind === 'withdrawn') this.host.logger.info('hub.lease', { event: 'withdrawn', session: session.id })
    session.settled(outcome)
  }

  /** The fallback: today's per-session route, one exchange loop per session. */
  private superviseSessions(client: ApiClient): void {
    for (const session of this.host.sessions()) {
      if (this.perSession.has(session.id)) continue
      const task = this.perSessionLoop(client, session).finally(() => this.perSession.delete(session.id))
      this.perSession.set(session.id, task)
    }
  }

  private async perSessionLoop(client: ApiClient, session: AttendedSession): Promise<void> {
    let backoff = 1_000
    while (!this.stopping.signal.aborted && this.mode === 'per-session' && this.host.client() === client &&
      this.host.sessions().includes(session)) {
      const now = this.host.clock.monotonic()
      const final = session.lease.finalEntry(session.id)
      if (final === null && !session.runnable(now)) {
        await this.nextChange(Math.max(1_000, session.lease.pausedUntil - now))
        continue
      }
      const entry = final ?? session.lease.runningEntry(session.id, session.activity(), session.acceptsMessages())
      const rest: Record<string, unknown> = { ...entry }
      delete rest['session_id']
      const body = (entry.state === 'running' && session.lease.cursor !== undefined
        ? { ...rest, message_cursor: session.lease.cursor } : rest) as AttendanceRequestT
      const hold = final === null && session.lease.cursor !== undefined && !session.lease.needsFresh && session.lease.messageRetries === 0
      // Every loop shares the machine's exchange budget: take a slot first.
      for (let wait = this.reserveSlot(); wait > 0 && !this.stopping.signal.aborted; wait = this.reserveSlot()) await this.pause(wait)
      if (this.stopping.signal.aborted) return
      const current = new AbortController()
      this.inFlight.add(current)
      const sentAt = this.host.clock.monotonic()
      const sentEpoch = this.epoch
      const credential = this.host.credentialKey()
      this.requests += 1
      try {
        const response = await client.attend(session.id, body, { waitSeconds: hold ? ATTENDANCE_MAX_WAIT_SECONDS : 0, signal: current.signal })
        backoff = 1_000
        this.lastSuccessAt = this.host.clock.wall()
        await this.applyResult(session, response, sentAt, sentEpoch, credential, final !== null)
      } catch (err) {
        if (this.stopping.signal.aborted) return
        if (current.signal.aborted) continue
        if (this.isUnauthorized(err)) return
        if (err instanceof ApiCallError && err.status === 404) {
          await this.applyResult(session, { status: 'unknown_session' } as AttendanceBatchResult, sentAt, sentEpoch, credential, false)
          continue
        }
        await this.pause(backoff)
        backoff = Math.min(backoff * 2, MAX_NETWORK_BACKOFF_MS)
      } finally {
        this.inFlight.delete(current)
      }
    }
  }

  /** Exchanges started in the last second; the service allows about ten a second per machine. */
  private readonly recent: number[] = []

  private async pace(): Promise<void> {
    const now = this.host.clock.monotonic()
    while (this.recent.length > 0 && now - this.recent[0]! > 1_000) this.recent.shift()
    if (this.recent.length >= MAX_EXCHANGES_PER_SECOND) {
      this.host.logger.info('hub.exchange', { event: 'paced', exchanges_last_second: this.recent.length })
      await this.pause(1_000)
    }
  }

  /**
   * Take one exchange slot now (0), or say how long until one frees. Taken
   * synchronously, so concurrent per-session loops cannot all pass at once.
   */
  private reserveSlot(): number {
    const now = this.host.clock.monotonic()
    while (this.recent.length > 0 && now - this.recent[0]! > 1_000) this.recent.shift()
    if (this.recent.length < MAX_EXCHANGES_PER_SECOND) {
      this.recent.push(now)
      return 0
    }
    this.host.logger.info('hub.exchange', { event: 'paced', exchanges_last_second: this.recent.length })
    return Math.max(1, 1_001 - (now - this.recent[0]!))
  }

  private counted(): void {
    this.requests += 1
    this.recent.push(this.host.clock.monotonic())
  }

  private async nextChange(timeoutMs?: number): Promise<void> {
    if (this.stopping.signal.aborted) return
    await new Promise<void>((resolve) => {
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        this.wakers.delete(done)
        resolve()
      }
      const timer = timeoutMs === undefined ? undefined : setTimeout(done, Math.max(0, timeoutMs))
      this.wakers.add(done)
    })
  }

  private async pause(ms: number): Promise<void> {
    await this.host.sleep(ms, this.stopping.signal).catch(() => undefined)
  }
}
