import type {
  ClaimDeliveryAttemptRequestT,
  DeliveryAttemptOutcome,
} from '@raidiant/notifai-protocol'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApiCallError, NetworkError, type ApiClient } from './client.js'
import type { ProcessIdentity, ProcessLiveness } from './process-identity.js'
import { execFileSync } from 'node:child_process'
import {
  DELIVERY_WRITE_MARGIN_MS,
  JOURNAL_SWEEP_MAX_JOURNALS,
  acquireDeliveryLock,
  answerWriterGone,
  beginHandOff,
  deliveryJournalPath,
  answersAlreadyWritten,
  processGroupAlive,
  readDeliveryJournal,
  recordUnclaimedHandOffs,
  recoverDeliveryJournal,
  sweepDeliveryJournals,
  type DeliveryJournalEntry,
  type SequencerDeps,
} from './session-delivery.js'

const SESSION = 'session-delivery-test'
const SELF: ProcessIdentity = { pid: 4242, start: 'Fri Sep 25 10:00:00 2026' }
const GONE: ProcessIdentity = { pid: 777, start: 'Fri Sep 25 09:00:00 2026' }
const LEASE = { incarnation: 'inc_testincarnation', generation: 3 }

/** A service that grants claims unless told otherwise and records every report. */
class FakeAttempts {
  claims: ClaimDeliveryAttemptRequestT[] = []
  reports: Array<{ attemptId: string; outcome: DeliveryAttemptOutcome }> = []
  refuse: string | null = null
  failReports = 0
  failClaims = 0
  claimRemainingMs = 30_000
  private next = 0

  client(): ApiClient {
    return {
      claimDeliveryAttempt: async (_session: string, body: ClaimDeliveryAttemptRequestT) => {
        this.claims.push(body)
        if (this.failClaims > 0) {
          this.failClaims -= 1
          throw new NetworkError('offline')
        }
        if (this.refuse === 'not_found') throw new ApiCallError(404, 'not_found', 'missing')
        if (this.refuse !== null) {
          throw new ApiCallError(409, 'claim_refused', 'refused', null, { reason: this.refuse })
        }
        this.next += 1
        return { attempt_id: `att_${this.next}`, claim_remaining_ms: this.claimRemainingMs }
      },
      reportDeliveryAttempt: async (attemptId: string, body: { outcome: DeliveryAttemptOutcome }) => {
        if (this.failReports > 0) {
          this.failReports -= 1
          throw new NetworkError('offline')
        }
        this.reports.push({ attemptId, outcome: body.outcome })
        return { attempt_id: attemptId, outcome: body.outcome, replayed: false }
      },
    } as unknown as ApiClient
  }
}

function setup(liveness: (identity: ProcessIdentity) => ProcessLiveness = () => 'alive') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-delivery-'))
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'state') }
  const service = new FakeAttempts()
  let mono = 10_000
  const deps: SequencerDeps = {
    sessionId: SESSION,
    env,
    client: service.client(),
    monotonic: () => mono,
    wall: () => 1_790_000_000_000 + mono,
    sleep: async (milliseconds) => {
      mono += milliseconds
    },
    writer: SELF,
    liveness,
  }
  return {
    env,
    service,
    deps,
    advance: (milliseconds: number) => {
      mono += milliseconds
    },
  }
}

function seedJournal(env: NodeJS.ProcessEnv, entries: DeliveryJournalEntry[]): void {
  const file = deliveryJournalPath(SESSION, env)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ session_id: SESSION, entries }))
}

