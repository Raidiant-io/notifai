import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { HermesWriterBridge, hermesAnswerRoute } from './hermes-attendant.js'
import { acquireClaimFile, releaseClaimFile } from './hook-question-lock.js'
import { attendantClaimPath, hermesQuestionRouteReady, writeAttendantStatus } from './session-attendant-state.js'

it('requires a current exact Hermes session and confirms one fenced injection', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const bridge = new HermesWriterBridge(input, output)
  input.write(`${JSON.stringify({ type: 'hello', session_id: 'session-a', cwd: '/tmp', pid: process.ppid })}\n`)
  input.write(`${JSON.stringify({ type: 'state', session_id: 'session-a', activity: 'working' })}\n`)
  expect((await bridge.hello())?.session_id).toBe('session-a')
  expect(bridge.probe('session-a')).toEqual({ state: 'running', activity: 'working' })

  let beginnings = 0
  const guard = { writable: () => true, remainingMs: () => 5_000 }
  const rejected = await bridge.write('session-b', 'wrong session', () => { beginnings += 1; return true }, guard)
  expect(rejected.status).toBe('unavailable')
  expect(beginnings).toBe(0)

  const outbound = new Promise<{ id: number; session_id: string; text: string; deadline_ms: number }>(resolve => {
    output.once('data', chunk => resolve(JSON.parse(String(chunk)) as { id: number; session_id: string; text: string; deadline_ms: number }))
  })
  const before = Date.now()
  const write = bridge.write('session-a', 'quoted note', () => { beginnings += 1; return true }, guard)
  const frame = await outbound
  expect(frame).toMatchObject({ session_id: 'session-a', text: 'quoted note' })
  expect(frame.deadline_ms).toBeGreaterThan(before)
  expect(frame.deadline_ms).toBeLessThanOrEqual(Date.now() + 5_000)
  input.write(`${JSON.stringify({ type: 'result', id: frame.id, accepted: true })}\n`)
  expect(await write).toMatchObject({ status: 'written', route: 'session-queue' })
  expect(beginnings).toBe(1)

  input.write(`${JSON.stringify({ type: 'state', session_id: 'session-b', activity: 'idle' })}\n`)
  expect(bridge.probe('session-a')).toEqual({ state: 'ended', reason: 'session-replaced' })
  bridge.close()
})

it('leaves a missing plugin confirmation unconfirmed after the write begins', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const bridge = new HermesWriterBridge(input, output)
  input.write(`${JSON.stringify({ type: 'hello', session_id: 'session-a', cwd: '/tmp', pid: process.ppid })}\n`)
  input.write(`${JSON.stringify({ type: 'state', session_id: 'session-a', activity: 'idle' })}\n`)
  await bridge.hello()
  const outbound = new Promise<void>(resolve => output.once('data', () => resolve()))
  let began = false
  const write = bridge.write('session-a', 'note', () => { began = true; return true }, {
    writable: () => true, remainingMs: () => 5_000,
  })
  await outbound
  input.end()
  expect((await write).status).toBe('failed')
  expect(began).toBe(true)
})

it('admits only fresh exact-session plugin writer evidence', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-route-'))
  const env = { XDG_STATE_HOME: root }
  const sessionId = 'hermes-live'
  const file = attendantClaimPath(sessionId, env)
  const token = acquireClaimFile(file, { incarnation: 'inc_test' })
  try {
    expect(token).not.toBeNull()
    const now = Date.now()
    const status = {
      phase: 'dormant' as const, incarnation: 'inc_test', generation: null,
      activity: 'working' as const, reason: null, accepts_messages: true,
      writer_ready: true, updated_at: now,
    }
    writeAttendantStatus(sessionId, env, status)
    expect(hermesQuestionRouteReady(sessionId, env, now)).toBe(true)
    expect(hermesQuestionRouteReady('hermes-other', env, now)).toBe(false)
    writeAttendantStatus(sessionId, env, { ...status, writer_ready: false })
    expect(hermesQuestionRouteReady(sessionId, env, now)).toBe(false)
    writeAttendantStatus(sessionId, env, { ...status, updated_at: now - 5_001 })
    expect(hermesQuestionRouteReady(sessionId, env, now)).toBe(false)
  } finally {
    if (token !== null) releaseClaimFile(file, token)
    rmSync(root, { recursive: true, force: true })
  }
})

it('commits a claimed answer only when the exact plugin confirms injection', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const bridge = new HermesWriterBridge(input, output)
  input.write(`${JSON.stringify({ type: 'hello', session_id: 'session-a', cwd: '/tmp', pid: process.ppid })}\n`)
  input.write(`${JSON.stringify({ type: 'state', session_id: 'session-a', activity: 'idle' })}\n`)
  await bridge.hello()
  const route = hermesAnswerRoute(bridge, 'session-a')
  let commits = 0
  const event = {
    context: 'answer context', answers: 1, remaining: 0, request_ids: ['req_one'], journal_recorded_at: 1,
    commitDelivery: () => { commits += 1; return true },
  }
  expect((await route.deliver(event)).acknowledgement).toBe('held')
  expect(commits).toBe(0)
  const frame = new Promise<{ id: number; text: string }>(resolve =>
    output.once('data', chunk => resolve(JSON.parse(String(chunk)) as { id: number; text: string })))
  const delivery = route.deliver({ ...event, writeGuard: { writable: () => true, remainingMs: () => 5_000 } })
  const sent = await frame
  expect(sent.text).toBe('answer context')
  input.write(`${JSON.stringify({ type: 'result', id: sent.id, accepted: true })}\n`)
  expect((await delivery).acknowledgement).toBe('delivered')
  expect(commits).toBe(1)
  bridge.close()
})
