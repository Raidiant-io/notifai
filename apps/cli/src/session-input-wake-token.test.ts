import { mkdtempSync,rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { beginSessionIncarnation,lifecycleStamp,readSessionState } from './hook-session-state.js'
import { currentProcessIdentity } from './process-identity.js'
import {
inputWakeToken,
observeSessionInputWake,
sessionInputWake,
wakeSessionInputs
} from './session-inputs.js'

const SESSION = 'claude-wake-token'
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-wake-token-'))
  roots.push(root)
  const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
  beginSessionIncarnation(SESSION, env, { stamp: lifecycleStamp(), harnessProcess: currentProcessIdentity()! })
  const sent: string[] = []
  let now = 1_000_000
  const wake = (options: { replaceLost?: () => boolean } = {}) =>
    wakeSessionInputs(SESSION, env, async (text) => { sent.push(text); return 'written' as const }, undefined,
      { unique: true, now: () => now, ...options })
  return { env, sent, wake, advance: (ms: number) => { now += ms }, clock: () => now }
}

describe('Claude input wakes', () => {
  it('gives two successive wakes different text, so the second is never an identical repeat', async () => {
    const h = setup()
    await h.wake()
    observeSessionInputWake(SESSION, h.env, h.sent[0])
    await h.wake()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]).not.toBe(h.sent[1])
    expect(inputWakeToken(h.sent[0])).not.toBeNull()
    expect(inputWakeToken(h.sent[1])).not.toBeNull()
    expect(h.sent[0]).toContain('`notifai receive`')
  })

  it.each(['ENOSPC', 'daemon start failed', 'socket closed'])('retains a %s wake failure and retries with bounded backoff', async (message) => {
    const h = setup()
    let attempts = 0
    let failing = true
    const wake = () => wakeSessionInputs(SESSION, h.env, async () => {
      attempts += 1
      if (failing) throw new Error(message)
      return 'written'
    }, undefined, { now: h.clock })
    await expect(wake()).resolves.toBeUndefined()
    expect(readSessionState(SESSION, h.env).input_wake_fault).toMatchObject({ attempts: 1, kind: 'transport' })
    expect(readSessionState(SESSION, h.env).input_wake).toBeUndefined()
    await wake()
    expect(attempts).toBe(1)
    h.advance(5_000)
    await wake()
    expect(attempts).toBe(2)
    h.advance(5_000)
    await wake()
    expect(attempts).toBe(2)
    failing = false
    h.advance(5_000)
    await wake()
    expect(attempts).toBe(3)
    expect(readSessionState(SESSION, h.env).input_wake).toMatchObject({ queued: true })
    // Queue acceptance alone does not clear the fault: presentation does.
    expect(readSessionState(SESSION, h.env).input_wake_fault?.recovered_at).toBeUndefined()
    observeSessionInputWake(SESSION, h.env, sessionInputWake(), h.clock())
    expect(readSessionState(SESSION, h.env).input_wake_fault?.recovered_at).toBe(h.clock())
  })

})
