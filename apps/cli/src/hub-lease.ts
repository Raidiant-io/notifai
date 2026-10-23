/**
 * One Agent Session's presence lease, as the hub holds it.
 *
 * The rules are the Session Attendant's (generation fencing, incarnation
 * rotation after a refused acquisition, lease deadlines measured on the
 * monotonic clock from when the exchange was sent, a clock discontinuity
 * voiding every grant), but nothing here talks to the network: the batched
 * driver and the per-session fallback both build entries from it and apply
 * results to it, so the two transports cannot disagree about a lease.
 */
import type {
  AttendanceBatchEntryT,
  AttendanceBatchResult,
  AttendanceMessage,
  AttendanceResponse,
  SessionActivity,
} from '@raidiant/notifai-protocol'

export type LeasePhase =
  /** Resident, no network: the session has not notified yet. */
  | 'dormant'
  /** The service does not offer Session Attendance. */
  | 'unsupported'
  | 'acquiring'
  | 'attending'
  /** Another incarnation holds the lease. */
  | 'waiting-for-lease'
  /** Local evidence is missing or ambiguous: no renewal, no writes. */
  | 'uncertain'
  /** The service refused this incarnation; nothing more is sent until re-armed. */
  | 'withdrawn'
  | 'exited'

/** Harness writes stop this long before the lease ends by the hub's own clock. */
export const HUB_WRITE_MARGIN_MS = 15_000
/** How long to wait before asking again about a session the service does not know yet. */
export const HUB_UNKNOWN_SESSION_RETRY_MS = 60_000
/** First pause before re-asking for a message that waits on something brief; doubles. */
export const HUB_MESSAGE_RETRY_MS = 2_000

export type LeaseOutcome =
  | { kind: 'attending'; acquired: boolean; messages: AttendanceMessage[] }
  | { kind: 'owned'; retryAfterMs: number }
  /** Refused while holding a generation: stop attending this incarnation. */
  | { kind: 'withdrawn' }
  /** Refused while acquiring: a fresh incarnation id may acquire once. */
  | { kind: 'rotated' }
  | { kind: 'unknown-session' }
  /** A final report was answered (whatever the answer, it is done). */
  | { kind: 'reported'; state: 'ended' | 'withdrawn'; successor: string | null }
  /** The service refused to continue this session under the named successor; a plain end is owed instead. */
  | { kind: 'successor-refused'; successor: string }
  /** The service holds this session as stopped; `messages` wait for it and cannot be claimed until it is back. */
  | { kind: 'stopped'; messages: AttendanceMessage[] }
  /** The service would not hold this session as stopped (another incarnation holds it, or none does). */
  | { kind: 'stop-refused' }

export class SessionLease {
  incarnation: string
  generation: number | null = null
  /** Monotonic time after which the lease may have lapsed at the service. */
  leaseEndsAt: number | null = null
  /** The hub clock epoch the lease was granted in. */
  private grantedEpoch = -1
  /** Per-session cursor, used only by the per-session fallback transport. */
  cursor: string | undefined
  phase: LeasePhase = 'dormant'
  reason: string | null = null
  /** The next exchange must answer at once rather than hold. */
  needsFresh = true
  /** Monotonic time before which this session sits out of exchanges. */
  pausedUntil = 0
  messageRetries = 0
  /** A final report still owed to the service. */
  final: 'ended' | 'withdrawn' | null = null
  /**
   * With `final: 'ended'`: the Agent Session this one continues as (a fork
   * that records it as its origin). Its questions, held answers and pending
   * notes move there instead of expiring. Set only against a service that
   * offers `session_stopped_hold`.
   */
  successor: string | null = null
  /**
   * The session stopped without the User closing it: against a service that
   * offers `session_stopped_hold` it is reported `stopped` and stays in the
   * exchange, so notes sent to it meanwhile are seen (and held by the service).
   */
  holdStopped = false
  /** The service answered `stopped` for this incarnation: it holds the session as stopped. */
  stopReported = false
  /**
   * It came back after a stop: a service that held it as stopped refuses
   * this incarnation's renewal, which then means "acquire afresh" (a new
   * incarnation), not "stop attending".
   */
  resumedFromStop = false
  /** Which credential the current lease was granted under. */
  credentialKey: string | null = null
  private rotated = false

  constructor(
    incarnation: string,
    /** Replace a refused incarnation id; null when the local record moved on. */
    private readonly rotate: (expected: string) => string | null,
  ) {
    this.incarnation = incarnation
  }

  setPhase(phase: LeasePhase, reason: string | null = null): boolean {
    if (phase === this.phase && reason === this.reason) return false
    this.phase = phase
    this.reason = reason
    return true
  }

  /** Drops the lease locally; the service keeps it until it lapses or is released. */
  lose(): void {
    this.leaseEndsAt = null
  }

  /** A `running` entry for the batch. */
  runningEntry(sessionId: string, activity: SessionActivity, acceptsMessages: boolean): AttendanceBatchEntryT {
    return {
      session_id: sessionId,
      incarnation: this.incarnation,
      ...(this.generation === null ? {} : { generation: this.generation }),
      state: 'running',
      activity,
      accepts_messages: acceptsMessages,
    }
  }

