/**
 * Several agents in one Project send at the same instant. Each `notifai` here
 * is a real process from the built CLI, sharing one fixture home and one
 * Project with its siblings, against an in-process stand-in for the service.
 * Shared local state must never fail a send or lose its Notification Request.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CAPABILITIES_V1, type SubmissionReceipt } from '@raidiant/notifai-protocol'
import { projectBinding, projectEnabled } from './project-enablement.js'

const CLI = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const SENDS = 10
const ACKNOWLEDGEMENTS = 4

interface Service {
  server: Server
  baseUrl: string
  submissions: { idempotency_key: string; title: string }[]
  acknowledgements: string[]
}

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function service(): Promise<Service> {
  const state: Omit<Service, 'server' | 'baseUrl'> = { submissions: [], acknowledgements: [] }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fixture')
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const capabilities = /^\/api\/v1\/capabilities\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'GET' && capabilities !== null) {
        return reply(200, CAPABILITIES_V1.describe(decodeURIComponent(capabilities[1]!)))
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/notifications') {
        const body = JSON.parse(raw) as { idempotency_key: string; draft: { presentation: { title: string } } }
        state.submissions.push({ idempotency_key: body.idempotency_key, title: body.draft.presentation.title })
        const receipt: SubmissionReceipt = {
          request_id: `req_fixture_${state.submissions.length}`,
          reply_expires_at: null,
          agent_acknowledgement_required: false,
          agent_acknowledgement_text_required: false,
          replayed: false,
          overall: 'provider_accepted_all',
          deliveries: [{
            delivery_id: `del_fixture_${state.submissions.length}`,
            device_id: 'dev_fixture',
            device_name: 'Fixture phone',
            state: 'provider_accepted',
            attempts: 1,
            provider_status: 200,
            provider_reason: null,
            provider_id: 'provider_fixture',
            updated_at: new Date().toISOString(),
          }],
          warnings: [],
        }
        return reply(200, receipt)
      }
      const acknowledgement = /^\/api\/v1\/notifications\/([^/]+)\/agent-acknowledgement$/.exec(url.pathname)
      if (req.method === 'PUT' && acknowledgement !== null) {
        state.acknowledgements.push(decodeURIComponent(acknowledgement[1]!))
        const text = (JSON.parse(raw) as { text?: string }).text ?? ''
        return reply(200, { status: 'recorded', agent_acknowledgement: { text, created_at: new Date().toISOString() } })
      }
      reply(404, { error: { code: 'not_found', message: `${req.method} ${url.pathname}` } })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${port}`, ...state }
}

/** A paired fixture machine: one home, one Git Project, a file credential. */
function machine(baseUrl: string): { project: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-concurrent-send-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const project = path.join(root, 'shared-project')
  mkdirSync(project, { recursive: true })
  execFileSync('git', ['init', '-q', project])
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: home,
    USERPROFILE: home,
    TMPDIR: path.join(root, 'tmp'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    NOTIFAI_CREDENTIALS: 'file',
    NOTIFAI_NO_INPUT: '1',
    NOTIFAI_BASE_URL: baseUrl,
    LANG: 'C',
  }
  mkdirSync(env['TMPDIR']!, { recursive: true })
  const credentials = path.join(env['XDG_CONFIG_HOME']!, 'notifai')
  mkdirSync(credentials, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(credentials, 'credentials.json'), `${JSON.stringify({
    format: 'notifai.machine-credential.v1',
    machineId: 'mac_fixture',
    secret: 'fixture-machine-secret',
    baseUrl,
    machineName: 'Fixture machine',
  })}\n`, { mode: 0o600 })
  return { project, env }
}

interface Run { args: string[]; code: number | null; stderr: string }

function run(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('close', (code) => resolve({ args, code, stderr }))
  })
}

/** Every process starts in the same instant; none waits on a sibling to begin. */
function burst(project: string, env: NodeJS.ProcessEnv, label: string): Promise<Run[]> {
  return Promise.all([
    ...Array.from({ length: SENDS }, (_, i) => run(project, env, [
      'send', '--kind', 'update', '--title', `${label} ${i}`, '--summary', `Parallel agent ${i} finished.`, '--no-wait',
    ])),
    ...Array.from({ length: ACKNOWLEDGEMENTS }, (_, i) => run(project, env, [
      'acknowledge', `req_${label}_${i}`, '--text', `Using answer ${i}.`,
    ])),
  ])
}

function failures(runs: Run[]): string[] {
  return runs.filter((r) => r.code !== 0).map((r) => `${r.args[0]} exited ${String(r.code)}: ${r.stderr.slice(0, 400)}`)
}

describe.skipIf(process.platform === 'win32')('concurrent sends in one Project', () => {
  it('submits every Notification Request while siblings enable and then share the Project', async () => {
    const svc = await service()
    const { project, env } = machine(svc.baseUrl)
    const binding = projectBinding(project, env)
    expect(projectEnabled(binding)).toBe(false)

    // First contact: every sender races to record the Project's enablement.
    expect(failures(await burst(project, env, 'first'))).toEqual([])
    expect(projectEnabled(binding)).toBe(true)
    const recorded = statSync(binding!.markerPath)

    // Steady state: the Project is enabled, so senders only read the record.
    expect(failures(await burst(project, env, 'steady'))).toEqual([])
    const after = statSync(binding!.markerPath)
    expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: recorded.ino, mtimeMs: recorded.mtimeMs })

    const titles = svc.submissions.map((s) => s.title).sort()
    const expected = ['first', 'steady'].flatMap((label) => Array.from({ length: SENDS }, (_, i) => `${label} ${i}`)).sort()
    expect(titles).toEqual(expected)
    expect(new Set(svc.submissions.map((s) => s.idempotency_key)).size).toBe(2 * SENDS)
    expect(svc.acknowledgements).toHaveLength(2 * ACKNOWLEDGEMENTS)
  }, 120_000)
})
