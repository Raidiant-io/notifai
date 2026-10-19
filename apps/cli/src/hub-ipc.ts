/**
 * Local IPC between the hub, the native session children, and the CLI.
 *
 * One Unix socket in a 0700 run directory, never a TCP listener. Frames are a
 * 4-byte big-endian length and UTF-8 JSON. Every connection opens with a
 * `hello` naming its role and IPC version; nothing secret crosses it. The
 * native child computes the same paths (`launcher/session-child.h`).
 */
import { lstatSync, chmodSync, mkdirSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import path from 'node:path'
import { stateDir } from './config.js'

/** The IPC version this build speaks, and the range of versions the hub serves. */
export const HUB_IPC_VERSION = 1
export const HUB_IPC_VERSIONS = { min: 1, max: 1 } as const

/** Largest frame either side accepts. */
export const HUB_MAX_FRAME = 1024 * 1024

/** A Unix socket path at or beyond this many bytes moves to the short fallback. */
const SOCKET_PATH_LIMIT = 100

/** The hybrid runs on these platforms; Windows keeps today's attendant until W1-Win proves it. */
export function hubSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux'
}

/** FNV-1a 64-bit over UTF-8 bytes, as 16 hex digits; the child names files with it. */
export function fnv64Hex(text: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

export function hubRunDir(env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), 'run')
}

/** `<state>/run/hub.sock`, or `/tmp/notifai-<uid>/<hash>.sock` when that is too long for a socket. */
export function hubSocketPath(env: NodeJS.ProcessEnv): string {
  const candidate = path.join(hubRunDir(env), 'hub.sock')
  if (Buffer.byteLength(candidate) < SOCKET_PATH_LIMIT) return candidate
  return path.join(`/tmp/notifai-${process.getuid?.() ?? 0}`, `${fnv64Hex(stateDir(env))}.sock`)
}

export function hubLockPath(env: NodeJS.ProcessEnv): string {
  return path.join(hubRunDir(env), 'hub.lock')
}

export function hubStatusPath(env: NodeJS.ProcessEnv): string {
  return path.join(hubRunDir(env), 'hub-status.json')
}

export function hubHistoryPath(env: NodeJS.ProcessEnv): string {
  return path.join(hubRunDir(env), 'hub-history.json')
}

/** Non-secret marker bumped whenever the Machine credential changes. */
export function credentialGenerationPath(env: NodeJS.ProcessEnv): string {
  return path.join(hubRunDir(env), 'credential-generation')
}

/** The flock the native child holds for one session (see `session-child.h`). */
export function childLockPath(env: NodeJS.ProcessEnv, sessionId: string): string {
  return path.join(hubRunDir(env), 'children', `${fnv64Hex(sessionId)}.lock`)
}

/** Local end records a child writes when its harness exits. */
export function endedRecordsDir(env: NodeJS.ProcessEnv): string {
  return path.join(hubRunDir(env), 'ended')
}

/** A directory only this user can enter: 0700, owned by this user, not a link. */
export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  const uid = process.getuid?.()
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`${directory} is not a private directory owned by this user`)
  }
  if ((info.mode & 0o077) !== 0) chmodSync(directory, 0o700)
}

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  if (body.length > HUB_MAX_FRAME) throw new Error('IPC frame too large')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/** Splits a byte stream into decoded frames; throws on an oversized or malformed frame. */
export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Record<string, unknown>[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk])
    const frames: Record<string, unknown>[] = []
    for (;;) {
      if (this.buffered.length < 4) return frames
      const length = this.buffered.readUInt32BE(0)
      if (length > HUB_MAX_FRAME) throw new Error('IPC frame too large')
      if (this.buffered.length < length + 4) return frames
      const parsed: unknown = JSON.parse(this.buffered.subarray(4, 4 + length).toString('utf8'))
      this.buffered = this.buffered.subarray(4 + length)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('IPC frame is not an object')
      frames.push(parsed as Record<string, unknown>)
    }
  }
}

/** Connect to the hub's socket, or null when nothing answers within `timeoutMs`. */
export function connectHub(env: NodeJS.ProcessEnv, timeoutMs = 1_000): Promise<Socket | null> {
  return new Promise((resolve) => {
    let settled = false
    const socket = createConnection(hubSocketPath(env))
    const finish = (value: Socket | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (value === null) socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.once('connect', () => finish(socket))
    socket.once('error', () => finish(null))
  })
}

/**
 * One request to a running hub: hello, the message, the first reply. Null when
 * no hub answers. Never starts the hub.
 */
export async function requestHub(
  env: NodeJS.ProcessEnv,
  message: Record<string, unknown>,
  options: { timeoutMs?: number; role?: 'cli' | 'hint' } = {},
): Promise<Record<string, unknown> | null> {
  const timeoutMs = options.timeoutMs ?? 2_000
  const socket = await connectHub(env, timeoutMs)
  if (socket === null) return null
  return await new Promise((resolve) => {
    const decoder = new FrameDecoder()
    let settled = false
    const finish = (value: Record<string, unknown> | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.on('data', (chunk: Buffer) => {
      try {
        const frames = decoder.push(chunk)
        const reply = frames.find((frame) => frame['type'] !== 'hello')
        if (reply !== undefined) finish(reply)
      } catch {
        finish(null)
      }
    })
    socket.once('error', () => finish(null))
    socket.once('close', () => finish(null))
    socket.write(encodeFrame({ type: 'hello', ipc_version: HUB_IPC_VERSION, role: options.role ?? 'cli', pid: process.pid }))
    socket.write(encodeFrame(message))
  })
}