  /**
   * A `stopped` entry while the session is held as stopped, or null. Only the
   * holder may report it, so it needs the generation this incarnation held.
   */
  stoppedEntry(sessionId: string): AttendanceBatchEntryT | null {
    if (!this.holdStopped || this.final !== null || this.generation === null) return null
    return { session_id: sessionId, incarnation: this.incarnation, generation: this.generation, state: 'stopped' }
  }

  /**
   * The owed final report, or null when there is nothing safe to report: an
   * `ended` is always worth sending (the service fences it), a withdrawal only
   * from a generation this hub held.
   */
  confirmedEnd = false

  finalEntry(sessionId: string, confirmedEnd = false): AttendanceBatchEntryT | null {
    if (this.final === null) return null
    if (this.final === 'withdrawn' && this.generation === null) return null
    return {
      session_id: sessionId,
      incarnation: this.incarnation,
      ...(this.generation === null ? {} : { generation: this.generation }),
      state: this.final,
      ...(this.final === 'ended' && this.successor !== null ? { end_reason: 'continued' as const, successor_session_id: this.successor }
        : this.final === 'ended' && confirmedEnd && this.confirmedEnd ? { end_reason: 'closed' as const } : {}),
    } as AttendanceBatchEntryT
  }

  /** Applies one exchange's result. `sentAt`/`sentEpoch` are taken when the request left. */
  apply(
    result: AttendanceResponse | AttendanceBatchResult,
    sentAt: number,
    sentEpoch: number,
    currentEpoch: number,
    credentialKey: string | null,
    sentFinal: boolean,
    sentStopped = false,
  ): LeaseOutcome {
    if (sentFinal) {
      const successor = this.successor
      if (successor !== null && result.status === 'unknown_successor') {
        // Nothing changed at the service: the session still owes a plain end.
        this.successor = null
        this.needsFresh = true
        return { kind: 'successor-refused', successor }
      }
      const state = this.final ?? 'ended'
      this.final = null
      this.successor = null
      this.holdStopped = false
      this.generation = null
      this.leaseEndsAt = null
      return { kind: 'reported', state, successor }
    }
    if (sentStopped) {
      if (result.status === 'stopped') {
        this.generation = result.generation
        this.leaseEndsAt = null
        this.cursor = result.message_cursor
        this.credentialKey = credentialKey
        this.needsFresh = false
        this.stopReported = true
        return { kind: 'stopped', messages: result.messages }
      }
      // Another incarnation holds the session, or the service has none: there
      // is nothing for this one to hold. A later end is still worth sending.
      this.holdStopped = false
      this.needsFresh = true
      return { kind: 'stop-refused' }
    }
    if (result.status === 'attending') {
      const acquired = this.generation !== result.generation
      this.generation = result.generation
      this.leaseEndsAt = sentEpoch === currentEpoch ? sentAt + result.lease_remaining_ms : null
      this.grantedEpoch = sentEpoch
      this.cursor = result.message_cursor
      this.credentialKey = credentialKey
      this.rotated = false
      this.resumedFromStop = false
      this.needsFresh = false
      this.setPhase('attending')
      return { kind: 'attending', acquired, messages: result.messages }
    }
    if (result.status === 'owned') {
      this.generation = null
      this.leaseEndsAt = null
      this.cursor = undefined
      this.needsFresh = true
      this.setPhase('waiting-for-lease')
      return { kind: 'owned', retryAfterMs: Math.min(Math.max(result.retry_after_ms, 1_000), 120_000) }
    }
    if (result.status === 'unknown_session') {
      this.needsFresh = true
      this.setPhase('acquiring', 'session-unknown-to-service')
      return { kind: 'unknown-session' }
    }
    // withdrawn: the service holds no lease for this incarnation.
    if (this.generation !== null && this.resumedFromStop) {
      // The service held it as stopped: only a new incarnation takes it back.
      this.resumedFromStop = false
      this.generation = null
      this.leaseEndsAt = null
    }
    if (this.generation !== null) {
      this.generation = null
      this.leaseEndsAt = null
      this.cursor = undefined
      this.setPhase('withdrawn', 'withdrawn-by-service')
      return { kind: 'withdrawn' }
    }
    // Refused while acquiring: this incarnation id already released its lease
    // (a report made before a restart). A fresh id may acquire once.
    const next = this.rotated ? null : this.rotate(this.incarnation)
    if (next === null) {
      this.setPhase('withdrawn', 'withdrawn-by-service')
      return { kind: 'withdrawn' }
    }
    this.incarnation = next
    this.rotated = true
    this.cursor = undefined
    this.needsFresh = true
    return { kind: 'rotated' }
  }

  /** Whether the held lease still covers a write that starts now. */
  covers(now: number, currentEpoch: number, credentialKey: string | null): boolean {
    return this.generation !== null && this.leaseEndsAt !== null && this.grantedEpoch === currentEpoch &&
      this.credentialKey === credentialKey && now < this.leaseEndsAt - HUB_WRITE_MARGIN_MS
  }
}
