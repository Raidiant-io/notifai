import type * as Fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireClaimFile, readClaimFile, releaseClaimFile } from './hook-question-lock.js'
import { handOffSessionMessages } from './session-message-handoff.js'
import { updateSessionState } from './hook-session-state.js'
import { doctorCommand } from './commands-doctor.js'
import type { CommandDeps } from './commands-core.js'
import type { ApiClient } from './client.js'
import { currentProcessIdentity } from './process-identity.js'
import { readDeliveryJournal, recoverDeliveryJournal, type SequencerDeps } from './session-delivery.js'
import { drainSessionInputs, stageSessionMessages } from './session-inputs.js'

const disk = vi.hoisted(() => ({ armed: false, full: false, failAt: 0, writes: 0, operation: 'writeFileSync' }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof Fs>()
  const trip = (operation: string) => {
    if (disk.operation === operation && disk.failAt > 0 && ++disk.writes >= disk.failAt) disk.full = true
    if (disk.full) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  }
  return { ...fs,
    fsyncSync: (...args: Parameters<typeof fs.fsyncSync>) => { trip('fsyncSync'); return fs.fsyncSync(...args) },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => { trip('renameSync'); return fs.renameSync(...args) },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (disk.armed && String(args[1]).includes('message_acknowledgement_due')) disk.full = true
      trip('writeFileSync')
      return fs.writeFileSync(...args)
    },
  }
})
const roots: string[] = []
afterEach(() => { vi.useRealTimers(); disk.armed = false; disk.full = false; disk.failAt = 0; disk.writes = 0; disk.operation = 'writeFileSync'; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const cases = ['note', 'answer', 'unclaimed'].flatMap(kind =>
  ['writeFileSync', 'fsyncSync', 'renameSync'].flatMap(operation =>
    Array.from({ length: 11 }, (_, failAt) => ({ kind, operation, failAt }))))

async function recoveryCase({ kind, operation, failAt }: { kind: string; operation: string; failAt: number }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-full-')); roots.push(root)
  const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state') }
  const sessionId = 'disk-recovery'
  const lease = { incarnation: 'inc_diskrecovery', generation: 1 }
  const reports: string[] = []
  const outcomes = new Map<string, string>()
  let attempt = 0
  const client = {
    agentAcknowledgement: async () => ({ agent_acknowledgement: null }),
    claimDeliveryAttempt: async () => ({ attempt_id: `att_disk${++attempt}`, claim_remaining_ms: 30_000 }),
    reportDeliveryAttempt: async (id: string, body: { outcome: string }) => {
      const outcome = outcomes.get(id) ?? body.outcome
      outcomes.set(id, outcome)
      reports.push(outcome)
      return { attempt_id: id, outcome, replayed: false }
    },
  } as unknown as ApiClient
  const sequencer: SequencerDeps = { sessionId, env, client, writer: currentProcessIdentity()!,
    monotonic: () => performance.now(), wall: () => Date.now(), sleep: async () => {} }
  if (kind !== 'note') {
    const reply = { reply_id: 'rpl_full', seq: 1, delivery_id: 'del_full', device_id: 'dev_test', device_name: 'Test', text: 'Continue the work', answers: [], source: null, created_at: new Date().toISOString() }
    updateSessionState(sessionId, env, state => ({ ...state, waiting_answers: [{
      pending: { question_id: 'q_full', question: 'Continue?', request_id: 'req_full', collapse_key: 'disk-question', device_ids: ['dev_test'] },
      reply, replies: [reply], agent_acknowledgement_required: true, delivery_claim: kind !== 'unclaimed',
    }], acknowledgement_due: [{ request_id: 'req_full', recorded_at: Date.now(), text_required: true }] }))
  } else stageSessionMessages(sessionId, env, lease, [{ message_id: 'sm_full', kind: 'note', body: 'Continue the work',
    created_at: new Date().toISOString(), agent_acknowledgement_text_required: true }])
  const output: string[] = []
  const drain = () => drainSessionInputs({ sequencer, lease, mayWrite: () => true, write: text => { output.push(text) } })
  disk.armed = failAt === 0 && kind === 'note'; disk.failAt = failAt; disk.operation = operation
  await drain().catch(error => { expect(error.message).toContain('ENOSPC') })
  if (failAt === 0 && kind === 'note') expect(output).toEqual([])
  disk.armed = false; disk.full = false; disk.failAt = 0
  await recoverDeliveryJournal(sequencer)
  await drain()
  expect(output).toHaveLength(1)
  expect(output[0]).toContain('Continue the work')
  await drain()
  expect(output).toHaveLength(1)
  if (kind !== 'unclaimed') expect(readDeliveryJournal(sessionId, env).some(entry => entry.reported === 'handed_off')).toBe(true)
  expect(reports).not.toContain('failed')
}

const legacyUncertain = (item: typeof cases[number]) => item.kind === 'unclaimed' &&
  item.operation === 'fsyncSync' && item.failAt === 4 && process.platform !== 'win32'
it.each(cases.filter(item => !legacyUncertain(item)))('recovers $kind after $operation $failAt without duplicate presentation', recoveryCase)
// Known residual: directory fsync after published legacy consumption cannot
// establish whether a previous hook showed the answer. Do not count as recovery.
it.fails.each(cases.filter(legacyUncertain))('legacy recovery remains unproven after published consumption ($operation $failAt)', recoveryCase)

it('releases an owned claim after space returns even while its process stays alive', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-full-lock-')); roots.push(root)
  const file = path.join(root, 'claim')
  const token = acquireClaimFile(file, {})!
  expect(token).not.toBeNull()
  disk.full = true
  releaseClaimFile(file, token)
  disk.full = false
  expect(acquireClaimFile(file, {})).not.toBeNull()
})

it('doctor reports a storage fault instead of ready while local writes fail', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-full-doctor-')); roots.push(root)
  const output: string[] = []
  const deps = { cwd: root, env: { HOME: root, XDG_STATE_HOME: path.join(root, 'state') },
    io: { out: (text: string) => output.push(text), err: () => {} } } as unknown as CommandDeps
  disk.full = true
  const code = await doctorCommand(deps, { json: true }, { readiness: { states: [] }, updatesRunHere: false })
  disk.full = false
  expect(code).toBe(1)
  expect(JSON.parse(output.at(-1)!).states).toContainEqual(expect.objectContaining({ id: 'local-storage', status: 'gap' }))
})