describe('per-session delivery sequencer', () => {
  it('claims under the lease, journals before and after the write, then reports the hand-off', async () => {
    const { env, service, deps } = setup()
    const handOff = await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'session_message', message_id: 'sm_one' }],
    })
    expect(handOff).not.toBeNull()
    expect(service.claims).toEqual([
      { incarnation: LEASE.incarnation, generation: 3, subject: { type: 'session_message', message_id: 'sm_one' } },
    ])
    expect(readDeliveryJournal(SESSION, env)).toMatchObject([{ attempt_id: 'att_1', stage: 'claimed', writer: SELF }])

    expect(handOff!.begin()).toBe(true)
    expect(readDeliveryJournal(SESSION, env)[0]!.stage).toBe('writing')
    await handOff!.finish('written')

    expect(service.reports).toEqual([{ attemptId: 'att_1', outcome: 'handed_off' }])
    expect(readDeliveryJournal(SESSION, env)[0]).toMatchObject({ stage: 'written', reported: 'handed_off' })
  })

  it('never begins a write inside the margin before the claim deadline, and releases the claim', async () => {
    const { service, deps, advance } = setup()
    const handOff = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'answer', request_id: 'req_late' }],
    }))!
    advance(30_000 - DELIVERY_WRITE_MARGIN_MS)
    let committed = false
    expect(handOff.begin(() => (committed = true))).toBe(false)
    expect(committed).toBe(false)
    await handOff.finish('not-written')
    expect(service.reports).toEqual([{ attemptId: 'att_1', outcome: 'released' }])
  })

  it('runs the caller fence after every check and writes nothing when it refuses', async () => {
    const { env, service, deps } = setup()
    const handOff = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'answer', request_id: 'req_fenced' }],
    }))!
    expect(handOff.begin(() => false)).toBe(false)
    expect(readDeliveryJournal(SESSION, env)[0]!.stage).toBe('claimed')
    await handOff.finish('not-written')
    expect(service.reports.map((report) => report.outcome)).toEqual(['released'])
  })

  it('reports a write that began and failed as unconfirmed, never as released', async () => {
    const { service, deps } = setup()
    const handOff = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'session_message', message_id: 'sm_torn' }],
    }))!
    expect(handOff.begin()).toBe(true)
    await handOff.finish('failed')
    expect(service.reports).toEqual([{ attemptId: 'att_1', outcome: 'unconfirmed' }])
  })

  it('treats a begun write that reports nothing written as unconfirmed', async () => {
    const { service, deps } = setup()
    const handOff = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'session_message', message_id: 'sm_unknown' }],
    }))!
    handOff.begin()
    await handOff.finish('not-written')
    expect(service.reports.map((report) => report.outcome)).toEqual(['unconfirmed'])
  })

  it('names each refusal and claims nothing for it', async () => {
    const { env, service, deps } = setup()
    service.refuse = 'awaiting_earlier_answer'
    const waiting = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'session_message', message_id: 'sm_edit' }],
    }))!
    expect(waiting.claimed).toEqual([])
    expect(waiting.refused).toEqual([
      { subject: { type: 'session_message', message_id: 'sm_edit' }, reason: 'awaiting_earlier_answer' },
    ])
    await waiting.finish('not-written')

    service.refuse = 'not_found'
    const missing = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'session_message', message_id: 'sm_gone' }],
    }))!
    expect(missing.refused[0]!.reason).toBe('not_found')
    await missing.finish('not-written')
    expect(service.reports).toEqual([])
    expect(readDeliveryJournal(SESSION, env)).toEqual([])
  })

  it('retries a claim whose response was lost, once', async () => {
    const { service, deps } = setup()
    service.failClaims = 1
    const handOff = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'session_message', message_id: 'sm_retry' }],
    }))!
    expect(service.claims).toHaveLength(2)
    expect(handOff.claimed).toHaveLength(1)
    await handOff.finish('not-written')
  })

  it('attaches the writer-gone proof only when the caller proves it', async () => {
    const { service, deps } = setup()
    const handOff = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'session_message', message_id: 'sm_edit' }],
      earlierAnswerWriterGone: () => true,
    }))!
    await handOff.finish('not-written')
    expect(service.claims[0]).toMatchObject({ earlier_answer_writer_gone: true })

    const plain = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'session_message', message_id: 'sm_note' }],
    }))!
    await plain.finish('not-written')
    expect(service.claims[1]).not.toHaveProperty('earlier_answer_writer_gone')
  })

  it('serialises writers: a second hand-off waits for the lock and gives up without claiming', async () => {
    const { service, deps } = setup()
    const held = (await acquireDeliveryLock(deps))!
    const blocked = await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'session_message', message_id: 'sm_blocked' }],
      lockWaitMs: 500,
    })
    expect(blocked).toBeNull()
    expect(service.claims).toEqual([])
    held.release()
    const next = await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'session_message', message_id: 'sm_blocked' }],
    })
    expect(next).not.toBeNull()
    await next!.finish('not-written')
  })

  it('keeps an unreported outcome and reports it at the next recovery', async () => {
    const { env, service, deps } = setup()
    service.failReports = 3
    const handOff = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'session_message', message_id: 'sm_offline' }],
    }))!
    handOff.begin()
    await handOff.finish('written')
    expect(service.reports).toEqual([])
    expect(readDeliveryJournal(SESSION, env)[0]).toMatchObject({ stage: 'written' })
    expect(readDeliveryJournal(SESSION, env)[0]!.reported).toBeUndefined()

    await recoverDeliveryJournal(deps)
    expect(service.reports).toEqual([{ attemptId: 'att_1', outcome: 'handed_off' }])
  })
})

