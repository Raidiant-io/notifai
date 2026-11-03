import { randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'
import type { ReadinessState } from './readiness.js'

/** Test the same create/write/flush/rename path delivery needs. Free-byte
 * estimates alone cannot detect quotas, permissions or a read-only volume. */
export function localStorageReadiness(env: NodeJS.ProcessEnv): ReadinessState {
  const directory = stateDir(env)
  const file = path.join(directory, `.storage-check-${randomUUID()}`)
  try {
    atomicWriteFileSync(file, Buffer.alloc(4096))
    unlinkSync(file)
    return { id: 'local-storage', title: 'Local storage', status: 'ready',
      detail: 'Notifai can save delivery state on this computer' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'storage_error'
    const full = code === 'ENOSPC' || code === 'EDQUOT'
    return { id: 'local-storage', title: 'Local storage', status: 'gap',
      detail: full
        ? 'This computer has no space available for Notifai delivery state. Answers and notes may wait until space is available.'
        : 'Notifai cannot save delivery state on this computer. Answers and notes may wait until storage is writable.',
      technical: { code, directory },
      remedy: { by: 'user-elsewhere', summary: full
        ? 'Free space on the volume holding Notifai state, then run notifai doctor again. Do not delete Notifai state to make room.'
        : 'Restore write access to the Notifai state directory, then run notifai doctor again. Keep existing state intact.' },
    }
  } finally {
    try { unlinkSync(file) } catch { /* Only this disposable probe belongs to us. */ }
  }
}
