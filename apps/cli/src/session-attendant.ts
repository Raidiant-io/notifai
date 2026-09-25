/**
 * The Session Attendant: one long-lived CLI process per Agent Session.
 *
 * It starts as that session's own asynchronous hook child, proves the harness
 * process alive every two seconds by local evidence only, and holds the
 * session's Session Presence lease with the service. It is resident from its
 * start but makes no network call until the session had a Notification
 * Request accepted, so sessions that never notified are never reported.
 *
 * Nothing ends it from outside. Claude Code neither signals nor waits for a
 * resident async hook on `/exit` or when the harness is killed, so the local
 * probe is the one universal end signal; SessionEnd's marker is a fast path,
 * and a SIGTERM (terminal close) is treated as "ending, report once".
 *
 * Local only: PIDs, process start times, descriptor paths, and harness homes
 * never leave this machine. The service sees an opaque incarnation id.
 */
import type {
  AttendanceMessage,
  AttendanceRequestT,
  AttendanceResponse,
  SessionActivity,
} from '@raidiant/notifai-protocol'
import { ATTENDANCE_MAX_WAIT_SECONDS } from '@raidiant/notifai-protocol'
import { ApiCallError, type ApiClient } from './client.js'
import type { Logger } from './logging.js'

/** Local probe cadence. */
export const ATTENDANT_PROBE_INTERVAL_MS = 2_000

/** Harness writes stop this long before the lease ends by the attendant's own clock. */
export const ATTENDANT_WRITE_MARGIN_MS = 15_000

/** A wall-clock move this far from the monotonic clock means sleep or a clock jump. */
export const ATTENDANT_CLOCK_JUMP_MS = 5_000

/** Best-effort bound on the final `ended` or `withdrawn` report. */
export const ATTENDANT_FINAL_REPORT_MS = 3_000

/** How often an unsupported service is asked again. */
export const ATTENDANT_UNSUPPORTED_RECHECK_MS = 30 * 60_000

/** How long to wait before asking again about a session the service does not know yet. */
export const ATTENDANT_UNKNOWN_SESSION_RETRY_MS = 60_000

const MAX_NETWORK_BACKOFF_MS = 30_000

export type HarnessProbe =
  | { state: 'running'; activity: SessionActivity }
  /** Evidence is missing or ambiguous: no renewal, no deliveries, never `running`. */
  | { state: 'uncertain'; reason: string }
  | { state: 'ended'; reason: 'harness-gone' | 'session-replaced' | 'session-end-hook' }

export type GateResult = { ok: true } | { ok: false; reason: string }

export type AttendantPhase =
  /** Resident, no network: the session has not notified yet. */
  | 'dormant'
  /** The service does not offer Session Attendance; resident without reporting. */
  | 'unsupported'
  | 'acquiring'
  | 'attending'
  /** Another incarnation holds the lease. */
  | 'waiting-for-lease'
  | 'uncertain'
  | 'exited'

export type AttendantExitReason =
  | 'harness-gone'
  | 'session-replaced'
  | 'session-end-hook'
  | 'signal'
  | 'superseded'
  | 'claim-lost'
  | 'withdrawn-by-service'
  | 'unauthorized'
  | `gate:${string}`

export interface AttendantStatus {
  phase: AttendantPhase
  incarnation: string
  generation: number | null
  activity: SessionActivity | null
  reason: string | null
  updated_at: number
}

export interface AttendantClock {
  /** Monotonic milliseconds; never moves with the wall clock. */
  monotonic(): number
  wall(): number
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>
}

export interface SessionAttendantOptions {
  sessionId: string
  /** The opaque incarnation this attendant serves; see `incarnationNow`. */
  incarnation: string
  /** The incarnation currently recorded for the session, read fresh each probe. */
  incarnationNow(): string | null
  /** Replace a refused incarnation id; null when the record moved on. */
  rotateIncarnation(expected: string): string | null
  probe(): HarnessProbe
  /** Whether this attendant still holds its exclusive local claim. */
  claimHeld(): boolean
  /** Whether this session had a Notification Request accepted on this machine. */
  notified(): boolean
  /** Project Enablement and the installed CLI/hook contract. */
  gates(): GateResult
  /** Authenticated client, or null when this machine is not paired. */
  client(): ApiClient | null
  /** Whether the service advertises Session Attendance. */
  serverSupportsAttendance(client: ApiClient): Promise<boolean>
  /** Whether this attendant can hand Session Messages into the session. */
  acceptsMessages: boolean
  /** Receives claimable Session Messages; absent until message hand-off ships. */
  onMessages?: (messages: AttendanceMessage[], attendant: AttendantHandle) => Promise<void>
  clock: AttendantClock
  logger: Logger
  /** Persist the local status `notifai doctor` reads. */
  writeStatus(status: AttendantStatus): void
  /** Periodic housekeeping (e.g. keep markers younger than pruning). */
  heartbeat?: () => void
  /** Resolves when a termination signal arrived. */
  signalled?: Promise<void>
  probeIntervalMs?: number
  waitSeconds?: number
}