it('retries direct message handoff after the disk fills between saving debt and starting output', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-direct-full-')); roots.push(root)
  const sequencer: SequencerDeps = { sessionId: 'direct-full', env: { HOME: root, XDG_STATE_HOME: root },
    client: { claimDeliveryAttempt: async () => ({ attempt_id: 'att_directfull', claim_remaining_ms: 30_000 }),
      reportDeliveryAttempt: async (attempt_id: string, body: { outcome: string }) => ({ attempt_id, ...body, replayed: false }),
    } as unknown as ApiClient, writer: currentProcessIdentity()!, monotonic: () => performance.now(), wall: Date.now, sleep: async () => {} }
  const messages = [{ message_id: 'sm_directfull', kind: 'note' as const, body: 'Keep going',
    created_at: new Date().toISOString(), agent_acknowledgement_text_required: true }]
  let written = 0
  const handle = { mayWrite: () => true, generation: () => 1, incarnation: () => 'inc_directfull' }
  const run = () => handOffSessionMessages(messages, handle, { sequencer, lockWaitMs: 0, write: async (_text, begin) => {
    if (!begin()) return { status: 'cancelled' as const }
    written++
    return { status: 'written' as const, route: 'inbox-socket' as const, sessionState: 'live-idle' as const }
  } })
  disk.failAt = 6
  await run().catch(error => expect(error.message).toContain('ENOSPC'))
  expect(written).toBe(0)
  disk.failAt = 0; disk.full = false
  await run()
  expect(written).toBe(1)
})

it('retries a failed release without waiting for a new prompt or another acquisition', async () => {
  vi.useFakeTimers()
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-release-retry-')); roots.push(root)
  const file = path.join(root, 'claim')
  const token = acquireClaimFile(file, {})!
  disk.full = true
  releaseClaimFile(file, token)
  disk.full = false
  await vi.advanceTimersByTimeAsync(30_000)
  expect(readClaimFile(file)).toBeNull()
})
