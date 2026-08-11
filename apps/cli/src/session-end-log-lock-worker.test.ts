import { existsSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { withFileLock } from './file-lock.js'

const workerMode = process.env['NOTIFAI_SESSION_END_LOG_LOCK_WORKER_MODE']
const sleep = new Int32Array(new SharedArrayBuffer(4))

function waitFor(file: string): void {
  const deadline = Date.now() + 15_000
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`)
    Atomics.wait(sleep, 0, 0, 2)
  }
}

if (workerMode === undefined) {
  describe('SessionEnd log lock worker', () => {
    it('stays dormant outside the CLI deadline regression', () => {
      expect(workerMode).toBeUndefined()
    })
  })
} else {
  describe('SessionEnd log lock worker', () => {
    it('holds a live bakery ticket until the parent releases it', () => {
      withFileLock(
        process.env['NOTIFAI_SESSION_END_LOG_LOCK_PATH']!,
        () => {
          writeFileSync(process.env['NOTIFAI_SESSION_END_LOG_LOCK_READY']!, workerMode)
          waitFor(process.env['NOTIFAI_SESSION_END_LOG_LOCK_RELEASE']!)
        },
        { waitMs: 15_000 },
      )
    })
  })
}
