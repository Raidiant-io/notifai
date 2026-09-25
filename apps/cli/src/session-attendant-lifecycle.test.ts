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
  endsIncarnation,
  happenedBefore,
  lifecycleStamp,
  markSessionEnded,
  pruneAbandonedSessions,
  readSessionEndMarker,
  readSessionIncarnation,
  recordSessionNotified,
  recordSessionStart,
  refreshSessionMarkers,
  sessionHasEnded,
} from './hook-session-state.js'
import { installHookAdapter } from './hook-adapter.js'
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

  it('does not attend for a harness without an exact-session probe', async () => {
    const { env, root } = isolatedEnv()
    const deps = attendDeps(env, root)
    expect(await hookRunCommand(deps, 'attend', stdin({ session_id: 'c1', cwd: root }), 'codex')).toBe(0)
    expect(existsSync(attendantClaimPath('c1', env))).toBe(false)
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