describe('journal recovery for writers that died before reporting', () => {
  const stages = [
    ['claimed', 'released'],
    ['writing', 'unconfirmed'],
    ['failed', 'unconfirmed'],
    ['written', 'handed_off'],
  ] as const

  for (const [stage, outcome] of stages) {
    it(`reports a gone writer's ${stage} attempt as ${outcome}`, async () => {
      const { env, service, deps } = setup((identity) => (identity.pid === GONE.pid ? 'gone' : 'alive'))
      seedJournal(env, [
        {
          attempt_id: 'att_dead',
          subject: { type: 'answer', request_id: 'req_dead' },
          stage,
          writer: GONE,
          claimed_at: 1,
        },
      ])
      expect(await recoverDeliveryJournal(deps)).toBe(1)
      expect(service.reports).toEqual([{ attemptId: 'att_dead', outcome }])
      expect(readDeliveryJournal(SESSION, env)[0]!.reported).toBe(outcome)
    })
  }

  it("never reports a live writer's attempt, and does not trust unknown liveness", async () => {
    const { env, service, deps } = setup((identity) => (identity.pid === 1 ? 'unknown' : 'alive'))
    seedJournal(env, [
      { attempt_id: 'att_live', subject: { type: 'answer', request_id: 'req_a' }, stage: 'writing', writer: { pid: 99, start: 'x' }, claimed_at: 1 },
      { attempt_id: 'att_unknown', subject: { type: 'answer', request_id: 'req_b' }, stage: 'writing', writer: { pid: 1, start: 'y' }, claimed_at: 1 },
    ])
    expect(await recoverDeliveryJournal(deps)).toBe(0)
    expect(service.reports).toEqual([])
  })

  it('reads a corrupt journal as no evidence', async () => {
    const { env, service, deps } = setup(() => 'gone')
    const file = deliveryJournalPath(SESSION, env)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{"entries": [ {"attempt_id": 3 } ')
    expect(readDeliveryJournal(SESSION, env)).toEqual([])
    expect(await recoverDeliveryJournal(deps)).toBe(0)
    expect(service.reports).toEqual([])
  })
})

describe('Answer Edit release proof', () => {
  it('is proven only when the journal names the fenced answer’s writer and that writer is gone', () => {
    const { env } = setup()
    const gone = (identity: ProcessIdentity): ProcessLiveness => (identity.pid === GONE.pid ? 'gone' : 'alive')
    expect(answerWriterGone(SESSION, env, 'req_x', gone)).toBe(false)
    seedJournal(env, [
      { attempt_id: 'att_old', subject: { type: 'answer', request_id: 'req_x' }, stage: 'written', writer: SELF, claimed_at: 1 },
      { attempt_id: 'att_new', subject: { type: 'answer', request_id: 'req_x' }, stage: 'writing', writer: GONE, claimed_at: 2 },
    ])
    expect(answerWriterGone(SESSION, env, 'req_x', gone)).toBe(true)
    expect(answerWriterGone(SESSION, env, 'req_other', gone)).toBe(false)
  })

  it('stays unproven for a writer suspended past its deadline but before its write', async () => {
    // The writer passed the deadline check and journaled `writing`, then was
    // suspended. It may still write, so no Answer Edit may be released behind
    // it, however long ago its claim deadline passed.
    const { env, service, deps, advance } = setup()
    const handOff = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'answer', request_id: 'req_suspended' }],
    }))!
    expect(handOff.begin()).toBe(true)
    advance(10 * 60_000)
    expect(answerWriterGone(SESSION, env, 'req_suspended', () => 'alive')).toBe(false)
    // Even a liveness check that says gone does not release an attempt this
    // process still has in flight.
    expect(answerWriterGone(SESSION, env, 'req_suspended', () => 'gone')).toBe(false)
    await handOff.finish('written')
    expect(service.reports).toEqual([{ attemptId: 'att_1', outcome: 'handed_off' }])
  })
})

