import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  CODEX_THREAD_LOCK_DIR,
  codexThreadLockPath,
  codexWakeRoute,
  observeCodexThread,
  systemCodexWakeAdapters,
  type CodexWakeAdapters,
  type CodexWakeObservation,
} from './codex-wake.js'

const THREAD_ID = '019ff69d-a07f-7161-ab6e-bd06b3b93c8e'

const event = {
  context:
    'Notifai — question_id rollout-option, question "Which rollout option?"; the user answered "BETA".',
  answers: 1,
  remaining: 0,
  request_ids: ['req_test'],
  journal_recorded_at: 1_800_000_000_000,
  commitDelivery: () => true,
}

const temporaries: string[] = []

function codexHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-wake-'))
  temporaries.push(home)
  mkdirSync(path.join(home, CODEX_THREAD_LOCK_DIR), { recursive: true })
  return home
}

afterAll(() => {
  for (const directory of temporaries) rmSync(directory, { recursive: true, force: true })
})

function adapters(
  options: {
    sourceAlive?: boolean
    probes?: CodexWakeObservation[]
    probe?: CodexWakeObservation
  } = {},
): CodexWakeAdapters & { resumed: Array<{ threadId: string; cwd: string; context: string }>; probed: string[] } {
  const resumed: Array<{ threadId: string; cwd: string; context: string }> = []
  const probed: string[] = []
  const sequence = [...(options.probes ?? [])]
  return {
    resumed,
    probed,
    probeThreadWriter(lockPath) {
      probed.push(lockPath)
      return sequence.shift() ?? options.probe ?? { state: 'stopped' }
    },
    sourceAlive() {
      return options.sourceAlive ?? false
    },
    async resume(threadId, cwd, context) {
      resumed.push({ threadId, cwd, context })
    },
  }
}

function route(
  wake: CodexWakeAdapters,
  overrides: { threadId?: string; env?: NodeJS.ProcessEnv } = {},
): ReturnType<typeof codexWakeRoute> {
  return codexWakeRoute({
    threadId: overrides.threadId ?? THREAD_ID,
    cwd: '/tmp/notifai-codex-wake',
    sourcePid: 4242,
    env: overrides.env ?? { CODEX_HOME: '/tmp/notifai-codex-home' },
    adapters: wake,
  })
}

describe('Codex thread ownership', () => {
  it('names the lock file Codex itself keys by thread id', () => {
    expect(codexThreadLockPath(THREAD_ID, { CODEX_HOME: '/tmp/cx' })).toBe(
      `/tmp/cx/${CODEX_THREAD_LOCK_DIR}/${THREAD_ID}.lock`,
    )
  })

  it('refuses to derive a lock path from a session id that is not a thread id', () => {
    const wake = adapters()

    expect(observeCodexThread('../../etc/passwd', {}, wake)).toEqual({
      state: 'unknown',
      reason: 'the Codex session id is not a thread id',
    })
    expect(wake.probed).toEqual([])
  })

  it('reports a probe that throws as unknown rather than as an unowned thread', () => {
    const observation = observeCodexThread(THREAD_ID, { CODEX_HOME: '/tmp/cx' }, {
      probeThreadWriter() {
        throw new Error('permission denied')
      },
    })

    expect(observation).toEqual({
      state: 'unknown',
      reason: 'Codex thread-writer lock probe failed: permission denied',
    })
  })
})

describe('Codex writer-lock probe', () => {
  const platform = process.platform
  const supported = platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd'

  it.runIf(supported)('reads a kernel-held lock as a live writer and its release as stopped', () => {
    const home = codexHome()
    const lock = codexThreadLockPath(THREAD_ID, { CODEX_HOME: home })
    writeFileSync(lock, '')
    const probe = systemCodexWakeAdapters({ CODEX_HOME: home }).probeThreadWriter

    // flock is held per open file description, so this process contends with
    // itself exactly as a separate Codex process would.
    const held = openSync(lock, 0x20 | 0x4)
    try {
      expect(probe(lock)).toEqual({ state: 'live' })
    } finally {
      closeSync(held)
    }

    expect(probe(lock)).toEqual({ state: 'stopped' })
  })

  it.runIf(supported)('treats a swept lock file inside a real lock directory as stopped', () => {
    const home = codexHome()
    const probe = systemCodexWakeAdapters({ CODEX_HOME: home }).probeThreadWriter

    expect(probe(codexThreadLockPath(THREAD_ID, { CODEX_HOME: home }))).toEqual({
      state: 'stopped',
    })
  })

  it.runIf(supported)('never claims a thread is unowned when there is no lock directory', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-nohome-'))
    temporaries.push(home)
    const probe = systemCodexWakeAdapters({ CODEX_HOME: home }).probeThreadWriter
    const lock = codexThreadLockPath(THREAD_ID, { CODEX_HOME: home })

    expect(probe(lock)).toMatchObject({ state: 'unknown' })
  })

  it.runIf(!supported)('fails closed where no non-blocking lock probe exists', () => {
    const probe = systemCodexWakeAdapters({ CODEX_HOME: '/tmp/cx' }).probeThreadWriter

    expect(probe(`/tmp/cx/${CODEX_THREAD_LOCK_DIR}/${THREAD_ID}.lock`)).toMatchObject({
      state: 'unknown',
    })
  })
})

