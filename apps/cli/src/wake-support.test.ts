import { describe, expect, it } from 'vitest'
import { cancelledDelivery, holdForNextTurn, runWakeCommand } from './wake-support.js'

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
})
