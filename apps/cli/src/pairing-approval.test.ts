import { mkdtempSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, it } from 'vitest'
import { loginCommand, logoutCommand, EXIT, type CommandDeps } from './commands.js'
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
  return { deps, client, lines, errors, opened, targeted, setStatus: (next: typeof status) => { status = next },
    begins: () => begins, saved: () => saved }
}

/** Settles, or fails the test instead of hanging the run. */
async function settlesWithin<T>(work: Promise<T>, milliseconds = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${milliseconds} ms`)), milliseconds)
  })
  try { return await Promise.race([work, hung]) } finally { clearTimeout(timer) }
}

/** A clock that moves only when the command sleeps, yielding to timers so a hang stays observable. */
function fakeClock(deps: CommandDeps) {
  let clock = 0
  deps.now = () => clock
  deps.sleep = (milliseconds) => { clock += milliseconds; return new Promise((resolve) => setImmediate(resolve)) }
  return { now: () => clock }
}

/**
 * A person at a real terminal who scans the QR and never touches the keyboard:
 * an unanswered prompt stays open until something dismisses it, exactly like
 * the terminal prompt library.
 */
function humanAtTerminal(deps: CommandDeps, answers: { select?: string; text?: string } = {}) {
  const asked: string[] = []
  let dismissed = 0
  const ask = (message: string, answer: string | undefined, signal?: AbortSignal) => {
    asked.push(message)
    if (answer !== undefined) return Promise.resolve(answer)
    return new Promise<string | null>((resolve) => {
      signal?.addEventListener('abort', () => { dismissed += 1; resolve(null) }, { once: true })
    })
  }
  const spinner = { message: () => {}, stop: () => {}, error: () => {} }
  deps.io = {
    ...deps.io,
    interactive: true,
    select: (message, _options, signal) => ask(message, answers.select, signal),
    text: (message, signal) => ask(message, answers.text, signal),
    note: async () => {},
    outro: async () => {},
    spinner: async () => spinner,
  }
  return { asked, get dismissed() { return dismissed } }
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
  it('ends the wait the moment approval lands while the route choice is still open', async () => {
    const test = ceremony()
    fakeClock(test.deps)
    let polls = 0
    test.deps.clientFactory = () => ({
      ...test.client,
      pollPairing: async () => (++polls >= 2 ? { status: 'approved', machine_id: 'mac_test' } : { status: 'pending' }),
    }) as unknown as ApiClient
    const prompts = humanAtTerminal(test.deps)
    expect(await settlesWithin(loginCommand(test.deps, {}))).toBe(EXIT.ok)
    expect(prompts.asked).toEqual(['Connect this computer'])
    expect(prompts.dismissed).toBe(1)
    expect(test.saved()).toBe(1)
    expect(readPendingPairing(test.deps.env, 0)).toBeNull()
  })
  it('ends the wait when approval lands while the Account email is being asked for', async () => {
    const test = ceremony()
    fakeClock(test.deps)
    let polls = 0
    test.deps.clientFactory = () => ({
      ...test.client,
      pollPairing: async () => (++polls >= 2 ? { status: 'approved', machine_id: 'mac_test' } : { status: 'pending' }),
    }) as unknown as ApiClient
    const prompts = humanAtTerminal(test.deps, { select: 'notification' })
    expect(await settlesWithin(loginCommand(test.deps, {}))).toBe(EXIT.ok)
    expect(prompts.asked).toEqual(['Connect this computer', 'Account email'])
    expect(test.targeted).toEqual([])
    expect(test.saved()).toBe(1)
  })
  it('an unanswered route choice cannot outlive the approval', async () => {
    const test = ceremony()
    const clock = fakeClock(test.deps)
    test.deps.clientFactory = () => ({
      ...test.client,
      pollPairing: async () => ({ status: clock.now() >= 600_000 ? 'expired' : 'pending' }),
    }) as unknown as ApiClient
    humanAtTerminal(test.deps)
    expect(await settlesWithin(loginCommand(test.deps, {}))).toBe(EXIT.auth)
    expect(test.errors.join('\n')).toContain('expired')
    expect(test.saved()).toBe(0)
  })
  it.each(['denied', 'no_active_plan'] as const)('dismisses an unanswered prompt when approval ends with %s', async (status) => {
    const test = ceremony()
    fakeClock(test.deps)
    let polls = 0
    test.deps.clientFactory = () => ({
      ...test.client,
      pollPairing: async () => (++polls >= 2 ? { status } : { status: 'pending' }),
    }) as unknown as ApiClient
    const prompts = humanAtTerminal(test.deps)
    const gaps: ReadinessState[] = []
    expect(await settlesWithin(loginCommand(test.deps, {}, (gap) => gaps.push(gap)))).toBe(EXIT.auth)
    expect(prompts.dismissed).toBe(1)
    expect(test.saved()).toBe(0)
    expect(readPendingPairing(test.deps.env, 0)).toBeNull()
    expect(gaps.at(-1)?.id).toBe(status === 'denied' ? 'credential' : 'auth')
  })
  it('dismisses an unanswered prompt after a persistent network failure and preserves the approval', async () => {
    const test = ceremony()
    const clock = fakeClock(test.deps)
    let polls = 0
    test.deps.clientFactory = () => ({
      ...test.client,
      pollPairing: async () => {
        if (++polls === 1) return { status: 'pending' }
        throw new NetworkError('Offline')
      },
    }) as unknown as ApiClient
    const prompts = humanAtTerminal(test.deps)
    expect(await settlesWithin(loginCommand(test.deps, {}))).toBe(EXIT.network)
    expect(prompts.dismissed).toBe(1)
    expect(clock.now()).toBe(600_000)
    expect(test.errors.join('\n')).toContain('notifai init')
    expect(readPendingPairing(test.deps.env, 0)?.pairing_id).toBe('pair_1')
    // Approval may have succeeded while its response was unreachable.
    test.setStatus('approved')
    test.deps.clientFactory = () => test.client
    expect(await settlesWithin(loginCommand(test.deps, {}))).toBe(EXIT.ok)
    expect(test.begins()).toBe(1)
    expect(test.saved()).toBe(1)
  })
  it('a connection that never returns ends the wait at the approval deadline and keeps the approval resumable', async () => {
    const test = ceremony()
    fakeClock(test.deps)
    let polls = 0
    test.deps.clientFactory = () => ({
      ...test.client,
      pollPairing: async () => {
        polls += 1
        if (polls === 1) return { status: 'pending' }
        if (polls > 5_000) throw new ApiCallError(400, 'test_runaway', 'the wait never ended')
        throw new NetworkError('Offline')
      },
    }) as unknown as ApiClient
    humanAtTerminal(test.deps, { select: 'qr' })
    const gaps: ReadinessState[] = []
    expect(await settlesWithin(loginCommand(test.deps, {}, (gap) => gaps.push(gap)))).toBe(EXIT.network)
    expect(test.errors.join('\n')).toMatch(/notifai init/)
    expect(gaps.at(-1)?.technical?.pairing_outcome).toBe('pending')
    expect(readPendingPairing(test.deps.env, 0)?.pairing_id).toBe('pair_1')
  })
  it('a skewed clock cannot stretch an unreachable wait past the approval lifetime', async () => {
    const test = ceremony()
    fakeClock(test.deps)
    let polls = 0
    test.deps.clientFactory = () => ({
      ...test.client,
      // The service's clock is a day ahead of this computer's.
      beginPairing: async () => ({ pairing_id: 'pair_1', code: 'ABC-234', approve_url: 'https://app.notifai.sh/approve?code=ABC-234',
        expires_at: new Date(86_400_000 + 600_000).toISOString(), poll_interval_seconds: 3 }),
      pollPairing: async () => {
        polls += 1
        if (polls === 1) return { status: 'pending' }
        if (polls > 5_000) throw new ApiCallError(400, 'test_runaway', 'the wait never ended')
        throw new NetworkError('Offline')
      },
    }) as unknown as ApiClient
    humanAtTerminal(test.deps, { select: 'qr' })
    expect(await settlesWithin(loginCommand(test.deps, {}))).toBe(EXIT.network)
    expect(polls).toBeLessThan(1_000)
  })
  it('rides out a temporary service failure and collects the approval', async () => {
    const test = ceremony()
    fakeClock(test.deps)
    let polls = 0
    test.deps.clientFactory = () => ({
      ...test.client,
      pollPairing: async () => {
        polls += 1
        if (polls === 1) return { status: 'pending' }
        if (polls === 2) throw new ApiCallError(503, 'internal_error', 'Request failed with status 503')
        if (polls === 3) throw new ApiCallError(429, 'rate_limited', 'Polling too fast')
        return { status: 'approved', machine_id: 'mac_test' }
      },
    }) as unknown as ApiClient
    humanAtTerminal(test.deps, { select: 'qr' })
    expect(await settlesWithin(loginCommand(test.deps, {}))).toBe(EXIT.ok)
    expect(test.saved()).toBe(1)
  })
  it('logout removes both the pending proof and protected QR artifact', async () => {
    const test = ceremony(); await loginCommand(test.deps, {})
    await logoutCommand(test.deps)
    expect(readPendingPairing(test.deps.env, 0)).toBeNull()
    expect(existsSync(pairingQrPath(test.deps.env))).toBe(false)
    expect(existsSync(pairingQrTextPath(test.deps.env))).toBe(false)
  })
})
