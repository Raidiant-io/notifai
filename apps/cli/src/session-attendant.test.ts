import type { AttendanceRequestT, AttendanceResponse } from '@raidiant/notifai-protocol'
import { describe, expect, it } from 'vitest'
import { ApiCallError, type ApiClient } from './client.js'
import { nullLogger } from './logging.js'
import {
  ATTENDANT_WRITE_MARGIN_MS,
  runSessionAttendant,
  type AttendantClock,
  type AttendantHandle,
  type AttendantResult,
  type AttendantStatus,
  type GateResult,
  type HarnessProbe,
  type SessionAttendantOptions,
} from './session-attendant.js'

/** A virtual clock: nothing moves until the test advances it. */
class VirtualClock implements AttendantClock {
  mono = 1_000
  wallTime = 1_790_000_000_000
  private timers: { at: number; resolve: () => void; reject: (err: unknown) => void }[] = []

  monotonic(): number {
    return this.mono
  }
  wall(): number {
    return this.wallTime
  }
  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      const timer = { at: this.mono + milliseconds, resolve, reject }
      this.timers.push(timer)
      signal.addEventListener(
        'abort',
        () => {
          this.timers = this.timers.filter((entry) => entry !== timer)
          reject(new Error('aborted'))
        },
        { once: true },
      )
    })
  }
  /** Advance both clocks together, firing due timers in order. */
  async advance(milliseconds: number, options: { wallOnly?: number } = {}): Promise<void> {
    const target = this.mono + milliseconds
    this.wallTime += options.wallOnly ?? 0
    while (true) {
      await flush()
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (due === undefined) break
      this.wallTime += due.at - this.mono
      this.mono = due.at
      this.timers = this.timers.filter((timer) => timer !== due)
      due.resolve()
    }
    this.wallTime += target - this.mono
    this.mono = target
    await flush()
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

interface HeldExchange {
  body: AttendanceRequestT
  waitSeconds: number
  respond(response: AttendanceResponse): void
  fail(err: unknown): void
  aborted: boolean
}

/** A service whose every exchange waits for the test to answer it. */
class FakeService {
  exchanges: HeldExchange[] = []
  compatibilityCalls = 0
  supports = true
  /** When set, discovery waits for the test to call this. */
  holdCompatibility: { release?: () => void } | null = null

  client(): ApiClient {
    return {
      attend: (_sessionId: string, body: AttendanceRequestT, options: { waitSeconds: number; signal?: AbortSignal }) =>
        new Promise<AttendanceResponse>((resolve, reject) => {
          const held: HeldExchange = {
            body,
            waitSeconds: options.waitSeconds,
            respond: resolve,
            fail: reject,
            aborted: false,
          }
          options.signal?.addEventListener(
            'abort',
            () => {
              held.aborted = true
              reject(new Error('aborted'))
            },
            { once: true },
          )
          this.exchanges.push(held)
        }),
      compatibility: async () => {
        // Answered on a later turn, so a test can configure the service first.
        await new Promise((resolve) => setImmediate(resolve))
        this.compatibilityCalls += 1
        const hold = this.holdCompatibility
        if (hold !== null) await new Promise<void>((resolve) => (hold.release = resolve))
        return {
          server_capabilities: this.supports ? ['agent_acknowledgement', 'session_attendance'] : ['agent_acknowledgement'],
        }
      },
    } as unknown as ApiClient
  }

  last(): HeldExchange {
    const exchange = this.exchanges.at(-1)
    if (exchange === undefined) throw new Error('no exchange yet')
    return exchange
  }

  attending(generation: number, leaseMs = 120_000, cursor = 'c1'): AttendanceResponse {
    return { status: 'attending', generation, lease_remaining_ms: leaseMs, message_cursor: cursor, messages: [] }
  }
}

interface Harness {
  clock: VirtualClock
  service: FakeService
  probe: HarnessProbe
  notified: boolean
  gate: GateResult
  claimHeld: boolean
  recorded: string | null
  statuses: AttendantStatus[]
  handle: AttendantHandle | null
  signal: () => void
  result: Promise<AttendantResult>
}

function startAttendant(overrides: Partial<SessionAttendantOptions> = {}, initial: Partial<Harness> = {}): Harness {
  const clock = new VirtualClock()
  const service = new FakeService()
  let signal!: () => void
  const signalled = new Promise<void>((resolve) => {
    signal = resolve
  })
  const harness = {
    clock,
    service,
    probe: { state: 'running', activity: 'idle' } as HarnessProbe,
    notified: true,
    gate: { ok: true } as GateResult,
    claimHeld: true,
    recorded: 'inc_aaaaaaaaaaaa' as string | null,
    statuses: [] as AttendantStatus[],
    handle: null as AttendantHandle | null,
    signal,
    ...initial,
  } as Harness
  let rotations = 0
  harness.result = runSessionAttendant({
    sessionId: 'session-1',
    incarnation: 'inc_aaaaaaaaaaaa',
    incarnationNow: () => harness.recorded,
    rotateIncarnation: (expected) => {
      if (harness.recorded !== expected) return null
      rotations += 1
      harness.recorded = `inc_rotated${rotations}xxxx`
      return harness.recorded
    },
    probe: () => harness.probe,
    claimHeld: () => harness.claimHeld,
    notified: () => harness.notified,
    gates: () => harness.gate,
    client: () => service.client(),
    serverSupportsAttendance: async (client) =>
      (await client.compatibility()).server_capabilities.includes('session_attendance'),
    acceptsMessages: false,
    onMessages: async (_messages, handle) => {
      harness.handle = handle
      return 'done'
    },
    clock,
    logger: nullLogger(),
    writeStatus: (status) => harness.statuses.push(status),
    signalled,
    ...overrides,
  })
  return harness
}

describe('Session Attendant', () => {
  it('stays dormant with no network call until the session notifies', async () => {
    const h = startAttendant({}, { notified: false })
    await h.clock.advance(60_000)
    expect(h.service.exchanges).toHaveLength(0)
    expect(h.service.compatibilityCalls).toBe(0)
    expect(h.statuses.at(-1)?.phase).toBe('dormant')

    // The first question is accepted after the attendant started.
    h.notified = true
    await h.clock.advance(2_000)
    expect(h.service.exchanges).toHaveLength(1)
    expect(h.service.last().body).toMatchObject({
      incarnation: 'inc_aaaaaaaaaaaa',
      state: 'running',
      activity: 'idle',
      accepts_messages: false,
    })
    expect(h.service.last().body).not.toHaveProperty('generation')
    expect(h.service.last().waitSeconds).toBe(0)
    h.signal()
    h.service.last().fail(new Error('gone'))
    await h.clock.advance(10)
  })

  it('never reports a session that ended before it notified', async () => {
    const h = startAttendant({}, { notified: false })
    await h.clock.advance(4_000)
    h.probe = { state: 'ended', reason: 'harness-gone' }
    await h.clock.advance(2_000)
    const result = await h.result
    expect(result).toEqual({ reason: 'harness-gone', reported: null })
    expect(h.service.exchanges).toHaveLength(0)
  })

  it('acquires, renews with its generation and cursor, and long-polls', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().respond(h.service.attending(4))
    await h.clock.advance(1)
    const renewal = h.service.last()
    expect(renewal.body).toMatchObject({ generation: 4, message_cursor: 'c1' })
    expect(renewal.waitSeconds).toBe(25)
    expect(h.statuses.at(-1)).toMatchObject({ phase: 'attending', generation: 4 })
    h.signal()
    await h.clock.advance(1)
  })

  it('reports ended once when the harness goes away, then exits', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().respond(h.service.attending(2))
    await h.clock.advance(1)
    h.probe = { state: 'ended', reason: 'harness-gone' }
    await h.clock.advance(2_000)
    const final = h.service.last()
    expect(final.body).toEqual({ incarnation: 'inc_aaaaaaaaaaaa', generation: 2, state: 'ended' })
    final.respond({ status: 'withdrawn' })
    const result = await h.result
    expect(result).toEqual({ reason: 'harness-gone', reported: 'ended' })
    expect(h.statuses.at(-1)).toMatchObject({ phase: 'exited', reason: 'harness-gone' })
  })

  it('treats a termination signal as ending and reports once', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().respond(h.service.attending(1))
    await h.clock.advance(1)
    h.signal()
    await h.clock.advance(1)
    const final = h.service.last()
    expect(final.body.state).toBe('ended')
    final.respond({ status: 'withdrawn' })
    expect(await h.result).toEqual({ reason: 'signal', reported: 'ended' })
  })

  it('gives up the final report after its bound when the service does not answer', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().respond(h.service.attending(1))
    await h.clock.advance(1)
    h.signal()
    await h.clock.advance(1)
    const final = h.service.last()
    // The real timer bounds it; aborting stands in for that timer firing.
    final.fail(new Error('timed out'))
    expect(await h.result).toEqual({ reason: 'signal', reported: 'ended' })
  })

  it('pauses renewal while evidence is uncertain and never reports running', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().respond(h.service.attending(1))
    await h.clock.advance(1)
    const held = h.service.last()
    h.probe = { state: 'uncertain', reason: 'descriptor-missing' }
    await h.clock.advance(2_000)
    expect(held.aborted).toBe(true)
    const count = h.service.exchanges.length
    await h.clock.advance(120_000)
    expect(h.service.exchanges).toHaveLength(count)
    expect(h.statuses.at(-1)).toMatchObject({ phase: 'uncertain', reason: 'descriptor-missing' })

    h.probe = { state: 'running', activity: 'working' }
    await h.clock.advance(2_000)
    expect(h.service.exchanges).toHaveLength(count + 1)
    expect(h.service.last().body).toMatchObject({ state: 'running', activity: 'working', generation: 1 })
    h.signal()
    await h.clock.advance(1)
  })

  it('cuts a held exchange short when the activity changes', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().respond(h.service.attending(1))
    await h.clock.advance(1)
    const held = h.service.last()
    expect(held.body.activity).toBe('idle')
    h.probe = { state: 'running', activity: 'working' }
    await h.clock.advance(2_000)
    expect(held.aborted).toBe(true)
    expect(h.service.last().body.activity).toBe('working')
    h.signal()
    await h.clock.advance(1)
  })

  it('hands messages over only when it accepts them, and re-asks at once for one that must wait', async () => {
    const note = { message_id: 'sm_1', created_at: 'x', agent_acknowledgement_text_required: true, kind: 'note' as const, body: 'hi' }
    const silent = startAttendant()
    await silent.clock.advance(1)
    silent.service.last().respond({ ...silent.service.attending(3), messages: [note] })
    await silent.clock.advance(1)
    expect(silent.handle).toBeNull()
    silent.signal()
    await silent.clock.advance(1)

    const answers: Array<'done' | 'retry-soon'> = ['retry-soon', 'done']
    const batches: string[][] = []
    const h = startAttendant({
      acceptsMessages: true,
      onMessages: async (messages) => {
        batches.push(messages.map((message) => message.message_id))
        return answers.shift() ?? 'done'
      },
    })
    await h.clock.advance(1)
    h.service.last().respond({ ...h.service.attending(3), messages: [note] })
    await h.clock.advance(1)
    expect(batches).toEqual([['sm_1']])
    const beforePause = h.service.exchanges.length
    // A brief pause, then an exchange the service answers at once.
    await h.clock.advance(1_000)
    expect(h.service.exchanges).toHaveLength(beforePause)
    await h.clock.advance(1_000)
    expect(h.service.exchanges).toHaveLength(beforePause + 1)
    expect(h.service.last().waitSeconds).toBe(0)
    h.service.last().respond({ ...h.service.attending(3), messages: [note] })
    await h.clock.advance(1)
    expect(batches).toEqual([['sm_1'], ['sm_1']])
    // Handed over: the next exchange holds again.
    expect(h.service.last().waitSeconds).toBe(25)
    h.signal()
    await h.clock.advance(1)
  })

  it('republishes its status when it holds a new generation, so the answer waiter claims under it', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().respond(h.service.attending(3))
    await h.clock.advance(1)
    h.service.last().respond(h.service.attending(4))
    await h.clock.advance(1)
    expect(h.statuses.at(-1)).toMatchObject({ phase: 'attending', generation: 4 })
    h.signal()
    await h.clock.advance(1)
  })

  it('stops harness writes before the lease ends by its own monotonic clock', async () => {
    const h = startAttendant({ acceptsMessages: true })
    await h.clock.advance(1)
    const acquiring = h.service.last()
    await h.clock.advance(500)
    acquiring.respond({
      status: 'attending',
      generation: 3,
      lease_remaining_ms: 60_000,
      message_cursor: 'c1',
      messages: [{ message_id: 'sm_1', created_at: 'x', agent_acknowledgement_text_required: true, kind: 'note', body: 'hi' }],
    })
    await h.clock.advance(1)
    const handle = h.handle!
    expect(handle.mayWrite()).toBe(true)
    // Measured from when the exchange was sent (t=1000), not when it was answered (t=1501).
    await h.clock.advance(60_000 - ATTENDANT_WRITE_MARGIN_MS - 503)
    expect(handle.mayWrite()).toBe(true)
    await h.clock.advance(2)
    expect(handle.mayWrite()).toBe(false)
    h.signal()
    await h.clock.advance(1)
  })

  it('after a wall-clock jump, writes nothing until a fresh exchange re-acquires', async () => {
    const h = startAttendant({ acceptsMessages: true })
    await h.clock.advance(1)
    h.service.last().respond({
      status: 'attending',
      generation: 5,
      lease_remaining_ms: 120_000,
      message_cursor: 'c1',
      messages: [{ message_id: 'sm_1', created_at: 'x', agent_acknowledgement_text_required: true, kind: 'note', body: 'hi' }],
    })
    await h.clock.advance(1)
    const handle = h.handle!
    const held = h.service.last()
    expect(handle.mayWrite()).toBe(true)
    // The machine slept: the wall clock moved an hour, the monotonic clock did not.
    await h.clock.advance(2_000, { wallOnly: 3_600_000 })
    expect(handle.mayWrite()).toBe(false)
    expect(held.aborted).toBe(true)
    const reacquire = h.service.last()
    expect(reacquire).not.toBe(held)
    expect(reacquire.body).toMatchObject({ generation: 5, state: 'running' })
    reacquire.respond(h.service.attending(5))
    await h.clock.advance(1)
    expect(handle.mayWrite()).toBe(true)
    h.signal()
    await h.clock.advance(1)
  })

  it('withdraws and exits when a gate fails at the next exchange', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().respond(h.service.attending(2))
    await h.clock.advance(1)
    h.gate = { ok: false, reason: 'project-disabled' }
    h.service.last().respond(h.service.attending(2, 120_000, 'c2'))
    await h.clock.advance(1)
    const final = h.service.last()
    expect(final.body).toEqual({ incarnation: 'inc_aaaaaaaaaaaa', generation: 2, state: 'withdrawn' })
    final.respond({ status: 'withdrawn' })
    expect(await h.result).toEqual({ reason: 'gate:project-disabled', reported: 'withdrawn' })
  })

  it('waits while another incarnation holds the lease, then acquires', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().respond({ status: 'owned', retry_after_ms: 30_000 })
    await h.clock.advance(29_000)
    expect(h.service.exchanges).toHaveLength(1)
    expect(h.statuses.at(-1)?.phase).toBe('waiting-for-lease')
    await h.clock.advance(1_000)
    expect(h.service.exchanges).toHaveLength(2)
    expect(h.service.last().body).not.toHaveProperty('generation')
    h.signal()
    await h.clock.advance(1)
  })

  it('stops attending when the service withdraws a held lease', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().respond(h.service.attending(2))
    await h.clock.advance(1)
    h.service.last().respond({ status: 'withdrawn' })
    const result = await h.result
    expect(result).toEqual({ reason: 'withdrawn-by-service', reported: null })
  })

  it('re-identifies once when its incarnation id was already released', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().respond({ status: 'withdrawn' })
    await h.clock.advance(1)
    expect(h.recorded).toBe('inc_rotated1xxxx')
    expect(h.service.last().body.incarnation).toBe('inc_rotated1xxxx')
    h.service.last().respond({ status: 'withdrawn' })
    expect(await h.result).toEqual({ reason: 'withdrawn-by-service', reported: null })
  })

  it('withdraws, never ends, when a newer start of the same session supersedes it', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().respond(h.service.attending(2))
    await h.clock.advance(1)
    h.recorded = 'inc_newerincarnation'
    await h.clock.advance(2_000)
    const final = h.service.last()
    expect(final.body).toEqual({ incarnation: 'inc_aaaaaaaaaaaa', generation: 2, state: 'withdrawn' })
    final.respond({ status: 'withdrawn' })
    expect(await h.result).toEqual({ reason: 'superseded', reported: 'withdrawn' })
  })

  it('stays resident without reporting when the service offers no attendance', async () => {
    const h = startAttendant()
    h.service.supports = false
    await h.clock.advance(60_000)
    expect(h.service.exchanges).toHaveLength(0)
    expect(h.statuses.at(-1)).toMatchObject({ phase: 'unsupported' })
    h.probe = { state: 'ended', reason: 'session-end-hook' }
    await h.clock.advance(2_000)
    // The session had notified, so its end is still worth recording.
    h.service.last().respond({ status: 'withdrawn' })
    expect((await h.result).reason).toBe('session-end-hook')
  })

  it('exits without a report when the machine credential is refused', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().fail(new ApiCallError(401, 'unauthorized', 'revoked', null, null, null))
    expect(await h.result).toEqual({ reason: 'unauthorized', reported: null })
  })

  it('retries a session the service does not know yet after a pause', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().fail(new ApiCallError(404, 'not_found', 'No such Agent Session.', null, null, null))
    await h.clock.advance(59_000)
    expect(h.service.exchanges).toHaveLength(1)
    await h.clock.advance(1_000)
    expect(h.service.exchanges).toHaveLength(2)
    h.signal()
    await h.clock.advance(1)
  })

  describe('service discovery', () => {
    const running = (h: Harness) => h.service.exchanges.filter((exchange) => exchange.body.state === 'running')

    it('re-checks the gates after discovery and sends nothing once the Project is disabled', async () => {
      const h = startAttendant()
      h.service.holdCompatibility = {}
      await h.clock.advance(1)
      h.gate = { ok: false, reason: 'project-disabled' }
      h.service.holdCompatibility.release?.()
      await h.clock.advance(1)
      expect(await h.result).toEqual({ reason: 'gate:project-disabled', reported: null })
      expect(running(h)).toHaveLength(0)
    })

    it('is cut short by uncertainty and sends nothing until evidence returns', async () => {
      const h = startAttendant()
      h.service.holdCompatibility = {}
      await h.clock.advance(1)
      h.probe = { state: 'uncertain', reason: 'descriptor-missing' }
      await h.clock.advance(2_000)
      h.service.holdCompatibility.release?.()
      await h.clock.advance(10_000)
      expect(running(h)).toHaveLength(0)
      h.service.holdCompatibility = null
      h.probe = { state: 'running', activity: 'idle' }
      await h.clock.advance(2_000)
      expect(running(h)).toHaveLength(1)
      h.signal()
      await h.clock.advance(1)
    })

    it('ends without a running request when the session ended during discovery', async () => {
      const h = startAttendant()
      h.service.holdCompatibility = {}
      await h.clock.advance(1)
      h.probe = { state: 'ended', reason: 'harness-gone' }
      await h.clock.advance(2_000)
      h.service.holdCompatibility.release?.()
      await h.clock.advance(1)
      h.service.last().respond({ status: 'withdrawn' })
      expect(await h.result).toEqual({ reason: 'harness-gone', reported: 'ended' })
      expect(running(h)).toHaveLength(0)
    })
  })

  describe('write guard', () => {
    async function attendingWithHandle(): Promise<Harness> {
      const h = startAttendant({ acceptsMessages: true })
      await h.clock.advance(1)
      h.service.last().respond({
        status: 'attending',
        generation: 1,
        lease_remaining_ms: 120_000,
        message_cursor: 'c1',
        messages: [{ message_id: 'sm_1', created_at: 'x', agent_acknowledgement_text_required: true, kind: 'note', body: 'hi' }],
      })
      await h.clock.advance(1)
      expect(h.handle!.mayWrite()).toBe(true)
      return h
    }

    it('refuses at once when a gate fails, without waiting for a probe tick', async () => {
      const h = await attendingWithHandle()
      h.gate = { ok: false, reason: 'project-disabled' }
      expect(h.handle!.mayWrite()).toBe(false)
      h.service.last().respond({ status: 'withdrawn' })
      expect((await h.result).reason).toBe('gate:project-disabled')
    })

    it('refuses at once after a wall-clock jump and only a newer grant restores it', async () => {
      const h = await attendingWithHandle()
      const held = h.service.last()
      h.clock.wallTime += 3_600_000
      expect(h.handle!.mayWrite()).toBe(false)
      expect(held.aborted).toBe(true)
      await h.clock.advance(1)
      // The re-acquiring exchange is answered at once, never held.
      const reacquire = h.service.last()
      expect(reacquire.waitSeconds).toBe(0)
      reacquire.respond(h.service.attending(1))
      await h.clock.advance(1)
      expect(h.handle!.mayWrite()).toBe(true)
      h.signal()
      await h.clock.advance(1)
    })

    it('ignores a grant for an exchange sent before the jump', async () => {
      const h = await attendingWithHandle()
      const inFlight = h.service.last()
      // The grant was sent before the machine slept and is answered, but the
      // attendant has not processed it yet when the jump is seen: too late to
      // abort, and it must still not count as a fresh lease.
      inFlight.respond(h.service.attending(1))
      h.clock.wallTime += 3_600_000
      expect(h.handle!.mayWrite()).toBe(false)
      await h.clock.advance(1)
      expect(h.statuses.at(-1)?.phase).toBe('attending')
      expect(h.handle!.mayWrite()).toBe(false)
      // Only the re-acquiring exchange, sent after the jump, restores it.
      h.service.last().respond(h.service.attending(1))
      await h.clock.advance(1)
      expect(h.handle!.mayWrite()).toBe(true)
      h.signal()
      await h.clock.advance(1)
    })

    it('refuses on fresh uncertain evidence and on a lost claim', async () => {
      const h = await attendingWithHandle()
      h.probe = { state: 'uncertain', reason: 'descriptor-missing' }
      expect(h.handle!.mayWrite()).toBe(false)
      h.probe = { state: 'running', activity: 'idle' }
      h.claimHeld = false
      expect(h.handle!.mayWrite()).toBe(false)
      expect(await h.result).toEqual({ reason: 'claim-lost', reported: null })
    })
  })

  it('fences itself without a report when its claim disappears', async () => {
    const h = startAttendant()
    await h.clock.advance(1)
    h.service.last().respond(h.service.attending(2))
    await h.clock.advance(1)
    h.claimHeld = false
    await h.clock.advance(2_000)
    expect(await h.result).toEqual({ reason: 'claim-lost', reported: null })
    expect(h.service.exchanges.every((exchange) => exchange.body.state === 'running')).toBe(true)
  })
})
