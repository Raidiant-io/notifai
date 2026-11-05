import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { orphanSweepDue, readOrphanSweepReport, sweepCodexOrphanWakes } from './codex-orphan-sweep.js'
import { codexQueueSweepCheck } from './commands-doctor.js'
import { sessionInputWake } from './session-inputs.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const T1 = '00000000-0000-7000-8000-00000000b001'
const T2 = '00000000-0000-7000-8000-00000000b002'
const wake = (id: string) => ({ id, input: [{ type: 'text', text: sessionInputWake() }] })
const tokenWake = (id: string) => ({ id, input: [{ type: 'text', text: sessionInputWake('11111111-2222-4333-8444-555555555555') }] })
const note = (id: string) => ({ id, input: [{ type: 'text', text: 'please also check the logs' }] })

/** Each home's queue, as Codex lists it per thread; deletes are recorded. */
function homes(queues: Record<string, Record<string, Array<{ id: string; input: unknown[] }>>>) {
  const deleted: string[] = []
  const opened: string[] = []
  return { deleted, opened, open: (home: string) => {
    opened.push(home)
    return {
      list: async (thread: string) => ({ data: queues[home]?.[thread] ?? [], nextCursor: null }) as never,
      remove: async (thread: string, id: string) => { deleted.push(`${home}:${thread}:${id}`); return { deleted: true } },
      close: async () => undefined,
    }
  } }
}

function env() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-sweep-')); roots.push(root)
  return { HOME: root, XDG_STATE_HOME: path.join(root, 'state') }
}

describe('the one-time sweep of other Codex homes', () => {
  it('removes only Notifai\'s content-free wakes where nothing runs the thread, and counts everything else for doctor', async () => {
    const e = env()
    const h = homes({ '/acct-a': { [T1]: [wake('w1'), note('n1'), tokenWake('w2')], [T2]: [wake('w3')] }, '/acct-b': { [T1]: [wake('w4')] } })
    const report = await sweepCodexOrphanWakes({ env: e, threads: [T1, T2], homes: ['/acct-a', '/acct-b'], cwd: '/', now: 1,
      // T2 runs in acct-a; acct-b's T1 wake is a live session's own.
      keep: (thread, id) => thread === T1 && id === 'w4',
      holders: async (home, thread) => home === '/acct-a' && thread === T2 ? [4242] : [],
      sharedServer: async () => false, open: h.open })
    expect(h.deleted).toEqual([`/acct-a:${T1}:w1`, `/acct-a:${T1}:w2`])
    expect(report).toMatchObject({ deleted: 2, undecided: 1, done: false, attempts: 1, left: [{ home: '/acct-a', threads: 1, items: 1 }] })
    expect(readOrphanSweepReport(e)).toMatchObject({ deleted: 2, done: false })
    // Something was undecided: the next start tries again, at most three times in all.
    expect(orphanSweepDue(e)).toBe(true)
  })

  it('leaves a home whose queue a shared server owns, and is done once nothing is undecided', async () => {
    const e = env()
    const h = homes({ '/acct-a': { [T1]: [wake('w1')] } })
    const shared = await sweepCodexOrphanWakes({ env: e, threads: [T1], homes: ['/acct-a'], cwd: '/', now: 1, keep: () => false,
      holders: async () => [], sharedServer: async () => true, open: h.open })
    expect(shared).toMatchObject({ deleted: 0, undecided: 1, done: false })
    expect(h.opened).toEqual([])
    const done = await sweepCodexOrphanWakes({ env: e, threads: [T1], homes: ['/acct-a'], cwd: '/', now: 2, keep: () => false,
      holders: async () => [], sharedServer: async () => false, open: h.open })
    expect(done).toMatchObject({ deleted: 1, done: true, attempts: 2 })
    expect(orphanSweepDue(e)).toBe(false)
  })

  it('tells doctor what it removed and what it left', async () => {
    const e = env()
    expect(codexQueueSweepCheck(e)).toBeNull()
    await sweepCodexOrphanWakes({ env: e, threads: [T1], homes: ['/acct-a'], cwd: '/', now: 1, keep: () => false,
      holders: async () => [], sharedServer: async () => false, open: homes({ '/acct-a': { [T1]: [wake('w1'), note('n1'), note('n2')] } }).open })
    const check = codexQueueSweepCheck(e)!
    expect(check).toMatchObject({ ok: true, reportOnly: true })
    expect(check.detail).toContain('removed 1 leftover Notifai wake-up')
    expect(check.detail).toContain('2 queued messages for 1 conversation in /acct-a are not Notifai\'s and were left as they are')
  })
})
