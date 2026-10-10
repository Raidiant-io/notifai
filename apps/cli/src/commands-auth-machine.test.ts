import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiCallError, NetworkError, type ApiClient } from './client.js'
import { authAdoptCommand, authStatusCommand, logoutCommand, EXIT, type CommandDeps } from './commands.js'
import type { MachineCredential } from './credentials.js'
import { readPendingPairing, writePendingPairing } from './pending-pairing.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const SECRET = 'a'.repeat(43)
const ADOPTED = {
  machine_id: 'mac_desktop',
  secret: SECRET,
  base_url: 'https://notifai.sh/',
  machine_name: 'Studio',
}

function harness(options: { stored?: MachineCredential | null; revoke?: () => Promise<{ ok: true }> } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-auth-machine-'))
  roots.push(root)
  let stored = options.stored ?? null
  const out: string[] = []
  const err: string[] = []
  const bearers: (string | null)[] = []
  let revokes = 0
  const client = {
    revokeMachine: async () => {
      revokes += 1
      return (options.revoke ?? (async () => ({ ok: true as const })))()
    },
  } as unknown as ApiClient
  const deps: CommandDeps = {
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      confirm: async () => false,
      openUrl: () => {},
    },
    store: {
      load: () => stored,
      save: (credential) => {
        stored = credential
      },
      clear: () => {
        stored = null
      },
      describe: () => 'test store',
    },
    env: { XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), HOME: root },
    cwd: root,
    clientFactory: (_baseUrl, bearer) => {
      bearers.push(bearer)
      return client
    },
  }
  return { deps, out, err, bearers, stored: () => stored, revokes: () => revokes }
}

const EXISTING: MachineCredential = {
  machineId: 'mac_existing',
  secret: 'existing-secret',
  baseUrl: 'https://notifai.sh',
  machineName: 'Laptop',
}

describe('notifai auth adopt', () => {
  it('stores the credential a Companion App on this machine obtained', () => {
    const test = harness()
    writePendingPairing(test.deps.env, {
      pairing_id: 'pair_cli_first',
      code: 'CODE-0001',
      approve_url: 'https://app.notifai.sh/approve?code=CODE-0001',
      base_url: 'https://notifai.sh',
      machine_name: 'Studio',
      secret: 'pending-secret',
      poll_verifier: 'pending-verifier',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      poll_interval_seconds: 2,
    })
    const code = authAdoptCommand(test.deps, { stdin: true, json: true }, () => JSON.stringify(ADOPTED))
    expect(code).toBe(EXIT.ok)
    expect(test.stored()).toEqual({
      machineId: 'mac_desktop',
      secret: SECRET,
      baseUrl: 'https://notifai.sh',
      machineName: 'Studio',
    })
    expect(JSON.parse(test.out.join('\n'))).toEqual({
      adopted: true,
      machine_id: 'mac_desktop',
      machine_name: 'Studio',
      base_url: 'https://notifai.sh',
      store: 'test store',
    })
    expect(test.out.join('\n')).not.toContain(SECRET)
    expect(readPendingPairing(test.deps.env, Date.now())).toBeNull()
  })

  it('is idempotent for the credential already stored', () => {
    const test = harness({
      stored: { machineId: 'mac_desktop', secret: SECRET, baseUrl: 'https://notifai.sh', machineName: 'Studio' },
    })
    expect(authAdoptCommand(test.deps, { stdin: true, json: true }, () => JSON.stringify(ADOPTED))).toBe(EXIT.ok)
    expect(JSON.parse(test.out.join('\n')).adopted).toBe(true)
  })

  it('never replaces a different signed-in machine', () => {
    const test = harness({ stored: EXISTING })
    const code = authAdoptCommand(test.deps, { stdin: true, json: true }, () => JSON.stringify(ADOPTED))
    expect(code).toBe(EXIT.failed)
    expect(test.stored()).toEqual(EXISTING)
    const result = JSON.parse(test.out.join('\n'))
    expect(result).toMatchObject({ adopted: false, machine_id: 'mac_existing', error: { code: 'already_signed_in' } })
    expect(result.error.message).toContain('notifai logout --revoke')
    expect(test.out.join('\n')).not.toContain(EXISTING.secret)
  })

  it('reads the secret from standard input only', () => {
    const test = harness()
    expect(authAdoptCommand(test.deps, { json: true }, () => JSON.stringify(ADOPTED))).toBe(EXIT.usage)
    expect(JSON.parse(test.out.join('\n')).error.code).toBe('input_required')
    expect(test.stored()).toBeNull()
  })

  it.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['a malformed machine id', JSON.stringify({ ...ADOPTED, machine_id: 'machine 1' })],
    ['a short secret', JSON.stringify({ ...ADOPTED, secret: 'short' })],
    ['a secret with spaces', JSON.stringify({ ...ADOPTED, secret: `${SECRET} x` })],
    ['no machine name', JSON.stringify({ ...ADOPTED, machine_name: ' ' })],
    ['a non-http origin', JSON.stringify({ ...ADOPTED, base_url: 'file:///etc/passwd' })],
    ['an origin with credentials', JSON.stringify({ ...ADOPTED, base_url: 'https://user:pw@notifai.sh' })],
  ])('refuses %s without echoing the input', (_label, input) => {
    const test = harness()
    expect(authAdoptCommand(test.deps, { stdin: true, json: true }, () => input)).toBe(EXIT.usage)
    expect(JSON.parse(test.out.join('\n'))).toMatchObject({ adopted: false, error: { code: 'invalid_credential' } })
    expect(test.out.join('\n')).not.toContain(SECRET)
    expect(test.stored()).toBeNull()
  })

  it('reports a store that refuses the write', () => {
    const test = harness()
    test.deps.store.save = () => {
      throw new Error('Secret Service credential save failed')
    }
    expect(authAdoptCommand(test.deps, { stdin: true }, () => JSON.stringify(ADOPTED))).toBe(EXIT.failed)
    expect(test.err.join('\n')).toContain('Secret Service credential save failed')
  })
})

