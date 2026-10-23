import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { opencodePluginSource, opencodePluginTarget } from './opencode-plugin.js'
import { opencode2PluginSource, opencode2QuestionJsonSchema } from './opencode2-plugin.js'

/**
 * The generated OpenCode 2 plugin, run as OpenCode 2.1.3 runs it: its default
 * export's `setup` is given a plugin context, its hooks are called with the
 * payloads OpenCode 2.1.3 really sent (`fixtures/opencode-2.1.3-plugin-payloads.json`,
 * captured live), and a stand-in `question` tool behaves as the native one
 * does: it opens a form, then settles on a reply, a dismissal or an abort.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
interface SessionInfo { id: string; title?: string; location: { directory: string } }
type Payload = Record<string, unknown>
/** The parts of the captured payloads these tests read. */
interface Captured {
  setup_location: Payload
  prompt_root: { sessionID: string }
  session_get_root: SessionInfo
  session_get_child: SessionInfo
  context_question_input: { properties: { questions: unknown } }
  execute_before_question: { messageID: string; input: { questions: Array<{ question: string }> } }
  form_created: Payload & { data: { form: Payload } }
  native_result_answered: { output: unknown; content: string; metadata: unknown }
  execution_succeeded: Payload
  execution_interrupted_after_dismissal: Payload
  session_renamed: Payload
  session_deleted: Payload
}
interface ToolResult { output?: unknown; content?: unknown; metadata?: unknown }
const captured = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'opencode-2.1.3-plugin-payloads.json'), 'utf8')) as Captured
const ROOT = captured.session_get_root.id as string
const CHILD = captured.session_get_child.id as string
const QUESTIONS = captured.execute_before_question.input.questions as Array<{ question: string }>

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const ADAPTER_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs")
const event = process.argv[3]
const log = process.env.FAKE_LOG
let input = ""
if (event !== "opencode-question") {
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    fs.appendFileSync(log, JSON.stringify({ event, envelope: JSON.parse(input) }) + "\\n")
    if (event === "session-start") process.stdout.write(process.env.FAKE_ACTIVATION ?? "ACTIVATION TEXT")
    if (event === "subagent-start") process.stdout.write("WORKER ACTIVATION")
    if (event === "user-prompt-submit") process.stdout.write(process.env.FAKE_PROMPT_OUTPUT ?? "")
  })
  return
}
fs.appendFileSync(log, JSON.stringify({ event }) + "\\n")
let buffered = ""
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
        process.stdout.write(JSON.stringify({ type: "answer", request_id: "req_1", answers: [["Blue"]],
          acknowledgement: "notifai acknowledge req_1 --text <text>" }) + "\\n")
      } else if (process.env.FAKE_MODE === "expire") {
        process.stdout.write(JSON.stringify({ type: "expired", context: "EXPIRED CONTEXT" }) + "\\n")
      }
    } else {
      process.stdout.write(JSON.stringify({ type: "done", outcome: frame.type }) + "\\n")
    }
  }
})
process.stdin.on("end", () => { fs.appendFileSync(log, JSON.stringify({ closed: true }) + "\\n"); process.exit(0) })
`

type Hook = (event: object) => Promise<void> | void
type LogRecord = { event?: string; envelope?: Record<string, unknown>; frame?: { type: string; [key: string]: unknown }; closed?: boolean }

/** OpenCode's native `question` tool: one form per call, settled from outside or aborted. */
function nativeQuestionTool(emit: (event: unknown) => void, ignoresAbort = false) {
  const open = new Map<string, { reply(answer: string): void; dismiss(): void }>()
  const calls: Array<{ input: unknown }> = []
  const cancelled = { name: 'QuestionTool.CancelledError', message: 'The user dismissed this question' }
  const execute = (input: { questions: Array<{ question: string }> }, context: { id: string; sessionID: string; messageID: string; signal: AbortSignal }) => {
    calls.push({ input })
    return new Promise((resolve, reject) => {
      const form = { ...captured.form_created.data.form, id: `frm_${context.id}`, sessionID: context.sessionID,
        metadata: { kind: 'question', tool: { messageID: context.messageID, id: context.id } } }
      const settle = () => open.delete(context.id)
      open.set(context.id, {
        reply: (answer) => {
          settle()
          const answers = [[answer]]
          resolve({ ...captured.native_result_answered, output: { answers }, metadata: { answers },
            content: `User has answered your questions: "${input.questions[0]!.question}"="${answer}". You can now continue with the user's answers in mind.` })
        },
        dismiss: () => { settle(); reject(cancelled) },
      })
      context.signal.addEventListener('abort', () => { if (ignoresAbort) return; settle(); reject(new Error('All fibers interrupted without error')) }, { once: true })
      queueMicrotask(() => emit({ ...captured.form_created, id: `evt_${context.id}`, data: { form } }))
    })
  }
  return { execute, open, calls, cancelled }
}

