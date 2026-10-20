import { describe, expect, it } from 'vitest'
import { markerInsideItsHost, resolveActiveHarness } from './commands-harness-context.js'
import { processAncestry } from './process-ancestry.js'

const claude = { harness: 'claude-code' as const, label: 'Claude Code', sessionId: 'live-session' }
const codex = { harness: 'codex' as const, label: 'Codex', sessionId: 'live-thread' }
const noHost = () => undefined

describe('harness markers', () => {
  // A shell in a tmux server an agent once started: its parent is the tmux
  // server, re-parented to the system, so the agent is not above it.
  const tmuxPane = [{ pid: 700, name: 'zsh' }, { pid: 600, name: 'tmux' }, { pid: 1, name: 'launchd' }]
  const agentShell = [{ pid: 702, name: 'zsh' }, { pid: 500, name: 'claude' }, { pid: 400, name: 'zsh' }, { pid: 1, name: 'launchd' }]

  it('believes a Claude Code marker only below the process it names', () => {
    expect(markerInsideItsHost(claude, { CLAUDE_PID: '500' }, agentShell, noHost)).toBe(true)
    expect(markerInsideItsHost(claude, { CLAUDE_PID: '500' }, tmuxPane, noHost)).toBe(false)
    expect(markerInsideItsHost(claude, { CLAUDE_PID: '99999' }, tmuxPane, noHost)).toBe(false)
  })

  it('believes a Codex marker only below the host its hooks recorded, or below Codex', () => {
    const codexShell = [{ pid: 703, name: 'zsh' }, { pid: 650, name: 'codex' }, { pid: 1, name: 'launchd' }]
    expect(markerInsideItsHost(codex, {}, codexShell, () => 650)).toBe(true)
    expect(markerInsideItsHost(codex, {}, codexShell, () => 651)).toBe(true)
    expect(markerInsideItsHost(codex, {}, tmuxPane, () => 650)).toBe(false)
  })

  it('keeps a marker nothing contradicts', () => {
    expect(markerInsideItsHost(claude, {}, tmuxPane, noHost)).toBe(true)
    expect(markerInsideItsHost(codex, {}, tmuxPane, noHost)).toBe(true)
    expect(markerInsideItsHost(claude, { CLAUDE_PID: '500' }, null, noHost)).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('reads this process and its parent from the real process tree', () => {
    const chain = processAncestry()
    expect(chain?.[0]?.pid).toBe(process.pid)
    expect(chain?.[1]?.pid).toBe(process.ppid)
  })

  it.runIf(process.platform !== 'win32')('treats a shell that inherited a session it is not inside as markerless', () => {
    const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'live-session' }
    expect(resolveActiveHarness({ ...env, CLAUDE_PID: String(process.ppid) }, '/', 0).active?.sessionId).toBe('live-session')
    // The witnessed case: the markers of a live session and a pid that is not an ancestor.
    expect(resolveActiveHarness({ ...env, CLAUDE_PID: '99999999' }, '/', 0)).toEqual({ active: null, contested: [] })
  })
})
