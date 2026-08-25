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

function uploadingClient(uploaded: number[]): ApiClient {
  return {
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
}

function refusingClient(): ApiClient {
  return {
    createMediaUpload: async () => {
      throw new Error('must not request an upload')
    },
  } as unknown as ApiClient
}

describe('uploadImage remote fetch', () => {
  it('uploads bytes under the media limit from an allowed self-hosted origin', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const baseUrl = await serving((_request, response) => {
      response.setHeader('content-type', 'image/png')
      response.end(Buffer.from(png))
    })
    const uploaded: number[] = []
    const deps = { io: io(), env: {}, cwd: '/tmp' } as CommandDeps

    const result = await uploadImage(deps, uploadingClient(uploaded), `${baseUrl}/shot.png`, [
      baseUrl,
    ])
    expect(result).toEqual({ ok: true, mediaId: 'med_1' })
    expect(uploaded).toEqual([png.byteLength])
  })

  it('refuses that same loopback origin when the User has not allowed it', async () => {
    const baseUrl = await serving((_request, response) => {
      response.setHeader('content-type', 'image/png')
      response.end(Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47])))
    })
    const deps = { io: io(), env: {}, cwd: '/tmp' } as CommandDeps

    const result = await uploadImage(deps, refusingClient(), `${baseUrl}/shot.png`)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.exit).toBe(EXIT.usage)
    expect(result.error).toContain('media_origins')
  })

  it('refuses a remote image whose Content-Length exceeds the server media limit', async () => {
    const baseUrl = await serving((_request, response) => {
      response.setHeader('content-type', 'image/png')
      response.setHeader('content-length', String(NOTIFICATION_IMAGE_MAX_BYTES + 1))
      response.end()
    })
    const deps = { io: io(), env: {}, cwd: '/tmp' } as CommandDeps

    const result = await uploadImage(deps, refusingClient(), `${baseUrl}/huge.png`, [baseUrl])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.exit).toBe(EXIT.usage)
    expect(result.error).toContain(String(NOTIFICATION_IMAGE_MAX_BYTES))
  })

  it('refuses a redirect out of an allowed origin into an unallowed one', async () => {
    const target = await serving((_request, response) => {
      response.setHeader('content-type', 'image/png')
      response.end(Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47])))
    })
    // A second loopback origin the User never allowed. The first hop is
    // trusted; the destination is not, and each hop is checked on its own.
    const redirector = createServer((_request, response) => {
      response.writeHead(302, { location: `${target}/shot.png` })
      response.end()
    })
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve))
    const { port } = redirector.address() as AddressInfo
    const redirectOrigin = `http://127.0.0.1:${port}`
    const deps = { io: io(), env: {}, cwd: '/tmp' } as CommandDeps

    try {
      const result = await uploadImage(deps, refusingClient(), `${redirectOrigin}/shot.png`, [
        redirectOrigin,
      ])
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected refusal')
      expect(result.exit).toBe(EXIT.usage)
      expect(result.error).toContain('media_origins')
    } finally {
      await new Promise<void>((resolve) => redirector.close(() => resolve()))
    }
  })
})
