import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { withFileLock, type FileLockObservation } from './file-lock.js'

const worker = process.env['NOTIFAI_FILE_LOCK_WORKER']
const sleep = new Int32Array(new SharedArrayBuffer(4))

function waitFor(file: string): void {
  const deadline = Date.now() + 15_000
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`)
    Atomics.wait(sleep, 0, 0, 2)
  }
}

if (worker === undefined) {
  describe('file lock process worker', () => {
    it('stays dormant outside the cross-process regressions', () => {
      expect(worker).toBeUndefined()
    })
  })
} else {
  describe('file lock process worker', () => {
    it('runs one instrumented lock contender', () => {
      const pauseAt = process.env['NOTIFAI_FILE_LOCK_PAUSE_AT']
      const pausePath = process.env['NOTIFAI_FILE_LOCK_PAUSED']!
      const continuePath = process.env['NOTIFAI_FILE_LOCK_CONTINUE']!
      const enteredPath = process.env['NOTIFAI_FILE_LOCK_ENTERED']!
      const releasePath = process.env['NOTIFAI_FILE_LOCK_RELEASE']!
      const waitPath = process.env['NOTIFAI_FILE_LOCK_WAITS']!
      let waits = 0

      withFileLock(
        process.env['NOTIFAI_FILE_LOCK_PATH']!,
        () => {
          writeFileSync(enteredPath, worker)
          if (process.env['NOTIFAI_FILE_LOCK_ACTION'] === 'crash') {
            process.kill(process.pid, 'SIGKILL')
            throw new Error('SIGKILL did not terminate the worker')
          }
          waitFor(releasePath)
        },
        {
          waitMs: 15_000,
          observe(observation: FileLockObservation) {
            if (
              observation.phase === 'choosing-published' ||
              observation.phase === 'stale-entry'
            ) {
              writeFileSync(pausePath, observation.entry)
              if (pauseAt === observation.phase) waitFor(continuePath)
            }
            if (observation.phase === 'waiting') {
              waits += 1
              writeFileSync(waitPath, String(waits))
            }
          },
        },
      )

      expect(readFileSync(enteredPath, 'utf8')).toBe(worker)
    })
  })
}
