import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { opencodePluginSource } from './opencode-plugin.js'

/**
 * The generated OpenCode plugin, run as OpenCode runs it: imported as a module,
 * given a client, fed events. A stand-in adapter plays the CLI and records
 * every invocation and every frame the plugin sends it.
 */
type Hooks = {
  'experimental.chat.system.transform'(input: { sessionID?: string }, output: { system: string[] }): Promise<void>
  'chat.message'(input: { sessionID?: string }): Promise<void>
  event(input: { event: { type: string; properties: Record<string, unknown> } }): Promise<void>
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const ADAPTER_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs")
const event = process.argv[3]
const log = process.env.FAKE_LOG
fs.appendFileSync(log, JSON.stringify({ event }) + "\\n")
if (event === "session-start") { process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write("ACTIVATION TEXT"); }); return }
if (event !== "opencode-question") { process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); return }
let buffered = ""
let asked = false
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffered += chunk
  let newline
  while ((newline = buffered.indexOf("\\n")) >= 0) {
    const frame = JSON.parse(buffered.slice(0, newline))
    buffered = buffered.slice(newline + 1)
    fs.appendFileSync(log, JSON.stringify({ frame }) + "\\n")
    if (frame.type === "ask" && !asked) {
      asked = true
      process.stdout.write(JSON.stringify({ type: "registered", request_id: "req_1" }) + "\\n")
      if (process.env.FAKE_MODE === "device" || process.env.FAKE_MODE === "device-exit") {
        process.stdout.write(JSON.stringify({ type: "answer", request_id: "req_1", answers: [["Production"]],
          acknowledgement: "notifai acknowledge req_1 --text <text>" }) + "\\n")
      }
      if (process.env.FAKE_MODE === "device-exit") process.exit(0)
    } else if (frame.type !== "ask") {
      process.stdout.write(JSON.stringify({ type: "done", outcome: frame.type }) + "\\n")
    }
  }
})
process.stdin.on("end", () => { fs.appendFileSync(log, JSON.stringify({ closed: true }) + "\\n"); process.exit(0) })
`

const REQUEST = {
  id: 'que_1', sessionID: 'ses_parent',
  questions: [{ question: 'Where?', header: 'Target', options: [{ label: 'Staging', description: '' }, { label: 'Production', description: '' }] }],
}

async function load(mode: 'device' | 'device-exit' | 'wait', options: { questionApi?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode-plugin-'))
  roots.push(root)
  const adapter = path.join(root, 'adapter')
  writeFileSync(adapter, ADAPTER_SCRIPT)
  chmodSync(adapter, 0o755)
  const log = path.join(root, 'log.jsonl')
  writeFileSync(log, '')
  process.env['FAKE_LOG'] = log
  process.env['FAKE_MODE'] = mode
  const modulePath = path.join(root, 'plugin.mjs')
  writeFileSync(modulePath, opencodePluginSource({ adapterPath: adapter, timeoutSeconds: 10 }))
  const generated = await import(modulePath) as { NotifAIPlugin(input: object): Promise<Hooks> }
  const pending = [REQUEST]
  const replies: Array<{ requestID: string; answers: unknown }> = []
  const transport = {
    get: async ({ url }: { url: string }) => url === '/question' ? { data: pending, response: { ok: true } } : { error: 'not found' },
    post: async ({ url, path: params, body }: { url: string; path: { requestID: string }; body: { answers: unknown } }) => {
      if (url !== '/question/{requestID}/reply') return { error: 'not found' }
      replies.push({ requestID: params.requestID, answers: body.answers })
      pending.splice(0)
      return { data: true, response: { ok: true } }
    },
  }
  const plugin = await generated.NotifAIPlugin({
    directory: root,
    client: {
      ...(options.questionApi === false ? {} : { _client: transport }),
      session: { get: async ({ path: { id } }: { path: { id: string } }) => ({ data: id === 'ses_child' ? { id, parentID: 'ses_parent' } : { id } }) },
    },
  })
  const records = (): Array<{ event?: string; frame?: { type: string; answers?: unknown }; closed?: boolean }> =>
    readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { event?: string })
  const until = async (check: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 25))
    expect(check()).toBe(true)
  }
  return { plugin, records, until, replies, pending, root }
}

describe.skipIf(process.platform === 'win32')('the generated OpenCode plugin', () => {
  it('returns a device answer through OpenCode\'s own form and owes its acknowledgement once', async () => {
    const t = await load('device')
    await t.plugin.event({ event: { type: 'question.asked', properties: REQUEST } })
    await t.until(() => t.records().some(record => record.frame?.type === 'applied'))
    expect(t.replies).toEqual([{ requestID: 'que_1', answers: [['Production']] }])
    // OpenCode reports the reply this plugin made; that is not an OpenCode answer.
    await t.plugin.event({ event: { type: 'question.replied', properties: { sessionID: 'ses_parent', requestID: 'que_1', answers: [['Production']] } } })
    expect(t.records().filter(record => record.frame !== undefined).map(record => record.frame!.type)).toEqual(['ask', 'applied'])
    const first = { system: [] as string[] }
    await t.plugin['experimental.chat.system.transform']({ sessionID: 'ses_parent' }, first)
    expect(first.system.join('\n')).toContain('notifai acknowledge req_1 --text <text>')
    const second = { system: [] as string[] }
    await t.plugin['experimental.chat.system.transform']({ sessionID: 'ses_parent' }, second)
    expect(second.system.join('\n')).not.toContain('notifai acknowledge req_1')
  })

  it('survives a command that ends before the plugin writes to it', async () => {
    const t = await load('device-exit')
    await t.plugin.event({ event: { type: 'question.asked', properties: REQUEST } })
    await t.until(() => t.replies.length === 1)
    // The reply's own event and a late dismissal both target a pipe that is gone.
    await t.plugin.event({ event: { type: 'question.rejected', properties: { sessionID: 'ses_parent', requestID: 'que_1' } } })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(t.replies).toEqual([{ requestID: 'que_1', answers: [['Production']] }])
  })

  it('passes an answer given in OpenCode to the device question', async () => {
    const t = await load('wait')
    await t.plugin.event({ event: { type: 'question.asked', properties: REQUEST } })
    await t.until(() => t.records().some(record => record.frame?.type === 'ask'))
    await t.plugin.event({ event: { type: 'question.replied', properties: { sessionID: 'ses_parent', requestID: 'que_1', answers: [['Staging']] } } })
    await t.until(() => t.records().some(record => record.frame?.type === 'native'))
    expect(t.records().find(record => record.frame?.type === 'native')?.frame?.answers).toEqual([['Staging']])
    expect(t.replies).toEqual([])
  })

  it('passes a dismissal and closes the pipe when the session is deleted', async () => {
    const t = await load('wait')
    await t.plugin.event({ event: { type: 'question.asked', properties: REQUEST } })
    await t.until(() => t.records().some(record => record.frame?.type === 'ask'))
    await t.plugin.event({ event: { type: 'question.rejected', properties: { sessionID: 'ses_parent', requestID: 'que_1' } } })
    await t.until(() => t.records().some(record => record.frame?.type === 'dismissed'))

    const other = { ...REQUEST, id: 'que_2' }
    await t.plugin.event({ event: { type: 'question.asked', properties: other } })
    await t.until(() => t.records().filter(record => record.frame?.type === 'ask').length === 2)
    await t.plugin.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses_parent' } } } })
    await t.until(() => t.records().some(record => record.closed === true))
  })

  it('leaves a worker\'s form, and every form without OpenCode\'s question API, in OpenCode', async () => {
    const worker = await load('device')
    await worker.plugin.event({ event: { type: 'question.asked', properties: { ...REQUEST, sessionID: 'ses_child' } } })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(worker.records().some(record => record.event === 'opencode-question')).toBe(false)
    const legacy = await load('device', { questionApi: false })
    await legacy.plugin.event({ event: { type: 'question.asked', properties: REQUEST } })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(legacy.records().some(record => record.event === 'opencode-question')).toBe(false)
  })

  it('resolves activation once per User prompt, not once per model request', async () => {
    const t = await load('wait')
    for (let request = 0; request < 3; request += 1) {
      const output = { system: ['harness instructions'] }
      await t.plugin['experimental.chat.system.transform']({ sessionID: 'ses_parent' }, output)
      expect(output.system).toEqual(['harness instructions\n\nACTIVATION TEXT'])
    }
    expect(t.records().filter(record => record.event === 'session-start')).toHaveLength(1)
    await t.plugin['chat.message']({ sessionID: 'ses_parent' })
    await t.plugin['experimental.chat.system.transform']({ sessionID: 'ses_parent' }, { system: [] })
    expect(t.records().filter(record => record.event === 'session-start')).toHaveLength(2)
    expect(existsSync(t.root)).toBe(true)
  })
})