describe('claim deadline at the write itself', () => {
  it('re-checks the deadline after blocking checks and persistence, and writes nothing late', async () => {
    const { env, service, deps, advance } = setup()
    const handOff = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'answer', request_id: 'req_slow' }],
      // A lease check that blocks until one second past the 30 s deadline.
      mayWrite: () => {
        advance(31_000)
        return true
      },
    }))!
    let committed = false
    expect(handOff.begin(() => (committed = true))).toBe(false)
    expect(committed).toBe(false)
    await handOff.finish('not-written')
    expect(service.reports).toEqual([{ attemptId: 'att_1', outcome: 'released' }])
    expect(readDeliveryJournal(SESSION, env)[0]).toMatchObject({ stage: 'released' })
  })

  it('reverts a write that a slow commit pushed past the margin to claimed, then releases it', async () => {
    const { env, service, deps, advance } = setup()
    const handOff = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'answer', request_id: 'req_commit' }],
    }))!
    expect(
      handOff.begin(() => {
        advance(29_000)
        return true
      }),
    ).toBe(false)
    expect(readDeliveryJournal(SESSION, env)[0]).toMatchObject({ stage: 'claimed' })
    await handOff.finish('not-written')
    expect(service.reports.map((report) => report.outcome)).toEqual(['released'])
  })

  it('closes the socket boundary before the deadline and reports an aborted write as released', async () => {
    const { service, deps, advance } = setup()
    const handOff = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'session_message', message_id: 'sm_late_socket' }],
    }))!
    expect(handOff.begin()).toBe(true)
    expect(handOff.writable()).toBe(true)
    expect(handOff.remainingMs()).toBe(30_000 - 500)
    advance(30_000 - 500)
    expect(handOff.writable()).toBe(false)
    expect(handOff.remainingMs()).toBe(0)
    await handOff.finish('aborted')
    expect(service.reports).toEqual([{ attemptId: 'att_1', outcome: 'released' }])
  })
})

describe('subprocess writers in the Answer Edit release proof', () => {
  const gone = (identity: ProcessIdentity): ProcessLiveness => (identity.pid === GONE.pid ? 'gone' : 'alive')

  it('journals a subprocess write and its process group as soon as it exists', async () => {
    const { env, deps } = setup()
    const handOff = (await beginHandOff(deps, {
      lease: LEASE,
      subjects: [{ type: 'answer', request_id: 'req_resume' }],
    }))!
    expect(handOff.begin(undefined, { subprocess: true })).toBe(true)
    expect(readDeliveryJournal(SESSION, env)[0]).toMatchObject({ stage: 'writing', subprocess: true })
    handOff.recordGroup(9191)
    expect(readDeliveryJournal(SESSION, env)[0]!.groups).toEqual([9191])
    await handOff.finish('written')
  })

  it('proves a subprocess writer gone only when its whole recorded group is gone', () => {
    const { env } = setup()
    const entry = (groups?: number[]): DeliveryJournalEntry => ({
      attempt_id: 'att_resume',
      subject: { type: 'answer', request_id: 'req_resume' },
      stage: 'writing',
      writer: GONE,
      subprocess: true,
      ...(groups === undefined ? {} : { groups }),
      claimed_at: 1,
    })
    seedJournal(env, [entry()])
    // The waiter died before the child's group was journaled: unknowable.
    expect(answerWriterGone(SESSION, env, 'req_resume', gone, () => false)).toBe(false)
    seedJournal(env, [entry([9191])])
    // The resumed harness outlived the waiter and may still write.
    expect(answerWriterGone(SESSION, env, 'req_resume', gone, () => true)).toBe(false)
    expect(answerWriterGone(SESSION, env, 'req_resume', gone, () => false)).toBe(true)
  })

  it('asks the operating system about a whole process group', () => {
    expect(processGroupAlive(process.pid === 1 ? 2 : Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()))).toBe(true)
    expect(processGroupAlive(2_147_483_000)).toBe(false)
  })
})

