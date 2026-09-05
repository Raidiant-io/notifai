import {
  CAPABILITIES_V1,
  SHIPPED_CLI_CAPABILITIES,
  type Platform,
} from '@raidiant/notifai-protocol'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { CommandDeps } from './commands-core.js'
import { SETUP_PROOF_FORMAT, writeSetupProof } from './commands-setup-proof.js'
import { FileStore, type MachineCredential } from './credentials.js'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

const python = 'python3'
const pythonHasPty =
  process.platform !== 'win32' &&
  spawnSync(python, ['-c', 'import pty'], { stdio: 'ignore' }).status === 0
const ptyIt = pythonHasPty ? it : it.skip

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function compactTerminalOutput(value: string): string {
  return value
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replaceAll(/[^A-Za-z0-9]+/g, '')
}

ptyIt('renders completed setup ahead of a transient evidence failure in a real PTY', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-interactive-pty-'))
  roots.push(root)
  const cwd = path.join(root, 'project')
  const bin = path.join(root, 'bin')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    NOTIFAI_CREDENTIALS: 'file',
    NOTIFAI_NO_ANIMATION: '1',
    PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`,
  }
  delete env['CI']
  delete env['NOTIFAI_NO_INPUT']
  mkdirSync(path.join(cwd, '.notifai'), { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(cwd, '.notifai', 'config.toml'), 'project = "pty-proof"\n')

  let evidenceCalls = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/healthz') return json(response, { ok: true })
    if (url.pathname === '/api/v1/compatibility') {
      return json(response, {
        cli: {
          state: 'current',
          reason: 'current',
          affected_operation: null,
          recovery_action: null,
          current_version: '11.0.3',
          current_build: null,
          recommended_version: '11.0.3',
          recommended_build: null,
          minimum_version: null,
          minimum_build: null,
          deprecation: null,
          sunset: null,
        },
        platforms: [],
        server_capabilities: [...SHIPPED_CLI_CAPABILITIES],
      })
    }
    if (url.pathname.startsWith('/api/v1/capabilities/')) {
      const platform = url.pathname.split('/').at(-1) as Platform
      return json(response, CAPABILITIES_V1.describe(platform))
    }
    if (url.pathname === '/api/v1/account/access') {
      return json(response, {
        status: 'active',
        reason: 'alpha_grant',
        expires_at: null,
        email: 'pty@example.test',
      })
    }
    if (url.pathname === '/api/v1/account/alpha-access-request') {
      return json(response, { request: null })
    }
    if (url.pathname === '/api/v1/devices') {
      return json(response, {
        devices: [
          {
            device_id: 'dev_pty',
            display_name: 'iPhone',
            platform: 'ios',
            permission_status: 'authorized',
            registration_healthy: true,
            app_version: '1.0.0',
            app_build: '1',
            os_version: '19.0',
            capabilities: ['answer'],
            support_state: 'current',
            derived_status: 'working',
            status_message: null,
            last_seen_at: '2026-09-05T12:00:00.000Z',
          },
        ],
      })
    }
    if (url.pathname === '/api/v1/notifications/req_pty_proof') {
      evidenceCalls += 1
      return json(
        response,
        { error: { code: 'internal_error', message: 'transient fixture detail' } },
        503,
      )
    }
    return json(response, { error: { code: 'not_found', message: 'fixture route missing' } }, 404)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
    const credential: MachineCredential = {
      machineId: 'mac_pty',
      machineName: 'PTY fixture',
      secret: 'pty-fixture-secret',
      baseUrl: `http://127.0.0.1:${address.port}`,
    }
    const store = new FileStore(env)
    store.save(credential)
    const proofDeps = {
      cwd,
      env,
      store,
      io: { out() {}, err() {}, async confirm() { return false }, openUrl() {} },
    } satisfies CommandDeps
    expect(writeSetupProof(proofDeps, {
      format: SETUP_PROOF_FORMAT,
      request_id: 'req_pty_proof',
      device_id: 'dev_pty',
      project: 'pty-proof',
      started_at: '2026-09-05T12:00:00.000Z',
      companion_receipt: { state: 'observed', observed_at: '2026-09-05T12:00:02.000Z' },
    })).toBe(true)

    const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url))
    chmodSync(cli, 0o755)
    const command = path.join(bin, 'notifai')
    symlinkSync(cli, command)
    const fetchFixture = path.join(root, 'fetch-fixture.mjs')
    writeFileSync(
      fetchFixture,
      [
        'const fetchImpl = globalThis.fetch;',
        'globalThis.fetch = (input, init) => {',
        "  if (String(input).startsWith('https://registry.npmjs.org/')) {",
        "    return Promise.resolve(new Response('{}', { status: 503 }));",
        '  }',
        '  return fetchImpl(input, init);',
        '};',
        '',
      ].join('\n'),
    )
    env['NODE_OPTIONS'] = `--import=${pathToFileURL(fetchFixture).href}`

    const child = spawn(
      python,
      [
        '-c',
        'import os, pty, sys; status = pty.spawn([sys.argv[1]]); sys.exit(os.waitstatus_to_exitcode(status))',
        command,
      ],
      {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let output = ''
    let stopped = false
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (!stopped && compactTerminalOutput(output).includes('Sendatestnotification')) {
        stopped = true
        child.stdin.write('\u0003')
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    let timeout: NodeJS.Timeout | undefined
    const result = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve({ code, signal }))
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          child.kill('SIGTERM')
          reject(new Error(`PTY CLI timed out. Output:\n${output}`))
        }, 15_000).unref()
      }),
    ])
    if (timeout !== undefined) clearTimeout(timeout)

    expect(result.signal).toBeNull()
    expect(result.code).toBe(0)
    expect(compactTerminalOutput(output)).toContain('Sendatestnotification')
    expect(compactTerminalOutput(output)).not.toContain('Finishsetup')
    expect(evidenceCalls).toBe(1)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})
