/** A minimal RFC 6455 client over a local Unix domain socket.
 *
 * The shipped CLI is compiled with Bun, whose `ws` replacement rejects
 * `ws+unix:` URLs and whose native WebSocket cannot dial a socket path. Codex
 * serves its app-server control endpoint only on a Unix socket, so this speaks
 * the protocol over `node:net`, which both Node and Bun support.
 *
 * Scope is deliberately narrow: one client, text messages, no extensions.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'

const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const Opcode = { Continuation: 0x0, Text: 0x1, Close: 0x8, Ping: 0x9, Pong: 0xa } as const

export interface UnixWebSocket {
  /** Resolves once the frame is handed to the socket. */
  send(text: string): Promise<void>
  readonly open: boolean
  terminate(): void
}

export interface UnixWebSocketHandlers {
  message(text: string): void
  /** Called once, for any end of the connection after it opened. */
  closed(error: Error): void
}

/** Open a connection that ends, handshake included, after `lifetimeMs`. */
export function connectUnixWebSocket(
  socketPath: string, handlers: UnixWebSocketHandlers, options: { maxPayload: number; lifetimeMs: number },
): Promise<UnixWebSocket> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    const accept = createHash('sha1').update(key + ACCEPT_GUID).digest('base64')
    const socket = createConnection({ path: socketPath })
    let opened = false
    let ended = false
    const end = (error: Error) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      socket.destroy()
      if (opened) handlers.closed(error)
      else reject(error)
    }
    const timer = setTimeout(() => end(new Error('Unix WebSocket lifetime ended')), options.lifetimeMs)
    socket.once('error', end)
    socket.once('close', () => end(new Error('Unix WebSocket connection closed')))
    socket.once('connect', () => {
      socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    })

    let buffer = Buffer.alloc(0)
    let fragments: Buffer[] = []
    let fragmentBytes = 0
    const parser = new FrameReader(options.maxPayload)
    socket.on('data', (chunk: Buffer) => {
      if (ended) return
      if (!opened) {
        buffer = Buffer.concat([buffer, chunk])
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) {
          if (buffer.length > 16_384) end(new Error('Unix WebSocket handshake response is too large'))
          return
        }
        const [status, ...lines] = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n')
        const headers = new Map(lines.map(line => {
          const at = line.indexOf(':')
          return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()] as const
        }))
        if (!/^HTTP\/1\.1 101\b/.test(status ?? '') || headers.get('sec-websocket-accept') !== accept) {
          end(new Error('Unix WebSocket upgrade was refused'))
          return
        }
        opened = true
        resolve(connection(socket, () => !ended))
        chunk = buffer.subarray(headerEnd + 4)
        buffer = Buffer.alloc(0)
      }
      try {
        for (const frame of parser.push(chunk)) {
          if (frame.opcode === Opcode.Ping) socket.write(encodeFrame(Opcode.Pong, frame.payload))
          else if (frame.opcode === Opcode.Close) {
            socket.write(encodeFrame(Opcode.Close, frame.payload.subarray(0, 2)))
            end(new Error('Unix WebSocket closed by the server'))
            return
          } else if (frame.opcode === Opcode.Text || frame.opcode === Opcode.Continuation) {
            if ((frame.opcode === Opcode.Text) !== (fragments.length === 0)) throw new Error('Unexpected WebSocket continuation')
            fragmentBytes += frame.payload.length
            if (fragmentBytes > options.maxPayload) throw new Error('WebSocket message exceeds its limit')
            fragments.push(frame.payload)
            if (frame.fin) {
              const text = Buffer.concat(fragments).toString('utf8')
              fragments = []
              fragmentBytes = 0
              handlers.message(text)
            }
          } else if (frame.opcode !== Opcode.Pong) throw new Error('Unsupported WebSocket frame')
        }
      } catch (error) {
        end(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

function connection(socket: Socket, isOpen: () => boolean): UnixWebSocket {
  return {
    get open() { return isOpen() },
    send: text => new Promise((resolve, reject) => {
      if (!isOpen()) { reject(new Error('Unix WebSocket is not open')); return }
      socket.write(encodeFrame(Opcode.Text, Buffer.from(text, 'utf8')), error => error ? reject(error) : resolve())
    }),
    terminate: () => socket.destroy(),
  }
}

/** A client frame: final, masked, as RFC 6455 requires of clients. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  const header = length < 126 ? Buffer.alloc(2) : length < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10)
  header[0] = 0x80 | opcode
  if (length < 126) header[1] = 0x80 | length
  else if (length < 65_536) { header[1] = 0x80 | 126; header.writeUInt16BE(length, 2) }
  else { header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(length), 2) }
  const mask = randomBytes(4)
  const masked = Buffer.alloc(length)
  for (let i = 0; i < length; i++) masked[i] = payload[i]! ^ mask[i & 3]!
  return Buffer.concat([header, mask, masked])
}

interface Frame { fin: boolean; opcode: number; payload: Buffer }

/** Incremental reader for unmasked server frames. */
export class FrameReader {
  private pending = Buffer.alloc(0)
  constructor(private readonly maxPayload: number) {}

  push(chunk: Buffer): Frame[] {
    this.pending = Buffer.concat([this.pending, chunk])
    const frames: Frame[] = []
    for (;;) {
      if (this.pending.length < 2) return frames
      const first = this.pending[0]!
      const second = this.pending[1]!
      if ((first & 0x70) !== 0) throw new Error('WebSocket extensions are not supported')
      if ((second & 0x80) !== 0) throw new Error('A server WebSocket frame must not be masked')
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.pending.length < 4) return frames
        length = this.pending.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.pending.length < 10) return frames
        const wide = this.pending.readBigUInt64BE(2)
        if (wide > BigInt(this.maxPayload)) throw new Error('WebSocket frame exceeds its limit')
        length = Number(wide)
        offset = 10
      }
      if (length > this.maxPayload) throw new Error('WebSocket frame exceeds its limit')
      if (this.pending.length < offset + length) return frames
      frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload: this.pending.subarray(offset, offset + length) })
      this.pending = this.pending.subarray(offset + length)
    }
  }
}
