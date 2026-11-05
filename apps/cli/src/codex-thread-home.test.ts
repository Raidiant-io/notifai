import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexHomeCandidates, locateCodexThreadHome, removeOrphanCodexWake } from './codex-thread-home.js'
import { sessionInputWake } from './session-inputs.js'

const THREAD = '00000000-0000-7000-8000-00000000a007'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('the Codex homes a thread may run in', () => {
  it('are the recorded one, the others Notifai attends, Orca\'s account homes and ~/.codex, each once', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-homes-')); roots.push(root)
    const orca = path.join(root, 'orca')
    for (const account of ['account-a', 'account-b']) mkdirSync(path.join(orca, 'codex-accounts', account, 'home'), { recursive: true })
    mkdirSync(path.join(orca, 'codex-accounts', 'broken'), { recursive: true })
    mkdirSync(path.join(orca, 'codex-runtime-home', 'home'), { recursive: true })
    const recorded = path.join(orca, 'codex-accounts', 'account-a', 'home')
    expect(codexHomeCandidates({ recorded, known: [recorded, '/other/home', null], env: { ORCA_USER_DATA_PATH: orca }, home: root })).toEqual([
      recorded, '/other/home', path.join(orca, 'codex-accounts', 'account-b', 'home'), path.join(orca, 'codex-runtime-home', 'home'), path.join(root, '.codex'),
    ])
  })
})

describe('where a thread runs now', () => {
  const starts: Record<number, string> = { 101: 'Sun Nov  1 09:00:00 2026', 202: 'Sun Nov  1 09:28:04 2026' }
  const locate = async (held: Record<string, number[] | 'unknown'>, exited: number[] = []) => await locateCodexThreadHome(THREAD, Object.keys(held), {
    holders: (home) => held[home] ?? [], startOf: (pid) => starts[pid] ?? null, exited: (identity) => exited.includes(identity.pid) })
  it('is the home whose writer lock a live process holds: the newest, when the thread runs in two', async () => {
    expect(await locate({ A: [], B: [202] })).toEqual({ home: 'B', holder: { pid: 202, start: starts[202] }, ambiguous: false })
    expect(await locate({ A: [101], B: [202] })).toMatchObject({ home: 'B', ambiguous: true })
    expect(await locate({ A: [101], B: [202] }, [202])).toMatchObject({ home: 'A', ambiguous: false })
    expect(await locate({ A: [], B: [] })).toBeNull()
    expect(await locate({ A: 'unknown', B: [] })).toBe('unknown')
    expect(await locate({ A: 'unknown', B: [202] })).toMatchObject({ home: 'B' })
  })
})

describe('a wake left in the old home', () => {
  const wake = sessionInputWake()
  function fakeCodex(items: Array<{ id: string; input: unknown[] }>, pages = 1, holdAfterList?: number[]) {
    const calls: string[] = []
    let listed = false
    const queue = {
      list: async (_thread: string, cursor?: string) => {
        calls.push('list'); listed = true
        const page = cursor === undefined ? 0 : Number(cursor)
        const size = Math.ceil(items.length / pages)
        return { data: items.slice(page * size, (page + 1) * size), nextCursor: page + 1 < pages ? String(page + 1) : null } as never
      },
      remove: async (_thread: string, id: string) => { calls.push(`delete:${id}`); return { deleted: items.some((item) => item.id === id) } },
      close: async () => { calls.push('close') },
    }
    return { calls, open: () => queue, holders: () => (listed && holdAfterList !== undefined ? holdAfterList : []) }
  }
  const remove = (codex: ReturnType<typeof fakeCodex>, queuedId: string, options: { holders?: number[] | 'unknown'; shared?: boolean | 'unknown' } = {}) =>
    removeOrphanCodexWake({ home: '/old/home', threadId: THREAD, queuedId, env: {}, cwd: '/p',
      holders: options.holders === undefined ? codex.holders : () => options.holders!, sharedServer: async () => options.shared ?? false, open: codex.open })

  it('is removed in that home by its exact id, when it is exactly Notifai\'s content-free wake, and the server is let go', async () => {
    const codex = fakeCodex([{ id: 'other', input: [{ type: 'text', text: 'a message somebody else queued' }] }, { id: 'qs_1', input: [{ type: 'text', text: wake }] }], 2)
    expect(await remove(codex, 'qs_1')).toBe('deleted')
    expect(codex.calls).toEqual(['list', 'list', 'delete:qs_1', 'close'])
  })

  it('stays when the thread runs in that home (also once listed), a shared server owns the queue, it is anything else, or it is gone', async () => {
    const note = fakeCodex([{ id: 'qs_1', input: [{ type: 'text', text: 'Notifai: the User answered: yes' }] }])
    expect(await remove(note, 'qs_1')).toBe('not-a-wake')
    expect(note.calls).toEqual(['list', 'close'])
    const back = fakeCodex([{ id: 'qs_1', input: [{ type: 'text', text: wake }] }], 1, [4242])
    expect(await remove(back, 'qs_1')).toBe('held')
    expect(back.calls).toEqual(['list', 'close'])
    for (const holders of [[4242], 'unknown'] as const) {
      const held = fakeCodex([{ id: 'qs_1', input: [{ type: 'text', text: wake }] }])
      expect(await remove(held, 'qs_1', { holders: [...holders] as never })).toBe('held')
      expect(held.calls).toEqual([])
    }
    const shared = fakeCodex([{ id: 'qs_1', input: [{ type: 'text', text: wake }] }])
    expect(await remove(shared, 'qs_1', { shared: true })).toBe('shared-server')
    expect(shared.calls).toEqual([])
    expect(await remove(fakeCodex([]), 'qs_1')).toBe('gone')
  })
})

describe('who holds a thread', () => {
  it('counts only processes running Codex', async () => {
    const { symlinkSync } = await import('node:fs')
    const { spawn } = await import('node:child_process')
    const { codexProcessesAmong } = await import('./codex-session-end.js')
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-holders-')); roots.push(root)
    const codex = path.join(root, 'codex')
    symlinkSync('/bin/sleep', codex)
    const runner = spawn(codex, ['30'], { stdio: 'ignore' })
    const viewer = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    try {
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(await codexProcessesAmong([runner.pid!, viewer.pid!])).toEqual([runner.pid])
    } finally { runner.kill(); viewer.kill() }
  })
})

describe('a followed thread across hubs', () => {
  it('is kept in the adoption record', async () => {
    const { parseAdoptionRecord } = await import('./hub-adoption.js')
    const record = { harness: 'codex', harness_process: { pid: 4242, start: 'Thu Nov  5 09:00:00 2026' }, harness_ticks: null, boot: null, cwd: '/p',
      transcript_path: '/h/sessions/r.jsonl', claude_config_dir: null, codex_home: '/h', last_activity_at: null, transcript_seen: true, end_candidate_since: null,
      place: 'terminal', host_app: null, terminal_host: null, stopped: null, launch: null, session_path: null, display: {} }
    expect(parseAdoptionRecord({ ...record, followed_home: true })).toMatchObject({ followed_home: true })
    expect(parseAdoptionRecord(record)).not.toHaveProperty('followed_home')
  })
})
