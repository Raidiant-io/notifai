import type * as ChildProcess from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

const discovery = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof ChildProcess>()
  const execFile = Object.assign(() => { throw new Error('unexpected callback exec') }, {
    [Symbol.for('nodejs.util.promisify.custom')]: discovery,
  })
  return { ...original, execFile }
})
import { connectCodexQueue, NativeQueueNotSent } from './codex-queue-control.js'

// Unix control sockets are optional; Windows uses the CLI fallback.
const unixIt = it.skipIf(process.platform === 'win32')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); discovery.mockReset() })
async function fixture(options: { loaded?: string[]; homeMismatch?: boolean; failList?: boolean; loseReceipt?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'nfq-'))
  const home = path.join(root, 'home'); mkdirSync(home)
  const socket = path.join(root, 'q.sock'); const alias = path.join(root, 'alias.sock')
  const server = createServer(); const ws = new WebSocketServer({ server })
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const items: Array<{ id: string; clientUserMessageId: string; input: unknown[] }> = []
  ws.on('connection', client => client.on('message', bytes => {
    const request = JSON.parse(bytes.toString())
    calls.push(request)
    if (request.id === undefined) return
    const reply = (result: unknown) => client.send(JSON.stringify({ id: request.id, result }))
    switch (request.method) {
      case 'initialize': client.send('null'); reply({ codexHome: options.homeMismatch ? root : home }); break
      case 'thread/loaded/list': reply({ data: options.loaded ?? ['owned-thread'], nextCursor: null }); break
      case 'thread/queue/list':
        if (options.failList) client.send(JSON.stringify({ id: request.id, error: { code: -32601 } }))
        else reply({ data: items, nextCursor: null })
        break
      case 'thread/queue/add': {
        const item = { id: 'native-' + (items.length + 1), clientUserMessageId: request.params.clientUserMessageId, input: request.params.input }
        items.push(item)
        if (options.loseReceipt) client.close()
        else reply({ queuedSubmission: item })
        break
      }
      case 'thread/queue/delete': {
        const index = items.findIndex(item => item.id === request.params.queuedSubmissionId)
        if (index >= 0) items.splice(index, 1)
        reply({ deleted: index >= 0 }); break
      }
      default: throw new Error('Unexpected native method: ' + request.method)
    }
  }))
  await new Promise<void>(resolve => server.listen(socket, resolve))
  symlinkSync(socket, alias)
  discovery.mockResolvedValue({ stdout: JSON.stringify({ status: 'running', socketPath: alias }) })
  cleanup.push(async () => {
    for (const client of ws.clients) client.terminate()
    await new Promise<void>(resolve => ws.close(() => resolve()))
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })
  return { root, home, alias, socket, calls, items,
    connect: () => connectCodexQueue('owned-thread', { ...process.env, CODEX_HOME: home }, performance.now() + 2000) }
}

unixIt('discovers a symlinked endpoint, verifies namespace/thread and removes only an exact ID', async () => {
  const f = await fixture(); const control = (await f.connect())!
  expect(control).not.toBeNull()
  expect(control.threadId).toBe('owned-thread')
  const owned = await control.add('ours', 'content-free transport test')
  const unrelated = await control.add('human', 'unrelated work')
  expect(await control.find('ours', 'different text')).toBe('ambiguous')
  expect(await control.find('ours', 'content-free transport test')).toEqual({ id: owned })
  expect(await control.remove(owned)).toBe(true)
  expect(await control.remove(owned)).toBe(false)
  expect(f.items.map(item => item.id)).toEqual([unrelated])
  expect(f.calls.some(call => /resume|start/.test(call.method))).toBe(false)
  control.close()
})

unixIt.each([{ loaded: [] }, { homeMismatch: true }, { failList: true }])('refuses unsupported or differently owned native control: %j', async options => {
  const f = await fixture(options)
  expect(await f.connect()).toBeNull()
  expect(f.calls.some(call => call.method === 'thread/queue/add')).toBe(false)
})

unixIt('classifies an endpoint replacement before send as definitely unsent', async () => {
  const f = await fixture(); const control = (await f.connect())!
  rmSync(f.alias); symlinkSync(f.root, f.alias)
  await expect(control.add('ours', 'wake')).rejects.toBeInstanceOf(NativeQueueNotSent)
  expect(f.items).toHaveLength(0)
  control.close()
})

unixIt('keeps acceptance uncertain when the server stored input then lost the receipt', async () => {
  const f = await fixture({ loseReceipt: true }); const control = (await f.connect())!
  await expect(control.add('ours', 'wake')).rejects.not.toBeInstanceOf(NativeQueueNotSent)
  expect(f.items).toHaveLength(1)
  control.close()
})

unixIt('does not interpret duplicate client IDs as native idempotency', async () => {
  const f = await fixture(); const control = (await f.connect())!
  await control.add('same', 'wake'); await control.add('same', 'wake')
  expect(await control.find('same', 'wake')).toBe('ambiguous')
  expect(f.items).toHaveLength(2)
  control.close()
})
