import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { recordSessionStart } from './hook-session-state.js'
import { NOTIFICATION_IMAGE_MAX_BYTES } from '@raidiant/notifai-protocol'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT, type CommandDeps, type CommandIo } from './commands-core.js'
import { readCappedBytes, uploadImage, resolveDraftInvocation } from './commands-send-support.js'
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

describe('uploadImage local files', () => {
  it('refuses a repository image linked to an SSH key before any upload is requested', async () => {
    // The scenario: a cloned repository commits assets/preview.png as a link to
    // ../../../.ssh/id_ed25519 and asks for it on completion notifications.
    // send, ask, the held wait and OpenCode forms all upload through here.
    const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-image-link-'))
    try {
      const repo = path.join(home, 'src', 'cloned')
      mkdirSync(path.join(home, '.ssh'), { recursive: true })
      mkdirSync(path.join(repo, 'assets'), { recursive: true })
      writeFileSync(path.join(home, '.ssh', 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\n')
      try {
        symlinkSync(path.join('..', '..', '..', '.ssh', 'id_ed25519'), path.join(repo, 'assets', 'preview.png'))
      } catch {
        return // Windows without Developer Mode cannot create the link at all.
      }
      const deps = { io: io(), env: {}, cwd: repo } as CommandDeps
      expect(await uploadImage(deps, refusingClient(), 'assets/preview.png')).toEqual({
        ok: false,
        error: '--image "assets/preview.png" is a symbolic link; Notifai reads only the file itself.',
        exit: EXIT.usage,
      })
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('uploads a regular image and refuses one whose bytes are not the image its name says', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'notifai-image-local-'))
    try {
      writeFileSync(path.join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      writeFileSync(path.join(dir, 'notes.png'), 'not an image')
      const deps = { io: io(), env: {}, cwd: dir } as CommandDeps
      const uploaded: number[] = []
      expect(await uploadImage(deps, uploadingClient(uploaded), 'shot.png')).toEqual({ ok: true, mediaId: 'med_1' })
      expect(uploaded).toEqual([8])
      expect(await uploadImage(deps, refusingClient(), 'notes.png')).toEqual({
        ok: false, error: '--image "notes.png" is not the PNG image its name says.', exit: EXIT.usage,
      })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

it('keeps the exact session Project when a tool sends from a scratch directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-project-context-'))
  try {
    const repo = path.join(root, 'example-project')
    const scratch = path.join(root, 'scratch-assets')
    mkdirSync(repo); mkdirSync(scratch)
    execFileSync('git', ['init', '--quiet', repo])
    const env = { XDG_STATE_HOME: path.join(root, 'state') }
    recordSessionStart('session-context', env, 'claude-code', repo)
    const result = resolveDraftInvocation({ cwd: scratch, env, io: io() } as CommandDeps, {},
      { harness: 'claude-code', label: 'Claude Code', sessionId: 'session-context' })
    expect(result).toMatchObject({ ok: true, invocation: { inferredProject: 'example-project' } })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
