import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { openclawPluginSource } from './openclaw-plugin.js'

it('generated Gateway journal preserves corrupt replay fences and retries only outstanding messages', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-openclaw-journal-'))
  try {
    const file = path.join(root, 'plugin.mjs')
    // Exercise the actual generated module in Node, including its filesystem I/O.
    writeFileSync(file, openclawPluginSource({ adapterPath: '/unused', timeoutSeconds: 5 }) + `
import assert from 'node:assert/strict'
MESSAGE_JOURNAL_DIR = ${JSON.stringify(path.join(root, 'journal'))}
assert.deepEqual(retryMessageJournals(), [])
const first = { delivery_id: 'one', phase: 'prepared', text: 'private note', boot_id: GATEWAY_BOOT_ID }
saveMessageJournal(first)
assert.deepEqual(retryMessageJournals(), [first])
settleMessageJournal(first, 'transcript')
assert.deepEqual(retryMessageJournals(), [])
assert.equal(readMessageJournal('one').phase, 'transcript')
assert.equal(readMessageJournal('one').text, 'private note')
// Corrupt terminal records cannot disappear from a per-message lookup or be overwritten.
writeFileSync(messageJournalPath('one'), '{broken')
assert.throws(() => readMessageJournal('one'))
// Steady-state retries do not rescan terminal history.
assert.deepEqual(retryMessageJournals(), [])
pendingMessageJournals = null
assert.throws(() => retryMessageJournals())
assert.equal(pendingMessageJournals, null)
saveMessageJournal({ delivery_id: 'one', phase: 'transcript' })
saveMessageJournal({ delivery_id: 'two', phase: 'prepared', text: 'pending note', boot_id: GATEWAY_BOOT_ID })
assert.deepEqual(retryMessageJournals().map(record => record.delivery_id), ['two'])
settleMessageJournal(readMessageJournal('two'), 'unconfirmed')
assert.deepEqual(retryMessageJournals(), [])
assert.equal(readMessageJournal('two').text, undefined)
assert.equal(readMessageJournal('missing'), null)
`)
    const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 10_000 })
    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('adds private text only to the exact pointer prompt in its native generation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-openclaw-prompt-'))
  try {
    const adapter = path.join(root, 'adapter.cjs')
    const file = path.join(root, 'plugin.mjs')
    writeFileSync(adapter, `let input = ''; process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => { const event = process.argv[3];
  if (event === 'openclaw-generation') process.stdout.write('11111111-1111-4111-8111-111111111111');
});`)
    writeFileSync(file, openclawPluginSource({ adapterPath: adapter, timeoutSeconds: 5,
      platform: 'win32', nodePath: process.execPath }) + `
import assert from 'node:assert/strict'
const stateDir = ${JSON.stringify(root)}
const sessionKey = 'agent:main:main'
const generation = '11111111-1111-4111-8111-111111111111'
const messageId = 'sm_prompt'
const deliveryId = createHash('sha256').update(generation + '\\0' + messageId).digest('hex').slice(0, 32)
let nativeRevision = 'R1'
const handlers = new Map()
const api = { on(name, handler) { handlers.set(name, handler) },
  runtime: { state: { resolveStateDir: () => stateDir }, agent: { session: {
    getSessionEntry: () => ({ sessionId: 'same-id', lifecycleRevision: nativeRevision })
  } } } }
register(api)
assert.equal(MESSAGE_JOURNAL_DIR, path.join(stateDir, 'notifai', 'message-journal'))
mkdirSync(path.dirname(readinessPath()), { recursive: true })
writeFileSync(readinessPath(), JSON.stringify({ boot_id: GATEWAY_BOOT_ID }))
const base = { delivery_id: deliveryId, message_id: messageId, session_key: sessionKey,
  generation, native_revision: 'R1', openclaw_session_id: 'same-id', boot_id: GATEWAY_BOOT_ID,
  text: 'Private note from device', phase: 'admitted' }
saveMessageJournal(base)
const prompt = messagePointer(base)
const ctx = { sessionKey, sessionId: 'same-id' }
const hook = handlers.get('before_prompt_build')
assert.equal(!!(await hook({ prompt: 'unrelated turn' }, ctx))?.prependContext?.includes(base.text), false)
assert.equal(readMessageJournal(deliveryId).text, base.text)
nativeRevision = 'R2'
assert.equal(!!(await hook({ prompt }, ctx))?.prependContext?.includes(base.text), false)
assert.equal(readMessageJournal(deliveryId).text, base.text)
nativeRevision = 'R1'
assert.equal(!!(await hook({ prompt: prompt + ' altered' }, ctx))?.prependContext?.includes(base.text), false)
const result = await hook({ prompt }, ctx)
assert.equal(result?.prependContext?.includes(base.text), true)
assert.equal(readMessageJournal(deliveryId).text, undefined)
assert.equal(!!(await hook({ prompt }, ctx))?.prependContext?.includes(base.text), false)
const nextId = 'sm_restart'
const next = { ...base, delivery_id: createHash('sha256').update(generation + '\\0' + nextId)
  .digest('hex').slice(0, 32), message_id: nextId }
saveMessageJournal(next)
writeFileSync(readinessPath(), JSON.stringify({ boot_id: 'new-gateway-boot' }))
assert.equal((await messageContextForPointer(api, { prompt: messagePointer(next) }, ctx,
  sessionKey, nativeRevision)), null)
`)
    const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 30_000 })
    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
