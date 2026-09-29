import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { HermesWriterBridge } from './hermes-attendant.js'

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

  const outbound = new Promise<{ id: number; session_id: string; text: string }>(resolve => {
    output.once('data', chunk => resolve(JSON.parse(String(chunk)) as { id: number; session_id: string; text: string }))
  })
  const write = bridge.write('session-a', 'quoted note', () => { beginnings += 1; return true }, guard)
  const frame = await outbound
  expect(frame).toMatchObject({ session_id: 'session-a', text: 'quoted note' })
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
