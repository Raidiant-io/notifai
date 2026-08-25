import { NOTIFICATION_IMAGE_MAX_BYTES } from '@raidiant/notifai-protocol'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT, type CommandDeps, type CommandIo } from './commands-core.js'
import { readCappedBytes, uploadImage } from './commands-send-support.js'
import type { ApiClient } from './client.js'

let server: Server | undefined

afterEach(async () => {
  if (server) {
    const closing = server
    server = undefined
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  }
})

async function serving(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

function io(): CommandIo {
  return {
    out: () => undefined,
    err: () => undefined,
    confirm: async () => false,
    openUrl: () => undefined,
  }
}

describe('readCappedBytes', () => {
  it('refuses Content-Length over the cap before reading the body', async () => {
    const response = new Response(null, { headers: { 'content-length': '64' } })
    expect(await readCappedBytes(response, 16)).toBe('too-large')
  })

  it('stops reading once the downloaded bytes exceed the cap', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(12))
          controller.enqueue(new Uint8Array(12))
          controller.close()
        },
      }),
    )
    expect(await readCappedBytes(response, 16)).toBe('too-large')
  })

  it('returns a payload that fits the cap', async () => {
    const payload = new Uint8Array([1, 2, 3, 4])
    expect(await readCappedBytes(new Response(payload), 16)).toEqual(payload)
  })
})

describe('uploadImage remote fetch', () => {
  it('still accepts http URLs and uploads bytes under the media limit', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const baseUrl = await serving((_request, response) => {
      response.setHeader('content-type', 'image/png')
      response.end(Buffer.from(png))
    })
    const uploaded: number[] = []
    const client = {
      createMediaUpload: async () => ({
        media_id: 'med_1',
        upload_url: 'https://upload.invalid/1',
        upload_headers: {},
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
      uploadMedia: async (_grant: unknown, bytes: Uint8Array) => {
        uploaded.push(bytes.byteLength)
      },
    } as unknown as ApiClient
    const deps = { io: io(), env: {}, cwd: '/tmp' } as CommandDeps

    const result = await uploadImage(deps, client, `${baseUrl}/shot.png`)
    expect(result).toEqual({ ok: true, mediaId: 'med_1' })
    expect(uploaded).toEqual([png.byteLength])
  })

  it('refuses a remote image whose Content-Length exceeds the server media limit', async () => {
    const baseUrl = await serving((_request, response) => {
      response.setHeader('content-type', 'image/png')
      response.setHeader('content-length', String(NOTIFICATION_IMAGE_MAX_BYTES + 1))
      response.end()
    })
    const client = {
      createMediaUpload: async () => {
        throw new Error('must not request an upload')
      },
    } as unknown as ApiClient
    const deps = { io: io(), env: {}, cwd: '/tmp' } as CommandDeps

    const result = await uploadImage(deps, client, `${baseUrl}/huge.png`)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.exit).toBe(EXIT.usage)
    expect(result.error).toContain(String(NOTIFICATION_IMAGE_MAX_BYTES))
  })
})
