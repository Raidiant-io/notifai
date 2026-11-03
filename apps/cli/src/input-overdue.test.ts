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
  const check = (now: number, options: { busy?: boolean; messages?: number; client?: ApiClient | null; boundary?: boolean } = {}) =>
    checkInputOverdue({ sessionId: SESSION, env, cwd: root, harness: 'codex', lease: null, busy: options.busy ?? false, boundary: options.boundary,
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

// A Claude Code session sat working (a background shell, a long turn) for eleven
// minutes with an answer waiting. The moment it came free it took the answer, in
// the same second the User was told the answer had not reached it.
it('starts the shorter bound only once the session is free, so a session coming free is never called stuck', async () => {
  const h = setup()
  const busy = (now: number) => h.check(now, { busy: true })
  walk(busy, 0, 11 * 60_000)
  h.check(11 * 60_000 + 15_000)
  await h.settled()
  expect(h.submit).not.toHaveBeenCalled()
  walk(h.check, 11 * 60_000 + 15_000, 11 * 60_000 + 15_000 + INPUT_OVERDUE_MS - 1)
  await h.settled()
  expect(h.submit).not.toHaveBeenCalled()
  h.check(11 * 60_000 + 15_000 + INPUT_OVERDUE_MS)
  await h.settled()
  expect(h.submit).toHaveBeenCalledTimes(1)
})

it('still tells the User when a working session keeps input past the working bound', async () => {
  const h = setup()
  walk(h.check, 0, INPUT_OVERDUE_MS - 60_000)
  walk((now) => h.check(now, { busy: true }), INPUT_OVERDUE_MS - 30_000, INPUT_OVERDUE_BUSY_MS - 1)
  await h.settled()
  expect(h.submit).not.toHaveBeenCalled()
  h.check(INPUT_OVERDUE_BUSY_MS, { busy: true })
  await h.settled()
  expect(h.submit).toHaveBeenCalledTimes(1)
})

it('tells nothing at a hook boundary, which hands input in, and tells at the next check if it stayed behind', async () => {
  const h = setup()
  walk(h.check, 0, INPUT_OVERDUE_MS - 1)
  h.check(INPUT_OVERDUE_MS, { boundary: true })
  await h.settled()
  expect(h.submit).not.toHaveBeenCalled()
  h.check(INPUT_OVERDUE_MS + 1_000)
  await h.settled()
  expect(h.submit).toHaveBeenCalledTimes(1)
})

it('takes the notice down on every device once the input is no longer waiting, once', async () => {
  const h = setup()
  walk(h.check, 0, INPUT_OVERDUE_MS)
  await h.settled()
  expect(h.submit).toHaveBeenCalledTimes(1)
  const told = (h.submit.mock.calls[0] as unknown as [{ draft: { delivery: { collapse_key: string } } }])[0].draft
  expect(readSessionState(SESSION, h.env).input_overdue_notice?.request_id).toBe('req_x')
  h.submit.mockRejectedValueOnce(new Error('offline'))
  h.check(INPUT_OVERDUE_MS + 1_000, { messages: 0 })
  await h.settled()
  expect(readSessionState(SESSION, h.env).input_overdue_notice).toBeDefined()
  h.check(INPUT_OVERDUE_MS + 2_000, { messages: 0 })
  await h.settled()
  expect(h.submit).toHaveBeenCalledTimes(3)
  const calls = h.submit.mock.calls as unknown as Array<[{ idempotency_key: string; draft: { lifecycle?: unknown; delivery: { collapse_key: string } } }]>
  const retirement = calls[2]![0]
  expect(retirement.draft.lifecycle).toEqual({ tier: 'done', retires_request_id: 'req_x' })
  expect(retirement.draft.delivery.collapse_key).toBe(told.delivery.collapse_key)
  expect(retirement.idempotency_key).toBe(calls[1]![0].idempotency_key)
  expect(readSessionState(SESSION, h.env).input_overdue_notice).toBeUndefined()
  walk((now) => h.check(now, { messages: 0 }), INPUT_OVERDUE_MS + 3_000, INPUT_OVERDUE_MS + 120_000)
  await h.settled()
  expect(h.submit).toHaveBeenCalledTimes(3)
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
