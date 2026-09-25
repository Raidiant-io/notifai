import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AttendanceRequestT, AttendanceResponse } from '@raidiant/notifai-protocol'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from './client.js'
import { attendantGates } from './commands-hook-attend.js'
import { hookRunCommand } from './commands-hook-run.js'
import type { CommandDeps, CommandIo } from './commands.js'
import { sanitizeSessionId, stateDir } from './config.js'
import { claimQuestionPush, releaseQuestionPush } from './hook-question-lock.js'
import {
  beginSessionIncarnation,
  markSessionEnded,
  readSessionEndedAt,
  readSessionIncarnation,
  recordSessionNotified,
  recordSessionStart,
  sessionHasEnded,
} from './hook-session-state.js'
import { buildHookConfig } from './install-hooks.js'
import { currentProcessIdentity } from './process-identity.js'
import { disableProject, enableProject, projectBinding } from './project-enablement.js'
import type { AttendantResult } from './session-attendant.js'
import { claudeAttendanceProbe, type ClaudeProbeAdapters } from './session-attendant-probe.js'
import { attendantClaimPath, listAttendantReports } from './session-attendant-state.js'

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
    const first = beginSessionIncarnation('s1', env, { stamp: 1_000, harnessProcess: HARNESS })
    markSessionEnded('s1', env, 2_000)

    // In-process /resume: the attend handler runs before the paused activation handler.
    const attend = beginSessionIncarnation('s1', env, { stamp: 3_000, harnessProcess: HARNESS })
    expect(attend.incarnation).not.toBe(first.incarnation)
    expect(attend.started_at).toBe(3_000)
    expect(readSessionEndedAt('s1', env)).toBeNull()

    // The activation handler resumes afterwards and joins the same incarnation.
    recordSessionStart('s1', env, 'claude-code', '/work', undefined, 3_010)
    expect(readSessionIncarnation('s1', env)?.incarnation).toBe(attend.incarnation)
  })

  it('agrees on one incarnation when activation runs first', () => {
    const { env } = isolatedEnv()
    markSessionEnded('s2', env, 500)
    recordSessionStart('s2', env, 'claude-code', '/work', undefined, 1_000)
    const activation = readSessionIncarnation('s2', env)!
    const attend = beginSessionIncarnation('s2', env, { stamp: 1_020, harnessProcess: HARNESS })
    expect(attend.incarnation).toBe(activation.incarnation)
    expect(attend.harness_process).toEqual(HARNESS)
  })

  it('keeps an end written after this handler started: that end is its own', () => {
    const { env } = isolatedEnv()
    markSessionEnded('s3', env, 5_000)
    const late = beginSessionIncarnation('s3', env, { stamp: 4_000, harnessProcess: HARNESS })
    expect(readSessionEndedAt('s3', env)).toBe(5_000)
    expect(5_000 >= late.started_at).toBe(true)
  })

  it('mints a new incarnation for a new harness process and keeps it for /compact', () => {
    const { env } = isolatedEnv()
    const first = beginSessionIncarnation('s4', env, { stamp: 1_000, harnessProcess: HARNESS })
    const compact = beginSessionIncarnation('s4', env, { stamp: 9_000, harnessProcess: HARNESS })
    expect(compact.incarnation).toBe(first.incarnation)
    const resumed = beginSessionIncarnation('s4', env, {
      stamp: 10_000,
      harnessProcess: { pid: 5151, start: 'Fri Sep 25 12:00:00 2026' },
    })
    expect(resumed.incarnation).not.toBe(first.incarnation)
  })

  it('a re-arm never drops the shared end marker', () => {
    const { env } = isolatedEnv()
    markSessionEnded('s5', env, 1_000)
    const rearmed = beginSessionIncarnation('s5', env, {
      stamp: 2_000,
      harnessProcess: HARNESS,
      clearEarlierEnd: false,
    })
    expect(sessionHasEnded('s5', env)).toBe(true)
    expect(rearmed.started_at).toBeGreaterThan(1_000)
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
      now: () => 1_000,
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
        now: Date.now,
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
  it('becomes the attendant despite a stale end marker, and a second start exits at once', async () => {
    const { env, root } = isolatedEnv()
    const deps = attendDeps(env, root)
    markSessionEnded('sess-a', env, Date.now() - 60_000)
    const envelope = { session_id: 'sess-a', cwd: root, hook_event_name: 'SessionStart', source: 'resume' }

    const first = hookRunCommand(deps, 'attend', stdin(envelope), 'claude-code')
    await until(() => listAttendantReports(env).some((report) => report.phase === 'dormant'), 'dormant attendant')
    expect(readSessionEndedAt('sess-a', env)).toBeNull()

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

  it('does not attend for a harness without an exact-session probe', async () => {
    const { env, root } = isolatedEnv()
    const deps = attendDeps(env, root)
    expect(await hookRunCommand(deps, 'attend', stdin({ session_id: 'c1', cwd: root }), 'codex')).toBe(0)
    expect(existsSync(attendantClaimPath('c1', env))).toBe(false)
  })
})

describe('attendant gates', () => {
  it('require Project Enablement and an installed attend handler', () => {
    const { env, root } = isolatedEnv()
    const deps = { io: new CapturedIo(), env, cwd: root, store: {} } as unknown as CommandDeps
    const binding = projectBinding(root, env)!
    enableProject(binding, new Date())
    expect(attendantGates(deps, root, 's', 'claude-code')).toEqual({ ok: false, reason: 'attend-handler-removed' })

    const settings = path.join(env['CLAUDE_CONFIG_DIR'] as string, 'settings.json')
    mkdirSync(path.dirname(settings), { recursive: true })
    writeFileSync(
      settings,
      JSON.stringify({ hooks: buildHookConfig({ adapterPath: '/adapter', harness: 'claude-code', platform: 'darwin' }) }),
    )
    expect(attendantGates(deps, root, 's', 'claude-code')).toEqual({ ok: true })

    disableProject(binding)
    expect(attendantGates(deps, root, 's', 'claude-code')).toEqual({ ok: false, reason: 'project-disabled' })
  })
})
