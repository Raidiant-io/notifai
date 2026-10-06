import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AttendanceRequestT, AttendanceResponse } from '@raidiant/notifai-protocol'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from './client.js'
import { attendHook, attendantGates } from './commands-hook-attend.js'
import { hookRunCommand } from './commands-hook-run.js'
import type { CommandDeps, CommandIo } from './commands.js'
import { sanitizeSessionId, stateDir } from './config.js'
import { acquireClaimFile, claimQuestionPush, readClaimFile, releaseQuestionPush } from './hook-question-lock.js'
import {
  beginSessionIncarnation,
  endsIncarnation,
  happenedBefore,
  lifecycleStamp,
  markSessionEnded,
  pruneAbandonedSessions,
  readSessionEndMarker,
  readSessionIncarnation,
  readSessionState,
  recordSessionNotified,
  recordSessionStart,
  refreshSessionMarkers,
  sessionHasEnded,
  updateSessionState,
} from './hook-session-state.js'
import { hookAdapterPath, inspectHookAdapter, installHookAdapter } from './hook-adapter.js'
import { buildHookConfig, codexTrustKey, codexHookIdentityHash, findInstallations } from './install-hooks.js'
import { nullLogger } from './logging.js'
import { currentProcessIdentity, processExecutableName, processStartTime } from './process-identity.js'
import { disableProject, enableProject, projectBinding } from './project-enablement.js'
import type { AttendantResult } from './session-attendant.js'
import {
  attendantSupport,
  claudeAttendanceProbe,
  codexAttendanceProbe,
  type ClaudeProbeAdapters,
} from './session-attendant-probe.js'
import {
  attendantClaimPath,
  attendantStatusPath,
  listAttendantReports,
  readAttendantLease,
  readTurnActivity,
  recordTurnEnd,
  recordTurnStart,
  writeAttendantStatus,
} from './session-attendant-state.js'
import { readDeliveryJournal } from './session-delivery.js'
import { codexToolHookReady } from './codex-tool-messages.js'
import { inputWakeToken, readSessionMessages, sessionInputWake } from './session-inputs.js'
import { integrationFaultNotice } from './integration-health.js'
import type { QueueControl } from './codex-queue-control.js'
import { readInputWakes } from './session-input-wakes.js'

const HARNESS = { pid: 4242, start: 'Fri Sep 25 11:12:08 2026' }

function isolatedEnv(): { env: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-attendant-'))
  return {
    root,
    env: {
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      PATH: process.env['PATH'],
    },
  }
}

describe('beginSessionIncarnation', () => {
  it('drops an end recorded before this start, whichever SessionStart handler runs first', () => {
    const { env } = isolatedEnv()
    const first = beginSessionIncarnation('s1', env, { stamp: lifecycleStamp(1_000), harnessProcess: HARNESS })
    markSessionEnded('s1', env, 2_000)
    expect(endsIncarnation(readSessionEndMarker('s1', env), first)).toBe(true)

    // In-process /resume: the attend handler runs before the paused activation handler.
    const invoked = lifecycleStamp(3_000)
    const attend = beginSessionIncarnation('s1', env, { stamp: invoked, harnessProcess: HARNESS })
    expect(attend.incarnation).not.toBe(first.incarnation)
    expect(readSessionEndMarker('s1', env)).toBeNull()

    // The activation handler of the same start resumes afterwards and joins it.
    recordSessionStart('s1', env, 'claude-code', '/work', undefined, invoked)
    expect(readSessionIncarnation('s1', env)?.incarnation).toBe(attend.incarnation)
  })

  it('agrees on one incarnation when activation runs first', () => {
    const { env } = isolatedEnv()
    markSessionEnded('s2', env, 500)
    const invoked = lifecycleStamp(1_000)
    recordSessionStart('s2', env, 'claude-code', '/work', undefined, invoked)
    const activation = readSessionIncarnation('s2', env)!
    const attend = beginSessionIncarnation('s2', env, { stamp: invoked, harnessProcess: HARNESS })
    expect(attend.incarnation).toBe(activation.incarnation)
    expect(attend.harness_process).toEqual(HARNESS)
  })

  it('a delayed handler keeps an end that came after its own invocation: that end is its start\'s', () => {
    const { env } = isolatedEnv()
    const invoked = lifecycleStamp(4_000)
    // The activation handler joined this start, then the session ended, then
    // the slow async handler of the same start finally runs.
    recordSessionStart('s3', env, 'claude-code', '/work', undefined, invoked)
    const started = readSessionIncarnation('s3', env)!
    markSessionEnded('s3', env, 5_000)
    const late = beginSessionIncarnation('s3', env, { stamp: invoked, harnessProcess: HARNESS })
    expect(late.key).toBe(started.key)
    expect(endsIncarnation(readSessionEndMarker('s3', env), late)).toBe(true)
  })

  it('orders lifecycle edges without the wall clock: a backward step cannot end a resumed session', () => {
    const { env } = isolatedEnv()
    beginSessionIncarnation('s6', env, { stamp: lifecycleStamp(10_000), harnessProcess: HARNESS })
    markSessionEnded('s6', env, 11_000)
    // The wall clock stepped back to 5 000 before the in-process resume.
    const resumed = beginSessionIncarnation('s6', env, { stamp: lifecycleStamp(5_000), harnessProcess: HARNESS })
    expect(readSessionEndMarker('s6', env)).toBeNull()
    expect(endsIncarnation(readSessionEndMarker('s6', env), resumed)).toBe(false)
    // And the resumed incarnation's own end, whatever its wall time, ends it.
    markSessionEnded('s6', env, 1)
    expect(endsIncarnation(readSessionEndMarker('s6', env), resumed)).toBe(true)
  })

  it('treats an end from an earlier boot as earlier, whatever its monotonic value', () => {
    const later = { wall: 0, mono: (process.hrtime.bigint() + 10n ** 15n).toString() }
    expect(happenedBefore(later, lifecycleStamp())).toBe(true)
    const reference = lifecycleStamp()
    expect(happenedBefore(lifecycleStamp(), reference)).toBe(false)
  })

  it('mints a new incarnation for a new harness process and keeps it for /compact', () => {
    const { env } = isolatedEnv()
    const first = beginSessionIncarnation('s4', env, { stamp: lifecycleStamp(), harnessProcess: HARNESS })
    const compact = beginSessionIncarnation('s4', env, { stamp: lifecycleStamp(), harnessProcess: HARNESS })
    expect(compact.incarnation).toBe(first.incarnation)
    const resumed = beginSessionIncarnation('s4', env, {
      stamp: lifecycleStamp(),
      harnessProcess: { pid: 5151, start: 'Fri Sep 25 12:00:00 2026' },
    })
    expect(resumed.incarnation).not.toBe(first.incarnation)
  })

  it('a re-arm never drops the shared end marker', () => {
    const { env } = isolatedEnv()
    markSessionEnded('s5', env, 1_000)
    const rearmed = beginSessionIncarnation('s5', env, {
      stamp: lifecycleStamp(),
      harnessProcess: HARNESS,
      clearEarlierEnd: false,
    })
    expect(sessionHasEnded('s5', env)).toBe(true)
    expect(endsIncarnation(readSessionEndMarker('s5', env), rearmed)).toBe(false)
  })

  it('keeps a live attendant claim through the abandoned-state prune', () => {
    const { env } = isolatedEnv()
    const claim = attendantClaimPath('s7', env)
    mkdirSync(path.dirname(claim), { recursive: true })
    writeFileSync(claim, '{}')
    beginSessionIncarnation('s7', env, { stamp: lifecycleStamp(), harnessProcess: HARNESS })
    const eightDays = 8 * 24 * 3600 * 1000
    const later = Date.now() + eightDays
    // The attendant's hourly heartbeat, a week on.
    refreshSessionMarkers('s7', env, later, [claim])
    expect(pruneAbandonedSessions(env, later + 60_000)).toBe(0)
    expect(existsSync(claim)).toBe(true)
  })
})

describe('claim ownership by PID and process start time', () => {
  it('replaces a holder whose PID now belongs to a different process', () => {
    const { env } = isolatedEnv()
    const self = currentProcessIdentity()
    expect(self).not.toBeNull()
    const file = path.join(stateDir(env), 'sessions', `${sanitizeSessionId('q1')}.claim`)
    mkdirSync(path.dirname(file), { recursive: true })
    // A live PID (this one) recorded with another start time: the PID was reused.
    writeFileSync(file, JSON.stringify({ pid: process.pid, start: 'Mon Jan 1 00:00:00 2001', at: 1, token: 't' }))
    expect(claimQuestionPush('q1', env)).toBe(true)
    const held = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; start: string }
    expect(held).toMatchObject({ pid: process.pid, start: self!.start })
    // The live holder with a matching start time keeps it.
    expect(claimQuestionPush('q1', env)).toBe(false)
    releaseQuestionPush('q1', env)
    expect(existsSync(file)).toBe(false)
  })
})

