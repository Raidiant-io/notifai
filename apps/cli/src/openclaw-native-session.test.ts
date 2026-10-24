import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { recordOpenclawNativeSession, openclawNativeSession } from './openclaw-native-session.js'
import { recordSessionStart } from './hook-session-state.js'
import { writeOpenclawGeneration } from './openclaw-generation.js'
import { sourceContextHarnessSession } from './commands-harness-context.js'
import { activeOpenclawGeneration } from './openclaw-session-access.js'
vi.mock('./process-ancestry.js', () => ({ processAncestry: () => [{ pid: 42, name: 'node' }] }))
vi.mock('./process-identity.js', async (original) => ({ ...await original<object>(), processStartTime: () => 'start', processIdentityLiveness: () => 'alive' }))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'notifai-native-owner-')); roots.push(home)
  const env = { HOME: home, XDG_STATE_HOME: home, CODEX_THREAD_ID: 'native-thread', NOTIFAI_HOOK_SOURCE_PID: '42' }
  recordSessionStart('agent:main:test', env, 'openclaw', home, undefined, undefined, 'generation')
  writeOpenclawGeneration('agent:main:test', env, { id: 'generation', sessionId: 'native-openclaw', startSeen: true,
    resetPending: false, recorded: true, activationPrinted: true, ended: false })
  return env
}
describe('OpenClaw native thread ownership', () => {
  it('binds send attribution and acknowledgement access to the same exact generation', () => {
    const env = setup()
    expect(recordOpenclawNativeSession(env, 'native-thread', 'agent:main:test', 'generation')).toBe(true)
    expect(sourceContextHarnessSession(env, '/', 0)).toEqual({ harness: 'openclaw', label: 'OpenClaw', sessionId: 'agent:main:test' })
    expect(activeOpenclawGeneration('agent:main:test', env)).toBe('generation')
    expect(activeOpenclawGeneration('agent:main:other', env)).toBeNull()
  })
  it('fences a reset instead of falling back to Codex attribution', () => {
    const env = setup()
    recordOpenclawNativeSession(env, 'native-thread', 'agent:main:test', 'old-generation')
    expect(openclawNativeSession(env)).toBeNull()
    expect(sourceContextHarnessSession(env, '/', 0)).toEqual({ harness: 'openclaw', label: 'OpenClaw' })
  })
  it('leaves an unrelated Codex thread independent', () => {
    const env = setup()
    recordOpenclawNativeSession(env, 'native-thread', 'agent:main:test', 'generation')
    expect(openclawNativeSession({ ...env, CODEX_THREAD_ID: 'other-thread' })).toBeUndefined()
  })
  it('refuses an unproven Gateway and path-like native IDs', () => {
    const env = setup()
    expect(recordOpenclawNativeSession({ ...env, NOTIFAI_HOOK_SOURCE_PID: '43' }, 'native-thread', 'agent:main:test', 'generation')).toBe(false)
    expect(recordOpenclawNativeSession(env, '../thread', 'agent:main:test', 'generation')).toBe(false)
  })
})

it('generated adapter waits for the matching run binding and never borrows another run', async () => {
  const { openclawPluginSource } = await import('./openclaw-plugin.js')
  const { writeFileSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const root = mkdtempSync(path.join(tmpdir(), 'notifai-native-event-')); roots.push(root)
  const file = path.join(root, 'plugin.mjs')
  writeFileSync(file, openclawPluginSource({ adapterPath: '/unused', timeoutSeconds: 5 }) + `
import assert from 'node:assert/strict'
let observe
const handlers = new Map(), calls = []
runHook = async (event, envelope) => { calls.push({ event, envelope }); return '' }
register({ on: (name, handler) => handlers.set(name, handler), runtime: { events: {
  onAgentEvent: (handler) => { observe = handler }
} } })
const callback = handlers.get('before_tool_call')
observe({ stream: 'codex_app_server.lifecycle', data: { phase: 'thread_ready', threadId: 'thread-A' }, runId: 'A', sessionKey: 'session-A' })
observe({ stream: 'codex_app_server.lifecycle', data: { phase: 'thread_ready', threadId: 'thread-B' }, runId: 'B', sessionKey: 'session-B' })
await callback({}, { runId: 'A', sessionKey: 'session-B', sessionId: 'native-B' })
assert.equal(calls.length, 0)
await callback({}, { runId: 'A', sessionKey: 'session-A', sessionId: 'native-A' })
assert.equal(calls.length, 1)
assert.equal(calls[0].event, 'openclaw-native-session')
assert.equal(calls[0].envelope.openclaw_native_thread_id, 'thread-A')
assert.equal(calls[0].envelope.session_id, 'session-A')
observe({ stream: 'lifecycle', data: { phase: 'end' }, runId: 'A' })
await callback({}, { runId: 'A', sessionKey: 'session-A', sessionId: 'native-A' })
assert.equal(calls.length, 1)
`)
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 10000 })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
})
