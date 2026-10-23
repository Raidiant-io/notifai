import type { AttendanceRequestT,AttendanceResponse } from '@raidiant/notifai-protocol'
import { execFileSync } from 'node:child_process'
import { appendFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe,expect,it } from 'vitest'
import type { ApiClient } from './client.js'
import { attendantGates } from './commands-hook-attend.js'
import { hookRunCommand } from './commands-hook-run.js'
import type { CommandDeps,CommandIo } from './commands.js'
import { sanitizeSessionId,stateDir } from './config.js'
import { inspectHookAdapter,installHookAdapter } from './hook-adapter.js'
import { claimQuestionPush,readClaimFile,releaseQuestionPush } from './hook-question-lock.js'
import {
beginSessionIncarnation,
endsIncarnation,
lifecycleStamp,
markSessionEnded,
readSessionEndMarker,
readSessionIncarnation,
readSessionState,
recordSessionNotified,
recordSessionStart,
updateSessionState
} from './hook-session-state.js'
import { buildHookConfig } from './install-hooks.js'
import { currentProcessIdentity,processExecutableName,processStartTime } from './process-identity.js'
import { enableProject,projectBinding } from './project-enablement.js'
import {
claudeAttendanceProbe,
codexAttendanceProbe,
type ClaudeProbeAdapters
} from './session-attendant-probe.js'
import {
attendantClaimPath,
attendantStatusPath,
listAttendantReports,
readTurnActivity,
recordTurnEnd,
recordTurnStart,
writeAttendantStatus
} from './session-attendant-state.js'
import type { AttendantResult } from './session-attendant.js'
import { readDeliveryJournal } from './session-delivery.js'
import { sessionInputWake } from './session-inputs.js'

const HARNESS = { pid: 4242, start: 'Fri Sep 25 11:12:08 2026' }

function isolatedEnv(): { env: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-attendant-'))
  execFileSync('git', ['init', '--quiet', root])
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
      inboxSettleMs: 50,
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

  it('hands a development Claude Code session over to the installed runtime at its next root hook, keeping its pending work', async () => {
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

  it('ends on this incarnation’s SessionEnd marker, and when the Codex process is gone or its PID reused', () => {
    expect(probeWith({}, { ended: true })).toEqual({ state: 'ended', reason: 'session-end-hook' })
    const orphaned = { parentPid: () => 1 }
    expect(probeWith({ ...orphaned, pidExists: () => false })).toEqual({ state: 'ended', reason: 'harness-gone' })
    expect(probeWith({ ...orphaned, readStart: () => 'Sat Sep 26 09:00:00 2026' })).toEqual({
      state: 'ended',
      reason: 'harness-gone',
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
    expect(deps.exits).toEqual([{ reason: 'session-end-hook', reported: 'withdrawn' }])
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

  it('reads a symlinked installed CLI contract and fails closed when its real manifest is unavailable', () => {
    const { env, root } = isolatedEnv()
    enableProject(projectBinding(root, env)!, new Date())
    installAttend(env)
    const home = installedCli(root, env, '11.4.0')
    const deps = gateDeps(root, env, home)
    expect(attendantGates(deps, root, 'claude-code', '11.4.0')).toEqual({ ok: true })
    const link = path.join(root, 'bin', 'notifai')
    mkdirSync(path.dirname(link), { recursive: true })
    symlinkSync(path.join(root, 'pkg', 'dist', 'main.js'), link)
    installHookAdapter({ execPath: process.execPath, scriptPath: link }, home, 'darwin', env)
    expect(inspectHookAdapter(home, 'darwin').target).toMatchObject({ scriptPath: link })
    const manifest = path.join(root, 'pkg', 'package.json')

    expect(attendantGates(deps, root, 'claude-code', '11.4.0')).toEqual({ ok: true })
    writeFileSync(manifest, JSON.stringify({ name: '@raidiant/notifai', version: '11.3.0' }))
    expect(attendantGates(deps, root, 'claude-code', '11.4.0')).toEqual({ ok: false, reason: 'cli-downgraded' })
    writeFileSync(manifest, '{invalid json')
    expect(attendantGates(deps, root, 'claude-code', '11.4.0')).toEqual({ ok: false, reason: 'cli-contract-unknown' })
    rmSync(manifest)
    expect(attendantGates(deps, root, 'claude-code', '11.4.0')).toEqual({ ok: false, reason: 'cli-contract-unknown' })
  })
})

it('reloads changed credentials in a resident hook and keeps serving the same session', async () => {
  const { env, root } = isolatedEnv()
  const old = fakeAttendance(), next = fakeAttendance()
  let machine = 'mac_first'
  const deps = attendDeps(env, root, {
    clientFactory: (_base, authorization) => authorization.includes('mac_first') ? old.client : next.client,
  })
  deps.store.load = () => ({ machineId: machine, secret: 'test-secret', baseUrl: 'https://test.notifai.invalid', machineName: 'test' })
  recordSessionNotified('sess-a', env, Date.now())
  const running = hookRunCommand(deps, 'attend', stdin({ session_id: 'sess-a', cwd: root,
    hook_event_name: 'SessionStart', source: 'startup' }), 'claude-code')
  try {
    await until(() => old.calls.length >= 2, 'original attendance')
    machine = 'mac_replacement'
    await until(() => next.calls.length >= 2, 'attendance with current credentials')
    expect(old.calls.some(call => call.state === 'withdrawn')).toBe(true)
    expect(old.calls.some(call => call.state === 'ended')).toBe(false)
    expect(next.calls[0]?.generation).toBeUndefined()
    expect(deps.exits).toEqual([])
  } finally {
    markSessionEnded('sess-a', env, Date.now() + 1)
    await running
  }
})
