import { mkdtempSync, rmSync, existsSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { withFileLock } from './file-lock.js'
import { clearSessionState, markSessionEnded, pruneAbandonedSessions, readSessionState, sessionStatePath, writeSessionState } from './hook-session-state.js'
import { retainSessionRuntime } from './runtime-build-retention.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-retained-build-')); roots.push(root)
  const env = { HOME: root, USERPROFILE: root, XDG_STATE_HOME: root }, session = 'owned-session'
  const first = { installation_id: '12345678-1234-1234-1234-123456789012', build: 'a'.repeat(64) }
  const next = { ...first, build: 'b'.repeat(64) }
  return { env, session, first, next }
}

it('retains every serving build without dropping the existing question state', () => {
  const f = fixture()
  writeSessionState(f.session, f.env, { harness: 'claude-code', activation_cwd: '/fixture' })
  retainSessionRuntime(f.session, f.env, f.first)
  withFileLock(`${sessionStatePath(f.session, f.env)}.lock`, () => retainSessionRuntime(f.session, f.env, f.next, true))
  retainSessionRuntime(f.session, f.env, f.first)
  expect(readSessionState(f.session, f.env)).toEqual({ harness: 'claude-code', activation_cwd: '/fixture', runtime_builds: [f.first, f.next] })
  markSessionEnded(f.session, f.env, Date.now())
  expect(() => retainSessionRuntime(f.session, f.env, { ...f.first, build: 'c'.repeat(64) })).toThrow(/ended/)
  expect(readSessionState(f.session, f.env).runtime_builds).toEqual([f.first, f.next])
})

it('does not invent a session and keeps builds pinned by retained native work', () => {
  const f = fixture()
  retainSessionRuntime(f.session, f.env, null)
  expect(existsSync(sessionStatePath(f.session, f.env))).toBe(false)
  expect(() => retainSessionRuntime(f.session, f.env, f.first)).toThrow(/existing/)
  writeSessionState(f.session, f.env, { harness: 'codex', runtime_builds: [f.first], native_answer_operations: [{} as never] })
  clearSessionState(f.session, f.env)
  expect(readSessionState(f.session, f.env).runtime_builds).toEqual([f.first])
})

it('does not age-prune a dormant native owner and lose its runtime reference', () => {
  const f = fixture()
  writeSessionState(f.session, f.env, { harness: 'codex', runtime_builds: [f.first] })
  utimesSync(sessionStatePath(f.session, f.env), new Date(0), new Date(0))
  expect(pruneAbandonedSessions(f.env)).toBe(0)
  expect(readSessionState(f.session, f.env).runtime_builds).toEqual([f.first])
})
