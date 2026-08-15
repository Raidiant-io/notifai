import { existsSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createLogger } from './logging.js'

const worker = process.env['NOTIFAI_ROTATION_WORKER']

if (worker === undefined) {
  describe('rotation process worker', () => {
    it('stays dormant outside the concurrency regression', () => {
      expect(worker).toBeUndefined()
    })
  })
} else {
  describe('rotation process worker', () => {
    it('writes one share of an overlapping log stream', async () => {
      const readyPath = process.env['NOTIFAI_ROTATION_READY']!
      const startPath = process.env['NOTIFAI_ROTATION_START']!
      const records = Number(process.env['NOTIFAI_ROTATION_RECORDS'])
      const maxBytes = Number(process.env['NOTIFAI_ROTATION_MAX_BYTES'])
      const maxFiles = Number(process.env['NOTIFAI_ROTATION_MAX_FILES'])
      writeFileSync(readyPath, 'ready')
      // The parent's absolute deadline, not a countdown of this worker's own:
      // the barrier fails for everyone at one instant, so a worker that started
      // early cannot walk out on a parent still waiting for its last sibling.
      const startDeadline = Number(process.env['NOTIFAI_ROTATION_DEADLINE'])
      while (!existsSync(startPath)) {
        if (Date.now() >= startDeadline) throw new Error('rotation parent never released the barrier')
        await new Promise((resolve) => setTimeout(resolve, 2))
      }

      const logger = createLogger({
        runId: `r_worker_${worker}`,
        settings: { maxBytes, maxFiles },
      })
      for (let sequence = 0; sequence < records; sequence += 1) {
        logger.info('cli.end', { worker, sequence, pad: 'p'.repeat(140) })
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      // The sink switches itself off for the rest of a process the first time a
      // write throws, so this is the whole point of the worker: every record it
      // was given reached the shared file through the cross-process lock.
      expect(logger.enabled, 'the shared-log sink switched itself off mid-run').toBe(true)
    })
  })
}