/** What a harness writer asks before each write. */
export interface AttendantHandle {
  /**
   * True only while, right now: this attendant still owns its claim and
   * incarnation, fresh local evidence shows the session running, every gate
   * passes, no clock discontinuity happened since the lease was granted, and
   * the lease cannot lapse before the write ends by the monotonic clock.
   */
  mayWrite(): boolean
  generation(): number | null
  incarnation(): string
}

export interface AttendantResult {
  reason: AttendantExitReason
  /** Whether a final report was attempted. */
  reported: 'ended' | 'withdrawn' | null
}

/** Runs one Session Attendant until its session ends or a gate fails. */
export async function runSessionAttendant(options: SessionAttendantOptions): Promise<AttendantResult> {
  const { clock, logger } = options
  const probeInterval = options.probeIntervalMs ?? ATTENDANT_PROBE_INTERVAL_MS
  const waitSeconds = Math.min(options.waitSeconds ?? ATTENDANCE_MAX_WAIT_SECONDS, ATTENDANCE_MAX_WAIT_SECONDS)
  const stopping = new AbortController()

  let incarnation = options.incarnation
  let generation: number | null = null
  let cursor: string | undefined
  /** Monotonic time after which the lease may have lapsed at the service. */
  let leaseEndsAt: number | null = null
  let probe: HarnessProbe = options.probe()
  let activity: SessionActivity | null = probe.state === 'running' ? probe.activity : null
  let phase: AttendantPhase = 'dormant'
  let phaseReason: string | null = null
  let networkStarted = false
  let exit: AttendantExitReason | null = probe.state === 'ended' ? probe.reason : null
  let exchange: AbortController | null = null
  let wake: (() => void) | null = null

  const setPhase = (next: AttendantPhase, reason: string | null = null): void => {
    if (next === phase && reason === phaseReason) return
    phase = next
    phaseReason = reason
    logger.info('attendant.state', {
      phase,
      ...(reason === null ? {} : { reason }),
      ...(generation === null ? {} : { generation }),
    })
    writeStatus()
  }
  const writeStatus = (): void => {
    try {
      options.writeStatus({
        phase,
        incarnation,
        generation,
        activity,
        reason: phaseReason,
        updated_at: clock.wall(),
      })
    } catch {
      // Status is diagnostic; the attendant keeps attending without it.
    }
  }
  const nudge = (): void => {
    const resolve = wake
    wake = null
    resolve?.()
  }
  const abortExchange = (): void => {
    exchange?.abort()
  }
  const stop = (reason: AttendantExitReason): void => {
    if (exit === null) exit = reason
    exchange?.abort()
    stopping.abort()
    nudge()
  }
  /** Bumped by every clock discontinuity; a lease granted in an older epoch is void. */
  let epoch = 0
  let reacquireNow = false
  const loseLease = (reason: string): void => {
    if (leaseEndsAt !== null || generation !== null) {
      logger.info('attendant.lease', { event: 'lost', reason, ...(generation === null ? {} : { generation }) })
    }
    leaseEndsAt = null
  }

  let lastWall = clock.wall()
  let lastMono = clock.monotonic()
  /**
   * Sleep pauses the monotonic clock while the service's lease keeps running;
   * a wall-clock step says the same. Either way nothing may be written until
   * a fresh exchange, sent after the jump, re-acquires.
   */
  const checkClock = (): void => {
    const wall = clock.wall()
    const mono = clock.monotonic()
    const jump = Math.abs(wall - lastWall - (mono - lastMono))
    lastWall = wall
    lastMono = mono
    if (jump > ATTENDANT_CLOCK_JUMP_MS) {
      epoch += 1
      reacquireNow = true
      loseLease('clock-jump')
      exchange?.abort()
    }
  }

  /**
   * Re-establish everything this attendant relies on, now: clock continuity,
   * its claim, its incarnation, and fresh session evidence. Returns whether
   * the session is running and this attendant may still act for it.
   */
  const refresh = (): boolean => {
    if (exit !== null) return false
    checkClock()
    if (!options.claimHeld()) {
      stop('claim-lost')
      return false
    }
    const recorded = options.incarnationNow()
    if (recorded !== null && recorded !== incarnation) {
      stop('superseded')
      return false
    }
    const previous = probe
    probe = options.probe()
    if (probe.state === 'ended') {
      stop(probe.reason)
      return false
    }
    if (probe.state === 'uncertain') {
      if (previous.state !== 'uncertain') {
        exchange?.abort()
        if (networkStarted) setPhase('uncertain', probe.reason)
      }
      return false
    }
    const changed = activity !== probe.activity
    activity = probe.activity
    if (previous.state !== 'running' || changed) {
      // A held exchange carries the old activity; cut it so the next one reports this.
      exchange?.abort()
      nudge()
    }
    return true
  }

  const handle: AttendantHandle = {
    mayWrite: () => {
      if (!refresh()) return false
      const gate = options.gates()
      if (!gate.ok) {
        stop(`gate:${gate.reason}`)
        return false
      }
      return (
        generation !== null &&
        leaseEndsAt !== null &&
        clock.monotonic() < leaseEndsAt - ATTENDANT_WRITE_MARGIN_MS
      )
    },
    generation: () => generation,
    incarnation: () => incarnation,
  }

  // -- local probe -------------------------------------------------------
  let lastHeartbeat = lastMono
  const tick = (): void => {
    refresh()
    if (exit !== null) return
    if (!networkStarted && options.notified()) nudge()
    const mono = clock.monotonic()
    if (mono - lastHeartbeat >= 60 * 60_000) {
      lastHeartbeat = mono
      try {
        options.heartbeat?.()
      } catch {
        // Housekeeping only.
      }
    }
  }
  const probeLoop = (async () => {
    while (!stopping.signal.aborted) {
      await clock.sleep(probeInterval, stopping.signal).catch(() => undefined)
      if (stopping.signal.aborted) break
      tick()
    }
  })()
  void options.signalled?.then(() => stop('signal'))

  /** Wait until a probe tick changes something this loop waits on, or a stop. */
  const nextChange = async (): Promise<void> => {
    if (stopping.signal.aborted) return
    await new Promise<void>((resolve) => {
      wake = resolve
    })
  }
  const pause = async (ms: number): Promise<void> => {
    await clock.sleep(ms, stopping.signal).catch(() => undefined)
  }

  writeStatus()
  logger.info('attendant.start', { notified: options.notified(), probe: probe.state })

  // -- exchange loop -----------------------------------------------------
  let backoff = 1_000
  let rotated = false
  let serverChecked = false
  while (exit === null) {
    if (!networkStarted) {
      if (!options.notified()) {
        await nextChange()
        continue
      }
      networkStarted = true
    }
    // Fresh evidence before every exchange, not the last tick's.
    if (!refresh()) {
      if (exit !== null) break
      if (probe.state === 'uncertain') setPhase('uncertain', probe.reason)
      await nextChange()
      continue
    }
    const gate = options.gates()
    if (!gate.ok) {
      stop(`gate:${gate.reason}`)
      break
    }
    const client = options.client()
    if (client === null) {
      stop('gate:not-paired')
      break
    }
    if (!serverChecked) {
      // Discovery is an exchange like any other: a stop, an uncertain probe,
      // or an activity change cuts it, and whatever it answers, every check
      // above runs again before anything is sent.
      const discovery = new AbortController()
      exchange = discovery
      let supported: boolean
      try {
        supported = await abortable(options.serverSupportsAttendance(client), discovery.signal)
      } catch {
        exchange = null
        if (exit !== null || discovery.signal.aborted) continue
        await pause(backoff)
        backoff = Math.min(backoff * 2, MAX_NETWORK_BACKOFF_MS)
        continue
      }
      exchange = null
      if (!supported) {
        setPhase('unsupported', 'service-has-no-session-attendance')
        await pause(ATTENDANT_UNSUPPORTED_RECHECK_MS)
        continue
      }
      serverChecked = true
      continue
    }
    if (generation === null) setPhase('acquiring')

    const body: AttendanceRequestT = {
      incarnation,
      ...(generation === null ? {} : { generation }),
      state: 'running',
      // Set by the successful refresh above.
      activity: activity ?? 'idle',
      accepts_messages: options.acceptsMessages,
      ...(cursor === undefined ? {} : { message_cursor: cursor }),
    }
    const current = new AbortController()
    exchange = current
    const sentAt = clock.monotonic()
    const sentEpoch = epoch
    const hold = cursor !== undefined && !reacquireNow
    reacquireNow = false
    let response: AttendanceResponse
    try {
      response = await client.attend(options.sessionId, body, {
        waitSeconds: hold ? waitSeconds : 0,
        signal: current.signal,
      })
    } catch (err) {
      exchange = null
      if (exit !== null) break
      if (current.signal.aborted) continue
      if (err instanceof ApiCallError) {
        if (err.status === 401 || err.status === 403) {
          stop('unauthorized')
          break
        }
        if (err.status === 404) {
          setPhase('acquiring', 'session-unknown-to-service')
          await pause(ATTENDANT_UNKNOWN_SESSION_RETRY_MS)
          continue
        }
        if (err.status === 409 && err.code === 'feature_unavailable') {
          serverChecked = false
          setPhase('unsupported', 'service-refused-session-attendance')
          await pause(ATTENDANT_UNSUPPORTED_RECHECK_MS)
          continue
        }
      }
      await pause(backoff)
      backoff = Math.min(backoff * 2, MAX_NETWORK_BACKOFF_MS)
      continue
    }
    exchange = null
    backoff = 1_000
    if (exit !== null) break

    if (response.status === 'attending') {
      if (generation !== response.generation) {
        logger.info('attendant.lease', { event: 'acquired', generation: response.generation })
      }
      generation = response.generation
      // A grant sent before a clock discontinuity says nothing about now.
      leaseEndsAt = sentEpoch === epoch ? sentAt + response.lease_remaining_ms : null
      cursor = response.message_cursor
      rotated = false
      setPhase('attending')
      if (response.messages.length > 0 && options.onMessages !== undefined) {
        try {
          await options.onMessages(response.messages, handle)
        } catch (err) {
          logger.error('attendant.state', {
            phase,
            reason: 'message-handoff-failed',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }
      continue
    }
    if (response.status === 'owned') {
      if (generation !== null) loseLease('owned-by-another-incarnation')
      generation = null
      cursor = undefined
      setPhase('waiting-for-lease')
      await pause(Math.min(Math.max(response.retry_after_ms, 1_000), 120_000))
      continue
    }
    // withdrawn: the service holds no lease for this incarnation.
    if (generation !== null) {
      loseLease('withdrawn-by-service')
      generation = null
      stop('withdrawn-by-service')
      break
    }
    // Refused while acquiring: this incarnation id already released its lease
    // (a report made before a restart). A fresh id may acquire once.
    const next = rotated ? null : options.rotateIncarnation(incarnation)
    if (next === null) {
      stop('withdrawn-by-service')
      break
    }
    logger.info('attendant.lease', { event: 'incarnation-rotated' })
    incarnation = next
    rotated = true
    cursor = undefined
  }

  // -- end -----------------------------------------------------------------
  stopping.abort()
  abortExchange()
  await probeLoop
  const reason = exit ?? 'signal'
  let reported: AttendantResult['reported'] = null
  const final = finalReport(reason)
  if (networkStarted && final !== null && (final === 'ended' || generation !== null)) {
    const client = safeClient(options)
    if (client !== null) {
      reported = final
      const bound = new AbortController()
      const timer = setTimeout(() => bound.abort(), ATTENDANT_FINAL_REPORT_MS)
      try {
        await client.attend(
          options.sessionId,
          {
            incarnation,
            ...(generation === null ? {} : { generation }),
            state: final,
          },
          { waitSeconds: 0, signal: bound.signal },
        )
      } catch {
        // Without the report the lease lapses and presence reads out of reach.
      } finally {
        clearTimeout(timer)
      }
    }
  }
  leaseEndsAt = null
  phase = 'exited'
  phaseReason = reason
  writeStatus()
  logger.info('attendant.exit', {
    reason,
    ...(reported === null ? {} : { reported }),
    ...(generation === null ? {} : { generation }),
  })
  return { reason, reported }
}

/** Which final state a way of ending reports, if any. */
function finalReport(reason: AttendantExitReason): 'ended' | 'withdrawn' | null {
  switch (reason) {
    case 'harness-gone':
    case 'session-replaced':
    case 'session-end-hook':
    case 'signal':
      return 'ended'
    case 'superseded':
      // A newer start of the same session attends now; ending would end it.
      return 'withdrawn'
    case 'withdrawn-by-service':
    case 'unauthorized':
    case 'claim-lost':
      // Another attendant may hold this incarnation's lease now; any report
      // from here could release it.
      return null
    default:
      return reason.startsWith('gate:') && reason !== 'gate:not-paired' ? 'withdrawn' : null
  }
}

function safeClient(options: SessionAttendantOptions): ApiClient | null {
  try {
    return options.client()
  } catch {
    return null
  }
}

/** Rejects when `signal` aborts, so an awaited call cannot outlive a stop. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/** Production clocks: `performance.now()` pauses with the machine; `Date.now()` does not. */
export const systemAttendantClock: AttendantClock = {
  monotonic: () => performance.now(),
  wall: () => Date.now(),
  sleep: (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, milliseconds)
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }),
}
