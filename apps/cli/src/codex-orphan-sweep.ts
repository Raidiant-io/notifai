/**
 * A one-time cleanup of Notifai's own wakes left in Codex homes the thread no
 * longer runs in (2026-11-05: "Clean them up"), from builds before the hub
 * followed threads into other homes and removed what it left behind
 * (`codex-thread-home.ts`).
 *
 * For every Codex conversation Notifai attended, in every home it may have
 * run in, an item is removed only when it is exactly Notifai's content-free
 * wake and nothing runs the thread in that home (and no shared server owns
 * that home's queue). Anything else (a note or message somebody queued) is
 * left, and only counted for `notifai doctor`. Removal goes through a quiet
 * private server (`openQuietCodexQueue`): no credentials read or refreshed,
 * no plugin sync, never loading a thread.
 *
 * The hub runs it once, a minute after it starts (so once after the update
 * that brings it, without anyone running a command), and again at later
 * starts only while something was left undecided (a home held, a server not
 * answering), at most three times.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { codexThreadHoldersAsync } from './codex-session-end.js'
import { codexSharedServerRuns, contentFreeWake, openQuietCodexQueue, type QuietQueue } from './codex-thread-home.js'
import { ensurePrivateDirectory } from './hub-ipc.js'
import { stateDir } from './config.js'

export const ORPHAN_SWEEP_VERSION = 1
const ORPHAN_SWEEP_ATTEMPTS = 3

export interface OrphanSweepReport {
  version: number
  at: number
  attempts: number
  /** Nothing was left undecided: no later start runs it again. */
  done: boolean
  deleted: number
  /** Items that are not Notifai's wake, per home: left as they are. */
  left: Array<{ home: string; threads: number; items: number }>
  /** Items or homes that could not be decided this time. */
  undecided: number
}

export function orphanSweepPath(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'codex-queue-sweep.json')
}

export function readOrphanSweepReport(env: NodeJS.ProcessEnv): OrphanSweepReport | null {
  try {
    const value = JSON.parse(readFileSync(orphanSweepPath(env), 'utf8')) as OrphanSweepReport
    return typeof value === 'object' && value !== null && typeof value.version === 'number' ? value : null
  } catch {
    return null
  }
}

/** Whether a hub starting now should run the sweep. */
export function orphanSweepDue(env: NodeJS.ProcessEnv): boolean {
  const report = readOrphanSweepReport(env)
  return report === null || report.version < ORPHAN_SWEEP_VERSION || (!report.done && report.attempts < ORPHAN_SWEEP_ATTEMPTS)
}

export async function sweepCodexOrphanWakes(input: {
  env: NodeJS.ProcessEnv
  /** Codex threads Notifai attended. */
  threads: readonly string[]
  /** The homes they may have run in. */
  homes: readonly string[]
  /** A wake the hub still counts on (a live session's own), never removed here. */
  keep: (threadId: string, itemId: string) => boolean
  cwd: string
  now: number
  holders?: (home: string, threadId: string) => Promise<number[] | 'unknown'>
  sharedServer?: (home: string) => Promise<boolean | 'unknown'>
  open?: (home: string) => QuietQueue
}): Promise<OrphanSweepReport> {
  const holders = input.holders ?? ((home: string, id: string) => codexThreadHoldersAsync(home, id))
  const previous = readOrphanSweepReport(input.env)
  const report: OrphanSweepReport = { version: ORPHAN_SWEEP_VERSION, at: input.now,
    attempts: (previous?.version === ORPHAN_SWEEP_VERSION ? previous.attempts : 0) + 1, done: false, deleted: 0, left: [], undecided: 0 }
  for (const home of input.homes) {
    const shared = await (input.sharedServer ?? ((at: string) => codexSharedServerRuns(at, input.env)))(home)
    if (shared !== false) { report.undecided += 1; continue }
    const queue = (input.open ?? ((at: string) => openQuietCodexQueue({ home: at, env: input.env, cwd: input.cwd })))(home)
    let leftItems = 0
    const leftThreads = new Set<string>()
    try {
      for (const threadId of input.threads) {
        const items: Array<{ id?: unknown; input?: Array<{ type?: unknown; text?: unknown }> }> = []
        let cursor: string | undefined
        for (let page = 0; page < 10; page += 1) {
          const listed = await queue.list(threadId, cursor)
          if (listed === null || !Array.isArray(listed.data)) break
          items.push(...listed.data)
          if (typeof listed.nextCursor !== 'string') break
          cursor = listed.nextCursor
        }
        if (items.length === 0) continue
        let free: boolean | null = null
        for (const item of items) {
          if (typeof item.id !== 'string') continue
          if (!contentFreeWake(item)) { leftItems += 1; leftThreads.add(threadId); continue }
          if (input.keep(threadId, item.id)) continue
          if (free === null) { const found = await holders(home, threadId); free = found !== 'unknown' && found.every((pid) => pid === process.pid) }
          if (!free) { report.undecided += 1; continue }
          const deleted = await queue.remove(threadId, item.id)
          if (deleted?.deleted === true) report.deleted += 1
          else if (deleted?.deleted !== false) report.undecided += 1
        }
      }
    } finally {
      await queue.close()
    }
    if (leftItems > 0) report.left.push({ home, threads: leftThreads.size, items: leftItems })
  }
  report.done = report.undecided === 0
  try {
    ensurePrivateDirectory(path.dirname(orphanSweepPath(input.env)))
    atomicWriteFileSync(orphanSweepPath(input.env), `${JSON.stringify(report)}\n`)
  } catch { /* The next start runs it again. */ }
  return report
}
