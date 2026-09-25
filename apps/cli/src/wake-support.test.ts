import { describe, expect, it, vi } from 'vitest'
import { cancelledDelivery, holdForNextTurn, runWakeCommand, WriteDeadlineError } from './wake-support.js'

describe('shared wake outcomes', () => {
  it('journals one canonical hold outcome', () => {
    expect(holdForNextTurn('session is busy')).toEqual({
      notes: ['holding the accepted answer for the next turn: session is busy'],
      log: { route: 'hold-for-next-turn', stage: 'queued', reason: 'session is busy' },
      acknowledgement: 'held',
    })
  })

  it('journals one canonical cancellation outcome', () => {
    expect(cancelledDelivery()).toEqual({
      notes: ['the Agent Session ended before answer delivery; stopping this observer'],
      log: { route: 'hold-for-next-turn', stage: 'queued', reason: 'session-ended' },
      acknowledgement: 'held',
    })
  })

  it('captures a child command result and names failures', async () => {
    await expect(
      runWakeCommand(process.execPath, ['-e', 'process.stdout.write("ready")']),
    ).resolves.toBe('ready')
    await expect(
      runWakeCommand(process.execPath, ['-e', 'process.stderr.write("nope"); process.exit(7)']),
    ).rejects.toThrow(/exited 7: nope$/)
  })

  it('starts a subprocess writer in its own process group and reports it at once', async () => {
    let reported: number | undefined
    const output = await runWakeCommand('sh', ['-c', 'echo "$$ $(ps -o pgid= -p $$)"'], {
      onSpawn: (pgid) => {
        reported = pgid
      },
    })
    const [pid, pgid] = output.trim().split(/\s+/).map(Number)
    expect(pgid).toBe(pid)
    expect(reported).toBe(pid)
  })
})

describe('bounded subprocess writers', () => {
  /** Whether any process of group `pgid` still exists. */
  const groupAlive = (pgid: number): boolean => {
    try {
      process.kill(-pgid, 0)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  it.skipIf(process.platform === 'win32')('kills the writer\u2019s whole process group at its deadline', async () => {
    let pgid = 0
    const deadline = new AbortController()
    // A writer that started a child of its own and is still running.
    const running = runWakeCommand('/bin/sh', ['-c', 'sleep 30 & wait'], {
      onSpawn: (group) => {
        pgid = group
      },
      signal: deadline.signal,
    })
    expect(pgid).toBeGreaterThan(0)
    expect(groupAlive(pgid)).toBe(true)
    deadline.abort()
    await expect(running).rejects.toBeInstanceOf(WriteDeadlineError)
    await vi.waitFor(() => expect(groupAlive(pgid)).toBe(false), { timeout: 5_000 })
  })

  it('never starts a writer whose deadline already passed', async () => {
    const deadline = new AbortController()
    deadline.abort()
    let spawned = false
    await expect(
      runWakeCommand('/bin/sh', ['-c', 'exit 0'], { onSpawn: () => (spawned = true), signal: deadline.signal }),
    ).rejects.toBeInstanceOf(WriteDeadlineError)
    expect(spawned).toBe(false)
  })
})