async function load(options: { mode?: 'device' | 'expire' | 'wait'; verdict?: 'accepted' | 'refused' | 'terminal'; activation?: string; promptOutput?: string; questionFields?: Record<string, unknown>; parentID?: unknown; ignoresAbort?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-opencode2-plugin-'))
  roots.push(root)
  const adapter = path.join(root, 'adapter')
  writeFileSync(adapter, ADAPTER_SCRIPT)
  chmodSync(adapter, 0o755)
  const log = path.join(root, 'log.jsonl')
  writeFileSync(log, '')
  process.env['FAKE_LOG'] = log
  process.env['FAKE_MODE'] = options.mode ?? 'wait'
  process.env['FAKE_VERDICT'] = options.verdict ?? 'accepted'
  if (options.activation === undefined) delete process.env['FAKE_ACTIVATION']
  else process.env['FAKE_ACTIVATION'] = options.activation
  process.env['FAKE_PROMPT_OUTPUT'] = options.promptOutput ?? ''
  const modulePath = path.join(root, 'notifai.mjs')
  writeFileSync(modulePath, opencode2PluginSource({ adapterPath: adapter, timeoutSeconds: 10 }))
  const generated = await import(modulePath) as { default: { id: string; setup(ctx: object): Promise<() => void> } }

  const hooks: Record<string, Hook> = {}
  const queue: unknown[] = []
  let wake: (() => void) | null = null
  const emit = (event: unknown): void => { queue.push(event); wake?.() }
  const native = nativeQuestionTool(emit, options.ignoresAbort)
  const question: Record<string, unknown> = { id: 'question', input: { fields: options.questionFields ?? { questions: {} } }, execute: native.execute }
  const sessions: Record<string, unknown> = {
    [ROOT]: { ...captured.session_get_root, ...(options.parentID === undefined ? {} : { parentID: options.parentID }) },
    [CHILD]: captured.session_get_child,
  }
  const ctx = {
    location: captured.setup_location,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (!(sessionID in sessions)) throw new Error('Session not found')
        return sessions[sessionID]
      },
      hook: async (name: string, callback: Hook) => { hooks[`session.${name}`] = callback; return { dispose: async () => {} } },
    },
    shell: { hook: async (name: string, callback: Hook) => { hooks[`shell.${name}`] = callback; return { dispose: async () => {} } } },
    tool: {
      transform: async (callback: (editor: object) => void) => {
        callback({ update: (id: string, update: (tool: Record<string, unknown>) => void) => { if (id === 'question') update(question) } })
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            if (queue.length > 0) { yield queue.shift(); continue }
            await new Promise<void>((resolve) => { wake = resolve; signal.addEventListener('abort', () => resolve(), { once: true }) })
          }
        },
      }),
    },
  }
  const cleanup = await generated.default.setup(ctx)
  const records = (): LogRecord[] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogRecord)
  const frames = () => records().filter((record) => record.frame !== undefined).map((record) => record.frame!.type)
  const until = async (check: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(check()).toBe(true)
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300))
  const call = (id: string, sessionID = ROOT, input: Record<string, unknown> = { questions: QUESTIONS }) => {
    const controller = new AbortController()
    const execute = question['execute'] as (input: unknown, context: object) => Promise<ToolResult>
    return execute(input, { sessionID, agent: 'build', messageID: captured.execute_before_question.messageID, id, signal: controller.signal,
      progress: async () => {} })
  }
  const context = async (sessionID = ROOT) => {
    const event = { sessionID, agent: 'build', model: { id: 'stub', providerID: 'stub' }, system: [] as Array<{ type: string; text: string }>, messages: [], options: {}, tools: {} }
    await hooks['session.context']!(event)
    return event.system.map((part) => part.text)
  }
  return { generated, hooks, emit, native, question, records, frames, until, settle, call, context, cleanup, root }
}

