import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from './client.js'
import { readSessionState, writeSessionState } from './hook-session-state.js'
import { checkInputOverdue, INPUT_OVERDUE_BUSY_MS, INPUT_OVERDUE_MS, inputOverdueSummary } from './input-overdue.js'
import { bootstrapLogger } from './logging.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const SESSION = '019ff69d-a07f-7161-ab6e-bd06b3b93c8e'

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-overdue-'))
  roots.push(root)
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') }
  mkdirSync(env.HOME, { recursive: true })
  writeSessionState(SESSION, env, { harness: 'codex' })
  const submit = vi.fn(async () => ({ request_id: 'req_x' }))
  const client = { submit } as unknown as ApiClient
  const logger = bootstrapLogger({ env })
  const check = (now: number, options: { busy?: boolean; messages?: number; client?: ApiClient | null } = {}) =>
    checkInputOverdue({ sessionId: SESSION, env, cwd: root, harness: 'codex', lease: null, busy: options.busy ?? false,
      serviceMessages: options.messages ?? 1, reason: () => 'test', now,
      client: options.client === undefined ? client : options.client, logger })
  const settled = () => new Promise(resolve => setTimeout(resolve, 20))
  return { env, submit, check, settled, root }
}

/** Check every 30 s from `from` to `to`, as a watching loop does. */
const walk = (check: (now: number) => void, from: number, to: number): void => {
  for (let now = from; now < to; now += 30_000) check(now)
  check(to)
}

it('tells the User once, in plain words, when a note waits too long', async () => {
  const h = setup()
  walk(h.check, 1_000, 1_000 + INPUT_OVERDUE_MS - 1)
  await h.settled()
  expect(h.submit).not.toHaveBeenCalled()
  h.check(1_000 + INPUT_OVERDUE_MS)
  await h.settled()
  expect(h.submit).toHaveBeenCalledTimes(1)
  const submission = h.submit.mock.calls[0] as unknown as [{ draft: { presentation: { summary: string }; kind: string; source: { session_id: string } } }]
  expect(submission[0].draft.presentation.summary).toBe("Your note hasn't reached the agent yet. Type anything in its session to deliver it.")
  expect(submission[0].draft.kind).toBe('blocked')
  expect(submission[0].draft.source.session_id).toBe(SESSION)
  expect(readSessionState(SESSION, h.env).input_wake_fault?.kind).toBe('overdue')
  walk(h.check, 1_000 + INPUT_OVERDUE_MS, 1_000 + 3 * INPUT_OVERDUE_MS)
  await h.settled()
  expect(h.submit).toHaveBeenCalledTimes(1)
})

it('gives a working session longer, and starts over once nothing waits', async () => {
  const h = setup()
  const busy = (now: number) => h.check(now, { busy: true })
  walk(busy, 0, INPUT_OVERDUE_MS)
  await h.settled()
  expect(h.submit).not.toHaveBeenCalled()
  h.check(INPUT_OVERDUE_MS + 1, { busy: true, messages: 0 })
  expect(readSessionState(SESSION, h.env).input_waiting).toBeUndefined()
  walk(busy, INPUT_OVERDUE_MS + 2, INPUT_OVERDUE_MS + 2 + INPUT_OVERDUE_BUSY_MS)
  await h.settled()
  expect(h.submit).toHaveBeenCalledTimes(1)
})

it('does not count time the machine slept', async () => {
  const h = setup()
  h.check(0)
  h.check(30_000)
  // Hours asleep: the first check after waking must not call input overdue.
  h.check(30_000 + 3 * 60 * 60_000)
  await h.settled()
  expect(h.submit).not.toHaveBeenCalled()
  walk(h.check, 30_000 + 3 * 60 * 60_000, 30_000 + 3 * 60 * 60_000 + INPUT_OVERDUE_MS)
  await h.settled()
  expect(h.submit).toHaveBeenCalledTimes(1)
})

it('tries again after a failed send, under the same key, and stays quiet with no service', async () => {
  const h = setup()
  walk((now) => h.check(now, { client: null }), 0, INPUT_OVERDUE_MS)
  await h.settled()
  expect(readSessionState(SESSION, h.env).input_waiting?.notified_at).toBeUndefined()
  h.submit.mockRejectedValueOnce(new Error('offline'))
  h.check(INPUT_OVERDUE_MS + 1)
  await h.settled()
  h.check(INPUT_OVERDUE_MS + 2)
  await h.settled()
  expect(h.submit).toHaveBeenCalledTimes(2)
  const keys = (h.submit.mock.calls as unknown as Array<[{ idempotency_key: string }]>).map(call => call[0].idempotency_key)
  expect(keys[0]).toBe(keys[1])
})

it('names what is waiting', () => {
  expect(inputOverdueSummary({ answers: 1, messages: 0 })).toBe("Your answer hasn't reached the agent yet. Type anything in its session to deliver it.")
  expect(inputOverdueSummary({ answers: 2, messages: 0 })).toBe("Your answers haven't reached the agent yet. Type anything in its session to deliver them.")
  expect(inputOverdueSummary({ answers: 0, messages: 2 })).toBe("Your notes haven't reached the agent yet. Type anything in its session to deliver them.")
  expect(inputOverdueSummary({ answers: 1, messages: 1 })).toBe("Your answer and note haven't reached the agent yet. Type anything in its session to deliver them.")
})