describe('Claude exact-session probe', () => {
  function adapters(overrides: Partial<ClaudeProbeAdapters> & { descriptor?: unknown } = {}): ClaudeProbeAdapters {
    const descriptor =
      'descriptor' in overrides
        ? overrides.descriptor
        : {
            pid: HARNESS.pid,
            sessionId: 'sess',
            cwd: '/work',
            startedAt: 1,
            procStart: 'Fri Sep 25 11:12:08 2026',
            version: '2.1.282',
            peerProtocol: 1,
            messagingSocketPath: '/tmp/x.sock',
            status: 'idle',
          }
    return {
      readDescriptor: () => {
        if (descriptor === undefined) throw new Error('ENOENT')
        return descriptor
      },
      pidExists: () => true,
      readStart: () => 'Fri Sep 25  11:12:08 2026 ',
      parentPid: () => 1,
      ...overrides,
    }
  }
  const probeWith = (a: ClaudeProbeAdapters, ended = false) =>
    claudeAttendanceProbe({ sessionId: 'sess', harness: HARNESS, endedByHook: () => ended, adapters: a })()

  it('reports running with the descriptor activity', () => {
    expect(probeWith(adapters())).toEqual({ state: 'running', activity: 'idle' })
    const busy = adapters({
      descriptor: { ...(adapters().readDescriptor(0) as object), status: 'busy' },
    })
    expect(probeWith(busy)).toEqual({ state: 'running', activity: 'working' })
  })

  it('reads a missing descriptor as uncertain while the process lives, ended once it is gone', () => {
    expect(probeWith(adapters({ descriptor: undefined }))).toEqual({
      state: 'uncertain',
      reason: 'descriptor-missing',
    })
    expect(probeWith(adapters({ descriptor: undefined, readStart: () => null, pidExists: () => false }))).toEqual({
      state: 'ended',
      reason: 'harness-gone',
    })
    // PID reused by another process: same PID, different start time.
    expect(probeWith(adapters({ descriptor: undefined, readStart: () => 'Sat Sep 26 09:00:00 2026' }))).toEqual({
      state: 'ended',
      reason: 'harness-gone',
    })
  })

  it('ends when /clear or /resume replaced the session in the same process', () => {
    const replaced = adapters({ descriptor: { ...(adapters().readDescriptor(0) as object), sessionId: 'other' } })
    expect(probeWith(replaced)).toEqual({ state: 'ended', reason: 'session-replaced' })
  })

  it('never claims running when the descriptor start disagrees', () => {
    const stale = adapters({ descriptor: { ...(adapters().readDescriptor(0) as object), procStart: 'Thu Sep 24 08:00:00 2026' } })
    expect(probeWith(stale)).toEqual({ state: 'uncertain', reason: 'process-start-mismatch' })
  })

  it('stays uncertain until a start-time check succeeds again, re-checking on every probe', () => {
    let start: string | null = null
    const probe = claudeAttendanceProbe({
      sessionId: 'sess',
      harness: HARNESS,
      endedByHook: () => false,
      adapters: adapters({ readStart: () => start }),
    })
    // The lookup fails: never running, on this probe or the next.
    expect(probe()).toEqual({ state: 'uncertain', reason: 'process-start-unreadable' })
    expect(probe()).toEqual({ state: 'uncertain', reason: 'process-start-unreadable' })
    start = HARNESS.start
    expect(probe()).toEqual({ state: 'running', activity: 'idle' })
    // The PID is reused while the old descriptor remains: caught on the very next probe.
    start = 'Sat Sep 26 09:00:00 2026'
    expect(probe()).toEqual({ state: 'ended', reason: 'harness-gone' })
  })

  it('proves identity from a living parent without a lookup, and looks up once orphaned', () => {
    let parent = HARNESS.pid
    let lookups = 0
    const probe = claudeAttendanceProbe({
      sessionId: 'sess',
      harness: HARNESS,
      endedByHook: () => false,
      adapters: adapters({
        parentPid: () => parent,
        readStart: () => {
          lookups += 1
          return null
        },
      }),
    })
    expect(probe()).toEqual({ state: 'running', activity: 'idle' })
    expect(lookups).toBe(0)
    // Reparented: the parent exited, and its PID now belongs to someone else.
    parent = 1
    expect(probe()).toEqual({ state: 'uncertain', reason: 'process-start-unreadable' })
    expect(lookups).toBe(1)
  })

  it('takes the SessionEnd marker as the fast end path', () => {
    expect(probeWith(adapters(), true)).toEqual({ state: 'ended', reason: 'session-end-hook' })
  })
})

class CapturedIo implements CommandIo {
  out(): void {}
  err(): void {}
  async confirm(): Promise<boolean> {
    return false
  }
  openUrl(): void {}
}

function stdin(value: unknown): () => Promise<string> {
  return async () => JSON.stringify(value)
}

interface FakeAttendance {
  calls: AttendanceRequestT[]
  client: ApiClient
}

function fakeAttendance(): FakeAttendance {
  const calls: AttendanceRequestT[] = []
  const client = {
    compatibility: async () => ({ server_capabilities: ['session_attendance'] }),
    attend: async (_session: string, body: AttendanceRequestT): Promise<AttendanceResponse> => {
      calls.push(body)
      if (body.state !== 'running') return { status: 'withdrawn' }
      // Answer the first exchange, then hold like a long poll would.
      if (calls.length > 1) await new Promise((resolve) => setTimeout(resolve, 20))
      return { status: 'attending', generation: 1, lease_remaining_ms: 120_000, message_cursor: 'c', messages: [] }
    },
  } as unknown as ApiClient
  return { calls, client }
}

