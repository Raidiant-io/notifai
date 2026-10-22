import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexSubagentRecordPath, delegatedCodexRoot, recordCodexSubagent } from './codex-subagent.js'
import { beginSessionIncarnation, lifecycleStamp, markSessionEnded } from './hook-session-state.js'
import { currentProcessIdentity } from './process-identity.js'

const ROOT = 'root-thread'
const CHILD = 'child-thread'

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-subagent-'))
  const env: NodeJS.ProcessEnv = { HOME: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root }
  // The test process stands in for the Codex process hosting the root thread.
  const host = currentProcessIdentity()!
  beginSessionIncarnation(ROOT, env, { stamp: lifecycleStamp(), harnessProcess: host })
  const shell = { ...env, CODEX_THREAD_ID: CHILD, CODEX_SESSION_ID: ROOT }
  // The child's shell runs below the Codex process.
  const chain = [{ pid: 9_000_001, name: 'zsh' }, { pid: host.pid, name: 'codex' }, { pid: 1, name: 'launchd' }]
  return { env, host, shell, chain }
}

describe('Codex subagent ownership', () => {
  it('resolves a spawned child to its root once Codex reported the spawn from the root\'s own host', () => {
    const h = fixture()
    expect(recordCodexSubagent({ rootSessionId: ROOT, childThreadId: CHILD, hookSourcePid: h.host.pid, env: h.env, now: 1 })).toBe(true)
    expect(delegatedCodexRoot(h.shell, h.chain)).toEqual({ rootSessionId: ROOT, childThreadId: CHILD })
  })

  it('records no spawn reported by a process other than the root\'s host', () => {
    const h = fixture()
    expect(recordCodexSubagent({ rootSessionId: ROOT, childThreadId: CHILD, hookSourcePid: h.host.pid + 1, env: h.env, now: 1 })).toBe(false)
    expect(recordCodexSubagent({ rootSessionId: ROOT, childThreadId: CHILD, hookSourcePid: undefined, env: h.env, now: 1 })).toBe(false)
    expect(recordCodexSubagent({ rootSessionId: 'unknown-root', childThreadId: CHILD, hookSourcePid: h.host.pid, env: h.env, now: 1 })).toBe(false)
    expect(recordCodexSubagent({ rootSessionId: ROOT, childThreadId: ROOT, hookSourcePid: h.host.pid, env: h.env, now: 1 })).toBe(false)
    expect(delegatedCodexRoot(h.shell, h.chain)).toBeNull()
  })

  it('never takes the environment\'s word alone: variables without a recorded spawn name no root', () => {
    const h = fixture()
    expect(delegatedCodexRoot(h.shell, h.chain)).toBeNull()
  })

  it('refuses a root the recorded spawn does not name', () => {
    const h = fixture()
    recordCodexSubagent({ rootSessionId: ROOT, childThreadId: CHILD, hookSourcePid: h.host.pid, env: h.env, now: 1 })
    beginSessionIncarnation('other-root', h.env, { stamp: lifecycleStamp(), harnessProcess: h.host })
    expect(delegatedCodexRoot({ ...h.shell, CODEX_SESSION_ID: 'other-root' }, h.chain)).toBeNull()
  })

  it('refuses a shell outside the root\'s Codex process, such as a tmux pane that inherited the variables', () => {
    const h = fixture()
    recordCodexSubagent({ rootSessionId: ROOT, childThreadId: CHILD, hookSourcePid: h.host.pid, env: h.env, now: 1 })
    const tmuxPane = [{ pid: 9_000_002, name: 'zsh' }, { pid: 9_000_003, name: 'tmux' }, { pid: 1, name: 'launchd' }]
    expect(delegatedCodexRoot(h.shell, tmuxPane)).toBeNull()
    // Where the process tree cannot be read there is no proof, so nothing is rerouted.
    expect(delegatedCodexRoot(h.shell, null)).toBeNull()
  })

  it('refuses a spawn recorded for an earlier start of the root, and a root that has ended', () => {
    const h = fixture()
    recordCodexSubagent({ rootSessionId: ROOT, childThreadId: CHILD, hookSourcePid: h.host.pid, env: h.env, now: 1 })
    beginSessionIncarnation(ROOT, h.env, { stamp: lifecycleStamp(), harnessProcess: h.host, restart: true })
    expect(delegatedCodexRoot(h.shell, h.chain)).toBeNull()

    const ended = fixture()
    recordCodexSubagent({ rootSessionId: ROOT, childThreadId: CHILD, hookSourcePid: ended.host.pid, env: ended.env, now: 1 })
    markSessionEnded(ROOT, ended.env, Date.now())
    expect(delegatedCodexRoot(ended.shell, ended.chain)).toBeNull()
  })

  it('leaves a root thread\'s own shell alone', () => {
    const h = fixture()
    expect(delegatedCodexRoot({ ...h.env, CODEX_THREAD_ID: ROOT, CODEX_SESSION_ID: ROOT }, h.chain)).toBeNull()
    expect(delegatedCodexRoot({ ...h.env, CODEX_THREAD_ID: CHILD }, h.chain)).toBeNull()
  })

  it('ignores a corrupt or hand-edited record', () => {
    const h = fixture()
    writeFileSync(codexSubagentRecordPath(CHILD, h.env), '{"root_session_id":', { mode: 0o600 })
    expect(delegatedCodexRoot(h.shell, h.chain)).toBeNull()
    writeFileSync(codexSubagentRecordPath(CHILD, h.env), JSON.stringify({ root_session_id: ROOT }), { mode: 0o600 })
    expect(delegatedCodexRoot(h.shell, h.chain)).toBeNull()
  })
})
