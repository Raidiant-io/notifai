import { beforeEach, expect, it, vi } from 'vitest'
import type { CommandDeps } from './commands-core.js'
import type { SessionAttendantOptions } from './session-attendant.js'
import type { MessageHandOffDeps } from './session-message-handoff.js'
import type { Logger } from './logging.js'
import { attendCursorStop } from './cursor-attendant.js'
const state = vi.hoisted(() => ({ notified: true, promptAt: 1, options: null as SessionAttendantOptions | null, delivery: null as MessageHandOffDeps | null }))
vi.mock('./commands-core.js', () => ({ makeClient: () => ({}) }))
vi.mock('./install-hooks.js', () => ({ loadCursorSettings: () => ({ hooks: { stop: [{ timeout: 3600, loop_limit: null }] } }), findInstallations: () => [{ harness: 'cursor', handlers: [{ event: 'stop', handlerIndex: 0 }] }] }))
vi.mock('./hook-session-state.js', () => ({
  readSessionState: () => ({ last_prompt_at: state.promptAt }),
  readSessionIncarnation: () => ({ incarnation: 'incarnation' }), sessionHasEnded: () => false,
  sessionNotified: () => state.notified, rotateSessionIncarnation: () => null,
}))
vi.mock('./hook-question-lock.js', () => ({ acquireClaimFile: () => 'claim', readClaimFile: () => ({ token: 'claim' }), releaseClaimFile: vi.fn() }))
vi.mock('./session-attendant-state.js', () => ({ attendantClaimPath: () => '/claim', writeAttendantStatus: vi.fn() }))
vi.mock('./process-identity.js', () => ({ currentProcessIdentity: () => ({ pid: 1, start: 'self' }), processStartTime: () => 'host', processIdentityLiveness: () => 'alive' }))
vi.mock('./session-attendant.js', () => ({ runSessionAttendant: async (options: SessionAttendantOptions) => {
  state.options = options
  await options.onMessages!([], { mayWrite: () => true, generation: () => 1, incarnation: () => 'incarnation' })
} }))
vi.mock('./session-message-handoff.js', () => ({ handOffSessionMessages: async (_messages: unknown, _attendant: unknown, deps: MessageHandOffDeps) => { state.delivery = deps; return 'done' } }))
beforeEach(() => { state.notified = true; state.promptAt = 1; state.options = null; state.delivery = null })
function deps() {
  return { env: { NOTIFAI_HOOK_SOURCE_PID: '2' }, io: { out: vi.fn() }, store: { load: () => ({ baseUrl: 'https://example.test', machineId: 'test', secret: 'test' }) } } as unknown as CommandDeps
}
it.each(['aborted', 'error', undefined])('never attends a %s Stop', async (status) => {
  await attendCursorStop(deps(), { session_id: 'conversation', ...(status ? { status } : {}) }, {} as Logger, Date.now() + 60000)
  expect(state.options).toBeNull()
})
it('does not announce conversations that never notified', async () => {
  state.notified = false
  await attendCursorStop(deps(), { session_id: 'conversation', status: 'completed' }, {} as Logger, Date.now() + 60000)
  expect(state.options).toBeNull()
})
it('writes exactly one native follow-up only under the delivery guard', async () => {
  const d = deps()
  await attendCursorStop(d, { session_id: 'conversation', status: 'completed' }, {} as Logger, Date.now() + 60000)
  expect(state.options?.probe()).toEqual({ state: 'running', activity: 'idle' })
  const begin = vi.fn(() => true)
  const message = {} as Parameters<MessageHandOffDeps['write']>[4]
  expect(await state.delivery!.write('note', begin, { writable: () => false, remainingMs: () => 1000 }, () => {}, message)).toMatchObject({ status: 'aborted' })
  expect(begin).not.toHaveBeenCalled()
  expect(await state.delivery!.write('note', begin, { writable: () => true, remainingMs: () => 1000 }, () => {}, message)).toMatchObject({ status: 'written' })
  expect(d.io.out).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ followup_message: 'note' }))
  expect(state.options?.gates()).toEqual({ ok: false, reason: 'cursor-stop-closed' })
  expect(await state.delivery!.write('duplicate', begin, { writable: () => true, remainingMs: () => 1000 }, () => {}, message)).toMatchObject({ status: 'aborted' })
})

it('withdraws its writer when a new user prompt supersedes the held Stop', async () => {
  await attendCursorStop(deps(), { session_id: 'conversation', status: 'completed' }, {} as Logger, Date.now() + 60000)
  expect(state.options?.gates()).toEqual({ ok: true })
  state.promptAt = 2
  expect(state.options?.gates()).toEqual({ ok: false, reason: 'cursor-stop-closed' })
})
