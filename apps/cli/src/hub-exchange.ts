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
import { ApiCallError, DEFAULT_TIMEOUT_MS, type ApiClient } from './client.js'
import { HUB_MESSAGE_RETRY_MS, HUB_UNKNOWN_SESSION_RETRY_MS, type LeaseOutcome, type SessionLease } from './hub-lease.js'
import type { Logger } from './logging.js'

/** A wall-clock move this far from the monotonic clock means sleep or a clock jump. */
export const HUB_CLOCK_JUMP_MS = 5_000
const MAX_NETWORK_BACKOFF_MS = 30_000
/** Above this many exchanges in one second the driver pauses (the service budget is 600 a minute). */
const MAX_EXCHANGES_PER_SECOND = 8
/** How often an unsupported service is asked again. */
const UNSUPPORTED_RECHECK_MS = 30 * 60_000
/** How long a session whose entry the service refused on its own sits out before it is offered again. */
export const REFUSED_ENTRY_RETRY_MS = 10 * 60_000
/** An idle loop looks again at least this often, so a healthy loop always shows progress. */
export const HUB_IDLE_RECHECK_MS = 30_000
/** A service call the transport did not end by its own deadline is abandoned this much later. */
const HARD_TIMEOUT_GRACE_MS = 5_000

/** A service call that outlived its own deadline (a transport that ignored its timeout). */
class ExchangeTimeoutError extends Error {}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type Kind = 'final' | 'running' | 'stopped'
interface Chosen { session: AttendedSession; entry: AttendanceBatchEntryT; kind: Kind }

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
  /** The exchange loop moved on (the hub's heartbeat). */
  progressed?(): void
}

type Mode = 'unknown' | 'batch' | 'per-session' | 'unsupported'

/** The service refused the request itself: resending it unchanged gets the same answer. */
function refusal(err: unknown): err is ApiCallError {
  return err instanceof ApiCallError && (err.status === 400 || err.status === 422)
}

export class ExchangeDriver {
  private mode: Mode = 'unknown'
  private cursor: string | undefined
  private epoch = 0
  private lastWall: number
  private lastMono: number
  /** Every exchange in flight; a change cuts each one short. */
  private readonly inFlight = new Set<AbortController>()
  /** Held long-polls only: a poke cuts these, never an exchange that is already answering. */
  private readonly held = new Set<AbortController>()
  private readonly wakers = new Set<() => void>()
  private readonly stopping = new AbortController()
  private readonly perSession = new Map<string, Promise<void>>()
  /** Grows with each failed exchange; only a successful attendance exchange resets it. */
  private backoff = 1_000
  private unsupportedUntil = 0
  /** After a refused batch: these sessions go one per exchange, so one bad entry cannot hold up the rest. */
  private readonly isolating = new Set<AttendedSession>()
  /** Sessions whose entry the service refused on its own, and when they may be offered again. */
  private readonly setAside = new Map<AttendedSession, number>()
  /** What the service said it offers at the last discovery. */
  private capabilities: ReadonlySet<string> = new Set()
  /** Requests sent, for status (and the W1-R counts). */
  requests = 0
  lastSuccessAt: number | null = null
  /** Which loop is current: a restarted loop's predecessor stops at its next step. */
  private loop = 0
  /** Monotonic time the current loop last moved on; every step it waits on is bounded. */
  private progressAt: number

  constructor(private readonly host: ExchangeHost) {
    this.lastWall = host.clock.wall()
    this.lastMono = host.clock.monotonic()
    this.progressAt = this.lastMono
  }

  /** How long the current loop has gone without moving on. */
  stalledFor(now = this.host.clock.monotonic()): number {
    return Math.max(0, now - this.progressAt)
  }

  private progress(): void {
    this.progressAt = this.host.clock.monotonic()
    this.host.progressed?.()
  }

  get currentEpoch(): number {
    return this.epoch
  }

  get transport(): Mode {
    return this.mode
  }

  /** Whether the service, as last discovered, offers `capability`; false before discovery. */
  offers(capability: string): boolean {
    return (this.mode === 'batch' || this.mode === 'per-session') && this.capabilities.has(capability)
  }

  /** A stopped session is reported, and kept in the exchange, only where the service holds it. */
  private stoppedEntry(session: AttendedSession): AttendanceBatchEntryT | null {
    return this.offers('session_stopped_hold') ? session.lease.stoppedEntry(session.id) : null
  }

