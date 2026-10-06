import { attendantRuntimeRevision } from './commands-hook-attend.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { attendantClaimMatches, recoveryOwner, resumeAttendantCommand } from './attendant-update.js'
import { findNativeTranscript } from './codex-native-turn.js'
import { beginSessionIncarnation, lifecycleStamp, markSessionEnded, readSessionState, updateSessionState } from './hook-session-state.js'
import * as identity from './process-identity.js'
import type { CommandDeps } from './commands-core.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const SESSION = '019a1b2c-3d4e-7f50-8a61-72b3c4d5e6f7'
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-resident-update-')); roots.push(root)
  const env = { CODEX_HOME: path.join(root, 'codex'), XDG_STATE_HOME: path.join(root, 'state') }
  const owner = beginSessionIncarnation(SESSION, env, { stamp: lifecycleStamp(), harnessProcess: { pid: 4242, start: 'original-start' } })
  updateSessionState(SESSION, env, () => ({ harness: 'codex', activation_cwd: root,
    pending: [{ question: 'Keep this question', request_id: 'req_pending' }],
  }))
  const file = path.join(env.CODEX_HOME, 'sessions', '2026', '01', '01', `rollout-${SESSION}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, [
    { type: 'session_meta', payload: { id: SESSION, source: 'cli' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
  const deps = { env, cwd: root } as CommandDeps
  vi.spyOn(identity, 'processIdentityLiveness').mockImplementation(value => value.pid === 4242 && value.start === 'original-start' ? 'alive' : 'gone')
  vi.spyOn(identity, 'processExecutableName').mockReturnValue('codex')
  return { root, env, owner, file, deps }
}

it('requires the existing exact root process, incarnation and live session without altering pending work', () => {
  const f = fixture()
  const before = readSessionState(SESSION, f.env)
  expect(recoveryOwner(f.deps, SESSION, f.owner.key)?.owner.incarnation).toBe(f.owner.incarnation)
  expect(recoveryOwner(f.deps, SESSION, 'new-key')).toBeNull()
  vi.mocked(identity.processExecutableName).mockReturnValue('another-program')
  expect(recoveryOwner(f.deps, SESSION, f.owner.key)).toBeNull()
  vi.mocked(identity.processExecutableName).mockReturnValue('codex')
  vi.mocked(identity.processIdentityLiveness).mockReturnValue('gone')
  expect(recoveryOwner(f.deps, SESSION, f.owner.key)).toBeNull()
  vi.mocked(identity.processIdentityLiveness).mockReturnValue('alive')
  markSessionEnded(SESSION, f.env, Date.now())
  expect(recoveryOwner(f.deps, SESSION, f.owner.key)).toBeNull()
  expect(readSessionState(SESSION, f.env).pending).toEqual(before.pending)
})

it('discovers one native transcript, refuses ambiguous files and validates root metadata before recovery', async () => {
  const f = fixture()
  expect(findNativeTranscript(SESSION, f.env)).toBe(f.file)
  writeFileSync(f.file, JSON.stringify({ type: 'session_meta', payload: { id: SESSION, source: { subagent: {} } } }) + '\n')
  expect(await resumeAttendantCommand(f.deps, SESSION, f.owner.key)).toBe(1)
  const second = path.join(path.dirname(f.file), `duplicate-${SESSION}.jsonl`)
  writeFileSync(second, '')
  expect(findNativeTranscript(SESSION, f.env)).toBeNull()
  expect(findNativeTranscript('../foreign', f.env)).toBeNull()
})


it('does not report a prior runtime owner as activated merely because its protocol matches', () => {
  const reference = { installation_id: '12345678-1234-1234-1234-123456789012', build: 'a'.repeat(64) }
  const claim = { runtime_revision: attendantRuntimeRevision, runtime_version: '2.0.0', runtime_build: reference }
  expect(attendantClaimMatches(claim, '2.0.0', reference)).toBe(true)
  expect(attendantClaimMatches({ ...claim, runtime_version: '1.0.0' }, '2.0.0', reference)).toBe(false)
  expect(attendantClaimMatches({ ...claim, runtime_build: { ...reference, build: 'b'.repeat(64) } }, '2.0.0', reference)).toBe(false)
  expect(attendantClaimMatches({ ...claim, runtime_build: undefined }, '2.0.0', reference)).toBe(false)
  expect(attendantClaimMatches(claim, '2.0.0', null)).toBe(true)
})
