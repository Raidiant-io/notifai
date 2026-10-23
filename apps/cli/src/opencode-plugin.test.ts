import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OPENCODE_QUESTION_EXTRA_PROPERTIES, OPENCODE_QUESTION_JSON_SCHEMA, opencodePluginSource } from './opencode-plugin.js'

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

  it('owes each parallel form its own acknowledgement', async () => {
    const t = await load('device')
    const second = { ...REQUEST, id: 'que_2' }
    t.pending.push(second)
    await t.plugin.event({ event: { type: 'question.asked', properties: REQUEST } })
    await t.plugin.event({ event: { type: 'question.asked', properties: second } })
    await t.until(() => t.records().filter(record => record.frame?.type === 'applied').length === 2)
    const turn = { system: [] as string[] }
    await t.plugin['experimental.chat.system.transform']({ sessionID: 'ses_parent' }, turn)
    const context = turn.system.join('\n')
    expect(context).toContain('OWED ACKNOWLEDGEMENT for que_1')
    expect(context).toContain('OWED ACKNOWLEDGEMENT for que_2')
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

  it('offers Notifai\'s fields on OpenCode\'s question form, and only on its known shape', async () => {
    const t = await load('wait')
    const question = { description: 'Ask', parameters: { fields: { questions: {} } } as unknown, jsonSchema: undefined as unknown }
    await t.plugin['tool.definition']({ toolID: 'question' }, question)
    const schema = question.jsonSchema as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).toEqual(Object.keys({ ...OPENCODE_QUESTION_JSON_SCHEMA.properties, ...OPENCODE_QUESTION_EXTRA_PROPERTIES }))
    expect(schema.properties.title).toEqual({ anyOf: [OPENCODE_QUESTION_EXTRA_PROPERTIES.title, { type: 'null' }] })
    const changed = { description: 'Ask', parameters: { fields: { questions: {}, deadline: {} } } as unknown, jsonSchema: undefined as unknown }
    await t.plugin['tool.definition']({ toolID: 'question' }, changed)
    expect(changed.jsonSchema).toBeUndefined()
    const other = { description: 'Run', parameters: { fields: { questions: {} } } as unknown, jsonSchema: undefined as unknown }
    await t.plugin['tool.definition']({ toolID: 'bash' }, other)
    expect(other.jsonSchema).toBeUndefined()
  })

  it('takes Notifai\'s fields off the form and opens it only once Notifai accepted it', async () => {
    const t = await load('device')
    const args = { questions: REQUEST.questions, title: 'Deploy target', body: 'Why', images: [{ path: 'a.png', alt: 'A' }], source: 'notifai:q_1' }
    await t.plugin['tool.execute.before']({ tool: 'question', sessionID: 'ses_parent', callID: 'call_1' }, { args })
    // OpenCode reads only its own input.
    expect(args).toEqual({ questions: REQUEST.questions })
    const formFrame = t.records().find((record) => record.frame?.type === 'form')?.frame
    expect(formFrame).toMatchObject({ questions: REQUEST.questions,
      extras: { title: 'Deploy target', body: 'Why', images: [{ path: 'a.png', alt: 'A' }], source: 'notifai:q_1' } })
    await t.plugin.event({ event: { type: 'question.asked', properties: { ...REQUEST, tool: { messageID: 'msg_1', callID: 'call_1' } } } })
    await t.until(() => t.replies.length === 1)
    expect(t.records().filter((record) => record.frame !== undefined).map((record) => record.frame!.type)).toEqual(['form', 'opened', 'applied'])
    expect(t.replies).toEqual([{ requestID: 'que_1', answers: [['Production']] }])
  })

  it('offers a closed strict-compatible schema and removes nullable optional values before native decoding', async () => {
    const current = await load('wait', { verdict: 'terminal' })
    const output = { description: 'Ask', parameters: { fields: { questions: {} } }, jsonSchema: undefined as unknown }
    await current.plugin['tool.definition']({ toolID: 'question' }, output)
    const check = (schema: Record<string, unknown>): void => {
      if (schema.type === 'object') {
        const properties = schema.properties as Record<string, Record<string, unknown>>
        expect(schema.additionalProperties).toBe(false)
        expect(new Set(schema.required as string[])).toEqual(new Set(Object.keys(properties)))
        for (const property of Object.values(properties)) check(property)
      }
      if (schema.items) check(schema.items as Record<string, unknown>)
      for (const branch of (schema.anyOf as Record<string, unknown>[] | undefined) ?? []) check(branch)
    }
    check(output.jsonSchema as Record<string, unknown>)
    const args = { questions: REQUEST.questions.map(question => ({ ...question, multiple: null })), title: null, body: null, images: null, source: null }
    await current.plugin['tool.execute.before']({ tool: 'question', sessionID: 'ses_parent', callID: 'strict_call' }, { args })
    expect(args).toEqual({ questions: REQUEST.questions })
    expect(current.records().find(record => record.frame?.type === 'form')?.frame?.extras).toEqual({})
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

  it('closes a form whose device question expired, and returns only Notifai\'s context', async () => {
    const t = await load('expire')
    await t.plugin['tool.execute.before']({ tool: 'question', sessionID: 'ses_parent', callID: 'call_1' }, { args: { questions: REQUEST.questions } })
    await t.plugin.event({ event: { type: 'question.asked', properties: { ...REQUEST, tool: { messageID: 'msg_1', callID: 'call_1' } } } })
    await t.until(() => t.replies.length === 1)
    expect(t.replies).toEqual([{ requestID: 'que_1', answers: [[]] }])
    await t.plugin.event({ event: { type: 'question.replied', properties: { sessionID: 'ses_parent', requestID: 'que_1', answers: [[]] } } })
    const result = { output: 'User has answered your questions: "Where?"="Unanswered".' }
    await t.plugin['tool.execute.after']({ tool: 'question', sessionID: 'ses_parent', callID: 'call_1' }, result)
    expect(result.output).toBe('EXPIRED CONTEXT')
    expect(t.records().some((record) => record.frame?.type === 'native')).toBe(false)
  })

  it('tells the agent\'s shell whether its session is a worker, and asks nothing about a worker\'s form', async () => {
    const t = await load('wait')
    const root = { env: {} as Record<string, string> }
    await t.plugin['shell.env']({ sessionID: 'ses_parent' }, root)
    expect(root.env).toMatchObject({ NOTIFAI_ACTIVE_HARNESS: 'opencode', NOTIFAI_ACTIVE_SESSION_ID: 'ses_parent', NOTIFAI_ACTIVE_SESSION_WORKER: '0' })
    const child = { env: {} as Record<string, string> }
    await t.plugin['shell.env']({ sessionID: 'ses_child' }, child)
    expect(child.env['NOTIFAI_ACTIVE_SESSION_WORKER']).toBe('1')
    const args = { questions: REQUEST.questions, title: 'Deploy target' }
    await t.plugin['tool.execute.before']({ tool: 'question', sessionID: 'ses_child', callID: 'call_2' }, { args })
    expect(args).toEqual({ questions: REQUEST.questions })
    expect(t.records().some((record) => record.event === 'opencode-question')).toBe(false)
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

  it('resolves activation again once OpenCode compacts the session, telling the CLI it was compacted', async () => {
    const t = await load('wait')
    await t.plugin['experimental.chat.system.transform']({ sessionID: 'ses_parent' }, { system: [] })
    await t.plugin.event({ event: { type: 'session.compacted', properties: { sessionID: 'ses_parent' } } })
    // The next model request of the same turn, not only the next User prompt.
    await t.plugin['experimental.chat.system.transform']({ sessionID: 'ses_parent' }, { system: [] })
    await t.plugin['experimental.chat.system.transform']({ sessionID: 'ses_parent' }, { system: [] })
    expect(t.records().filter(record => record.event === 'session-start')).toHaveLength(2)
    expect(t.records().filter(record => (record as { compacted?: boolean }).compacted === true)).toHaveLength(1)
  })
})