function attendDeps(env: NodeJS.ProcessEnv, cwd: string, extra: Partial<CommandDeps> = {}): CommandDeps & {
  exits: AttendantResult[]
} {
  const exits: AttendantResult[] = []
  const descriptorSession = { value: 'sess-a' }
  return {
    exits,
    io: new CapturedIo(),
    env,
    cwd,
    store: {
      load: () => ({ machineId: 'mac_test', secret: 'test-secret', baseUrl: 'https://test.notifai.invalid', machineName: 'm' }),
      save: () => {},
      clear: () => {},
    } as unknown as CommandDeps['store'],
    attendant: {
      harnessProcess: HARNESS,
      probeAdapters: {
        readDescriptor: () => ({
          pid: HARNESS.pid,
          sessionId: descriptorSession.value,
          cwd,
          startedAt: 1,
          procStart: HARNESS.start,
          version: '2.1.282',
          peerProtocol: 1,
          messagingSocketPath: '/tmp/x.sock',
          status: 'idle',
        }),
        pidExists: () => true,
        readStart: () => HARNESS.start,
        parentPid: () => 1,
      },
      gates: () => ({ ok: true }),
      probeIntervalMs: 10,
      supersededOwnerWaitMs: 50,
      onExit: (result) => exits.push(result),
    },
    ...extra,
  }
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('notifai hook attend', () => {
  it('records a removed contract before withdrawal without consuming the agent fault notice', async () => {
    const { env, root } = isolatedEnv()
    const service = fakeAttendance()
    let removed = false
    const deps = attendDeps(env, root, { clientFactory: () => service.client })
    deps.attendant!.gates = () => removed ? { ok: false, reason: 'attend-handler-removed' } : { ok: true }
    recordSessionNotified('sess-a', env, Date.now())
    const running = hookRunCommand(deps, 'attend', stdin({ session_id: 'sess-a', cwd: root,
      hook_event_name: 'SessionStart', source: 'startup' }), 'claude-code')
    try {
      await until(() => service.calls.length > 0, 'resident observer')
      removed = true
      await running
      expect(deps.exits).toEqual([{ reason: 'gate:attend-handler-removed', reported: 'withdrawn' }])
      expect(integrationFaultNotice(deps, 'claude-code')).toContain('hooks-missing')
      expect(integrationFaultNotice(deps, 'claude-code')).toBeUndefined()
    } finally {
      markSessionEnded('sess-a', env, Date.now() + 1)
      await running
    }
  })

  it('becomes the attendant despite a stale end marker, and a second start exits at once', async () => {
    const { env, root } = isolatedEnv()
    const deps = attendDeps(env, root)
    markSessionEnded('sess-a', env, Date.now() - 60_000)
    const envelope = { session_id: 'sess-a', cwd: root, hook_event_name: 'SessionStart', source: 'resume' }

    const first = hookRunCommand(deps, 'attend', stdin(envelope), 'claude-code')
    await until(() => listAttendantReports(env).some((report) => report.phase === 'dormant'), 'dormant attendant')
    expect(readSessionEndMarker('sess-a', env)).toBeNull()

    // Re-arm from the next prompt: a healthy owner already serves this incarnation.
    const started = Date.now()
    await hookRunCommand(deps, 'attend', stdin({ session_id: 'sess-a', cwd: root, hook_event_name: 'UserPromptSubmit' }), 'claude-code')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(deps.exits).toHaveLength(0)

    // SessionEnd for this incarnation ends it; it never notified, so nothing is reported.
    markSessionEnded('sess-a', env, Date.now() + 1)
    await first
    expect(deps.exits).toEqual([{ reason: 'session-end-hook', reported: null }])
    expect(existsSync(attendantClaimPath('sess-a', env))).toBe(false)
    expect(listAttendantReports(env)[0]).toMatchObject({ session_id: 'sess-a', phase: 'exited', alive: false })
  })

  it('wakes on the first accepted request and reports ended when the session is replaced', async () => {
    const { env, root } = isolatedEnv()
    const service = fakeAttendance()
    const deps = attendDeps(env, root, { clientFactory: () => service.client })
    const envelope = { session_id: 'sess-a', cwd: root, hook_event_name: 'SessionStart', source: 'startup' }
    const running = hookRunCommand(deps, 'attend', stdin(envelope), 'claude-code')
    await until(() => listAttendantReports(env).some((report) => report.phase === 'dormant'), 'dormant attendant')
    expect(service.calls).toHaveLength(0)

    recordSessionNotified('sess-a', env, Date.now())
    await until(() => service.calls.length >= 2, 'attendance exchanges')
    expect(service.calls[0]).toMatchObject({ state: 'running', activity: 'idle', accepts_messages: false })
    expect(service.calls[0]?.incarnation).toBe(readSessionIncarnation('sess-a', env)?.incarnation)

    // /clear: the descriptor now names a different session id.
    const adapters = deps.attendant!.probeAdapters!
    const read = adapters.readDescriptor
    adapters.readDescriptor = (pid) => ({ ...(read(pid) as object), sessionId: 'sess-b' })
    await running
    expect(deps.exits).toEqual([{ reason: 'session-replaced', reported: 'ended' }])
    expect(service.calls.at(-1)).toMatchObject({ state: 'ended', generation: 1 })
  })

  it.each(['note', 'answer'] as const)('wakes a Claude %s through its resident writer, including empty note batches', async (kind) => {
    const { env, root } = isolatedEnv()
    const socket = path.join(root, 'inbox.sock')
    writeFileSync(socket, '')
    const descriptor = {
      pid: HARNESS.pid,
      sessionId: 'sess-a',
      cwd: root,
      startedAt: 1,
      procStart: HARNESS.start,
      version: '2.1.282',
      peerProtocol: 1,
      messagingSocketPath: socket,
      status: 'idle',
    }
    const posted: string[] = []
    const calls: AttendanceRequestT[] = []
    const claims: unknown[] = []
    const reports: unknown[] = []
    let delivered = false
    const client = {
      compatibility: async () => ({ server_capabilities: ['session_attendance'] }),
      attend: async (_session: string, body: AttendanceRequestT): Promise<AttendanceResponse> => {
        calls.push(body)
        if (body.state !== 'running') return { status: 'withdrawn' }
        if (calls.length > 1) await new Promise((resolve) => setTimeout(resolve, 20))
        if (kind === 'answer' && calls.length === 1) {
          const reply = { reply_id: 'rpl_test', seq: 1, delivery_id: 'del_test', device_id: 'dev_test',
            device_name: 'Test device', text: 'Ship it', answers: [], source: null, created_at: new Date().toISOString() }
          updateSessionState('sess-a', env, (state) => ({ ...state,
            waiting_answers: [{ pending: { question: 'Deploy?', request_id: 'req_waiting' }, reply, replies: [reply] }],
            acknowledgement_due: [{ request_id: 'req_waiting', recorded_at: Date.now() }],
          }))
        }
        const messages = delivered || kind === 'answer'
          ? []
          : [{ message_id: 'sm_note', created_at: '2026-09-25T10:00:00.000Z', agent_acknowledgement_text_required: true, kind: 'note' as const, body: 'Use the staging database' }]
        return { status: 'attending', generation: 1, lease_remaining_ms: 120_000, message_cursor: 'c', messages }
      },
      claimDeliveryAttempt: async (_session: string, body: unknown) => {
        claims.push(body)
        return { attempt_id: 'att_note', claim_remaining_ms: 30_000 }
      },
      reportDeliveryAttempt: async (attemptId: string, body: { outcome: string }) => {
        reports.push({ attemptId, ...body })
        delivered = true
        return { attempt_id: attemptId, outcome: body.outcome, replayed: false }
      },
    } as unknown as ApiClient
    const deps = attendDeps(env, root, {
      clientFactory: () => client,
      claudeWake: {
        listAgents: async () => [{ pid: HARNESS.pid, sessionId: 'sess-a', startedAt: 1, status: 'idle' }],
        readDescriptor: () => descriptor,
        sendSocket: async (_path: string, line: string) => {
          posted.push(line)
        },
        resume: async () => {
          throw new Error('Session Messages never cold resume')
        },
        sleep: async () => {},
      },
    })
    recordSessionNotified('sess-a', env, Date.now())
    const envelope = { session_id: 'sess-a', cwd: root, hook_event_name: 'SessionStart', source: 'startup' }
    const running = hookRunCommand(deps, 'attend', stdin(envelope), 'claude-code')
    await until(() => posted.length === 1, 'the note wake')

    expect(calls[0]).toMatchObject({ state: 'running', accepts_messages: true })
    expect(claims).toEqual([])
    expect(posted).toHaveLength(1)
    const line = JSON.parse(posted[0]!) as { type: string; message: { content: string } }
    expect(line.type).toBe('user')
    expect(inputWakeToken(line.message.content)).toBe(readSessionState('sess-a', env).input_wake?.token)
    expect(line.message.content).not.toContain('Use the staging database')
    expect(reports).toEqual([])
    expect(readSessionState('sess-a', env).message_acknowledgement_due).toBeUndefined()
    expect(readSessionMessages('sess-a', env, { incarnation: readSessionIncarnation('sess-a', env)!.incarnation, generation: 1 })).toHaveLength(kind === 'note' ? 1 : 0)
    if (kind === 'answer') expect(readSessionState('sess-a', env).waiting_answers).toHaveLength(1)

    markSessionEnded('sess-a', env, Date.now() + 1)
    await running
  })

  it('stays presence-only, accepting no notes, when the session has no inbox socket', async () => {
    const { env, root } = isolatedEnv()
    const service = fakeAttendance()
    const deps = attendDeps(env, root, {
      clientFactory: () => service.client,
      claudeWake: {
        listAgents: async () => [],
        readDescriptor: () => {
          throw new Error('started with --bare')
        },
        sendSocket: async () => {},
        resume: async () => {},
        sleep: async () => {},
      },
    })
    recordSessionNotified('sess-a', env, Date.now())
    const envelope = { session_id: 'sess-a', cwd: root, hook_event_name: 'SessionStart', source: 'startup' }
    const running = hookRunCommand(deps, 'attend', stdin(envelope), 'claude-code')
    await until(() => service.calls.length >= 1, 'attendance exchange')
    expect(service.calls[0]).toMatchObject({ accepts_messages: false })
    markSessionEnded('sess-a', env, Date.now() + 1)
    await running
  })

  it('fences itself, without any report, when its claim is removed or changes hands', async () => {
    const { env, root } = isolatedEnv()
    const service = fakeAttendance()
    const deps = attendDeps(env, root, { clientFactory: () => service.client })
    recordSessionNotified('sess-a', env, Date.now())
    const envelope = { session_id: 'sess-a', cwd: root, hook_event_name: 'SessionStart', source: 'startup' }
    const running = hookRunCommand(deps, 'attend', stdin(envelope), 'claude-code')
    await until(() => service.calls.length >= 2, 'attendance exchanges')

    // A prune (or anything else) removed the claim, and a re-arm took it.
    const claim = attendantClaimPath('sess-a', env)
    const held = JSON.parse(readFileSync(claim, 'utf8')) as Record<string, unknown>
    writeFileSync(claim, JSON.stringify({ ...held, token: 'someone-else' }))
    await running
    expect(deps.exits).toEqual([{ reason: 'claim-lost', reported: null }])
    expect(service.calls.every((call) => call.state === 'running')).toBe(true)
    // It never releases a claim that is no longer its own.
    expect(JSON.parse(readFileSync(claim, 'utf8'))).toMatchObject({ token: 'someone-else' })
  })

  it('hands a Claude Code session over to the installed runtime at its next root hook, keeping its pending work', async () => {
    const { env, root } = isolatedEnv()
    const service = fakeAttendance()
    const previous = { ...attendDeps(env, root, { clientFactory: () => service.client }), runningVersion: '1.0.0' }
    recordSessionNotified('sess-a', env, Date.now())
    const running = hookRunCommand(previous, 'attend', stdin({ session_id: 'sess-a', cwd: root,
      hook_event_name: 'SessionStart', source: 'startup' }), 'claude-code')
    await until(() => service.calls.length >= 2, 'previous runtime attending')
    const claim = attendantClaimPath('sess-a', env)
    const incarnation = readSessionIncarnation('sess-a', env)!.incarnation
    // The previous writer is another live process; this one stands in for it.
    writeFileSync(claim, JSON.stringify({ ...readClaimFile(claim), pid: process.ppid, start: processStartTime(process.ppid) }))
    updateSessionState('sess-a', env, state => ({ ...state,
      pending: [{ question: 'Existing question', request_id: 'req_pending' }],
      message_acknowledgement_due: [{ message_id: 'sm_pending', recorded_at: Date.now(), text_required: true }],
    }))
    const installed = { ...attendDeps(env, root, { clientFactory: () => service.client }), runningVersion: '2.0.0' }
    const rearm = { session_id: 'sess-a', cwd: root, hook_event_name: 'UserPromptSubmit' }

    // A subagent's hook is not the session's own event and hands nothing over.
    await hookRunCommand(installed, 'attend', stdin({ ...rearm, agent_id: 'agent-1', agent_type: 'general-purpose' }), 'claude-code')
    expect(readClaimFile(claim)).toMatchObject({ runtime_version: '1.0.0' })
    expect(readClaimFile(claim)?.['handoff']).toBeUndefined()
    expect(previous.exits).toHaveLength(0)

    // The session's own prompt fences the previous writer. Its process is
    // still alive here, so the successor waits out its bound and leaves.
    await hookRunCommand(installed, 'attend', stdin(rearm), 'claude-code')
    await running
    expect(previous.exits).toEqual([{ reason: 'claim-lost', reported: null }])
    expect(readClaimFile(claim)).toMatchObject({ handoff: true, incarnation, runtime_version: '1.0.0' })
    expect(installed.exits).toHaveLength(0)

    // Once the previous process is gone, the next hook attends on the installed runtime.
    writeFileSync(claim, JSON.stringify({ ...readClaimFile(claim), pid: 2 ** 22 + 1, start: 'Thu Jan 1 00:00:00 1970' }))
    const successor = hookRunCommand(installed, 'attend', stdin(rearm), 'claude-code')
    try {
      await until(() => readClaimFile(claim)?.['runtime_version'] === '2.0.0', 'installed runtime attending')
      expect(readClaimFile(claim)).toMatchObject({ incarnation, pid: process.pid })
      expect(readSessionIncarnation('sess-a', env)?.incarnation).toBe(incarnation)
      expect(readSessionState('sess-a', env).pending?.[0]?.request_id).toBe('req_pending')
      expect(readSessionState('sess-a', env).message_acknowledgement_due?.[0]?.message_id).toBe('sm_pending')
    } finally {
      markSessionEnded('sess-a', env, Date.now() + 1)
      await successor
    }
  })

  it('does not attend for a harness without an exact-session probe', async () => {
    const { env, root } = isolatedEnv()
    const deps = attendDeps(env, root)
    expect(await hookRunCommand(deps, 'attend', stdin({ session_id: 'c1', cwd: root }), 'cursor')).toBe(0)
    expect(existsSync(attendantClaimPath('c1', env))).toBe(false)
  })
})

describe('Codex process probe', () => {
  const base = { pidExists: () => true, readStart: () => HARNESS.start, parentPid: () => HARNESS.pid }
  const probeWith = (
    adapters: Partial<typeof base> = {},
    options: { ended?: boolean; activity?: 'idle' | 'working' } = {},
  ) =>
    codexAttendanceProbe({
      harness: HARNESS,
      endedByHook: () => options.ended ?? false,
      activity: () => options.activity ?? 'idle',
      adapters: { ...base, ...adapters },
    })()

  it('is supported on macOS and Linux, and unknown on Windows', () => {
    expect(attendantSupport('codex', 'darwin')).toEqual({ supported: true })
    expect(attendantSupport('codex', 'linux')).toEqual({ supported: true })
    expect(attendantSupport('codex', 'win32')).toEqual({ supported: false, reason: 'codex-win32-unproven' })
    expect(attendantSupport('grok', 'darwin')).toEqual({
      supported: false,
      reason: 'grok-has-no-exact-session-writer-or-attendant',
    })
  })

  it('starts an OpenClaw attendant only on the verified macOS host', () => {
    expect(attendantSupport('openclaw', 'darwin')).toEqual({ supported: true })
    expect(attendantSupport('openclaw', 'linux')).toEqual({
      supported: false, reason: 'openclaw-linux-unproven',
    })
    expect(attendantSupport('openclaw', 'win32')).toEqual({
      supported: false, reason: 'openclaw-win32-unproven',
    })
  })

  it('reports running with the activity the thread’s own turns recorded', () => {
    expect(probeWith()).toEqual({ state: 'running', activity: 'idle' })
    expect(probeWith({}, { activity: 'working' })).toEqual({ state: 'running', activity: 'working' })
  })

  it('ends on this incarnation’s SessionEnd marker, and when the Codex process is gone or its PID reused', () => {
    expect(probeWith({}, { ended: true })).toEqual({ state: 'ended', reason: 'session-end-hook' })
    const orphaned = { parentPid: () => 1 }
    expect(probeWith({ ...orphaned, pidExists: () => false })).toEqual({ state: 'ended', reason: 'harness-gone' })
    expect(probeWith({ ...orphaned, readStart: () => 'Sat Sep 26 09:00:00 2026' })).toEqual({
      state: 'ended',
      reason: 'harness-gone',
    })
  })

  it('never claims running while the Codex start time cannot be read', () => {
    expect(probeWith({ parentPid: () => 1, readStart: () => null })).toEqual({
      state: 'uncertain',
      reason: 'process-start-unreadable',
    })
  })
})

describe('Codex turn activity', () => {
  it('is working from a turn\u2019s start until that turn ends, whichever hook runs first', () => {
    const { env } = isolatedEnv()
    expect(readTurnActivity('t', env, 'k1')).toBe('idle')
    recordTurnStart('t', env, 'k1', 'turn-1')
    expect(readTurnActivity('t', env, 'k1')).toBe('working')
    recordTurnEnd('t', env, 'turn-1')
    expect(readTurnActivity('t', env, 'k1')).toBe('idle')
    // The async turn-end hook of turn 2 ran before its start was recorded.
    recordTurnEnd('t', env, 'turn-2')
    recordTurnStart('t', env, 'k1', 'turn-2')
    expect(readTurnActivity('t', env, 'k1')).toBe('idle')
    // A late end of an earlier turn does not end the current one.
    recordTurnStart('t', env, 'k1', 'turn-3')
    recordTurnEnd('t', env, 'turn-1')
    expect(readTurnActivity('t', env, 'k1')).toBe('working')
  })

  it('never lets a delayed start of an earlier turn replace a newer turn', () => {
    const { env } = isolatedEnv()
    recordTurnStart('t', env, 'k1', 'turn-a')
    // A ends and B starts; then A's start is recorded again, late.
    recordTurnEnd('t', env, 'turn-a')
    recordTurnStart('t', env, 'k1', 'turn-b')
    recordTurnStart('t', env, 'k1', 'turn-a')
    expect(readTurnActivity('t', env, 'k1')).toBe('working')
    // Only B's own end makes the thread idle.
    recordTurnEnd('t', env, 'turn-b')
    expect(readTurnActivity('t', env, 'k1')).toBe('idle')
  })

  it('belongs to one incarnation: a turn left open by an earlier start never reads as working now', () => {
    const { env } = isolatedEnv()
    recordTurnStart('t', env, 'k1', 'turn-crashed')
    expect(readTurnActivity('t', env, 'k2')).toBe('idle')
    recordTurnStart('t', env, 'k2', 'turn-1')
    expect(readTurnActivity('t', env, 'k2')).toBe('working')
    expect(readTurnActivity('t', env, 'k1')).toBe('idle')
  })
})

describe('notifai hook attend for Codex', () => {
  const THREAD = '019a1b2c-3d4e-7f50-8a61-72b3c4d5e6f7'

  function codexEnv(): { env: NodeJS.ProcessEnv; root: string } {
    const isolated = isolatedEnv()
    isolated.env['NOTIFAI_HOOK_SOURCE_PID'] = String(HARNESS.pid)
    isolated.env['CODEX_HOME'] = path.join(isolated.root, 'codex')
    return isolated
  }

  it('recovers an existing native turn during update without a hook event or a new incarnation', async () => {
    const { env, root } = codexEnv()
    delete env['NOTIFAI_HOOK_SOURCE_PID']
    const service = fakeAttendance()
    const deps = attendDeps(env, root, { clientFactory: () => service.client })
    deps.attendant!.probeAdapters!.parentPid = () => HARNESS.pid
    const owner = beginSessionIncarnation(THREAD, env, { stamp: lifecycleStamp(), harnessProcess: HARNESS })
    recordSessionNotified(THREAD, env, Date.now())
    recordTurnStart(THREAD, env, owner.key, 'previous')
    recordTurnEnd(THREAD, env, 'previous')
    updateSessionState(THREAD, env, state => ({ ...state,
      pending: [{ question: 'Existing question', request_id: 'req_pending' }],
      message_acknowledgement_due: [{ message_id: 'sm_pending', recorded_at: Date.now(), text_required: true }],
    }))
    const transcript = path.join(env['CODEX_HOME']!, 'sessions', 'recovery.jsonl')
    mkdirSync(path.dirname(transcript), { recursive: true })
    writeFileSync(transcript, [
      { type: 'session_meta', payload: { id: THREAD, source: 'cli' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'already-running' } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n')
    const running = attendHook(deps, { envelope: { session_id: THREAD, cwd: root }, harness: 'codex', cwd: root,
      invokedAt: lifecycleStamp(), logger: nullLogger(),
      recovery: { key: owner.key, harnessProcess: HARNESS, transcriptPath: transcript },
    })
    try {
      await until(() => service.calls.some(call => call.activity === 'working'), 'recovered working turn')
      expect(readSessionIncarnation(THREAD, env)?.incarnation).toBe(owner.incarnation)
      expect(readSessionState(THREAD, env).pending?.[0]?.request_id).toBe('req_pending')
      expect(readSessionState(THREAD, env).message_acknowledgement_due?.[0]?.message_id).toBe('sm_pending')
    } finally {
      markSessionEnded(THREAD, env, Date.now() + 1)
      await running
    }
  })

  it('attends a loaded thread, reports activity, and queues a wake without claiming the Note', async () => {
    const { env, root } = codexEnv()
    const calls: AttendanceRequestT[] = []
    const claims: unknown[] = []
    const reports: unknown[] = []
    const queued: Array<{ threadId: string; cwd: string; context: string }> = []
    let noteOffered = false
    let delivered = false
    const client = {
      compatibility: async () => ({ server_capabilities: ['session_attendance'] }),
      attend: async (_session: string, body: AttendanceRequestT): Promise<AttendanceResponse> => {
        calls.push(body)
        if (body.state !== 'running') return { status: 'withdrawn' }
        if (calls.length > 1) await new Promise((resolve) => setTimeout(resolve, 20))
        const messages =
          noteOffered && !delivered
            ? [{ message_id: 'sm_codex', created_at: '2026-09-25T10:00:00.000Z', agent_acknowledgement_text_required: false, kind: 'note' as const, body: 'Check the staging logs first' }]
            : []
        return { status: 'attending', generation: 1, lease_remaining_ms: 120_000, message_cursor: 'c', messages }
      },
      claimDeliveryAttempt: async (_session: string, body: unknown) => {
        claims.push(body)
        return { attempt_id: 'att_codex', claim_remaining_ms: 30_000 }
      },
      reportDeliveryAttempt: async (attemptId: string, body: { outcome: string }) => {
        reports.push({ attemptId, ...body })
        delivered = true
        return { attempt_id: attemptId, outcome: body.outcome, replayed: false }
      },
    } as unknown as ApiClient
    const deps = attendDeps(env, root, {
      clientFactory: () => client,
      codexWake: {
        queue: async (threadId, cwd, context, onSpawn) => {
          onSpawn?.(98_765)
          queued.push({ threadId, cwd, context })
        },
      },
    })
    const owner = currentProcessIdentity()!
    env['NOTIFAI_HOOK_SOURCE_PID'] = String(owner.pid)
    deps.attendant!.harnessProcess = owner
    deps.attendant!.probeAdapters!.readStart = () => owner.start
    deps.attendant!.probeAdapters!.parentPid = () => owner.pid
    const transcript = path.join(env['CODEX_HOME']!, 'sessions', 'activity.jsonl')
    mkdirSync(path.dirname(transcript), { recursive: true })
    writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: THREAD, source: 'cli' } }) + '\n')
    const nativeEvent = (type: string, turnId: string): void => {
      appendFileSync(transcript, JSON.stringify({ type: 'event_msg', payload: { type, turn_id: turnId } }) + '\n')
    }
    nativeEvent('task_started', 'initial')
    nativeEvent('task_complete', 'initial')
    recordSessionNotified(THREAD, env, Date.now())
    const running = hookRunCommand(
      deps,
      'attend',
      stdin({ session_id: THREAD, cwd: root, hook_event_name: 'SessionStart', source: 'startup', transcript_path: transcript }),
      'codex',
    )
    await until(() => calls.length >= 1, 'attendance exchange')
    expect(calls[0]).toMatchObject({ state: 'running', activity: 'idle', accepts_messages: true })

    // Codex runs the synchronous prompt hook (which records the turn's start)
    // and the asynchronous attend copy (which finds its owner present).
    const prompt = async (turnId: string): Promise<void> => {
      nativeEvent('task_started', turnId)
      const envelope = { session_id: THREAD, cwd: root, hook_event_name: 'UserPromptSubmit', turn_id: turnId, transcript_path: transcript }
      await hookRunCommand(deps, 'user-prompt-submit', stdin(envelope), 'codex')
      await hookRunCommand(deps, 'attend', stdin(envelope), 'codex')
    }
    await prompt('turn-1')
    await until(() => calls.some((call) => call.activity === 'working'), 'working activity')
    await hookRunCommand(
      deps,
      'attend',
      stdin({ session_id: THREAD, cwd: root, hook_event_name: 'Stop', turn_id: 'turn-1' }),
      'codex',
    )
    expect(readTurnActivity(THREAD, env, readSessionIncarnation(THREAD, env)!.key)).toBe('working')
    nativeEvent('task_complete', 'turn-1')
    await until(() => calls.at(-1)?.activity === 'idle', 'idle activity')
    // An interrupted turn fires Interrupt instead of Stop; that copy records the end and exits.
    await prompt('turn-2')
    await until(() => calls.at(-1)?.activity === 'working', 'working again')
    await hookRunCommand(
      deps,
      'attend',
      stdin({ session_id: THREAD, cwd: root, hook_event_name: 'Interrupt', turn_id: 'turn-2' }),
      'codex',
    )
    nativeEvent('turn_aborted', 'turn-2')
    await until(() => calls.at(-1)?.activity === 'idle', 'idle after the interrupt')
    // Turn 3 starts; a late async copy of turn 1's prompt hook changes nothing.
    await prompt('turn-3')
    await until(() => calls.at(-1)?.activity === 'working', 'working on turn 3')
    await hookRunCommand(
      deps,
      'attend',
      stdin({ session_id: THREAD, cwd: root, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' }),
      'codex',
    )
    expect(readTurnActivity(THREAD, env, readSessionIncarnation(THREAD, env)!.key)).toBe('working')
    await hookRunCommand(
      deps,
      'attend',
      stdin({ session_id: THREAD, cwd: root, hook_event_name: 'Stop', turn_id: 'turn-3' }),
      'codex',
    )
    expect(readTurnActivity(THREAD, env, readSessionIncarnation(THREAD, env)!.key)).toBe('working')
    nativeEvent('task_complete', 'turn-3')
    await until(() => calls.at(-1)?.activity === 'idle', 'idle after turn 3')
    expect(deps.exits).toHaveLength(0)

    // The native async copy must recover activity even when synchronous hooks
    // stop firing in a long-lived harness. The incumbent still owns attendance.
    nativeEvent('task_started', 'async-current')
    await hookRunCommand(deps, 'attend', stdin({
      session_id: THREAD, cwd: root, hook_event_name: 'UserPromptSubmit',
      turn_id: 'async-current', transcript_path: transcript,
    }), 'codex')
    await until(() => calls.at(-1)?.activity === 'working', 'async-only working activity')
    // Neither a child nor a different native process may end the root turn.
    await hookRunCommand(deps, 'attend', stdin({
      session_id: THREAD, cwd: root, hook_event_name: 'Stop', turn_id: 'async-current', agent_id: 'child',
    }), 'codex')
    const wrongOwner = { ...deps, attendant: { ...deps.attendant, harnessProcess: { ...owner, start: 'another-process-start' } } }
    await hookRunCommand(wrongOwner, 'attend', stdin({
      session_id: THREAD, cwd: root, hook_event_name: 'Stop', turn_id: 'async-current',
    }), 'codex')
    expect(readTurnActivity(THREAD, env, readSessionIncarnation(THREAD, env)!.key)).toBe('working')
    await hookRunCommand(deps, 'attend', stdin({
      session_id: THREAD, cwd: root, hook_event_name: 'Stop', turn_id: 'async-current',
    }), 'codex')
    expect(readTurnActivity(THREAD, env, readSessionIncarnation(THREAD, env)!.key)).toBe('working')
    nativeEvent('task_complete', 'async-current')
    await until(() => calls.at(-1)?.activity === 'idle', 'async-only turn ended')

    noteOffered = true
    await until(() => queued.length === 1, 'the note wake')
    expect(claims).toEqual([])
    expect(queued).toHaveLength(1)
    expect(queued[0]).toEqual({ threadId: THREAD, cwd: root, context: sessionInputWake() })
    expect(reports).toEqual([])
    expect(readDeliveryJournal(THREAD, env)).toEqual([])

    markSessionEnded(THREAD, env, Date.now() + 1)
    await running
    expect(deps.exits).toEqual([{ reason: 'session-end-hook', reported: 'ended' }])
  })

  it.each(['tool-drain', 'completion', 'first-tool', 'missing-tool', 'abort', 'owned-cancel'])('routes a staged Note safely: %s', async (mode) => {
    const { env, root } = codexEnv()
    enableProject(projectBinding(root, env, undefined))
    const home = env['CODEX_HOME']!
    mkdirSync(home, { recursive: true })
    writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: buildHookConfig({ adapterPath: hookAdapterPath(), harness: 'codex' }) }))
    const installed = findInstallations(env).find((entry) => entry.harness === 'codex')!
    writeFileSync(path.join(home, 'config.toml'), installed.handlers
      .filter((handler) => (mode === 'missing-tool' ? ['UserPromptSubmit'] : ['PostToolUse', 'UserPromptSubmit']).includes(handler.event))
      .map((handler) => `[hooks.state.${JSON.stringify(codexTrustKey(installed, handler))}]\ntrusted_hash = "${codexHookIdentityHash(handler)}"\n`).join('\n'))
    const owner = currentProcessIdentity()!
    env['NOTIFAI_HOOK_SOURCE_PID'] = String(owner.pid)
    const transcript = path.join(home, 'sessions', 'owned.jsonl')
    mkdirSync(path.dirname(transcript), { recursive: true })
    writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: THREAD, source: 'cli' } }) + '\n')
    const nativeEvent = (type: string, turnId = 'busy') => appendFileSync(transcript, JSON.stringify({ type: 'event_msg', payload: { type, turn_id: turnId } }) + '\n')
    nativeEvent('task_started')
    const output: string[] = []
    const queued: string[] = []
    let offered = false
    let delivered = false
    let claims = 0
    let exchanges = 0
    const outcomes: string[] = []
    const claimBodies: unknown[] = []
    const generation = mode === 'owned-cancel' ? 7 : 1
    const nativeQueue = new Map<string, { token: string; text: string }>()
    let nativeAdds = 0
    const removed: string[] = []
    const nativeControl: QueueControl = {
      namespace: home, threadId: THREAD,
      add: async (token, text) => {
        const id = `native-${++nativeAdds}`
        nativeQueue.set(id, { token, text })
        return id
      },
      find: async (token, text) => {
        const match = [...nativeQueue].find(([, entry]) => entry.token === token && entry.text === text)
        return match === undefined ? 'absent' : { id: match[0] }
      },
      remove: async id => { removed.push(id); return nativeQueue.delete(id) },
      close: () => {},
    }
    const client = {
      compatibility: async () => ({ server_capabilities: ['session_attendance'] }),
      attend: async (_session: string, body: AttendanceRequestT): Promise<AttendanceResponse> => {
        exchanges += 1
        if (body.state !== 'running') return { status: 'withdrawn' }
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { status: 'attending', generation, lease_remaining_ms: 120_000, message_cursor: 'c', messages:
          offered && !delivered
            ? [{ message_id: 'sm_tool', created_at: new Date().toISOString(), agent_acknowledgement_text_required: true, kind: 'note', body: 'Use the tool hook' }] : [] }
      },
      claimDeliveryAttempt: async (_session: string, body: unknown) => {
        claims += 1
        claimBodies.push(body)
        return { attempt_id: `att_tool_${claims}`, claim_remaining_ms: 30_000 }
      },
      reportDeliveryAttempt: async (id: string, body: { outcome: string }) => {
        outcomes.push(body.outcome)
        delivered = body.outcome === 'handed_off'
        return { attempt_id: id, ...body, replayed: false }
      },
    } as unknown as ApiClient
    const deps = attendDeps(env, root, { clientFactory: () => client,
      ...(mode === 'owned-cancel' ? { codexQueueControl: async () => nativeControl } : {}),
      codexWake: { queue: async (_id, _cwd, text) => { queued.push(text) } } })
    deps.attendant!.harnessProcess = owner
    deps.attendant!.probeAdapters!.readStart = () => owner.start
    deps.attendant!.probeAdapters!.parentPid = () => owner.pid
    deps.io.out = (text) => { output.push(text) }
    recordSessionNotified(THREAD, env, Date.now())
    const running = hookRunCommand(deps, 'attend', stdin({ session_id: THREAD, cwd: root, hook_event_name: 'SessionStart', source: 'startup', transcript_path: transcript }), 'codex')
    try {
      await until(() => readAttendantLease(THREAD, env) !== null, 'lease')
      const incarnation = readSessionIncarnation(THREAD, env)!
      recordTurnStart(THREAD, env, incarnation.key, 'busy')
      {
        // A native prompt observes the transcript before the first tool.
        await hookRunCommand(deps, 'attend', stdin({ session_id: THREAD, cwd: root,
          hook_event_name: 'UserPromptSubmit', turn_id: 'busy', transcript_path: transcript }), 'codex')
      }
      if (mode !== 'first-tool' && mode !== 'missing-tool') {
        await hookRunCommand(deps, 'post-tool-use', stdin({
          session_id: THREAD, cwd: root, hook_event_name: 'PostToolUse', turn_id: 'busy', transcript_path: transcript,
        }), 'codex')
        expect(codexToolHookReady(deps, THREAD)).toBe(true)
        expect(claims).toBe(0)
        expect(output.join('\n')).not.toContain('sm_tool')
        // This fixture only trusts prompt/tool handlers; discard the initial
        // integration diagnostic before observing subsequent input delivery.
        output.length = 0
      }
      offered = true
      await until(() => readSessionMessages(THREAD, env, { incarnation: incarnation.incarnation, generation }).length === 1, 'staged Note')
      expect(claims).toBe(0)
      {
        const observed = exchanges
        await until(() => exchanges >= observed + 2, 'busy input remains staged without a wake')
        expect(queued).toEqual([])
        await hookRunCommand(deps, 'attend', stdin({ session_id: THREAD, cwd: root,
          hook_event_name: 'Stop', turn_id: 'busy', transcript_path: transcript, stop_hook_active: true }), 'codex')
        expect(readTurnActivity(THREAD, env, incarnation.key)).toBe('working')
        if (mode === 'tool-drain') {
          await hookRunCommand(deps, 'post-tool-use', stdin({ session_id: THREAD, cwd: root,
            hook_event_name: 'PostToolUse', turn_id: 'busy', transcript_path: transcript }), 'codex')
          expect(delivered).toBe(true)
          expect(claims).toBe(1)
        }
        nativeEvent(mode === 'abort' ? 'turn_aborted' : 'task_complete')
        await until(() => listAttendantReports(env)[0]?.activity === 'idle', 'actual native completion without another hook')
        const completedAt = exchanges
        await until(() => exchanges >= completedAt + 2, 'idle reconciliation')
        if (mode === 'owned-cancel') {
          // Fake service and native transport; real resident, local lease,
          // hook dispatcher, foreground drain and automatic probe cleanup.
          const wakes = () => readInputWakes({ sessionId: THREAD, env })
          await until(() => wakes()[0]?.phase === 'accepted', 'resident-owned native wake')
          expect(readAttendantLease(THREAD, env)).toMatchObject({ incarnation: incarnation.incarnation, generation })
          expect(wakes()[0]).toMatchObject({ incarnation: incarnation.incarnation, generation, nativeId: 'native-1' })
          nativeQueue.set('unrelated', { token: 'independent-control', text: 'Synthetic unrelated transport control' })
          nativeEvent('task_started', 'foreground')
          await hookRunCommand(deps, 'user-prompt-submit', stdin({ session_id: THREAD, cwd: root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'foreground', transcript_path: transcript,
            prompt: 'Synthetic foreground boundary for the cancellation test',
          }), 'codex')
          await until(() => wakes()[0]?.phase === 'cancelled', 'automatic resident cancellation after foreground drain')
          expect(claims).toBe(1)
          expect(claimBodies[0]).toMatchObject({ incarnation: incarnation.incarnation, generation })
          expect(output.filter(text => text.includes('sm_tool'))).toHaveLength(1)
          expect(outcomes).toEqual(['handed_off'])
          expect(readDeliveryJournal(THREAD, env)[0]?.stage).toBe('written')
          expect(wakes()[0]?.detached).toBe(true)
          expect(removed).toEqual(['native-1'])
          expect([...nativeQueue.keys()]).toEqual(['unrelated'])
          nativeEvent('task_complete', 'foreground')
          const afterDrain = exchanges
          await until(() => exchanges >= afterDrain + 3, 'acknowledgement debt alone does not requeue')
          expect(nativeAdds).toBe(1)
          expect(queued).toEqual([])
          return
        }
        expect(queued).toEqual(mode === 'tool-drain' ? [] : [sessionInputWake()])
        if (mode !== 'tool-drain') {
          await hookRunCommand(deps, 'user-prompt-submit', stdin({ session_id: THREAD, cwd: root,
            hook_event_name: 'UserPromptSubmit', turn_id: 'wake-turn', prompt: queued[0] }), 'codex')
          expect(claims).toBe(1)
          expect(output.join('\n')).toContain('sm_tool')
        }
        return
      }
    } finally {
      markSessionEnded(THREAD, env, Date.now() + 1)
      await running
    }
  })

  it('stays presence-only, accepting no notes, when no codex executable can write the thread queue', async () => {
    const { env, root } = codexEnv()
    const service = fakeAttendance()
    const deps = attendDeps(env, root, {
      clientFactory: () => service.client,
      codexWake: { available: () => false, queue: async () => {} },
    })
    const owner = currentProcessIdentity()!
    env['NOTIFAI_HOOK_SOURCE_PID'] = String(owner.pid)
    deps.attendant!.harnessProcess = owner
    deps.attendant!.probeAdapters!.readStart = () => owner.start
    deps.attendant!.probeAdapters!.parentPid = () => owner.pid
    const transcript = path.join(env['CODEX_HOME']!, 'sessions', 'idle.jsonl')
    mkdirSync(path.dirname(transcript), { recursive: true })
    writeFileSync(transcript, [
      { type: 'session_meta', payload: { id: THREAD, source: 'cli' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'initial' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'initial' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    recordSessionNotified(THREAD, env, Date.now())
    const envelope = { session_id: THREAD, cwd: root, hook_event_name: 'SessionStart', source: 'startup', transcript_path: transcript }
    const running = hookRunCommand(deps, 'attend', stdin(envelope), 'codex')
    await until(() => service.calls.length >= 1, 'attendance exchange')
    expect(service.calls[0]).toMatchObject({ state: 'running', accepts_messages: false })
    markSessionEnded(THREAD, env, Date.now() + 1)
    await running
  })

  it('does not attend without the Codex process the hook adapter declares', async () => {
    const { env, root } = codexEnv()
    delete env['NOTIFAI_HOOK_SOURCE_PID']
    const deps = attendDeps(env, root)
    const envelope = { session_id: THREAD, cwd: root, hook_event_name: 'SessionStart', source: 'startup' }
    expect(await hookRunCommand(deps, 'attend', stdin(envelope), 'codex')).toBe(0)
    expect(existsSync(attendantClaimPath(THREAD, env))).toBe(false)
  })

  it('does not attend when the declared parent is not the Codex executable (a shell that did not exec)', async () => {
    const { env, root } = codexEnv()
    // This test process stands in for a login shell that kept running.
    env['NOTIFAI_HOOK_SOURCE_PID'] = String(process.pid)
    const processName = processExecutableName(process.pid)
    expect(processName).not.toBeNull()
    expect(processName).not.toBe('codex')
    const deps = attendDeps(env, root)
    delete deps.attendant!.harnessProcess
    const envelope = { session_id: THREAD, cwd: root, hook_event_name: 'SessionStart', source: 'startup' }
    expect(await hookRunCommand(deps, 'attend', stdin(envelope), 'codex')).toBe(0)
    expect(deps.exits).toEqual([])
    expect(readSessionIncarnation(THREAD, env)).toBeNull()
  })

  it('does not attend Codex on Windows', async () => {
    const { env, root } = codexEnv()
    const deps = attendDeps(env, root, { hookPlatform: 'win32' })
    const envelope = { session_id: THREAD, cwd: root, hook_event_name: 'SessionStart', source: 'startup' }
    expect(await hookRunCommand(deps, 'attend', stdin(envelope), 'codex')).toBe(0)
    expect(existsSync(attendantClaimPath(THREAD, env))).toBe(false)
  })

  it('SessionEnd reports the held lease ended, because Codex kills the attendant as soon as SessionEnd returns', async () => {
    const { env, root } = codexEnv()
    const calls: AttendanceRequestT[] = []
    const client = {
      attend: async (_session: string, body: AttendanceRequestT): Promise<AttendanceResponse> => {
        calls.push(body)
        return { status: 'withdrawn' }
      },
    } as unknown as ApiClient
    const deps = attendDeps(env, root, { clientFactory: () => client })
    const envelope = { session_id: THREAD, cwd: root, hook_event_name: 'SessionEnd' }

    // No attendant holds a lease: nothing to end.
    expect(await hookRunCommand(deps, 'session-end', stdin(envelope), 'codex')).toBe(0)
    expect(calls).toEqual([])

    // A live attendant (this process) holds generation 3 of this incarnation.
    const current = beginSessionIncarnation(THREAD, env, { stamp: lifecycleStamp(Date.now() + 1), harnessProcess: HARNESS })
    const claim = attendantClaimPath(THREAD, env)
    mkdirSync(path.dirname(claim), { recursive: true })
    expect(acquireClaimFile(claim, { incarnation: current.incarnation }, Date.now())).not.toBeNull()
    writeAttendantStatus(THREAD, env, {
      phase: 'attending',
      incarnation: current.incarnation,
      generation: 3,
      activity: 'idle',
      reason: null,
      accepts_messages: true,
      updated_at: Date.now(),
    })
    expect(await hookRunCommand(deps, 'session-end', stdin(envelope), 'codex')).toBe(0)
    expect(calls).toEqual([{ incarnation: current.incarnation, generation: 3, state: 'ended' }])
    expect(sessionHasEnded(THREAD, env)).toBe(true)

    // Claude Code's attendant survives SessionEnd and reports for itself.
    calls.length = 0
    expect(await hookRunCommand(deps, 'session-end', stdin(envelope), 'claude-code')).toBe(0)
    expect(calls).toEqual([])
  })

  it.each(['missing-claim', 'dead-claim', 'exited'] as const)(
    'Codex SessionEnd reports the saved generation when the attendant is %s before hook entry',
    async (failure) => {
      const { env, root } = codexEnv()
      const current = beginSessionIncarnation(THREAD, env, { stamp: lifecycleStamp(Date.now()), harnessProcess: HARNESS })
      const calls: AttendanceRequestT[] = []
      const client = {
        attend: async (_session: string, body: AttendanceRequestT): Promise<AttendanceResponse> => {
          calls.push(body)
          return { status: 'withdrawn' }
        },
      } as unknown as ApiClient
      const claim = attendantClaimPath(THREAD, env)
      mkdirSync(path.dirname(claim), { recursive: true })
      if (failure === 'dead-claim') {
        expect(acquireClaimFile(claim, { incarnation: current.incarnation }, Date.now())).not.toBeNull()
        const dead = { ...JSON.parse(readFileSync(claim, 'utf8')), pid: 1_073_741_824 }
        writeFileSync(claim, JSON.stringify(dead))
      }
      writeAttendantStatus(THREAD, env, {
        phase: failure === 'exited' ? 'exited' : 'attending',
        incarnation: current.incarnation,
        generation: 5,
        activity: 'idle',
        reason: failure === 'exited' ? 'signal' : null,
        accepts_messages: failure !== 'exited',
        updated_at: Date.now(),
      })
      if (failure === 'dead-claim') {
        const file = attendantStatusPath(THREAD, env)
        const status = JSON.parse(readFileSync(file, 'utf8'))
        writeFileSync(file, JSON.stringify({ ...status, pid: 1_073_741_824 }))
      }
      // Dead attendants must remain unusable for message delivery.
      expect(readAttendantLease(THREAD, env)).toBeNull()
      const deps = attendDeps(env, root, { clientFactory: () => client })
      const envelope = { session_id: THREAD, cwd: root, hook_event_name: 'SessionEnd' }
      expect(await hookRunCommand(deps, 'session-end', stdin(envelope), 'codex')).toBe(0)
      expect(calls).toEqual([{ incarnation: current.incarnation, generation: 5, state: 'ended' }])
      expect(sessionHasEnded(THREAD, env)).toBe(true)
    },
  )

  it.each([
    { generation: null },
    { generation: 0 },
    { generation: 1.5 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { incarnation: 'inc_an_earlier_start' },
    { session_id: 'another-session' },
  ])('Codex SessionEnd rejects unusable or foreign saved fencing identity: %j', async (override) => {
    const { env, root } = codexEnv()
    const current = beginSessionIncarnation(THREAD, env, { stamp: lifecycleStamp(Date.now()), harnessProcess: HARNESS })
    const calls: AttendanceRequestT[] = []
    const client = {
      attend: async (_session: string, body: AttendanceRequestT): Promise<AttendanceResponse> => {
        calls.push(body)
        return { status: 'withdrawn' }
      },
    } as unknown as ApiClient
    writeAttendantStatus(THREAD, env, {
      phase: 'attending', incarnation: current.incarnation, generation: 5,
      activity: 'idle', reason: null, accepts_messages: true, updated_at: Date.now(),
    })
    const file = attendantStatusPath(THREAD, env)
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...override }))
    const deps = attendDeps(env, root, { clientFactory: () => client })
    expect(await hookRunCommand(deps, 'session-end', stdin({ session_id: THREAD, cwd: root, hook_event_name: 'SessionEnd' }), 'codex')).toBe(0)
    expect(calls).toEqual([])
  })

  it('Codex SessionEnd keeps the captured generation when a replacement acquires during cleanup', async () => {
    const { env, root } = codexEnv()
    const current = beginSessionIncarnation(THREAD, env, { stamp: lifecycleStamp(Date.now()), harnessProcess: HARNESS })
    const status = {
      phase: 'attending' as const, incarnation: current.incarnation, generation: 5,
      activity: 'idle' as const, reason: null, accepts_messages: true, updated_at: Date.now(),
    }
    writeAttendantStatus(THREAD, env, status)
    const calls: AttendanceRequestT[] = []
    const client = {
      attend: async (_session: string, body: AttendanceRequestT): Promise<AttendanceResponse> => {
        calls.push(body)
        return { status: 'withdrawn' }
      },
    } as unknown as ApiClient
    const logger = {
      ...nullLogger(),
      info: (event: string): void => {
        if (event !== 'hook.end') return
        const replacement = beginSessionIncarnation(THREAD, env, {
          stamp: lifecycleStamp(Date.now() + 1), harnessProcess: HARNESS,
        })
        expect(replacement.incarnation).not.toBe(current.incarnation)
        writeAttendantStatus(THREAD, env, { ...status, incarnation: replacement.incarnation, generation: 6 })
      },
    }
    const deps = attendDeps(env, root, { clientFactory: () => client, logger })
    expect(await hookRunCommand(deps, 'session-end', stdin({ session_id: THREAD, cwd: root, hook_event_name: 'SessionEnd' }), 'codex')).toBe(0)
    // The service can fence this old report; it never names the replacement.
    expect(calls).toEqual([{ incarnation: current.incarnation, generation: 5, state: 'ended' }])
  })

  it('Codex SessionEnd still reports its lease when the attendant exits during local cleanup', async () => {
    const { env, root } = codexEnv()
    const calls: AttendanceRequestT[] = []
    const client = {
      attend: async (_session: string, body: AttendanceRequestT): Promise<AttendanceResponse> => {
        calls.push(body)
        return { status: 'withdrawn' }
      },
    } as unknown as ApiClient
    const current = beginSessionIncarnation(THREAD, env, { stamp: lifecycleStamp(Date.now()), harnessProcess: HARNESS })
    const claim = attendantClaimPath(THREAD, env)
    mkdirSync(path.dirname(claim), { recursive: true })
    expect(acquireClaimFile(claim, { incarnation: current.incarnation }, Date.now())).not.toBeNull()
    writeAttendantStatus(THREAD, env, {
      phase: 'attending',
      incarnation: current.incarnation,
      generation: 4,
      activity: 'idle',
      reason: null,
      accepts_messages: true,
      updated_at: Date.now(),
    })
    const logger = {
      ...nullLogger(),
      info: (event: string): void => {
        if (event !== 'hook.end') return
        expect(sessionHasEnded(THREAD, env)).toBe(true)
        writeAttendantStatus(THREAD, env, {
          phase: 'exited',
          incarnation: current.incarnation,
          generation: 4,
          activity: 'idle',
          reason: 'session-end-hook',
          accepts_messages: false,
          updated_at: Date.now(),
        })
        rmSync(claim, { force: true })
      },
    }
    const deps = attendDeps(env, root, { clientFactory: () => client, logger })
    const envelope = { session_id: THREAD, cwd: root, hook_event_name: 'SessionEnd' }

    expect(await hookRunCommand(deps, 'session-end', stdin(envelope), 'codex')).toBe(0)
    expect(calls).toEqual([{ incarnation: current.incarnation, generation: 4, state: 'ended' }])
  })
})

