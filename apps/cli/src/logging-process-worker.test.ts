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
      const startDeadline = Date.now() + 10_000
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
      expect(logger.enabled).toBe(true)
    })
  })
}
