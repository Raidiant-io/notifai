import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudePlaceCheck } from './claude-place-diagnostics.js'
import { claudeDescriptorDir } from './claude-wake.js'
import { claudeRunElsewhereReason } from './commands-hook-run.js'
import { beginSessionIncarnation, lifecycleStamp } from './hook-session-state.js'
import { processStartTime } from './process-identity.js'
import { attendantStatusPath } from './session-attendant-state.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'place-check-'))
  roots.push(root)
  const env = { XDG_STATE_HOME: root, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_CODE_ENTRYPOINT: 'orca', ORCA_STRUCTURED_SESSION: '1' }
  const id = 'place-check-session'
  const pid = process.pid
  const start = processStartTime(pid)!
  mkdirSync(claudeDescriptorDir(env), { recursive: true })
  writeFileSync(path.join(claudeDescriptorDir(env), `${pid}.json`), JSON.stringify({ pid, sessionId: id,
    cwd: root, startedAt: Date.now(), procStart: start, version: '2.1.304', peerProtocol: 1, messagingSocketPath: path.join(root, 'inbox.sock'), status: 'idle' }))
  beginSessionIncarnation(id, env, { stamp: lifecycleStamp(), harnessProcess: { pid: pid + 1, start } })
  writeFileSync(attendantStatusPath(id, env), JSON.stringify({ session_id: id, phase: 'exited', reason: 'stopped' }))
  return { env, id, pid }
}

describe('Claude place diagnostics and hook admission', () => {
  it('recognizes a resumed Orca process but reports the missing Session Child', () => {
    const { env, id, pid } = fixture()
    expect(claudeRunElsewhereReason(id, env, pid, () => 'Orca')).toBeNull()
    const check = claudePlaceCheck(env, id, pid, () => 'Orca')!
    expect(check.ok).toBe(false)
    expect(check.technical).toMatchObject({ place: 'orca-chat', reason: 'direct-orca-host', session_child: false, attached: false, recorded_phase: 'exited' })
    expect(check.detail).toContain('next turn end, prompt or resume')
    expect(claudePlaceCheck(env, 'another-session', pid, () => 'Orca')).toBeNull()
  })

  it('distinguishes an unproven host from a script without withdrawing a fresh owner', () => {
    const { env, id, pid } = fixture()
    expect(claudeRunElsewhereReason(id, env, pid, () => null)).toBe('place-unproven')
    expect(claudePlaceCheck(env, id, pid, () => null)?.technical.transfer_refusal).toBe('place-unproven')
    const scripted = { ...env, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }
    expect(claudeRunElsewhereReason(id, scripted, pid, () => 'bash')).toBe('place-receives-nothing')
    expect(claudePlaceCheck(scripted, id, pid, () => 'bash')?.detail).toContain('scripted')
    expect(claudeRunElsewhereReason(id, env, pid + 1, () => null)).toBeNull()
    expect(claudeRunElsewhereReason('new-owner', env, pid, () => null)).toBeNull()
  })
})
