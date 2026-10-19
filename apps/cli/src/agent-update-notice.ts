import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { stateDir } from './config.js'
import { withFileLock } from './file-lock.js'
import { discoverCliUpdate, shouldConsultCliRegistry } from './cli-release.js'
import { CLI_UPDATE_AVAILABLE } from './cli-contract.js'
import { packageVersion } from './release.js'
import { compareReleasePrecedence, isSemVer } from './version.js'

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const NOTICE_INTERVAL_MS = 7 * CHECK_INTERVAL_MS

interface NoticeState {
  checked_at?: number
  notified_at?: number
  /** The newer release the last successful lookup found. */
  available?: string
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
    if (state.available !== undefined && (typeof state.available !== 'string' || !isSemVer(state.available))) {
      throw new Error('invalid update notice version')
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

function noticeFile(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'cli-update-notice.json')
}

function save(file: string, state: NoticeState): void {
  atomicWriteFileSync(file, `${JSON.stringify(state)}\n`)
}

/**
 * The registry lookup behind the update notice, at most once a day and never
 * while a notice is still quiet. It records what it found and emits nothing.
 *
 * This is network work with its own long ceilings, so it never runs inside a
 * hook's harness timeout: the detached hook maintenance process and the
 * explicit CLI run it, and hooks only read what it recorded.
 */
export async function refreshAgentUpdateState(options: {
  env: NodeJS.ProcessEnv
  now: number
  fetchImpl?: typeof fetch
}): Promise<void> {
  if (!shouldConsultCliRegistry({ env: options.env })) return
  const file = noticeFile(options.env)
  try {
    // Claim the lookup before doing network I/O. Another process neither waits
    // for the registry nor repeats it. Only short disk work holds a lock.
    const claimed = withFileLock(`${file}.lock`, () => {
      const state = readState(file)
      if (recent(state.notified_at, options.now, NOTICE_INTERVAL_MS) ||
          recent(state.checked_at, options.now, CHECK_INTERVAL_MS)) return false
      save(file, { ...state, checked_at: options.now })
      return true
    }, { waitMs: 50 })
    if (!claimed) return
    const discovery = await discoverCliUpdate({ env: options.env, fetchImpl: options.fetchImpl, useCache: false })
    // An unreadable registry says nothing about availability; keep what is known.
    if (discovery.available === null) return
    withFileLock(`${file}.lock`, () => {
      const state = readState(file)
      delete state.available
      save(file, discovery.newer === null ? state : { ...state, available: discovery.newer })
    }, { waitMs: 50 })
  } catch {
    // Update discovery must never interrupt lifecycle guidance or routing.
  }
}

/**
 * The machine-wide update notice, read from what the last lookup recorded.
 * No network and no wait: it reads one small file, and takes the notice lock
 * only on the rare call that emits the notice.
 */
export function cachedAgentUpdateNotice(options: {
  env: NodeJS.ProcessEnv
  now: number
  updateCommand: string
  /** Test seam; production compares with this build's version. */
  currentVersion?: string | null
}): string | undefined {
  if (!shouldConsultCliRegistry({ env: options.env })) return undefined
  const file = noticeFile(options.env)
  try {
    const owed = (state: NoticeState): boolean => {
      if (state.available === undefined || recent(state.notified_at, options.now, NOTICE_INTERVAL_MS)) return false
      const current = options.currentVersion === undefined ? packageVersion() : options.currentVersion
      // Already on that release or a later one: there is nothing to offer.
      return current === null || compareReleasePrecedence(state.available, current) === 'after'
    }
    if (!owed(readState(file))) return undefined
    const notify = withFileLock(`${file}.lock`, () => {
      const state = readState(file)
      if (!owed(state)) return false
      save(file, { ...state, notified_at: options.now })
      return true
    }, { waitMs: 50 })
    if (!notify) return undefined
    return `${CLI_UPDATE_AVAILABLE} Run \`notifai update --check --json\`, read the release notes, and briefly offer to perform the update at a natural pause. ` +
      `When authorized, use \`${options.updateCommand}\` and follow the new CLI guidance and session handoff. ` +
      'Follow the User\'s instructions about updating; keep working if deferred. ' +
      'Do not send a Notification Request just for this notice. It appears at most once every seven days on this machine.'
  } catch {
    // An unreadable record never interrupts lifecycle guidance or routing.
    return undefined
  }
}

/** One optional notice per machine-local state directory, across roots and harnesses. */
export async function agentUpdateNotice(options: {
  env: NodeJS.ProcessEnv
  now: number
  updateCommand: string
  fetchImpl?: typeof fetch
}): Promise<string | undefined> {
  await refreshAgentUpdateState(options)
  return cachedAgentUpdateNotice(options)
}