  /**
   * Something an exchange waits on changed (a session joined, ended, changed
   * activity, or has local input): cut a held exchange and look again.
   */
  poke(): void {
    for (const exchange of this.held) exchange.abort()
    const waiting = [...this.wakers]
    this.wakers.clear()
    for (const resolve of waiting) resolve()
  }

  /** The credential changed: forget the transport choice and every cursor. */
  reset(): void {
    this.mode = 'unknown'
    this.capabilities = new Set()
    this.cursor = undefined
    // What one service refused says nothing about another credential's.
    this.isolating.clear()
    this.setAside.clear()
    // A credential change ends every exchange, held or not.
    for (const exchange of this.inFlight) exchange.abort()
    this.poke()
  }

  stop(): void {
    this.stopping.abort()
    for (const exchange of this.inFlight) exchange.abort()
    this.poke()
  }

  /**
   * Start a fresh loop in place of one that stopped moving: whatever the old
   * one waits on is cut, and it stops at its next step without applying
   * anything. Sessions, leases and cursor carry over.
   */
  restart(): Promise<void> {
    for (const exchange of this.inFlight) exchange.abort()
    this.inFlight.clear()
    this.held.clear()
    this.poke()
    return this.run()
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

  /**
   * The exchange loop. It never ends on an error: a step that throws (a
   * full disk under a session's bookkeeping, a transport bug) is logged and
   * the loop goes on after a backoff. Only `stop` or a `restart` ends it.
   */
  run(): Promise<void> {
    const loop = ++this.loop
    this.progress()
    return this.runLoop(loop)
  }

  private current(loop: number): boolean {
    return loop === this.loop && !this.stopping.signal.aborted
  }

  private async runLoop(loop: number): Promise<void> {
    while (this.current(loop)) {
      this.progress()
      try {
        await this.step(loop)
      } catch (err) {
        if (!this.current(loop)) break
        this.host.logger.error('hub.exchange', { event: 'step-failed', message: message(err) })
        await this.pause(this.backoff)
        this.backoff = Math.min(this.backoff * 2, MAX_NETWORK_BACKOFF_MS)
      }
    }
    if (loop === this.loop) await Promise.allSettled([...this.perSession.values()])
  }

  private async step(loop: number): Promise<void> {
    // Yield to I/O between exchanges: a service answering at once must
    // never starve the children's IPC; past the budget, slow down.
    await new Promise<void>((resolve) => setImmediate(resolve))
    await this.pace()
    this.checkClock()
    const client = this.host.client()
    if (client === null) {
      await this.nextChange()
      return
    }
    const now = this.host.clock.monotonic()
    if (this.mode === 'unsupported' && now < this.unsupportedUntil) {
      await this.nextChange(this.unsupportedUntil - now)
      return
    }
    if (this.mode === 'unknown' || this.mode === 'unsupported') {
      if (!this.work(now).some(Boolean)) { await this.nextChange(); return }
      await this.discover(client)
      return
    }
    if (this.mode === 'per-session') {
      this.superviseSessions(client)
      await this.nextChange(5_000)
      return
    }
    await this.batchOnce(client, loop)
  }

  /** A service call bounded even when the transport ignores its own deadline. */
  private bounded<T>(call: Promise<T>, waitSeconds: number): Promise<T> {
    const limitMs = waitSeconds * 1_000 + DEFAULT_TIMEOUT_MS + HARD_TIMEOUT_GRACE_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ExchangeTimeoutError(`the service call did not settle within ${limitMs} ms`)), limitMs)
    })
    return Promise.race([call, deadline]).finally(() => clearTimeout(timer))
  }

  /** One session's own step, so a failure in its bookkeeping holds up no other session. */
  private guarded<T>(session: AttendedSession, what: string, fn: () => T): T | undefined {
    try {
      return fn()
    } catch (err) {
      this.host.logger.error('hub.exchange', { event: 'session-step-failed', session: session.id, step: what, message: message(err) })
      return undefined
    }
  }

  /** Whether there is anything to send: [final reports, runnable sessions, stopped sessions the service might hold]. */
  private work(now: number): [boolean, boolean, boolean] {
    const sessions = this.host.sessions()
    return [sessions.some((s) => s.lease.finalEntry(s.id) !== null), sessions.some((s) => s.runnable(now)),
      sessions.some((s) => s.lease.stoppedEntry(s.id) !== null)]
  }

  private async discover(client: ApiClient): Promise<void> {
    try {
      const capabilities = (await this.bounded(client.compatibility(), 0)).server_capabilities as readonly string[]
      // Discovery alone never resets the backoff: a service that keeps refusing
      // the exchange after a successful discovery must still slow the hub down.
      this.capabilities = new Set(capabilities)
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
    // No plan is not a refused credential: the machine stays paired, and the
    // exchange resumes by itself once the plan is active. It backs off instead.
    if (err instanceof ApiCallError && err.code === 'no_active_plan') return false
    if (err instanceof ApiCallError && (err.status === 401 || err.status === 403)) {
      this.host.unauthorized()
      return true
    }
    return false
  }

  private async batchOnce(client: ApiClient, loop: number): Promise<void> {
    const now = this.host.clock.monotonic()
    const sessions = this.host.sessions()
    for (const [session, until] of this.setAside) if (until <= now || !sessions.includes(session)) this.setAside.delete(session)
    const finals: Chosen[] = []
    const running: Chosen[] = []
    const stopped: Chosen[] = []
    for (const session of sessions) {
      if (this.setAside.has(session)) continue
      this.guarded(session, 'select', () => {
        const final = session.lease.finalEntry(session.id, this.offers('session_confirmed_end'))
        const stop = final === null ? this.stoppedEntry(session) : null
        if (final !== null) finals.push({ session, entry: final, kind: 'final' })
        else if (stop !== null) { if (now >= session.lease.pausedUntil) stopped.push({ session, entry: stop, kind: 'stopped' }) }
        else if (session.runnable(now)) {
          running.push({ session, entry: session.lease.runningEntry(session.id, session.activity(), session.acceptsMessages()), kind: 'running' })
        }
      })
    }
    // One entry per Agent Session: finals first, so an earlier incarnation's
    // end goes before a later incarnation of the same session, which waits for
    // the next exchange.
    const ids = new Set<string>()
    const candidates: Chosen[] = []
    for (const item of [...finals, ...running, ...stopped]) {
      if (ids.has(item.session.id)) continue
      ids.add(item.session.id)
      candidates.push(item)
    }
    const deferred = candidates.length < finals.length + running.length + stopped.length
    for (const session of this.isolating) if (!candidates.some((item) => item.session === session)) this.isolating.delete(session)
    const isolated = candidates.find((item) => this.isolating.has(item.session))
    if (candidates.length === 0) {
      const next = Math.min(...sessions.map((s) => s.lease.pausedUntil).filter((at) => at > now), ...this.setAside.values())
      await this.nextChange(Number.isFinite(next) ? next - now : undefined)
      return
    }
    if (isolated !== undefined) this.isolating.delete(isolated.session)
    const chosen = isolated !== undefined ? [isolated] : candidates.slice(0, ATTENDANCE_BATCH_MAX_SESSIONS)
    // A session held as stopped stays in the exchange only to see notes sent
    // to it; once the service holds it, it never cuts a held exchange short.
    const hold = this.cursor !== undefined && isolated === undefined && !deferred &&
      chosen.every(({ session, kind }) => kind !== 'final' && !session.lease.needsFresh && session.lease.messageRetries === 0) &&
      chosen.length === candidates.length
    const current = new AbortController()
    this.inFlight.add(current)
    if (hold) this.held.add(current)
    const sentAt = this.host.clock.monotonic()
    const sentEpoch = this.epoch
    const credential = this.host.credentialKey()
    this.counted()
    let response
    const waitSeconds = hold ? ATTENDANCE_MAX_WAIT_SECONDS : 0
    try {
      response = await this.bounded(client.attendBatch(
        { ...(this.cursor === undefined ? {} : { message_cursor: this.cursor }), sessions: chosen.map(({ entry }) => entry) },
        { waitSeconds, signal: current.signal },
      ), waitSeconds)
    } catch (err) {
      this.inFlight.delete(current)
      this.held.delete(current)
      const timedOut = err instanceof ExchangeTimeoutError
      if (timedOut) current.abort()
      if (!this.current(loop) || (!timedOut && current.signal.aborted)) return
      if (this.isUnauthorized(err)) return
      if (err instanceof ApiCallError && (err.status === 404 || (err.status === 409 && err.code === 'feature_unavailable'))) {
        // The service lost the batch route (rollback, or a capability list that
        // ran ahead of the route): today's per-session exchange still works.
        this.host.logger.info('hub.exchange', { event: 'transport', mode: 'per-session', reason: `batch-${err.status}` })
        this.mode = 'per-session'
        return
      }
      if (refusal(err)) {
        this.refusedBatch(err, chosen)
        this.refusedShape(err, chosen.filter(({ kind }) => kind !== 'running').map(({ entry }) => entry))
        await this.pause(this.backoff)
        this.backoff = Math.min(this.backoff * 2, MAX_NETWORK_BACKOFF_MS)
        return
      }
      this.host.logger.info('hub.exchange', { event: 'failed', message: message(err) })
      await this.pause(this.backoff)
      this.backoff = Math.min(this.backoff * 2, MAX_NETWORK_BACKOFF_MS)
      return
    }
    this.inFlight.delete(current)
    this.held.delete(current)
    // A restarted loop took over meanwhile: it sends again; this answer is not applied twice.
    if (!this.current(loop)) return
    this.progress()
    this.backoff = 1_000
    this.lastSuccessAt = this.host.clock.wall()
    // An exchange that carried one isolated session says nothing for the
    // others: the next full batch answers at once instead of holding on it.
    if (isolated === undefined) this.cursor = response.message_cursor
    const byId = new Map(response.sessions.map((result) => [result.session_id, result]))
    await Promise.all(chosen.map(async ({ session, kind }) => {
      const result = byId.get(session.id)
      if (result === undefined) return
      try {
        await this.applyResult(session, result, sentAt, sentEpoch, credential, kind === 'final', kind === 'stopped')
      } catch (err) {
        // Nothing is handed in for it this time; the next exchange asks again.
        this.host.logger.error('hub.exchange', { event: 'session-step-failed', session: session.id, step: 'apply', message: message(err) })
      }
    }))
  }

  /**
   * The service refused the whole exchange (400/422). The same body is never
   * sent again: a batch is split into one exchange per session, and a
   * session refused on its own sits out for a while, so the others go on.
   */
  private refusedBatch(err: ApiCallError, chosen: readonly Chosen[]): void {
    this.host.logger.info('hub.exchange', { event: 'refused', status: err.status, code: err.code, message: err.message,
      sessions: chosen.length })
    // The cursor is the one part of the body every split exchange would share.
    this.cursor = undefined
    if (chosen.length > 1) {
      for (const { session } of chosen) this.isolating.add(session)
      return
    }
    for (const { session } of chosen) {
      this.setAside.set(session, this.host.clock.monotonic() + REFUSED_ENTRY_RETRY_MS)
      this.host.logger.info('hub.exchange', { event: 'set-aside', session: session.id, retry_in_ms: REFUSED_ENTRY_RETRY_MS })
    }
  }

  /**
   * The service refused the request's shape while it carried a `stopped`
   * entry or a continued end (a service rolled back past them): ask it again
   * what it offers, so nothing it no longer knows is sent again.
   */
  private refusedShape(err: unknown, entries: readonly AttendanceBatchEntryT[]): boolean {
    if (!refusal(err)) return false
    if (!entries.some((entry) => entry.state === 'stopped' || ('end_reason' in entry && entry.end_reason !== undefined))) return false
    this.host.logger.info('hub.exchange', { event: 'transport', mode: 'unknown', reason: `refused-${err.status}` })
    this.mode = 'unknown'
    this.capabilities = new Set()
    for (const session of this.host.sessions()) session.lease.successor = null
    return true
  }

  private async applyResult(
    session: AttendedSession,
    result: AttendanceResponse | AttendanceBatchResult,
    sentAt: number,
    sentEpoch: number,
    credential: string | null,
    sentFinal: boolean,
    sentStopped = false,
  ): Promise<void> {
    const outcome = session.lease.apply(result, sentAt, sentEpoch, this.epoch, credential, sentFinal, sentStopped)
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
      // A loop that fails ends alone; the next supervision starts it again.
      const task = this.perSessionLoop(client, session)
        .catch((err: unknown) => this.host.logger.error('hub.exchange', { event: 'session-step-failed', session: session.id, step: 'per-session',
          message: message(err) }))
        .finally(() => this.perSession.delete(session.id))
      this.perSession.set(session.id, task)
    }
  }

  private async perSessionLoop(client: ApiClient, session: AttendedSession): Promise<void> {
    let backoff = 1_000
    while (!this.stopping.signal.aborted && this.mode === 'per-session' && this.host.client() === client &&
      this.host.sessions().includes(session)) {
      const now = this.host.clock.monotonic()
      const final = session.lease.finalEntry(session.id, this.offers('session_confirmed_end'))
      const stop = final === null && now >= session.lease.pausedUntil ? this.stoppedEntry(session) : null
      if (final === null && stop === null && !session.runnable(now)) {
        await this.nextChange(Math.max(1_000, session.lease.pausedUntil - now))
        continue
      }
      const entry = final ?? stop ?? session.lease.runningEntry(session.id, session.activity(), session.acceptsMessages())
      const rest: Record<string, unknown> = { ...entry }
      delete rest['session_id']
      const body = ((entry.state === 'running' || entry.state === 'stopped') && session.lease.cursor !== undefined
        ? { ...rest, message_cursor: session.lease.cursor } : rest) as AttendanceRequestT
      const hold = final === null && session.lease.cursor !== undefined && !session.lease.needsFresh && session.lease.messageRetries === 0
      // Every loop shares the machine's exchange budget: take a slot first.
      for (let wait = this.reserveSlot(); wait > 0 && !this.stopping.signal.aborted; wait = this.reserveSlot()) await this.pause(wait)
      if (this.stopping.signal.aborted) return
      const current = new AbortController()
      this.inFlight.add(current)
      if (hold) this.held.add(current)
      const sentAt = this.host.clock.monotonic()
      const sentEpoch = this.epoch
      const credential = this.host.credentialKey()
      this.requests += 1
      try {
        const waitSeconds = hold ? ATTENDANCE_MAX_WAIT_SECONDS : 0
        const response = await this.bounded(client.attend(session.id, body, { waitSeconds, signal: current.signal }), waitSeconds)
        backoff = 1_000
        this.backoff = 1_000
        this.lastSuccessAt = this.host.clock.wall()
        await this.applyResult(session, response, sentAt, sentEpoch, credential, final !== null, stop !== null)
      } catch (err) {
        if (this.stopping.signal.aborted) return
        if (err instanceof ExchangeTimeoutError) current.abort()
        else if (current.signal.aborted) continue
        if (this.isUnauthorized(err)) return
        if (err instanceof ApiCallError && err.status === 404) {
          // A continued end whose successor the service does not know is a 404 here.
          const refusal = (err.details as { reason?: unknown } | undefined)?.reason === 'unknown_successor'
            ? 'unknown_successor' : 'unknown_session'
          await this.applyResult(session, { status: refusal } as AttendanceBatchResult, sentAt, sentEpoch, credential,
            final !== null && refusal === 'unknown_successor', false)
          continue
        }
        if (refusal(err)) {
          this.host.logger.info('hub.exchange', { event: 'refused', status: err.status, code: err.code, message: err.message, session: session.id })
          if (this.refusedShape(err, [entry])) {
            // Rediscovery starts a new loop: the driver's backoff carries over, so a refusal that recurs slows down.
            const wait = Math.max(backoff, this.backoff)
            this.backoff = Math.min(wait * 2, MAX_NETWORK_BACKOFF_MS)
            await this.pause(wait)
            return
          }
        }
        await this.pause(backoff)
        backoff = Math.min(backoff * 2, MAX_NETWORK_BACKOFF_MS)
      } finally {
        this.inFlight.delete(current)
        this.held.delete(current)
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

  /** Wait for a poke, never longer than `timeoutMs` or `HUB_IDLE_RECHECK_MS`. */
  private async nextChange(requestedMs?: number): Promise<void> {
    if (this.stopping.signal.aborted) return
    const timeoutMs = Math.min(requestedMs ?? HUB_IDLE_RECHECK_MS, HUB_IDLE_RECHECK_MS)
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.wakers.delete(done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, timeoutMs))
      this.wakers.add(done)
    })
  }

  private async pause(ms: number): Promise<void> {
    await this.host.sleep(ms, this.stopping.signal).catch(() => undefined)
  }
}
