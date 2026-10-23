import { mkdtempSync,rmSync } from 'node:fs'
import { createServer,type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach,expect,it,vi } from 'vitest'
import { GrokLeaderSession } from './grok-leader.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(sharedHome?: string, name = 'leader.sock') {
  const home = sharedHome ?? mkdtempSync(path.join(os.tmpdir(), 'gl-'))
  if (sharedHome === undefined) cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const file = path.join(home, name), clients = new Set<Socket>()
  const row = { sessionId: 'exact', cwd: '/project', resident: true, activity: 'idle' }
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let protocol = 1, answerWrite = true, malformed = false
  const server = createServer(socket => {
    clients.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => clients.delete(socket))
    let buffer = Buffer.alloc(0)
    const send = (value: unknown) => {
      const data = Buffer.from(JSON.stringify(value)), size = Buffer.alloc(4)
      size.writeUInt32BE(data.length)
      // Split framing deliberately: a read is not a protocol message.
      socket.write(size.subarray(0, 2)); socket.write(Buffer.concat([size.subarray(2), data]))
    }
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
        const size = buffer.readUInt32BE(0)
        const frame = JSON.parse(buffer.subarray(4, 4 + size).toString())
        buffer = buffer.subarray(4 + size)
        if (frame.type === 'register') send({ type: 'registered', ready: true, leader_protocol_version: protocol })
        else if (frame.type === 'acp') {
          const rpc = JSON.parse(frame.payload); calls.push(rpc)
          if (malformed) { send(null); continue }
          if (rpc.method === '_x.ai/interject' && !answerWrite) { socket.destroy(); continue }
          send({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { result:
            rpc.method === '_x.ai/sessions/list' ? { sessions: [row] } : { status: 'queued' } } }) })
        }
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(file, resolve) })
  cleanup.push(() => new Promise<void>(resolve => { for (const socket of clients) socket.destroy(); server.close(() => resolve()) }))
  const discover = async (cwd = '/project') => {
    const session = await GrokLeaderSession.discover('exact', cwd, { GROK_HOME: home })
    if (session) cleanup.push(() => session.close())
    return session
  }
  return { row, calls, discover, home, file, clients,
    setProtocol: (version: number) => { protocol = version },
    loseWriteReply: () => { answerWrite = false },
    corruptReply: () => { malformed = true },
  }
}
const guard = { writable: () => true, remainingMs: () => 10_000 }

it('writes only to the exact resident session and never attaches while observing', async () => {
  const f = await fixture(), session = await f.discover()
  expect(session?.probe()).toEqual({ state: 'running', activity: 'idle' })
  const begin = vi.fn(() => true)
  expect(await session!.write('complete note', begin, guard)).toEqual({ status: 'written', route: 'inbox-socket' })
  expect(begin).toHaveBeenCalledOnce()
  expect(f.calls.filter(call => call.method === '_x.ai/sessions/list').every(call => Object.keys(call.params).length === 0)).toBe(true)
  expect(f.calls.filter(call => call.method === '_x.ai/interject')).toMatchObject([{ params: { sessionId: 'exact', text: 'complete note' } }])
  f.row.resident = false
  expect(await session!.write('closed', begin, guard)).toEqual({ status: 'stopped' })
  f.row.resident = true // An ended observer cannot adopt a later reload.
  expect(await session!.write('reloaded', begin, guard)).toEqual({ status: 'stopped' })
  expect(begin).toHaveBeenCalledOnce()
})

it('keeps an ambiguous write unconfirmed, without retrying it', async () => {
  const f = await fixture(), session = await f.discover()
  f.loseWriteReply()
  expect(await session!.write('possibly delivered', () => true, guard)).toMatchObject({ status: 'failed' })
  expect(f.calls.filter(call => call.method === '_x.ai/interject')).toHaveLength(1)
})
