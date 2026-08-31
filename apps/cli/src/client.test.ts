import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAPABILITIES_HEADER,
  CLI_VERSION_HEADER,
  NOTIFICATION_CONTRACT_HEADER,
} from '@raidiant/notifai-protocol'
import { ApiCallError, NetworkError, createClient } from './client.js'

/**
 * These run against a real socket rather than a stubbed fetch, because the
 * failure being fixed is a property of the transport: a server that accepts the
 * connection and then says nothing. A mock that resolves or rejects cannot
 * reproduce it.
 */
let server: Server | undefined

afterEach(async () => {
  if (server) {
    const closing = server
    server = undefined
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  }
})

/** Starts a server with the given behaviour and returns its base URL. */
async function serving(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

describe('a server that never answers', () => {
  it('gives up instead of hanging until the harness kills the hook', async () => {
    // Accepts the request, holds the socket open, writes nothing — ever.
    const held: unknown[] = []
    const baseUrl = await serving((_request, response) => {
      held.push(response)
    })
    const client = createClient(baseUrl, null, { timeoutMs: 300 })

    const started = Date.now()
    await expect(client.listDevices()).rejects.toBeInstanceOf(NetworkError)
    // The point is that it returns at all; the bound is loose so a busy CI box
    // does not make this flaky.
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(held).toHaveLength(1)
  })

  it('says the server went quiet rather than reporting a bare abort', async () => {
    const baseUrl = await serving(() => {})
    const client = createClient(baseUrl, null, { timeoutMs: 300 })

    await expect(client.listDevices()).rejects.toThrow(/did not respond within/)
  })

  it('clamps a late request to the caller whole-operation deadline', async () => {
    const baseUrl = await serving(() => {})
    const started = Date.now()
    const client = createClient(baseUrl, null, {
      timeoutMs: 5_000,
      deadlineAt: started + 200,
    })

    await expect(client.listDevices()).rejects.toBeInstanceOf(NetworkError)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('allows for the long poll it asked the server to hold', async () => {
    // The deadline is per request, so a 25s long poll must not be cut off by
    // the ordinary budget — otherwise waiting for a reply could never work.
    let seen: string | undefined
    const baseUrl = await serving((request, response) => {
      seen = request.url
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ request_id: 'req_1', reply_expires_at: null, replies: [] }))
    })
    const client = createClient(baseUrl, null, { timeoutMs: 300 })

    const result = await client.replies('req_1', { waitSeconds: 25, afterSeq: 0 })

    expect(seen).toContain('wait_seconds=25')
    expect(result.replies).toEqual([])
  })

  it('encodes pairing and evidence path segments', async () => {
    const seen: string[] = []
    const baseUrl = await serving((request, response) => {
      seen.push(`${request.method} ${request.url}`)
      response.setHeader('content-type', 'application/json')
      if (request.url?.includes('/poll')) {
        response.end(JSON.stringify({ status: 'pending' }))
        return
      }
      response.end(
        JSON.stringify({
          request_id: 'req/encoded',
          overall: 'accepted',
          deliveries: [],
          warnings: [],
        }),
      )
    })
    const client = createClient(baseUrl, 'Bearer test')

    await client.pollPairing('pair/id', 'verifier')
    await client.evidence('req/encoded')

    expect(seen).toEqual([
      'POST /api/v1/pairings/pair%2Fid/poll',
      'GET /api/v1/notifications/req%2Fencoded',
    ])
  })

  it('lists Account custom sounds from the catalog endpoint', async () => {
    let seen: string | undefined
    const baseUrl = await serving((request, response) => {
      seen = `${request.method} ${request.url}`
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ sounds: [] }))
    })
    const result = await createClient(baseUrl, 'Bearer test').listSounds()
    expect(seen).toBe('GET /api/v1/sounds')
    expect(result).toEqual({ sounds: [] })
  })

  it('refuses redirects on bearer-authenticated calls', async () => {
    let followed = false
    const baseUrl = await serving((request, response) => {
      if (request.url === '/api/v1/devices') {
        response.statusCode = 302
        response.setHeader('location', '/stolen')
        response.end()
        return
      }
      followed = true
      response.end('stolen')
    })

    await expect(createClient(baseUrl, 'Bearer secret').listDevices()).rejects.toBeInstanceOf(
      NetworkError,
    )
    expect(followed).toBe(false)
  })

  it('still follows redirects when the call has no bearer', async () => {
    const baseUrl = await serving((request, response) => {
      if (request.url === '/healthz') {
        response.statusCode = 302
        response.setHeader('location', '/healthz-ok')
        response.end()
        return
      }
      response.setHeader('content-type', 'application/json')
      response.end('{}')
    })

    await expect(createClient(baseUrl, null).health()).resolves.toBe(true)
  })

  it('puts and fetches Agent Acknowledgements on the encoded request path', async () => {
    const seen: { method?: string; url?: string; body?: unknown }[] = []
    const baseUrl = await serving((request, response) => {
      let raw = ''
      request.on('data', (chunk) => {
        raw += String(chunk)
      })
      request.on('end', () => {
        seen.push({
          method: request.method,
          url: request.url,
          ...(raw === '' ? {} : { body: JSON.parse(raw) as unknown }),
        })
        response.setHeader('content-type', 'application/json')
        if (request.method === 'PUT') {
          response.end(
            JSON.stringify({
              status: 'recorded',
              agent_acknowledgement: {
                text: 'I will deploy.',
                created_at: '2026-08-13T12:01:00.000Z',
              },
            }),
          )
        } else {
          response.end(
            JSON.stringify({
              request_id: 'req/encoded',
              agent_acknowledgement_required: true,
              agent_acknowledgement: null,
            }),
          )
        }
      })
    })
    const client = createClient(baseUrl, 'Bearer test')

    await client.putAgentAcknowledgement('req/encoded', { text: 'I will deploy.' })
    await client.agentAcknowledgement('req/encoded', { waitSeconds: 25 })

    expect(seen).toEqual([
      {
        method: 'PUT',
        url: '/api/v1/notifications/req%2Fencoded/agent-acknowledgement',
        body: { text: 'I will deploy.' },
      },
      {
        method: 'GET',
        url: '/api/v1/notifications/req%2Fencoded/agent-acknowledgement?wait_seconds=25',
      },
    ])
  })

  it('finalizes provider metadata before treating a storage upload as usable', async () => {
    const seen: { method?: string; url?: string; authorization?: string; bytes: number }[] = []
    const baseUrl = await serving((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        seen.push({
          method: request.method,
          url: request.url,
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
          bytes: Buffer.concat(chunks).byteLength,
        })
        if (request.method === 'POST') {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ media_id: 'med_1', size_bytes: 4, status: 'ready' }))
        } else {
          response.statusCode = 200
          response.end()
        }
      })
    })
    const client = createClient(baseUrl, 'Bearer machine')

    await client.uploadMedia(
      {
        media_id: 'med_1',
        upload_url: `${baseUrl}/signed-upload`,
        upload_headers: { 'content-type': 'image/png' },
        expires_at: '2026-08-14T12:00:00.000Z',
      },
      new Uint8Array([1, 2, 3, 4]),
    )

    expect(seen).toEqual([
      { method: 'PUT', url: '/signed-upload', bytes: 4 },
      {
        method: 'POST',
        url: '/api/v1/media/med_1/finalize',
        authorization: 'Bearer machine',
        bytes: 0,
      },
    ])
  })

  it('refuses a signed upload redirect without replaying its headers or finalizing', async () => {
    let followed = false
    let finalized = false
    const baseUrl = await serving((request, response) => {
      if (request.url === '/signed-upload') {
        response.statusCode = 302
        response.setHeader('location', `${baseUrl}/stolen`)
        response.end()
        return
      }
      if (request.url === '/stolen') followed = true
      if (request.url === '/api/v1/media/med_1/finalize') finalized = true
      response.statusCode = 200
      response.end()
    })
    const client = createClient(baseUrl, 'Bearer machine')

    await expect(
      client.uploadMedia(
        {
          media_id: 'med_1',
          upload_url: `${baseUrl}/signed-upload`,
          upload_headers: { authorization: 'Signed secret' },
          expires_at: '2026-08-14T12:00:00.000Z',
        },
        new Uint8Array([1, 2, 3, 4]),
      ),
    ).rejects.toThrow(/redirect is refused/i)
    expect(followed).toBe(false)
    expect(finalized).toBe(false)
  })

  it('treats a truncated body as a transport failure, not a crash', async () => {
    // A body that stops mid-JSON used to escape as a raw parse error outside
    // the retry path, so nothing backed off and retried it.
    const baseUrl = await serving((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.write('{"devices": [')
      response.destroy()
    })
    const client = createClient(baseUrl, null, { timeoutMs: 500 })

    await expect(client.listDevices()).rejects.toBeInstanceOf(NetworkError)
  })
})