describe('machine-wide journal sweep', () => {
  function seedSession(env: NodeJS.ProcessEnv, sessionId: string, entries: DeliveryJournalEntry[]): void {
    const file = deliveryJournalPath(sessionId, env)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ session_id: sessionId, entries }))
  }

  it("reports gone writers' attempts from sessions that never ran again, bounded and rate-limited", async () => {
    const { env, service, deps } = setup()
    const dead = (id: string, stage: DeliveryJournalEntry['stage']): DeliveryJournalEntry => ({
      attempt_id: id,
      subject: { type: 'session_message', message_id: `sm_${id}` },
      stage,
      writer: GONE,
      claimed_at: 1,
    })
    seedSession(env, 'ended-a', [dead('att_a', 'written')])
    seedSession(env, 'ended-b', [dead('att_b', 'writing'), { ...dead('att_live', 'writing'), writer: { pid: 99, start: 'x' } }])
    const input = {
      env,
      client: deps.client,
      writer: SELF,
      now: 1_790_000_000_000,
      liveness: (identity: ProcessIdentity): ProcessLiveness => (identity.pid === GONE.pid ? 'gone' : 'alive'),
    }
    expect(await sweepDeliveryJournals(input)).toBe(2)
    expect(service.reports.sort((a, b) => a.attemptId.localeCompare(b.attemptId))).toEqual([
      { attemptId: 'att_a', outcome: 'handed_off' },
      { attemptId: 'att_b', outcome: 'unconfirmed' },
    ])
    // Rate-limited: a second sweep within the interval touches nothing.
    seedSession(env, 'ended-c', [dead('att_c', 'claimed')])
    expect(await sweepDeliveryJournals({ ...input, now: input.now + 1_000 })).toBe(0)
    expect(await sweepDeliveryJournals({ ...input, force: true })).toBe(1)
    expect(service.reports.at(-1)).toEqual({ attemptId: 'att_c', outcome: 'released' })
  })

  it(`sweeps at most ${JOURNAL_SWEEP_MAX_JOURNALS} journals`, async () => {
    const { env, service, deps } = setup()
    for (let index = 0; index < JOURNAL_SWEEP_MAX_JOURNALS + 5; index += 1) {
      seedSession(env, `many-${index}`, [
        { attempt_id: `att_${index}`, subject: { type: 'answer', request_id: `req_${index}` }, stage: 'claimed', writer: GONE, claimed_at: 1 },
      ])
    }
    await sweepDeliveryJournals({ env, client: deps.client, writer: SELF, now: Date.now(), liveness: () => 'gone' })
    expect(service.reports).toHaveLength(JOURNAL_SWEEP_MAX_JOURNALS)
  })
})

