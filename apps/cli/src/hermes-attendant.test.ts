import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { expect,it } from 'vitest'
import { HermesWriterBridge } from './hermes-attendant.js'
import { hermesPluginDir,hermesPluginSource,refreshHermesPlugin,retainedHermesPlugin } from './hermes-plugin.js'
import { hookAdapterPath } from './hook-adapter.js'

it('requires a current exact Hermes session and confirms one fenced injection', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const bridge = new HermesWriterBridge(input, output)
  input.write(`${JSON.stringify({ type: 'hello', session_id: 'session-a', cwd: '/tmp', pid: process.ppid })}\n`)
  input.write(`${JSON.stringify({ type: 'state', session_id: 'session-a', activity: 'working' })}\n`)
  expect((await bridge.hello())?.session_id).toBe('session-a')
  expect(bridge.probe('session-a')).toEqual({ state: 'running', activity: 'working' })

  let beginnings = 0
  const guard = { writable: () => true, remainingMs: () => 5_000 }
  const rejected = await bridge.write('session-b', 'wrong session', () => { beginnings += 1; return true }, guard)
  expect(rejected.status).toBe('unavailable')
  expect(beginnings).toBe(0)

  const outbound = new Promise<{ id: number; session_id: string; text: string; deadline_ms: number }>(resolve => {
    output.once('data', chunk => resolve(JSON.parse(String(chunk)) as { id: number; session_id: string; text: string; deadline_ms: number }))
  })
  const before = Date.now()
  const write = bridge.write('session-a', 'quoted note', () => { beginnings += 1; return true }, guard)
  const frame = await outbound
  expect(frame).toMatchObject({ session_id: 'session-a', text: 'quoted note' })
  expect(frame.deadline_ms).toBeGreaterThan(before)
  expect(frame.deadline_ms).toBeLessThanOrEqual(Date.now() + 5_000)
  input.write(`${JSON.stringify({ type: 'result', id: frame.id, accepted: true })}\n`)
  expect(await write).toMatchObject({ status: 'written', route: 'session-queue' })
  expect(beginnings).toBe(1)

  input.write(`${JSON.stringify({ type: 'state', session_id: 'session-b', activity: 'idle' })}\n`)
  expect(bridge.probe('session-a')).toEqual({ state: 'ended', reason: 'session-replaced' })
  bridge.close()
})

function installedPlugin() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-continuity-'))
  const env = { HOME: root, HERMES_HOME: path.join(root, 'hermes') }, directory = hermesPluginDir(env)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const module = path.join(directory, '__init__.py'), manifest = path.join(directory, 'plugin.yaml')
  writeFileSync(module, hermesPluginSource(hookAdapterPath(root), undefined, module), { mode: 0o600 })
  writeFileSync(manifest, 'name: notifai\n', { mode: 0o600 })
  return { root, env, directory, module, manifest }
}

it.skipIf(process.platform === 'win32')('rejects a different Hermes definition at initial native bridge admission', () => {
  const { root, env } = installedPlugin()
  try {
    refreshHermesPlugin('/different/command', env)
    expect(retainedHermesPlugin(root, env)()).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