describe('the generated OpenCode 2 plugin module', () => {
  it('is what the OpenCode 2 loader accepts, and the installer recognises its line', async () => {
    const t = await load()
    expect(Object.keys(t.generated)).toEqual(['default'])
    expect(t.generated.default.id).toBe('notifai')
    expect(typeof t.generated.default.setup).toBe('function')
    const source = opencode2PluginSource({ adapterPath: '/a/notifai-hook', timeoutSeconds: 5 })
    expect(opencodePluginTarget(source)).toMatchObject({ adapter: '/a/notifai-hook', current: true, line: 2, timeoutSeconds: 5 })
  })

  it('leaves the OpenCode 1 plugin byte for byte as it shipped', () => {
    const fixture = (name: string) => readFileSync(path.join(HERE, 'fixtures', name), 'utf8')
    expect(opencodePluginSource({ adapterPath: '/home/u/.notifai/bin/notifai-hook', timeoutSeconds: 5, platform: 'darwin',
      integrationScope: '/home/u/.config/opencode/plugins/notifai.js' })).toBe(fixture('opencode-1-plugin-posix.js.txt'))
    expect(opencodePluginSource({ adapterPath: 'C:\\Users\\u\\.notifai\\bin\\notifai-hook.mjs', nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      timeoutSeconds: 5, platform: 'win32', integrationScope: 'C:\\Users\\u\\.config\\opencode\\plugins\\notifai.js' })).toBe(fixture('opencode-1-plugin-win32.js.txt'))
    expect(opencodePluginTarget(fixture('opencode-1-plugin-posix.js.txt'))).toMatchObject({ line: 1, current: true })
  })

  it('declares Notifai\'s fields on OpenCode\'s own question schema, only while it is still the known shape', async () => {
    const t = await load()
    const schema = t.question['input'] as { properties: Record<string, unknown>; required: string[] }
    // OpenCode 2.1.3's own schema, unchanged, with the extras beside it.
    expect(schema.properties['questions']).toEqual(captured.context_question_input.properties.questions)
    expect(Object.keys(schema.properties)).toEqual(['questions', 'title', 'body', 'images', 'source'])
    expect(schema.required).toEqual(['questions'])
    expect(schema).toEqual(JSON.parse(JSON.stringify(opencode2QuestionJsonSchema())))
    const changed = await load({ questionFields: { questions: {}, deadline: {} } })
    expect(changed.question['input']).toEqual({ fields: { questions: {}, deadline: {} } })
  })
})

