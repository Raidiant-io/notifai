import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexAppIpcPath, codexAppIpcVerified, openCodexAppIpc } from './codex-app-ipc.js'

const THREAD = '00000000-0000-7000-8000-00000000a002'
const cleanup: Array<() => void> = []
afterEach(() => { for (const step of cleanup.splice(0)) step() })

/** The app's router as seen live (2026-11-05): length-prefixed JSON, one owner window for the thread, or none. */
async function router(options: { owner?: string | null; startVersion?: number }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cxipc-'))
  const socketPath = path.join(root, 'ipc.sock')
  const seen: Array<Record<string, unknown>> = []
  const clients: Socket[] = []
  const server: Server = createServer((socket) => {
    clients.push(socket)
    let buffer = Buffer.alloc(0)
    const send = (frame: unknown) => {
      const body = Buffer.from(JSON.stringify(frame))
      const head = Buffer.alloc(4)
      head.writeUInt32LE(body.length, 0)
      socket.write(Buffer.concat([head, body]))
    }
    // The router asks every client whether it handles a request, and broadcasts conversation events.
    send({ type: 'broadcast', method: 'client-status-changed', params: { secret: 'conversation text' } })
    send({ type: 'client-discovery-request', requestId: 'cd_1', request: { method: 'thread-follower-start-turn' } })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0)
        if (buffer.length < 4 + size) break
        const frame = JSON.parse(buffer.subarray(4, 4 + size).toString()) as Record<string, unknown>
        buffer = buffer.subarray(4 + size)
        seen.push(frame)
        if (frame['type'] !== 'request') continue
        const reply = (body: Record<string, unknown>) => send({ type: 'response', requestId: frame['requestId'], ...body })
        if (frame['method'] === 'initialize') reply({ resultType: 'success', result: { clientId: 'client_notifai' } })
        else if (frame['method'] === 'thread-owner-discovery') {
          reply(options.owner === null || options.owner === undefined ? { resultType: 'error', error: 'no-client-found' }
            : { resultType: 'success', handledByClientId: options.owner, result: { supportsUntrustedAppInput: true } })
        } else if (frame['method'] === 'thread-follower-start-turn') {
          reply(frame['version'] === (options.startVersion ?? 2) ? { resultType: 'success', result: { turn: { id: 'turn_new', status: 'inProgress' } } }
            : { resultType: 'error', error: 'request-version-mismatch' })
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  cleanup.push(() => { for (const client of clients) client.destroy(); server.close(); rmSync(root, { recursive: true, force: true }) })
  return { socketPath, seen }
}

describe('the Codex app\'s IPC router', () => {
  it('finds the window that has the conversation open and has it start the turn, as the User sending a message does', async () => {
    const r = await router({ owner: 'window_1' })
    const ipc = (await openCodexAppIpc(r.socketPath, Date.now() + 5_000))!
    try {
      expect(await ipc.owner(THREAD)).toEqual({ kind: 'owned', clientId: 'window_1' })
      expect(await ipc.startTurn('window_1', THREAD, 'wake text')).toBe('started')
    } finally { ipc.close() }
    const requests = r.seen.filter((frame) => frame['type'] === 'request')
    expect(requests.map((frame) => [frame['method'], frame['version']])).toEqual([['initialize', 0], ['thread-owner-discovery', 1], ['thread-follower-start-turn', 2]])
    expect(requests[1]!['params']).toEqual({ hostId: 'local', conversationId: THREAD })
    expect(requests[2]).toMatchObject({ targetClientId: 'window_1', sourceClientId: 'client_notifai', params: { conversationId: THREAD,
      turnStart: { request: { threadId: THREAD, input: [{ type: 'text', text: 'wake text', text_elements: [] }] }, context: {} } } })
    // Notifai handles nothing the router asks of its clients.
    expect(r.seen).toContainEqual({ type: 'client-discovery-response', requestId: 'cd_1', response: { canHandle: false } })
  })

  it('reports a conversation no window has open, a changed method version, and an app that is not running', async () => {
    const none = await router({ owner: null })
    const ipc = (await openCodexAppIpc(none.socketPath, Date.now() + 5_000))!
    expect(await ipc.owner(THREAD)).toEqual({ kind: 'not-owned' })
    ipc.close()
    const changed = await router({ owner: 'window_1', startVersion: 3 })
    const next = (await openCodexAppIpc(changed.socketPath, Date.now() + 5_000))!
    expect(await next.startTurn('window_1', THREAD, 'wake text')).toBe('refused')
    next.close()
    expect(await openCodexAppIpc(path.join(os.tmpdir(), 'no-such-codex-ipc.sock'), Date.now() + 1_000)).toBeNull()
  })

  it('is used only on Codex builds its methods were verified with, at the app\'s own path per OS', () => {
    expect(codexAppIpcVerified('0.166.0-alpha.6')).toBe(true)
    expect(codexAppIpcVerified('0.167.1')).toBe(true)
    expect(codexAppIpcVerified('0.165.9')).toBe(false)
    expect(codexAppIpcVerified(null)).toBe(false)
    expect(codexAppIpcPath({ HOME: '/Users/u' }, 'darwin')).toBe('/Users/u/.codex/ipc/ipc.sock')
    expect(codexAppIpcPath({}, 'win32')).toBe('\\\\.\\pipe\\codex-ipc')
  })
})