describe('attendant gates', () => {
  function installedCli(root: string, env: NodeJS.ProcessEnv, version: string): string {
    const pkg = path.join(root, 'pkg')
    mkdirSync(path.join(pkg, 'dist'), { recursive: true })
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@raidiant/notifai', version }))
    writeFileSync(path.join(pkg, 'dist', 'main.js'), '')
    const home = path.join(root, 'adapter-home')
    installHookAdapter({ execPath: process.execPath, scriptPath: path.join(pkg, 'dist', 'main.js') }, home, 'darwin', env)
    return home
  }

  function gateDeps(root: string, env: NodeJS.ProcessEnv, hookAdapterHome?: string): CommandDeps {
    return {
      io: new CapturedIo(),
      env,
      cwd: root,
      store: {},
      hookPlatform: 'darwin',
      ...(hookAdapterHome === undefined ? {} : { hookAdapterHome }),
    } as unknown as CommandDeps
  }

  function installAttend(env: NodeJS.ProcessEnv): void {
    const settings = path.join(env['CLAUDE_CONFIG_DIR'] as string, 'settings.json')
    mkdirSync(path.dirname(settings), { recursive: true })
    writeFileSync(
      settings,
      JSON.stringify({ hooks: buildHookConfig({ adapterPath: '/adapter', harness: 'claude-code', platform: 'darwin' }) }),
    )
  }

  it('require Project Enablement and an installed attend handler', () => {
    const { env, root } = isolatedEnv()
    const deps = gateDeps(root, env, installedCli(root, env, '11.4.0'))
    const binding = projectBinding(root, env)!
    enableProject(binding, new Date())
    expect(attendantGates(deps, root, 's', 'claude-code', '11.4.0')).toEqual({ ok: false, reason: 'attend-handler-removed' })
    installAttend(env)
    expect(attendantGates(deps, root, 's', 'claude-code', '11.4.0')).toEqual({ ok: true })
    disableProject(binding)
    expect(attendantGates(deps, root, 's', 'claude-code', '11.4.0')).toEqual({ ok: false, reason: 'project-disabled' })
  })

  it('withdraws after an in-place downgrade, judged by the version this attendant started with', () => {
    const { env, root } = isolatedEnv()
    enableProject(projectBinding(root, env)!, new Date())
    installAttend(env)
    // The attendant started as 11.4.0; the same install path now holds 11.3.0.
    // Rereading the manifest would have compared 11.3.0 with itself.
    const deps = gateDeps(root, env, installedCli(root, env, '11.3.0'))
    expect(attendantGates(deps, root, 's', 'claude-code', '11.4.0')).toEqual({ ok: false, reason: 'cli-downgraded' })
    expect(attendantGates(deps, root, 's', 'claude-code', '11.3.0')).toEqual({ ok: true })
  })

  it('reads a symlinked installed CLI contract and fails closed when its real manifest is unavailable', () => {
    const { env, root } = isolatedEnv()
    enableProject(projectBinding(root, env)!, new Date())
    installAttend(env)
    const home = installedCli(root, env, '11.4.0')
    const deps = gateDeps(root, env, home)
    expect(attendantGates(deps, root, 's', 'claude-code', '11.4.0')).toEqual({ ok: true })
    const link = path.join(root, 'bin', 'notifai')
    mkdirSync(path.dirname(link), { recursive: true })
    symlinkSync(path.join(root, 'pkg', 'dist', 'main.js'), link)
    installHookAdapter({ execPath: process.execPath, scriptPath: link }, home, 'darwin', env)
    expect(inspectHookAdapter(home, 'darwin').target).toMatchObject({ scriptPath: link })
    const manifest = path.join(root, 'pkg', 'package.json')

    expect(attendantGates(deps, root, 's', 'claude-code', '11.4.0')).toEqual({ ok: true })
    writeFileSync(manifest, JSON.stringify({ name: '@raidiant/notifai', version: '11.3.0' }))
    expect(attendantGates(deps, root, 's', 'claude-code', '11.4.0')).toEqual({ ok: false, reason: 'cli-downgraded' })
    writeFileSync(manifest, '{invalid json')
    expect(attendantGates(deps, root, 's', 'claude-code', '11.4.0')).toEqual({ ok: false, reason: 'cli-contract-unknown' })
    rmSync(manifest)
    expect(attendantGates(deps, root, 's', 'claude-code', '11.4.0')).toEqual({ ok: false, reason: 'cli-contract-unknown' })
  })

  it('fails closed when the installed contract cannot be established', () => {
    const { env, root } = isolatedEnv()
    enableProject(projectBinding(root, env)!, new Date())
    installAttend(env)
    const missing = gateDeps(root, env, path.join(root, 'no-adapter-here'))
    expect(attendantGates(missing, root, 's', 'claude-code', '11.4.0')).toEqual({ ok: false, reason: 'cli-contract-unknown' })
    const home = installedCli(root, env, '11.4.0')
    expect(attendantGates(gateDeps(root, env, home), root, 's', 'claude-code', null)).toEqual({
      ok: false,
      reason: 'cli-contract-unknown',
    })
    // An npx target is pinned to an exact version and compared like any other.
    const npxHome = path.join(root, 'npx-home')
    const npmCli = path.join(root, 'npm-cli.js')
    writeFileSync(npmCli, '')
    installHookAdapter(
      { kind: 'npx', execPath: process.execPath, npmCli, spec: '@raidiant/notifai@11.3.0' },
      npxHome,
      'darwin',
      env,
    )
    expect(attendantGates(gateDeps(root, env, npxHome), root, 's', 'claude-code', '11.4.0')).toEqual({
      ok: false,
      reason: 'cli-downgraded',
    })
  })
})
