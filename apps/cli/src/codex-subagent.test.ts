import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexSubagentRoot } from './codex-subagent.js'
import { beginSessionIncarnation, lifecycleStamp, markSessionEnded } from './hook-session-state.js'
import { currentProcessIdentity } from './process-identity.js'

const ROOT = 'root-thread'
const CHILD = 'child-thread'

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-subagent-'))
  const env: NodeJS.ProcessEnv = { HOME: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root }
  // The test process stands in for the Codex process hosting the root thread.
  const host = currentProcessIdentity()!
  const owner = beginSessionIncarnation(ROOT, env, { stamp: lifecycleStamp(), harnessProcess: host })
  const shell = { ...env, CODEX_THREAD_ID: CHILD, CODEX_SESSION_ID: ROOT }
  // The subagent's shell runs below the Codex process.
  const chain = [{ pid: 9_000_001, name: 'zsh' }, { pid: host.pid, name: 'codex' }, { pid: 1, name: 'launchd' }]
  return { env, host, owner, shell, chain }
}

describe('Codex subagent root', () => {
  it('names the root and its current start for a subagent shell below the root\'s live Codex process', () => {
    const h = fixture()
    expect(codexSubagentRoot(h.shell, h.chain)).toEqual({ rootSessionId: ROOT, rootKey: h.owner.key })
  })

  it('follows a restarted root to its current start', () => {
    const h = fixture()
    const successor = beginSessionIncarnation(ROOT, h.env, { stamp: lifecycleStamp(), harnessProcess: h.host, restart: true })
    expect(codexSubagentRoot(h.shell, h.chain)).toEqual({ rootSessionId: ROOT, rootKey: successor.key })
  })

  it('refuses a shell outside the root\'s Codex process, such as a tmux pane that inherited the variables', () => {
    const h = fixture()
    const tmuxPane = [{ pid: 9_000_002, name: 'zsh' }, { pid: 9_000_003, name: 'tmux' }, { pid: 1, name: 'launchd' }]
    expect(codexSubagentRoot(h.shell, tmuxPane)).toBeNull()
  })

  it('refuses where the process tree cannot be read, as on Windows', () => {
    const h = fixture()
    expect(codexSubagentRoot(h.shell, null)).toBeNull()
  })

  it('refuses a root that has ended, never started, or whose Codex process has gone', () => {
    const ended = fixture()
    markSessionEnded(ROOT, ended.env, Date.now())
    expect(codexSubagentRoot(ended.shell, ended.chain)).toBeNull()

    const unknown = fixture()
    expect(codexSubagentRoot({ ...unknown.shell, CODEX_SESSION_ID: 'never-started' }, unknown.chain)).toBeNull()

    const gone = fixture()
    beginSessionIncarnation(ROOT, gone.env, { stamp: lifecycleStamp(), harnessProcess: { ...gone.host, pid: 999_999_999 }, restart: true })
    expect(codexSubagentRoot(gone.shell, [...gone.chain, { pid: 999_999_999, name: 'codex' }])).toBeNull()
  })

  it('leaves a root thread\'s own shell, and a shell that names no root, alone', () => {
    const h = fixture()
    expect(codexSubagentRoot({ ...h.env, CODEX_THREAD_ID: ROOT, CODEX_SESSION_ID: ROOT }, h.chain)).toBeNull()
    expect(codexSubagentRoot({ ...h.env, CODEX_THREAD_ID: CHILD }, h.chain)).toBeNull()
  })
})
