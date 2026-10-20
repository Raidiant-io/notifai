import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSessionState, sessionStatePath, updateSessionState } from './hook-session-state.js'

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
