import { mkdtempSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, it } from 'vitest'
import { authWaitCommand, loginCommand, logoutCommand, EXIT, type CommandDeps } from './commands.js'
import type { ReadinessState } from './readiness.js'
import { ApiCallError, NetworkError, type ApiClient } from './client.js'
import { readPendingPairing } from './pending-pairing.js'
import { pairingQrPath, pairingQrTextPath } from './pairing-qr.js'

function decodeTextQr(text: string): string | undefined {
  const rows = text.split('\n')
  const scale = 4
  const width = Math.max(...rows.map((row) => row.length)) * scale
  const height = rows.length * 2 * scale
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  for (const [y, row] of rows.entries()) for (const [x, glyph] of [...row].entries()) {
    expect([' ', '█', '▀', '▄']).toContain(glyph)
    for (let half = 0; half < 2; half += 1) {
      const black = glyph === '█' || glyph === (half === 0 ? '▀' : '▄')
      if (!black) continue
      for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) {
        const offset = ((y * 2 * scale + half * scale + dy) * width + x * scale + dx) * 4
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0
      }
    }
  }
  return jsQR(pixels, width, height)?.data
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function ceremony() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-pairing-approval-')); roots.push(root)
  const lines: string[] = []; const errors: string[] = []; const opened: string[] = []
  let saved = 0; let begins = 0; let status: 'pending' | 'approved' | 'denied' | 'expired' | 'unknown' | 'network' = 'pending'
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
  it('shows a decodable QR in noninteractive terminal output and exposes its protected text artifact to JSON setup', async () => {
    const test = ceremony()
    const gaps: ReadinessState[] = []
    expect(await loginCommand(test.deps, {}, (gap) => gaps.push(gap))).toBe(EXIT.auth)
    const pending = readPendingPairing(test.deps.env, 0)!
    const file = pairingQrTextPath(test.deps.env)
    const text = readFileSync(file, 'utf8')
    expect(test.lines).toContain(text)
    expect(text).not.toContain('\u001b')
    expect(decodeTextQr(text)).toBe(pending.approve_url)
    expect(gaps[0]?.technical?.pairing).toMatchObject({ qr_text_path: file })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(test.opened).toEqual([])
    expect(test.targeted).toEqual([])
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
    expect(existsSync(pairingQrTextPath(test.deps.env))).toBe(false)
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
    expect(existsSync(pairingQrTextPath(test.deps.env))).toBe(false)
  })
})

describe('foreground machine approval wait', () => {
  it('returns a structured handoff and waits without asking for a User reply or creating another invitation', async () => {
    const test = ceremony(); const gaps: ReadinessState[] = []
    await loginCommand(test.deps, {}, (gap) => gaps.push(gap))
    expect(gaps[0]?.technical?.handoff).toMatchObject({
      template_id: 'machine-approval-pending', next_action: 'display-qr-then-wait',
      wait_argv: ['notifai', 'auth', 'wait', '--pairing', 'pair_1', '--json'],
    })
    let sleeps = 0
    test.deps.sleep = async () => { sleeps += 1; test.setStatus('approved') }
    test.lines.length = 0
    expect(await authWaitCommand(test.deps, { pairing: 'pair_1', json: true })).toBe(EXIT.ok)
    expect(sleeps).toBe(1)
    expect(test.lines).toHaveLength(1)
    expect(JSON.parse(test.lines[0]!)).toMatchObject({ status: 'approved', next_action: 'resume-setup' })
    expect(test.begins()).toBe(1); expect(test.saved()).toBe(1)
    expect(test.opened).toEqual([]); expect(test.targeted).toEqual([])
  })
  it.each(['denied', 'expired', 'unknown'] as const)('stops on %s without replacing the invitation', async (status) => {
    const test = ceremony(); await loginCommand(test.deps, {})
    test.setStatus(status); test.lines.length = 0
    expect(await authWaitCommand(test.deps, { pairing: 'pair_1', json: true })).toBe(EXIT.auth)
    expect(JSON.parse(test.lines[0]!)).toMatchObject({ status: status === 'unknown' ? 'expired' : status, next_action: 'stop' })
    expect(test.begins()).toBe(1); expect(test.saved()).toBe(0)
    expect(readPendingPairing(test.deps.env, 0)).toBeNull()
  })
  it('refuses a different invitation and preserves the original', async () => {
    const test = ceremony(); await loginCommand(test.deps, {})
    expect(await authWaitCommand(test.deps, { pairing: 'pair_other', json: true })).toBe(EXIT.auth)
    expect(readPendingPairing(test.deps.env, 0)?.pairing_id).toBe('pair_1')
    expect(test.begins()).toBe(1)
  })
  it('never starts an invitation when nothing is pending', async () => {
    const test = ceremony()
    expect(await authWaitCommand(test.deps, { pairing: 'pair_1', json: true })).toBe(EXIT.auth)
    expect(test.begins()).toBe(0)
  })
  it('retries a transient network error and collects approval from the same invitation', async () => {
    const test = ceremony(); await loginCommand(test.deps, {})
    test.setStatus('network')
    test.deps.sleep = async () => { test.setStatus('approved') }
    expect(await authWaitCommand(test.deps, { pairing: 'pair_1', json: true })).toBe(EXIT.ok)
    expect(test.begins()).toBe(1); expect(test.saved()).toBe(1)
  })
  it('bounds an outage at the invitation deadline and preserves late approval recovery', async () => {
    const test = ceremony(); await loginCommand(test.deps, {})
    test.setStatus('network'); let now = 599_500
    test.deps.now = () => now
    test.deps.sleep = async (ms) => { now += ms }
    test.lines.length = 0
    expect(await authWaitCommand(test.deps, { pairing: 'pair_1', json: true })).toBe(EXIT.network)
    expect(now).toBe(600_000)
    expect(JSON.parse(test.lines[0]!)).toMatchObject({ status: 'unavailable', next_action: 'resume-same-wait' })
    expect(readPendingPairing(test.deps.env, now)?.pairing_id).toBe('pair_1')
    test.setStatus('approved'); now += 60_000
    expect(await authWaitCommand(test.deps, { pairing: 'pair_1', json: true })).toBe(EXIT.ok)
    expect(test.begins()).toBe(1); expect(test.saved()).toBe(1)
  })
  it('resumes the exact invitation after an interrupted foreground command', async () => {
    const test = ceremony(); await loginCommand(test.deps, {})
    test.deps.sleep = async () => { throw new Error('tool interrupted') }
    await expect(authWaitCommand(test.deps, { pairing: 'pair_1', json: true })).rejects.toThrow('tool interrupted')
    expect(readPendingPairing(test.deps.env, 0)?.pairing_id).toBe('pair_1')
    test.setStatus('approved')
    expect(await authWaitCommand(test.deps, { pairing: 'pair_1', json: true })).toBe(EXIT.ok)
    expect(test.begins()).toBe(1); expect(test.saved()).toBe(1)
  })
  it('does not switch services or delete a pending invitation on a different service', async () => {
    const test = ceremony(); await loginCommand(test.deps, {})
    test.deps.env['NOTIFAI_BASE_URL'] = 'https://different.example'
    expect(await authWaitCommand(test.deps, { pairing: 'pair_1', json: true })).toBe(EXIT.auth)
    expect(readPendingPairing(test.deps.env, 0)?.pairing_id).toBe('pair_1')
    expect(test.begins()).toBe(1); expect(test.saved()).toBe(0)
  })
})
