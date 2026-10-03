import { mkdtempSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, it } from 'vitest'
import { loginCommand, logoutCommand, EXIT, type CommandDeps } from './commands.js'
import { ApiCallError, NetworkError, type ApiClient } from './client.js'
import { readPendingPairing } from './pending-pairing.js'
import { pairingQrPath } from './pairing-qr.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function ceremony() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-pairing-approval-')); roots.push(root)
  const lines: string[] = []; const errors: string[] = []; const opened: string[] = []
  let saved = 0; let begins = 0; let status: 'pending' | 'approved' | 'expired' | 'unknown' | 'network' = 'pending'
  const targeted: { id: string; email: string; verifier: string }[] = []
  const client = {
    beginPairing: async () => { begins += 1; return { pairing_id: `pair_${begins}`, code: begins === 1 ? 'ABC-234' : 'DEF-567',
      approve_url: `https://app.notifai.sh/approve?code=${begins === 1 ? 'ABC-234' : 'DEF-567'}`,
      expires_at: new Date(600_000).toISOString(), poll_interval_seconds: 1 } },
    pollPairing: async (id: string) => {
      if (id === 'pair_1' && status === 'unknown') throw new ApiCallError(404, 'pairing_not_found', 'No such pairing')
      if (status === 'network') throw new NetworkError('Offline')
      return status === 'approved' ? { status, machine_id: 'mac_test' }
        : { status: id === 'pair_1' ? status : 'pending' }
    },
    requestPairingNotification: async (id: string, verifier: string, email: string) => {
      targeted.push({ id, verifier, email }); return { status: 'requested' }
    },
  } as unknown as ApiClient
  const deps: CommandDeps = {
    cwd: root, env: { XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') },
    now: () => 0, clientFactory: () => client,
    io: { out: (line) => lines.push(line), err: (line) => errors.push(line), confirm: async () => false,
      openUrl: (url) => opened.push(url) },
    store: { load: () => null, save: () => { saved += 1 }, clear: () => {}, describe: () => 'test store' },
  }
  return { deps, lines, errors, opened, targeted, setStatus: (next: typeof status) => { status = next },
    begins: () => begins, saved: () => saved }
}

describe('QR-first computer approval', () => {
  it('generates a real protected QR matching the trusted HTTPS approval link, without browser or notification side effects', async () => {
    const test = ceremony()
    expect(await loginCommand(test.deps, {})).toBe(EXIT.auth)
    const pending = readPendingPairing(test.deps.env, 0)!
    const file = pairingQrPath(test.deps.env)
    const png = PNG.sync.read(readFileSync(file))
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)
    expect(decoded?.data).toBe(pending.approve_url)
    expect(decoded?.data).not.toContain(pending.secret)
    expect(decoded?.data).not.toContain(pending.poll_verifier)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(test.opened).toEqual([]); expect(test.targeted).toEqual([])
    expect(test.lines.filter((line) => line.startsWith('Pairing code:'))).toEqual(['Pairing code: ABC-234'])
    expect(test.saved()).toBe(0)
  })
  it('choosing browser approval retains the pending pairing and explicitly opens its approval page', async () => {
    const test = ceremony(); await loginCommand(test.deps, {})
    const pending = readPendingPairing(test.deps.env, 0)!
    await loginCommand(test.deps, { approval: 'browser' })
    expect(test.begins()).toBe(1); expect(test.opened).toEqual([pending.approve_url])
    expect(test.targeted).toEqual([])
  })
  it('only the notification route asks for email and resuming setup does not resend', async () => {
    const test = ceremony(); await loginCommand(test.deps, {})
    const pair = readPendingPairing(test.deps.env, 0)!
    await loginCommand(test.deps, { approval: 'notification', approvalEmail: 'one@example.com' })
    await loginCommand(test.deps, { approval: 'notification', approvalEmail: 'one@example.com' })
    expect(test.targeted).toEqual([{ id: pair.pairing_id, verifier: pair.poll_verifier, email: 'one@example.com' }])
    await loginCommand(test.deps, { approvalEmail: 'two@example.com' })
    expect(test.targeted).toHaveLength(2); expect(test.targeted[1]?.email).toBe('two@example.com')
    expect(test.begins()).toBe(1); expect(test.opened).toEqual([])
  })
  it('an unattended notification route with missing email returns immediately and preserves its usable QR', async () => {
    const test = ceremony()
    expect(await loginCommand(test.deps, { approval: 'notification' })).toBe(EXIT.auth)
    expect(test.errors.join('\n')).toContain('--approval-email')
    expect(test.targeted).toEqual([]); expect(test.opened).toEqual([])
    expect(readPendingPairing(test.deps.env, 0)).not.toBeNull()
    expect(existsSync(pairingQrPath(test.deps.env))).toBe(true)
  })
  it.each(['expired', 'unknown'] as const)('replaces a %s saved pairing before announcing a code', async (status) => {
    const test = ceremony(); await loginCommand(test.deps, {})
    test.lines.length = 0; test.setStatus(status)
    expect(await loginCommand(test.deps, { approval: 'browser' })).toBe(EXIT.auth)
    expect(test.lines.filter((line) => line.startsWith('Pairing code:'))).toEqual(['Pairing code: DEF-567'])
    expect(test.opened).toHaveLength(1); expect(test.opened[0]).toContain('DEF-567')
  })
  it('recovering an approved pairing after expiry neither repeats review nor generates another Machine', async () => {
    const test = ceremony(); await loginCommand(test.deps, {})
    test.lines.length = 0; test.setStatus('approved'); test.deps.now = () => 700_000
    expect(await loginCommand(test.deps, {})).toBe(EXIT.ok)
    expect(test.begins()).toBe(1); expect(test.saved()).toBe(1)
    expect(test.lines.some((line) => line.startsWith('Pairing code:'))).toBe(false)
    expect(existsSync(pairingQrPath(test.deps.env))).toBe(false)
  })
  it('network failure keeps the same approval and names the real gap', async () => {
    const test = ceremony(); await loginCommand(test.deps, {})
    const before = readPendingPairing(test.deps.env, 0)!
    test.setStatus('network')
    expect(await loginCommand(test.deps, {})).toBe(EXIT.network)
    expect(readPendingPairing(test.deps.env, 0)?.pairing_id).toBe(before.pairing_id)
    expect(test.begins()).toBe(1)
    expect(test.saved()).toBe(0)
  })
  it('logout removes both the pending proof and protected QR artifact', async () => {
    const test = ceremony(); await loginCommand(test.deps, {})
    logoutCommand(test.deps)
    expect(readPendingPairing(test.deps.env, 0)).toBeNull()
    expect(existsSync(pairingQrPath(test.deps.env))).toBe(false)
  })
})
