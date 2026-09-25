import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'
import { withFileLock } from './file-lock.js'
import { newerPublishedCli, publishedCliDistTags, shouldConsultCliRegistry, thisCliVersion } from './cli-release.js'
import { CLI_UPDATE_AVAILABLE } from './cli-contract.js'

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const NOTICE_INTERVAL_MS = 7 * CHECK_INTERVAL_MS

interface NoticeState {
  checked_at?: number
  notified_at?: number
}

function readState(file: string): NoticeState {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > 1024) throw new Error('invalid update notice state')
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof value !== 'object' || value === null) throw new Error('invalid update notice state')
    const state = value as NoticeState
    for (const timestamp of [state.checked_at, state.notified_at]) {
      if (timestamp !== undefined && (!Number.isSafeInteger(timestamp) || timestamp < 0)) {
        throw new Error('invalid update notice timestamp')
      }
    }
    return state
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

function recent(timestamp: number | undefined, now: number, interval: number): boolean {
  // A clock rollback must not create another notice.
  return timestamp !== undefined && now - timestamp < interval
}

/** One optional notice per machine-local state directory, across roots and harnesses. */
export async function agentUpdateNotice(options: {
  env: NodeJS.ProcessEnv
  now: number
  updateCommand: string
  fetchImpl?: typeof fetch
}): Promise<string | undefined> {
  if (!shouldConsultCliRegistry({ env: options.env })) return undefined
  const file = path.join(stateDir(options.env), 'cli-update-notice.json')
  const save = (state: NoticeState): void => atomicWriteFileSync(file, `${JSON.stringify(state)}\n`)
  try {
    // Claim the lookup before doing network I/O. Another process neither waits
    // for the registry nor emits a duplicate. Only short disk work holds a lock.
    const claimed = withFileLock(`${file}.lock`, () => {
      const state = readState(file)
      if (recent(state.notified_at, options.now, NOTICE_INTERVAL_MS) ||
          recent(state.checked_at, options.now, CHECK_INTERVAL_MS)) return false
      save({ ...state, checked_at: options.now })
      return true
    }, { waitMs: 50 })
    if (!claimed) return undefined
    const tags = await publishedCliDistTags(options.fetchImpl, { useCache: false })
    if (newerPublishedCli(thisCliVersion(), tags) === null) return undefined
    const notify = withFileLock(`${file}.lock`, () => {
      const state = readState(file)
      if (recent(state.notified_at, options.now, NOTICE_INTERVAL_MS)) return false
      save({ ...state, notified_at: options.now })
      return true
    }, { waitMs: 50 })
    if (!notify) return undefined
    return `${CLI_UPDATE_AVAILABLE} Run \`notifai update --check --json\`, read the release notes, and briefly offer to perform the update at a natural pause. ` +
      `When authorized, use \`${options.updateCommand}\` and follow the new CLI guidance and session handoff. ` +
      'Follow the User\'s instructions about updating; keep working if deferred. ' +
      'Do not send a Notification Request just for this notice. It appears at most once every seven days on this machine.'
  } catch {
    // Update discovery must never interrupt lifecycle guidance or routing.
    return undefined
  }
}
