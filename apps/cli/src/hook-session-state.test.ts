import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { beginSessionIncarnation, lifecycleStamp, markSessionEnded, readSessionIncarnation, readSessionState, rehostSessionIncarnation, sessionStatePath, updateSessionState } from './hook-session-state.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('session state updates', () => {
  it('rewrite the file only when an update changed something, and still create a missing one', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'session-state-'))
    roots.push(root)
    const env = { XDG_STATE_HOME: root }
    const id = '55555555-6666-7777-8888-999999999999'
    const file = sessionStatePath(id, env)
    updateSessionState(id, env, (state) => state)
    expect(existsSync(file)).toBe(true)
    updateSessionState(id, env, (state) => ({ ...state, last_prompt_at: 1 }))
    const written = statSync(file, { bigint: true })
    updateSessionState(id, env, (state) => state)
    const after = statSync(file, { bigint: true })
    expect([after.ino, after.mtimeNs]).toEqual([written.ino, written.mtimeNs])
    updateSessionState(id, env, (state) => ({ ...state, last_prompt_at: 2 }))
    expect(readSessionState(id, env).last_prompt_at).toBe(2)
  })
})

describe('rehosting an incarnation', () => {
  it('names another host for the same incarnation, only for its key holder and never once it ended', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'session-state-'))
    roots.push(root)
    const env = { XDG_STATE_HOME: root }
    const id = '66666666-7777-8888-9999-000000000000'
    const first = beginSessionIncarnation(id, env, { stamp: lifecycleStamp(), harnessProcess: { pid: 101, start: 'Mon Oct 20 10:00:00 2026' }, boot: 'b1' })
    const moved = rehostSessionIncarnation(id, env, first.key, { pid: 202, start: 'Mon Oct 20 10:05:00 2026' })
    expect(moved).toEqual({ ...first, harness_process: { pid: 202, start: 'Mon Oct 20 10:05:00 2026' } })
    expect(readSessionIncarnation(id, env)).toEqual(moved)
    expect(rehostSessionIncarnation(id, env, 'another-key', { pid: 303, start: 'x' })).toBeNull()
    markSessionEnded(id, env, Date.now())
    expect(rehostSessionIncarnation(id, env, first.key, { pid: 303, start: 'x' })).toBeNull()
    expect(readSessionIncarnation(id, env)?.harness_process?.pid).toBe(202)
  })
})
