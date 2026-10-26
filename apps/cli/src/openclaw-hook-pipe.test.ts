import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { openclawPluginSource } from './openclaw-plugin.js'

it('survives an asynchronous stdin EPIPE from an early-exiting hook child', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-openclaw-pipe-'))
  try {
    const plugin = path.join(root, 'plugin.mjs')
    writeFileSync(plugin, openclawPluginSource({ adapterPath: '/unused', timeoutSeconds: 1 }))
    const run = path.join(root, 'run.mjs')
    writeFileSync(run, `
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
cp.spawn = () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new Writable({ write(_chunk, _encoding, done) {
    setImmediate(() => done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
  } })
  child.kill = () => {}
  return child
}
syncBuiltinESMExports()
const { default: plugin } = await import('./plugin.mjs')
const handlers = new Map()
plugin.register({ on: (event, handler) => handlers.set(event, handler) })
await handlers.get('session_start')({ sessionKey: 'agent:main:test', sessionId: 'test' }, { workspaceDir: ${JSON.stringify(root)} })
console.log('host continued')
`)
    const result = spawnSync(process.execPath, [run], { encoding: 'utf8', timeout: 5000 })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('host continued')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