describe('answers written without a claim', () => {
  it('journals the hand-off first and records it later when the first record fails', async () => {
    const { env, deps } = setup()
    const recorded: ClaimDeliveryAttemptRequestT[] = []
    let offline = true
    const client = {
      claimDeliveryAttempt: async (_session: string, body: ClaimDeliveryAttemptRequestT) => {
        if (offline) throw new NetworkError('offline')
        recorded.push(body)
        return { attempt_id: 'att_recorded', claim_remaining_ms: 0, outcome: 'handed_off' as const }
      },
    } as unknown as ApiClient
    await recordUnclaimedHandOffs({ ...deps, client }, ['req_unclaimed'])
    expect(readDeliveryJournal(SESSION, env)).toMatchObject([
      { attempt_id: 'unclaimed:req_unclaimed', stage: 'written', unclaimed: true },
    ])
    expect(readDeliveryJournal(SESSION, env)[0]!.reported).toBeUndefined()
    // A replay of the answer is suppressed from the journal alone.
    expect(answersAlreadyWritten(SESSION, env, ['req_unclaimed'])).toEqual([{ requestId: 'req_unclaimed', stage: 'written' }])

    // The service is back: recovery records it, whoever runs it, and only once.
    offline = false
    expect(await recoverDeliveryJournal({ ...deps, client, writer: { pid: 1, start: 'someone else' } })).toBe(1)
    expect(recorded).toEqual([{ subject: { type: 'answer', request_id: 'req_unclaimed' }, already_handed_off: true }])
    expect(readDeliveryJournal(SESSION, env)[0]).toMatchObject({ reported: 'handed_off' })
    expect(await recoverDeliveryJournal({ ...deps, client })).toBe(0)
    expect(recorded).toHaveLength(1)
  })

  it('settles a refused record for good instead of retrying it', async () => {
    const { env, deps } = setup()
    let calls = 0
    const client = {
      claimDeliveryAttempt: async () => {
        calls += 1
        throw new ApiCallError(409, 'claim_refused', 'refused', null, { reason: 'not_claimable' })
      },
    } as unknown as ApiClient
    await recordUnclaimedHandOffs({ ...deps, client }, ['req_other_machine'])
    expect(readDeliveryJournal(SESSION, env)[0]).toMatchObject({ reported: 'released', refused: 'not_claimable' })
    await recoverDeliveryJournal({ ...deps, client })
    expect(calls).toBe(1)
  })

  it('lets the machine-wide sweep record an unclaimed hand-off a session never retried', async () => {
    const { env, deps, service } = setup()
    const file = deliveryJournalPath('ended-unclaimed', env)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        session_id: 'ended-unclaimed',
        entries: [
          {
            attempt_id: 'unclaimed:req_x',
            subject: { type: 'answer', request_id: 'req_x' },
            stage: 'written',
            // A live writer does not matter: the write already happened.
            writer: { pid: 99, start: 'alive' },
            unclaimed: true,
            claimed_at: 1,
          },
        ],
      }),
    )
    const recorded: ClaimDeliveryAttemptRequestT[] = []
    const client = {
      ...deps.client,
      claimDeliveryAttempt: async (_session: string, body: ClaimDeliveryAttemptRequestT) => {
        recorded.push(body)
        return { attempt_id: 'att_recorded', claim_remaining_ms: 0, outcome: 'handed_off' as const }
      },
    } as unknown as ApiClient
    expect(
      await sweepDeliveryJournals({ env, client, writer: SELF, now: Date.now(), liveness: () => 'alive', force: true }),
    ).toBe(1)
    expect(recorded).toHaveLength(1)
    expect(service.reports).toEqual([])
  })
})

describe('sweep selection never starves a journal that owes something', () => {
  it('recovers an owing journal however many settled or live-writer journals surround it', async () => {
    const { env, service, deps } = setup()
    const seed = (sessionId: string, entry: Partial<DeliveryJournalEntry>): void => {
      const file = deliveryJournalPath(sessionId, env)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(
        file,
        JSON.stringify({
          session_id: sessionId,
          entries: [
            { attempt_id: `att_${sessionId}`, subject: { type: 'answer', request_id: `req_${sessionId}` }, stage: 'written', writer: GONE, claimed_at: 1, ...entry },
          ],
        }),
      )
    }
    // More settled journals, and more journals whose writer is still alive,
    // than one sweep recovers.
    for (let index = 0; index < JOURNAL_SWEEP_MAX_JOURNALS + 10; index += 1) {
      seed(`settled-${index}`, { reported: 'handed_off', reported_at: Date.now() })
      seed(`live-${index}`, { writer: { pid: 99, start: 'alive' } })
    }
    seed('owing-old', { stage: 'writing' })
    // The oldest journal on disk: a newest-first selection would never reach it.
    const past = new Date(Date.now() - 3 * 24 * 3600 * 1000)
    utimesSync(deliveryJournalPath('owing-old', env), past, past)
    const liveness = (identity: ProcessIdentity): ProcessLiveness => (identity.pid === GONE.pid ? 'gone' : 'alive')
    expect(await sweepDeliveryJournals({ env, client: deps.client, writer: SELF, now: Date.now(), liveness, force: true })).toBe(1)
    expect(service.reports).toEqual([{ attemptId: 'att_owing-old', outcome: 'unconfirmed' }])
  })
})
