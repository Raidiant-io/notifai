import { chmodSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
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
  'shell.env'(input: { sessionID?: string }, output: { env: Record<string, string> }): Promise<void>
  'tool.definition'(input: { toolID: string }, output: { description: string; parameters: unknown; jsonSchema?: unknown }): Promise<void>
  'tool.execute.before'(input: { tool: string; sessionID: string; callID: string }, output: { args: Record<string, unknown> }): Promise<void>
  'tool.execute.after'(input: { tool: string; sessionID: string; callID: string }, output: { output: string }): Promise<void>
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const ADAPTER_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs")
const event = process.argv[3]
const log = process.env.FAKE_LOG
fs.appendFileSync(log, JSON.stringify({ event }) + "\\n")
if (event === "session-start") {
  let input = ""
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    if (JSON.parse(input || "{}").compacted === true) fs.appendFileSync(log, JSON.stringify({ compacted: true }) + "\\n")
    process.stdout.write("ACTIVATION TEXT")
  })
  return
}
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
    if (frame.type === "form") {
      const verdict = process.env.FAKE_VERDICT || "accepted"
      process.stdout.write(JSON.stringify(verdict === "refused" ? { type: "refused", message: "Notifai refused this form." }
        : verdict === "terminal" ? { type: "terminal", reason: "question-notifications-off" }
          : { type: "accepted", question_id: "q_1" }) + "\\n")
      if (verdict !== "accepted") process.exit(0)
    } else if (frame.type === "opened") {
      process.stdout.write(JSON.stringify({ type: "registered", request_id: "req_1" }) + "\\n")
      if (process.env.FAKE_MODE === "device") {
        process.stdout.write(JSON.stringify({ type: "answer", request_id: "req_1", answers: [["Production"]],
          acknowledgement: "notifai acknowledge req_1 --text <text>" }) + "\\n")
      } else if (process.env.FAKE_MODE === "expire") {
        process.stdout.write(JSON.stringify({ type: "expired", context: "EXPIRED CONTEXT" }) + "\\n")
      }
    } else if (frame.type === "ask" && !asked) {
      asked = true
      process.stdout.write(JSON.stringify({ type: "registered", request_id: "req_1" }) + "\\n")
      if (process.env.FAKE_MODE === "device" || process.env.FAKE_MODE === "device-exit") {
        process.stdout.write(JSON.stringify({ type: "answer", request_id: "req_" + frame.request.id, answers: [["Production"]],
          acknowledgement: "notifai acknowledge req_1 --text <text>", acknowledgement_context: "OWED ACKNOWLEDGEMENT for " + frame.request.id }) + "\\n")
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

async function load(mode: 'device' | 'device-exit' | 'wait' | 'expire', options: {
  questionApi?: boolean; verdict?: 'accepted' | 'refused' | 'terminal'
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode-plugin-'))
  roots.push(root)
  const adapter = path.join(root, 'adapter')
  writeFileSync(adapter, ADAPTER_SCRIPT)
  chmodSync(adapter, 0o755)
  const log = path.join(root, 'log.jsonl')
  writeFileSync(log, '')
  process.env['FAKE_LOG'] = log
  process.env['FAKE_MODE'] = mode
  process.env['FAKE_VERDICT'] = options.verdict ?? 'accepted'
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
      pending.splice(pending.findIndex(request => request.id === params.requestID), 1)
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
  const records = (): Array<{ event?: string; frame?: { type: string; answers?: unknown; extras?: unknown; questions?: unknown }; closed?: boolean }> =>
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
    expect(first.system.join('\n')).toContain('OWED ACKNOWLEDGEMENT')
    const second = { system: [] as string[] }
    await t.plugin['experimental.chat.system.transform']({ sessionID: 'ses_parent' }, second)
    expect(second.system.join('\n')).not.toContain('OWED ACKNOWLEDGEMENT')
  })

  it('rejects a refused form with Notifai\'s message, and leaves a terminal one to OpenCode', async () => {
    const refused = await load('wait', { verdict: 'refused' })
    await expect(refused.plugin['tool.execute.before']({ tool: 'question', sessionID: 'ses_parent', callID: 'call_1' },
      { args: { questions: REQUEST.questions } })).rejects.toThrow('Notifai refused this form.')
    const terminal = await load('wait', { verdict: 'terminal' })
    await terminal.plugin['tool.execute.before']({ tool: 'question', sessionID: 'ses_parent', callID: 'call_1' },
      { args: { questions: REQUEST.questions } })
    await terminal.plugin.event({ event: { type: 'question.asked', properties: { ...REQUEST, tool: { messageID: 'msg_1', callID: 'call_1' } } } })
    await new Promise((resolve) => setTimeout(resolve, 300))
    // Its opening starts no second command.
    expect(terminal.records().filter((record) => record.event === 'opencode-question')).toHaveLength(1)
  })
})
