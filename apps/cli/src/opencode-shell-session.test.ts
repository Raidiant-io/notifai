import { mkdtempSync,rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
import { recordOpencodeSession,trustedOpencodeShellSession } from './opencode-shell-session.js'

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
    expect(recordOpencodeSession(env, { session_id: SESSION, worker: false, session_label: 'Fix the build' }, 1, start, insideHost)).toBe('recorded')
    expect(trustedOpencodeShellSession(env, SESSION, insideHost, alive)).toEqual({ sessionId: SESSION, worker: false, sessionLabel: 'Fix the build' })
    recordOpencodeSession(env, { session_id: SESSION, worker: true, session_label_pending: true }, 2, start, insideHost)
    expect(trustedOpencodeShellSession(env, SESSION, insideHost, alive)).toEqual({ sessionId: SESSION, worker: true, sessionLabelPending: true })
  })

  it('refuses a value no plugin recorded, a forged or malformed one, and one from outside the recorded host', () => {
    const env = home()
    recordOpencodeSession(env, { session_id: SESSION, worker: false }, 1, start, insideHost)
    expect(trustedOpencodeShellSession(env, 'ses_neverrecorded', insideHost, alive)).toBeNull()
    expect(trustedOpencodeShellSession(env, '../ses_x', insideHost, alive)).toBeNull()
    expect(trustedOpencodeShellSession(env, undefined, insideHost, alive)).toBeNull()
    // A tmux server or editor started from the agent's shell is not inside OpenCode.
    expect(trustedOpencodeShellSession(env, SESSION, () => [{ pid: 9001, name: 'node' }, { pid: 1, name: 'launchd' }], alive)).toBeNull()
    // Where the tree cannot be read, the live record alone is the evidence.
    expect(trustedOpencodeShellSession(env, SESSION, () => null, alive)).toMatchObject({ sessionId: SESSION })
  })

  it('preserves another live or unreadable host record, but allows a dead host to be replaced', () => {
    const env = home()
    recordOpencodeSession(env, { session_id: SESSION, worker: true, session_label: 'Original' }, 1, start, insideHost)
    const other = { ...env, NOTIFAI_HOOK_SOURCE_PID: '77' }
    const otherChain = () => [{ pid: 77, name: 'opencode' }]
    for (const state of ['alive', 'unknown'] as const) {
      expect(recordOpencodeSession(other, { session_id: SESSION, worker: false, session_label: 'Replacement' }, 2,
        () => 'other-start', otherChain, () => state)).toBe('host-conflict')
      expect(trustedOpencodeShellSession(env, SESSION, insideHost, alive)).toMatchObject({ worker: true, sessionLabel: 'Original' })
    }
    expect(recordOpencodeSession(other, { session_id: SESSION, worker: false }, 3,
      () => 'other-start', otherChain, () => 'gone')).toBe('recorded')
    expect(trustedOpencodeShellSession(env, SESSION, otherChain, alive)).toMatchObject({ worker: false })
  })
})