describe.skipIf(process.platform === 'win32')('the generated OpenCode 2 plugin', () => {
  it('returns a device answer as the question tool\'s result, closing OpenCode\'s form, and owes its acknowledgement once', async () => {
    const t = await load({ mode: 'device' })
    await t.context()
    const input = { questions: QUESTIONS, title: 'Pick a colour', body: 'Why it matters', images: [{ path: 'a.png', alt: 'A' }], source: 'notifai:q_1' }
    const result = await t.call('call_device', ROOT, input)
    expect(result).toEqual({
      output: { answers: [['Blue']] },
      content: 'User has answered your questions: "Which colour?"="Blue". You can now continue with the user\'s answers in mind.',
      metadata: { answers: [['Blue']] },
    })
    // The native form was aborted, which is how OpenCode closes it.
    expect(t.native.open.size).toBe(0)
    // OpenCode decodes only its own input; Notifai's fields go to the command.
    expect(t.native.calls[0]!.input).toEqual({ questions: QUESTIONS })
    const form = t.records().find((record) => record.frame?.type === 'form')!.frame!
    expect(form).toMatchObject({ session_id: ROOT, cwd: captured.session_get_root.location.directory, call_id: 'call_device', questions: QUESTIONS,
      extras: { title: 'Pick a colour', body: 'Why it matters', images: [{ path: 'a.png', alt: 'A' }], source: 'notifai:q_1' } })
    const opened = t.records().find((record) => record.frame?.type === 'opened')!.frame!
    expect(opened['request']).toEqual({ id: 'frm_call_device', sessionID: ROOT, questions: QUESTIONS,
      tool: { messageID: captured.execute_before_question.messageID, callID: 'call_device' } })
    await t.until(() => t.frames().includes('applied'))
    expect(t.frames()).toEqual(['form', 'opened', 'applied'])
    expect((await t.context()).join('\n')).toContain('notifai acknowledge req_1 --text <text>')
    expect((await t.context()).join('\n')).not.toContain('notifai acknowledge req_1')
  })

  it('returns the device answer within a few seconds even when the native executor ignores abort', async () => {
    const t = await load({ mode: 'device', ignoresAbort: true })
    const started = Date.now()
    const result = await t.call('call_uncooperative')
    expect(Date.now() - started).toBeLessThan(4500)
    expect(result.output).toEqual({ answers: [['Blue']] })
    await t.until(() => t.frames().includes('applied'))
    expect((await t.context()).join('\n')).toContain('notifai acknowledge req_1')
    await t.cleanup()
  }, 7000)

  it('passes an answer given in OpenCode through unchanged and reports it', async () => {
    const t = await load({ mode: 'wait' })
    const pending = t.call('call_terminal')
    await t.until(() => t.frames().includes('opened'))
    t.native.open.get('call_terminal')!.reply('Green')
    const result = await pending
    expect(result.output).toEqual(captured.native_result_answered.output)
    expect(result.content).toBe(captured.native_result_answered.content)
    await t.until(() => t.frames().includes('native'))
    expect(t.records().find((record) => record.frame?.type === 'native')!.frame!['answers']).toEqual([['Green']])
  })

  it('rethrows OpenCode\'s own dismissal unchanged, so OpenCode still treats it as one, and withdraws the device question', async () => {
    const t = await load({ mode: 'wait' })
    const pending = t.call('call_dismiss')
    await t.until(() => t.frames().includes('opened'))
    t.native.open.get('call_dismiss')!.dismiss()
    await expect(pending).rejects.toBe(t.native.cancelled)
    await t.until(() => t.frames().includes('dismissed'))
  })

  it('closes OpenCode\'s form when the device question expired, with only Notifai\'s context as the result', async () => {
    const t = await load({ mode: 'expire' })
    const result = await t.call('call_expire')
    expect(result).toEqual({ output: { answers: [[]] }, content: 'EXPIRED CONTEXT', metadata: { answers: [[]] } })
    expect(t.native.open.size).toBe(0)
    await t.until(() => t.frames().includes('applied'))
  })

  it('refuses a form with Notifai\'s message before it opens, and leaves a terminal-only form to OpenCode', async () => {
    const refused = await load({ verdict: 'refused' })
    await expect(refused.call('call_refused')).rejects.toThrow('Notifai refused this form.')
    expect(refused.native.calls).toEqual([])
    const terminal = await load({ verdict: 'terminal' })
    const pending = terminal.call('call_native', ROOT, { questions: QUESTIONS, title: 'T' })
    await terminal.until(() => terminal.native.open.has('call_native'))
    terminal.native.open.get('call_native')!.reply('Green')
    expect((await pending).output).toEqual({ answers: [['Green']] })
    expect(terminal.native.calls[0]!.input).toEqual({ questions: QUESTIONS })
    expect(terminal.frames()).toEqual(['form'])
  })

  it('leaves a worker\'s form in OpenCode and asks Notifai nothing about it', async () => {
    const t = await load({ mode: 'device' })
    const pending = t.call('call_child', CHILD)
    await t.until(() => t.native.open.has('call_child'))
    t.native.open.get('call_child')!.reply('Green')
    await pending
    await t.settle()
    expect(t.records().some((record) => record.event === 'opencode-question')).toBe(false)
  })

  it('treats a session OpenCode cannot describe as a worker', async () => {
    const t = await load({ mode: 'device' })
    expect(await t.context('ses_unknown')).toEqual(['WORKER ACTIVATION'])
    expect(t.records().find((record) => record.event === 'opencode-session')!.envelope).toMatchObject({ session_id: 'ses_unknown', worker: true })
    const pending = t.call('call_unknown', 'ses_unknown')
    await t.until(() => t.native.open.has('call_unknown'))
    t.native.open.get('call_unknown')!.reply('Green')
    await pending
    expect(t.records().some((record) => record.event === 'opencode-question')).toBe(false)
  })

  it('treats malformed parent information as a worker instead of authorizing a root form', async () => {
    const t = await load({ parentID: { id: CHILD } })
    expect(await t.context()).toEqual(['WORKER ACTIVATION'])
    const pending = t.call('call_malformed_parent')
    await t.until(() => t.native.open.has('call_malformed_parent'))
    t.native.open.get('call_malformed_parent')!.reply('Green')
    await pending
    expect(t.records().some((record) => record.event === 'opencode-question')).toBe(false)
  })

  it('resolves activation once per User prompt and gives the next model request what the prompt hook returned', async () => {
    const t = await load({ promptOutput: 'SESSION NOTE TEXT' })
    expect(await t.context()).toEqual(['SESSION NOTE TEXT', 'ACTIVATION TEXT'])
    for (let request = 0; request < 2; request += 1) expect(await t.context()).toEqual(['ACTIVATION TEXT'])
    expect(t.records().filter((record) => record.event === 'session-start')).toHaveLength(1)
    await t.hooks['session.prompt']!(captured.prompt_root)
    expect(t.records().find((record) => record.event === 'user-prompt-submit')!.envelope).toEqual({
      session_id: ROOT, cwd: captured.session_get_root.location.directory, hook_event_name: 'UserPromptSubmit' })
    expect(await t.context()).toEqual(['SESSION NOTE TEXT', 'ACTIVATION TEXT'])
    expect(await t.context()).toEqual(['ACTIVATION TEXT'])
    expect(t.records().filter((record) => record.event === 'session-start')).toHaveLength(2)
  })

  it('recovers CLI acknowledgement context after reload without another User prompt', async () => {
    const before = await load({ mode: 'device' })
    await before.context()
    await before.call('call_before_reload')
    await before.cleanup()
    // The actual CLI's durable debt is covered by the prompt lifecycle test.
    const after = await load({ promptOutput: 'notifai acknowledge req_1 --text <text>' })
    expect((await after.context()).join('\n')).toContain('notifai acknowledge req_1')
    expect((await after.context()).join('\n')).not.toContain('notifai acknowledge req_1')
    await after.cleanup()
  })

  it('adds nothing in a Project the User disabled, and worker context in a child session', async () => {
    const disabled = await load({ activation: '' })
    expect(await disabled.context()).toEqual([])
    const worker = await load()
    expect(await worker.context(CHILD)).toEqual(['WORKER ACTIVATION'])
    expect(worker.records().find((record) => record.event === 'subagent-start')!.envelope).toMatchObject({ session_id: CHILD, hook_event_name: 'SubagentStart' })
  })

  it('records each session it serves for its shells, with whether it is a worker and its title', async () => {
    const t = await load()
    await t.context()
    await t.context(CHILD)
    const recorded = t.records().filter((record) => record.event === 'opencode-session').map((record) => record.envelope)
    // A new OpenCode 2 session has no title until OpenCode names it.
    expect(recorded).toEqual([
      { session_id: ROOT, cwd: captured.session_get_root.location.directory, hook_event_name: 'OpencodeSession', worker: false, session_label_pending: true },
      { session_id: CHILD, cwd: captured.session_get_child.location.directory, hook_event_name: 'OpencodeSession', worker: true, session_label: 'probe child' },
    ])
    const shell = { command: 'notifai ask', cwd: '/work/proj', timeout: 0, shell: '/bin/bash', env: { PATH: '/bin' } as Record<string, string> }
    await t.hooks['shell.create.before']!(shell)
    expect(shell.env).toEqual({ PATH: '/bin', NOTIFAI_ACTIVE_HARNESS: 'opencode', NOTIFAI_OPENCODE_PLUGIN: '2' })
  })

  it('ends the turn once per execution of a session it served, and never for another instance\'s session', async () => {
    const t = await load()
    await t.context()
    t.emit(captured.execution_succeeded)
    // OpenCode delivers an event to every instance; one instance can see the same one twice.
    t.emit(captured.execution_succeeded)
    t.emit({ ...captured.execution_interrupted_after_dismissal, id: 'evt_superseded', data: { sessionID: ROOT, reason: 'superseded' } })
    t.emit({ ...captured.execution_succeeded, id: 'evt_other', data: { sessionID: 'ses_otherinstance' } })
    await t.until(() => t.records().some((record) => record.event === 'stop'))
    await t.settle()
    expect(t.records().filter((record) => record.event === 'stop').map((record) => record.envelope)).toEqual([
      { session_id: ROOT, cwd: captured.session_get_root.location.directory, hook_event_name: 'Stop' },
    ])
    t.emit(captured.execution_interrupted_after_dismissal)
    await t.until(() => t.records().filter((record) => record.event === 'stop').length === 2)
  })

  it('records a renamed session again, and ends a deleted one and its open forms', async () => {
    const t = await load({ mode: 'wait' })
    await t.context()
    t.emit(captured.session_renamed)
    await t.until(() => t.records().filter((record) => record.event === 'opencode-session').length === 2)
    void t.call('call_open').catch(() => {})
    await t.until(() => t.frames().includes('opened'))
    t.emit({ ...captured.session_deleted, data: { sessionID: ROOT } })
    await t.until(() => t.records().some((record) => record.event === 'session-end'))
    await t.until(() => t.records().some((record) => record.closed === true))
    expect(t.records().find((record) => record.event === 'session-end')!.envelope).toMatchObject({ session_id: ROOT, hook_event_name: 'SessionEnd' })
  })
})
