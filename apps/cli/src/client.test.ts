import {
CAPABILITIES_HEADER,
CLI_VERSION_HEADER,
NOTIFICATION_CONTRACT_HEADER,
} from '@raidiant/notifai-protocol'
import { createServer,type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach,describe,expect,it } from 'vitest'
import { ApiCallError,NetworkError,createClient } from './client.js'

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

it('discovers setup issues and sends an authenticated replacement snapshot over the wire', async () => {
  const requests: { method: string; url: string; authorization: string | undefined; body: unknown }[] = []
  const baseUrl = await serving(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString()
    requests.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization, body: raw === '' ? null : JSON.parse(raw) })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(request.url === '/api/v1/features' ? { features: ['setup_issues'] } : { ok: true }))
  })
  const client = createClient(baseUrl, 'Bearer test-machine')
  expect(await client.features()).toEqual({ features: ['setup_issues'] })
  expect(await client.putMachineSetupIssues({ issues: [] })).toEqual({ ok: true })
  expect(requests.map(({ method, url, authorization }) => ({ method, url, authorization }))).toEqual([
    { method: 'GET', url: '/api/v1/features', authorization: 'Bearer test-machine' },
    { method: 'PUT', url: '/api/v1/machine/setup-issues', authorization: 'Bearer test-machine' },
  ])
  expect(requests[1]!.body).toEqual({ issues: [] })
})

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

describe('closing a retired question', () => {
  const listed = { request_id: 'req_1', reply_expires_at: null, agent_acknowledgement_required: true,
    agent_acknowledgement_text_required: false, agent_acknowledgement: null, replies: [],
    close_disposition: 'retire', delivered_reply_seq: null }

  it('says how the question ended, and closes anyway on a service that predates saying so', async () => {
    const bodies: unknown[] = []
    const baseUrl = await serving((request, response) => {
      let raw = ''
      request.on('data', (chunk) => { raw += chunk })
      request.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>
        bodies.push(body)
        response.setHeader('content-type', 'application/json')
        if ('retirement' in body) {
          response.statusCode = 422
          response.end(JSON.stringify({ error: { code: 'invalid_request', message: 'disposition must be "deliver" or "retire".' } }))
          return
        }
        response.end(JSON.stringify(listed))
      })
    })
    const client = createClient(baseUrl, 'Bearer nfm_m.s')

    await expect(client.closeReplies('req_1', 'retire', 'expired')).resolves.toMatchObject({ request_id: 'req_1' })
    expect(bodies).toEqual([{ disposition: 'retire', retirement: 'expired' }, { disposition: 'retire' }])
  })

  it('sends the end state once to a service that accepts it', async () => {
    const bodies: unknown[] = []
    const baseUrl = await serving((request, response) => {
      let raw = ''
      request.on('data', (chunk) => { raw += chunk })
      request.on('end', () => {
        bodies.push(JSON.parse(raw))
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(listed))
      })
    })
    const client = createClient(baseUrl, 'Bearer nfm_m.s')

    await client.closeReplies('req_1', 'retire', 'expired')
    expect(bodies).toEqual([{ disposition: 'retire', retirement: 'expired' }])
  })
})
