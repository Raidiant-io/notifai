import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveActiveHarness } from './commands-harness-context.js'
import { markSessionEnded } from './hook-session-state.js'
import { forgetOpencodeSession, recordOpencodeSession, trustedOpencodeShellSession } from './opencode-shell-session.js'
import { processAncestry } from './process-ancestry.js'
import type { ProcessIdentity } from './process-identity.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const SESSION = 'ses_e9a8be986ffeiCBgRwwkIijsgi'
const HOST = 4242

function home() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode-shell-'))
  roots.push(root)
  return { XDG_STATE_HOME: path.join(root, 'state'), HOME: root, NOTIFAI_HOOK_SOURCE_PID: String(HOST) } as NodeJS.ProcessEnv
}

const start = (pid: number) => pid === HOST ? 'Thu Oct 22 21:10:30 2026' : null
const alive = () => 'alive' as const
const insideHost = () => [{ pid: 9001, name: 'node' }, { pid: 73948, name: 'bash' }, { pid: HOST, name: 'opencode.exe' }, { pid: 1, name: 'launchd' }]

describe('OpenCode 2 shell session identity', () => {
  it('believes a shell\'s OPENCODE_SESSION_ID for a session the plugin recorded, running inside its host', () => {
    const env = home()
    expect(recordOpencodeSession(env, { session_id: SESSION, worker: false, session_label: 'Fix the build' }, 1, start)).toBe('recorded')
    expect(trustedOpencodeShellSession(env, SESSION, insideHost, alive)).toEqual({ sessionId: SESSION, worker: false, sessionLabel: 'Fix the build' })
    recordOpencodeSession(env, { session_id: SESSION, worker: true, session_label_pending: true }, 2, start)
    expect(trustedOpencodeShellSession(env, SESSION, insideHost, alive)).toEqual({ sessionId: SESSION, worker: true, sessionLabelPending: true })
  })

  it('refuses a value no plugin recorded, a forged or malformed one, and one from outside the recorded host', () => {
    const env = home()
    recordOpencodeSession(env, { session_id: SESSION, worker: false }, 1, start)
    expect(trustedOpencodeShellSession(env, 'ses_neverrecorded', insideHost, alive)).toBeNull()
    expect(trustedOpencodeShellSession(env, '../ses_x', insideHost, alive)).toBeNull()
    expect(trustedOpencodeShellSession(env, undefined, insideHost, alive)).toBeNull()
    // A tmux server or editor started from the agent's shell is not inside OpenCode.
    expect(trustedOpencodeShellSession(env, SESSION, () => [{ pid: 9001, name: 'node' }, { pid: 1, name: 'launchd' }], alive)).toBeNull()
    // Where the tree cannot be read, the live record alone is the evidence.
    expect(trustedOpencodeShellSession(env, SESSION, () => null, alive)).toMatchObject({ sessionId: SESSION })
  })

  it('refuses a stale value: an ended session, a host that is gone, or a forgotten record', () => {
    const env = home()
    recordOpencodeSession(env, { session_id: SESSION, worker: false }, 1, start)
    expect(trustedOpencodeShellSession(env, SESSION, insideHost, (_: ProcessIdentity) => 'gone')).toBeNull()
    expect(trustedOpencodeShellSession(env, SESSION, insideHost, (_: ProcessIdentity) => 'unknown')).toBeNull()
    markSessionEnded(SESSION, env, 3)
    expect(trustedOpencodeShellSession(env, SESSION, insideHost, alive)).toBeNull()
    const other = home()
    recordOpencodeSession(other, { session_id: SESSION, worker: false }, 1, start)
    forgetOpencodeSession(other, SESSION)
    expect(trustedOpencodeShellSession(other, SESSION, insideHost, alive)).toBeNull()
  })

  it('records nothing without a host, or for a malformed report', () => {
    const env = home()
    expect(recordOpencodeSession({ ...env, NOTIFAI_HOOK_SOURCE_PID: '' }, { session_id: SESSION, worker: false }, 1, start)).toBe('no-host')
    expect(recordOpencodeSession({ ...env, NOTIFAI_HOOK_SOURCE_PID: '77' }, { session_id: SESSION, worker: false }, 1, start)).toBe('no-host')
    expect(recordOpencodeSession(env, { session_id: SESSION }, 1, start)).toBe('invalid')
    expect(recordOpencodeSession(env, { session_id: 'not-a-session', worker: false }, 1, start)).toBe('invalid')
    expect(trustedOpencodeShellSession(env, SESSION, insideHost, alive)).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('identifies this process\'s shell end to end, with its real ancestry', () => {
    const env = home()
    // This test process stands in for the OpenCode host: it is its own ancestor.
    const host = { ...env, NOTIFAI_HOOK_SOURCE_PID: String(process.pid) }
    expect(recordOpencodeSession(host, { session_id: SESSION, worker: false, session_label: 'Fix the build' }, 1)).toBe('recorded')
    const shell = { ...env, NOTIFAI_ACTIVE_HARNESS: 'opencode', NOTIFAI_OPENCODE_PLUGIN: '2', OPENCODE_SESSION_ID: SESSION }
    expect(processAncestry()?.some((ancestor) => ancestor.pid === process.pid)).toBe(true)
    expect(resolveActiveHarness(shell, '/', 0).active).toEqual({
      harness: 'opencode', label: 'OpenCode', sessionId: SESSION, worker: false, sessionLabel: 'Fix the build',
    })
    // The same marker with a value nobody recorded names no session.
    expect(resolveActiveHarness({ ...shell, OPENCODE_SESSION_ID: 'ses_forged' }, '/', 0).active).toEqual({ harness: 'opencode', label: 'OpenCode' })
    // OpenCode 1's plugin still names its session itself.
    expect(resolveActiveHarness({ ...env, NOTIFAI_ACTIVE_HARNESS: 'opencode', NOTIFAI_ACTIVE_SESSION_ID: 'ses_one', NOTIFAI_ACTIVE_SESSION_WORKER: '0' }, '/', 0).active)
      .toEqual({ harness: 'opencode', label: 'OpenCode', sessionId: 'ses_one', worker: false })
  })
})
