import { spawnSync } from 'node:child_process'
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect,it } from 'vitest'
import { openclawPluginSource } from './openclaw-plugin.js'

function runModule(root: string, body: string): void {
  const file = path.join(root, 'plugin.mjs')
  // Exercise the actual generated module in Node; host calls are replaced in
  // its own scope so only the generation lifecycle is under test.
  writeFileSync(file, openclawPluginSource({ adapterPath: '/unused', timeoutSeconds: 5 }) + body)
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 30_000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
}

const HOST_DOUBLES = (root: string) => `
import assert from 'node:assert/strict'
const root = ${JSON.stringify(root)}
JOURNAL_DIR = path.join(root, 'notifai', 'continuation-journal')
MESSAGE_JOURNAL_DIR = path.join(root, 'notifai', 'message-journal')
const script = path.join(root, 'openclaw.mjs')
writeFileSync(script, 'host')
const sends = []
let releaseSend = null
let submission = 'absent'
runHook = async (event) => event === 'openclaw-generation' ? 'gen-1'
  : event === 'openclaw-list-pending' ? '[]' : null
verifiedGatewayTarget = async () => ({ script, port: 1, packageVersion: 'test' })
gatewaySessions = async () => new Map()
inspectSubmission = async () => submission
gatewayCall = async (target, method, params) => {
  if (method !== 'chat.send') return {}
  sends.push(params.idempotencyKey)
  await new Promise((resolve) => { releaseSend = resolve })
  return { ok: true }
}
const record = { delivery_id: 'd1', session_key: 'agent:main:main', cwd: root,
  generation: 'gen-1', openclaw_session_id: 's1', request_ids: ['req_one'], attempt: 1, phase: 'committed' }
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) {
  for (let i = 0; i < 200 && !check(); i += 1) await settle(10)
  assert.ok(check())
}
`

it('a retiring plugin generation finishes its admitted write before its successor takes the journal', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-openclaw-fence-'))
  try {
    runModule(root, HOST_DOUBLES(root) + `
saveJournal(record)
const oldGeneration = new AbortController()
const retiring = makeContinuationService({}, null, { lifecycle: { signal: oldGeneration.signal } })
retiring.start()
await until(() => releaseSend !== null)
assert.equal(existingJournal('d1').phase, 'submitting')
// OpenClaw awaits service stop before it registers the replacement.
let stopped = false
const stopping = retiring.stop().then(() => { stopped = true })
await settle(100)
assert.equal(stopped, false, 'stop must wait for the admitted submission')
releaseSend()
await stopping
assert.equal(existingJournal('d1').phase, 'admitted')
oldGeneration.abort()
// The successor reads the journal and reconciles by identity: no second send.
submission = 'pending'
releaseSend = null
const successor = makeContinuationService({}, null, { lifecycle: { signal: new AbortController().signal } })
successor.start()
await settle(300)
await successor.stop()
assert.deepEqual(sends, ['notifai-d1-a1'])
`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('a plugin replacement keeps the Gateway boot identity; a new Gateway process does not', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-openclaw-boot-'))
  try {
    const plugin = path.join(root, 'plugin.mjs')
    writeFileSync(plugin, openclawPluginSource({ adapterPath: '/unused', timeoutSeconds: 5 }) +
      '\nexport const bootId = GATEWAY_BOOT_ID\n')
    const probe = path.join(root, 'probe.mjs')
    // A replacement re-imports the module in the same process; the query
    // string forces a fresh module instance exactly as a reload does.
    writeFileSync(probe, `
const url = ${JSON.stringify(`file://${plugin}`)}
const first = await import(url + '?generation=1')
const second = await import(url + '?generation=2')
if (first.bootId !== second.bootId) throw new Error('boot identity changed across a plugin replacement')
process.stdout.write(first.bootId)
`)
    const run = () => spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 10_000 })
    const a = run(), b = run()
    expect(a.status, a.stderr).toBe(0)
    expect(b.status, b.stderr).toBe(0)
    expect(a.stdout).toMatch(/^[0-9a-f-]{36}$/)
    expect(a.stdout).not.toBe(b.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