describe('compatibility metadata transport', () => {
  it('advertises named CLI capabilities only on authenticated traffic', async () => {
    const seen: Array<{
      url: string | undefined
      cliVersion: string | string[] | undefined
      capabilities: string | string[] | undefined
      notificationContract: string | string[] | undefined
    }> = []
    const baseUrl = await serving((request, response) => {
      seen.push({
        url: request.url,
        cliVersion: request.headers[CLI_VERSION_HEADER],
        capabilities: request.headers[CAPABILITIES_HEADER],
        notificationContract: request.headers[NOTIFICATION_CONTRACT_HEADER],
      })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          schema_version: 1,
          platform: 'macos',
          payload_limit_bytes: 4096,
          sounds: [],
          interruption_levels: [],
          fields: [],
        }),
      )
    })
    const options = {
      cliVersion: '5.0.0',
      capabilities: ['agent_acknowledgement'] as const,
      notificationContractFingerprint: 'notification-draft/test',
    }

    await createClient(baseUrl, 'Bearer machine', options).capabilities('macos', '0.1.0', '42')
    await createClient(baseUrl, null, options).capabilities('macos')

    expect(seen).toEqual([
      {
        url: '/api/v1/capabilities/macos?app_version=0.1.0&app_build=42',
        cliVersion: '5.0.0',
        capabilities: 'agent_acknowledgement',
        notificationContract: 'notification-draft/test',
      },
      {
        url: '/api/v1/capabilities/macos',
        cliVersion: undefined,
        capabilities: undefined,
        notificationContract: undefined,
      },
    ])
  })

  it('keeps recovery typed when a feature is unavailable', async () => {
    const baseUrl = await serving((_request, response) => {
      response.statusCode = 422
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: {
            code: 'feature_unavailable',
            message: "The selected device can't answer questions.",
            next_action: 'run an untrusted server command',
            recovery_action: 'update_companion',
            details: {
              affected_operation: 'answer_questions',
              missing_capabilities: ['answer'],
            },
          },
        }),
      )
    })

    let caught: unknown
    try {
      await createClient(baseUrl, 'Bearer machine').compatibility()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ApiCallError)
    expect(caught).toMatchObject({
      status: 422,
      code: 'feature_unavailable',
      recoveryAction: 'update_companion',
      nextAction: 'run an untrusted server command',
      details: {
        affected_operation: 'answer_questions',
        missing_capabilities: ['answer'],
      },
    })
  })
})
