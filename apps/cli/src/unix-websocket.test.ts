import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer, type Socket } from 'node:net'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { canonicalSocketPath } from './local-path.js'
import { connectUnixWebSocket, encodeFrame, FrameReader } from './unix-websocket.js'

const unixIt = it.skipIf(process.platform === 'win32')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

/** A reference RFC 6455 server (the `ws` package) on a Unix socket. */
async function referenceServer(onClient: (client: WebSocket) => void): Promise<string> {
  const socket = path.join(mkdtempSync(path.join(tmpdir(), 'nfws-')), 's.sock')
  const http = createHttpServer()
  const wss = new WebSocketServer({ server: http })
  wss.on('connection', onClient)
  await new Promise<void>(resolve => http.listen(socket, resolve))
  cleanup.push(async () => {
    for (const client of wss.clients) client.terminate()
    await new Promise<void>(resolve => wss.close(() => resolve()))
    await new Promise<void>(resolve => http.close(() => resolve()))
  })
  return socket
}

function unmask(frame: Buffer): Buffer {
  const length = frame[1]! & 0x7f
  const offset = length === 126 ? 4 : length === 127 ? 10 : 2
  const mask = frame.subarray(offset, offset + 4)
  return Buffer.from(frame.subarray(offset + 4).map((byte, i) => byte ^ mask[i & 3]!))
}

describe('encodeFrame', () => {
  it.each([5, 300, 70_000])('masks a final client frame with a %i-byte payload', size => {
    const payload = Buffer.alloc(size, 'x')
    const frame = encodeFrame(0x1, payload)
    expect(frame[0]).toBe(0x81)
    expect(frame[1]! & 0x80).toBe(0x80)
    expect(unmask(frame).equals(payload)).toBe(true)
  })
})

describe('FrameReader', () => {
  const serverFrame = (opcode: number, payload: Buffer, fin = true) => {
    const length = payload.length
    const header = length < 126 ? Buffer.from([0, length]) : Buffer.from([0, 126, length >> 8, length & 0xff])
    header[0] = (fin ? 0x80 : 0) | opcode
    return Buffer.concat([header, payload])
  }

  it('assembles frames split across arbitrary chunk boundaries', () => {
    const reader = new FrameReader(1024)
    const bytes = Buffer.concat([serverFrame(0x1, Buffer.from('hello')), serverFrame(0x1, Buffer.alloc(200, 'y'))])
    const frames = [...bytes].flatMap(byte => reader.push(Buffer.from([byte])))
    expect(frames.map(frame => frame.payload.toString())).toEqual(['hello', 'y'.repeat(200)])
  })

  it('rejects masked server frames, extensions and oversized frames', () => {
    expect(() => new FrameReader(1024).push(Buffer.from([0x81, 0x85, 0, 0, 0, 0]))).toThrow(/masked/)
    expect(() => new FrameReader(1024).push(Buffer.from([0xc1, 0x00]))).toThrow(/extensions/)
    expect(() => new FrameReader(10).push(serverFrame(0x1, Buffer.alloc(11)))).toThrow(/limit/)
  })
})

describe('connectUnixWebSocket', () => {
  unixIt('exchanges text with a reference server, answering pings and joining fragments', async () => {
    const socket = await referenceServer(client => client.on('message', data => {
      client.ping('keepalive')
      client.send('part-one ', { fin: false })
      client.send(`echo:${data.toString()}`, { fin: true })
    }))
    const received: string[] = []
    const ws = await connectUnixWebSocket(socket, { message: text => received.push(text), closed: () => {} },
      { maxPayload: 1024, lifetimeMs: 2000 })
    await ws.send('ping?')
    await expect.poll(() => received).toEqual(['part-one echo:ping?'])
    ws.terminate()
  })

  unixIt('reports a server-initiated close once', async () => {
    const socket = await referenceServer(client => client.close(1000))
    const closed: Error[] = []
    const ws = await connectUnixWebSocket(socket, { message: () => {}, closed: error => closed.push(error) },
      { maxPayload: 1024, lifetimeMs: 2000 })
    await expect.poll(() => closed.length).toBe(1)
    expect(ws.open).toBe(false)
    await expect(ws.send('late')).rejects.toThrow(/not open/)
  })

  unixIt('ends the connection when its lifetime runs out', async () => {
    const socket = await referenceServer(() => {})
    const closed: Error[] = []
    const ws = await connectUnixWebSocket(socket, { message: () => {}, closed: error => closed.push(error) },
      { maxPayload: 1024, lifetimeMs: 150 })
    expect(ws.open).toBe(true)
    await expect.poll(() => closed[0]?.message).toMatch(/lifetime/)
    expect(ws.open).toBe(false)
  })

  unixIt('closes when a message exceeds its limit', async () => {
    const socket = await referenceServer(client => client.send('z'.repeat(64)))
    const closed: Error[] = []
    await connectUnixWebSocket(socket, { message: () => {}, closed: error => closed.push(error) },
      { maxPayload: 32, lifetimeMs: 2000 })
    await expect.poll(() => closed[0]?.message).toMatch(/limit/)
  })

  unixIt('rejects a refused upgrade', async () => {
    const socket = path.join(mkdtempSync(path.join(tmpdir(), 'nfws-')), 'h.sock')
    const connections = new Set<Socket>()
    const server = createNetServer(client => { connections.add(client); client.end('HTTP/1.1 400 Bad Request\r\n\r\n') })
    await new Promise<void>(resolve => server.listen(socket, resolve))
    cleanup.push(() => new Promise<void>(resolve => { for (const client of connections) client.destroy(); server.close(() => resolve()) }))
    await expect(connectUnixWebSocket(socket, { message: () => {}, closed: () => {} },
      { maxPayload: 1024, lifetimeMs: 2000 })).rejects.toThrow(/refused/)
  })
})

describe('canonicalSocketPath', () => {
  unixIt('follows a symlink chain to the socket and canonicalizes its directory', async () => {
    const socket = await referenceServer(() => {})
    const root = mkdtempSync(path.join(tmpdir(), 'nfsp-'))
    mkdirSync(path.join(root, 'links'))
    symlinkSync(socket, path.join(root, 'links', 'first.sock'))
    symlinkSync(path.join('links', 'first.sock'), path.join(root, 'second.sock'))
    const resolved = canonicalSocketPath(path.join(root, 'second.sock'))
    expect(path.basename(resolved)).toBe('s.sock')
    expect(resolved).toBe(canonicalSocketPath(socket))
  })
})