describe('Codex wake delivery', () => {
  it('continues the live session through its own Stop hook without probing anything', async () => {
    const wake = adapters({ sourceAlive: true })

    const outcome = await route(wake).deliver(event)

    expect(JSON.parse(outcome.stdout!)).toEqual({ decision: 'block', reason: event.context })
    expect(wake.probed).toEqual([])
    expect(wake.resumed).toEqual([])
  })

  it('cold-resumes a stopped thread only after two probes both find no writer', async () => {
    const wake = adapters({ probes: [{ state: 'stopped' }, { state: 'stopped' }] })

    const outcome = await route(wake).deliver(event)

    expect(wake.probed).toEqual([
      `/tmp/notifai-codex-home/${CODEX_THREAD_LOCK_DIR}/${THREAD_ID}.lock`,
      `/tmp/notifai-codex-home/${CODEX_THREAD_LOCK_DIR}/${THREAD_ID}.lock`,
    ])
    expect(wake.resumed).toEqual([
      { threadId: THREAD_ID, cwd: '/tmp/notifai-codex-wake', context: event.context },
    ])
    expect(outcome.stdout).toBeUndefined()
    expect(outcome.log).toEqual({ route: 'cold-resume', stage: 'delivered' })
  })

  it('never resumes a thread a live writer owns', async () => {
    const wake = adapters({ probe: { state: 'live' } })

    const outcome = await route(wake).deliver(event)

    expect(wake.resumed).toEqual([])
    expect(outcome.stdout).toBeUndefined()
    expect(outcome.log).toEqual({
      route: 'hold-for-next-turn',
      stage: 'queued',
      reason: 'a live writer owns the Codex thread and this hook can no longer continue it',
    })
    expect(outcome.notes.join('\n')).toContain('holding the accepted answer for the next turn')
  })

  it('never resumes a thread whose writer took the lock between the two probes', async () => {
    const wake = adapters({ probes: [{ state: 'stopped' }, { state: 'live' }] })

    const outcome = await route(wake).deliver(event)

    expect(wake.probed).toHaveLength(2)
    expect(wake.resumed).toEqual([])
    expect(outcome.log).toMatchObject({ route: 'hold-for-next-turn', stage: 'queued' })
  })

  it('journals the answer when ownership cannot be probed at all', async () => {
    const wake = adapters({ probe: { state: 'unknown', reason: 'no lock directory' } })

    const outcome = await route(wake).deliver(event)

    expect(wake.resumed).toEqual([])
    expect(outcome.log).toEqual({
      route: 'hold-for-next-turn',
      stage: 'queued',
      reason: 'no lock directory',
    })
  })

  it('journals the answer when the session id cannot name a thread lock', async () => {
    const wake = adapters()

    const outcome = await route(wake, { threadId: 'codex-session-7' }).deliver(event)

    expect(wake.probed).toEqual([])
    expect(wake.resumed).toEqual([])
    expect(outcome.log).toMatchObject({
      route: 'hold-for-next-turn',
      reason: 'the Codex session id is not a thread id',
    })
  })

  it('does not report delivery when the cold resume fails', async () => {
    const wake = adapters()
    wake.resume = vi.fn(async () => {
      throw new Error('codex exec exited 1')
    })

    await expect(route(wake).deliver(event)).rejects.toThrow('codex exec exited 1')
  })
})

describe('Codex system adapters', () => {
  it('reads this process as a live source and PID 0 as no source at all', () => {
    const wake = systemCodexWakeAdapters({})

    expect(wake.sourceAlive(process.pid)).toBe(true)
    expect(wake.sourceAlive(0)).toBe(false)
  })
})