describe('notifai auth status --json', () => {
  it('offers a pending approval without the private handshake values', () => {
    const test = harness()
    const pending = {
      pairing_id: 'pair_waiting',
      code: 'WAIT-0001',
      approve_url: 'https://app.notifai.sh/approve?code=WAIT-0001#confirmation_secret=shown-to-user',
      base_url: 'https://notifai.sh',
      machine_name: 'Studio',
      secret: 'credential-to-be',
      poll_verifier: 'verifier-private',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      poll_interval_seconds: 2,
    }
    writePendingPairing(test.deps.env, pending)
    expect(authStatusCommand(test.deps, { json: true })).toBe(EXIT.auth)
    const said = test.out.join('\n')
    expect(JSON.parse(said)).toEqual({
      signed_in: false,
      pending_approval: {
        code: 'WAIT-0001',
        approve_url: pending.approve_url,
        base_url: 'https://notifai.sh',
        machine_name: 'Studio',
        expires_at: pending.expires_at,
      },
    })
    expect(said).not.toContain('credential-to-be')
    expect(said).not.toContain('verifier-private')
  })

  it('offers nothing once the approval has expired', () => {
    const test = harness()
    writePendingPairing(test.deps.env, {
      pairing_id: 'pair_old',
      code: 'OLD-0001',
      approve_url: 'https://app.notifai.sh/approve?code=OLD-0001',
      base_url: 'https://notifai.sh',
      machine_name: 'Studio',
      secret: 's',
      poll_verifier: 'v',
      expires_at: new Date(Date.now() - 1_000).toISOString(),
      poll_interval_seconds: 2,
    })
    authStatusCommand(test.deps, { json: true })
    expect(JSON.parse(test.out.join('\n'))).toEqual({ signed_in: false })
  })
})

describe('notifai logout --revoke', () => {
  it('revokes this machine on the service, then removes the credential', async () => {
    const test = harness({ stored: EXISTING })
    expect(await logoutCommand(test.deps, { revoke: true })).toBe(EXIT.ok)
    expect(test.revokes()).toBe(1)
    expect(test.bearers).toEqual(['Bearer nfm_mac_existing.existing-secret'])
    expect(test.stored()).toBeNull()
    expect(test.out.join('\n')).toContain('revoked')
  })

  it('removes a credential the service already revoked or forgot', async () => {
    for (const error of [
      new ApiCallError(403, 'machine_revoked', 'This machine credential was revoked.', null, null),
      new ApiCallError(401, 'auth_required', 'Machine credential missing or unrecognized.', null, null),
    ]) {
      const test = harness({ stored: EXISTING, revoke: async () => Promise.reject(error) })
      expect(await logoutCommand(test.deps, { revoke: true })).toBe(EXIT.ok)
      expect(test.stored()).toBeNull()
    }
  })

  it('keeps the credential when the service cannot be reached', async () => {
    const test = harness({ stored: EXISTING, revoke: async () => Promise.reject(new NetworkError('offline')) })
    expect(await logoutCommand(test.deps, { revoke: true })).toBe(EXIT.network)
    expect(test.stored()).toEqual(EXISTING)
    expect(test.err.join('\n')).toContain('notifai logout --revoke')
  })

  it('has nothing to revoke when signed out', async () => {
    const test = harness()
    expect(await logoutCommand(test.deps, { revoke: true })).toBe(EXIT.ok)
    expect(test.revokes()).toBe(0)
  })

  it('without --revoke only removes the local credential and says how to revoke', async () => {
    const test = harness({ stored: EXISTING })
    expect(await logoutCommand(test.deps)).toBe(EXIT.ok)
    expect(test.revokes()).toBe(0)
    expect(test.stored()).toBeNull()
    expect(test.out.join('\n')).toContain('notifai logout --revoke')
  })
})
