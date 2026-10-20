#!/usr/bin/env node
/**
 * Codex card canary: does the newest Codex still carry a question card the way
 * Notifai links it to the User's devices?
 *
 * Notifai links a `request_user_input_async` card to a registered question only
 * when an answer from a device can close that card: by `turn/steer` with the
 * exact `expectedTurnId`, on the app-server that owns the thread, after
 * `thread/turns/list` showed that turn in progress. This script exercises that
 * surface against whatever `codex` is on PATH, with no account and no model:
 *
 * 1. Schema: `codex app-server generate-json-schema` must still describe the
 *    methods, parameters, response fields and the card question shape Notifai
 *    reads. Drift here fails the run before anything is started.
 * 2. Round trip: in a throwaway CODEX_HOME, a daemon is started, a thread is
 *    created, and a turn runs against a local mock of the Responses API that
 *    answers with one `request_user_input_async` call and then holds the turn
 *    open. Notifai's own shipped transport code (`connectCodexAnswerControl`)
 *    then has to discover the daemon, admit the in-progress turn and steer it
 *    with the expected turn id; the steer must reach the model as the next
 *    user input. Notifai's transcript reader must find the accepted card in the
 *    rollout, and Codex's PreToolUse/PostToolUse hooks must deliver the card
 *    fields Notifai's card hook reads.
 *
 * What a green run proves: the newest Codex's app-server protocol, daemon
 * discovery, turn admission, steer precondition, rollout record and hook
 * payload still match what the shipped CLI depends on, and Notifai's control
 * connection, opened first, still cannot become the originator of the
 * thread.
 *
 * What it does not prove: that a real model emits the card (the model is
 * mocked), that the Codex TUI clears the card when the steer is consumed (no
 * TUI runs here), that Notifai's reply envelope is still parsed by that TUI,
 * or anything about the Notifai service. Those remain the live proofs recorded
 * with each raise of `CODEX_CARD_VERSION_FLOOR`.
 *
 * A red run is a signal for a maintainer, not an automatic change: shipped
 * CLIs keep linking until the service withdraws the `harness_answers`
 * capability or a release raises the floor.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distModule = name => import(pathToFileURL(path.join(repositoryRoot, 'apps', 'cli', 'dist', name)).href)

/** The card the mock model emits and every later assertion compares against. */
export const CANARY_CARD = Object.freeze({
  callId: 'call_notifai_canary_1',
  questions: Object.freeze([Object.freeze({ title: 'Which environment?', options: Object.freeze(['Staging', 'Production']) })]),
})
export const CANARY_STEER_TEXT = 'Notifai canary device answer: Staging'

/** `codex --version` prints `codex-cli <version>`. */
export function parseCodexVersion(stdout) {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(String(stdout))
  return match === null ? null : match[1]
}

// ---------------------------------------------------------------------------
// 1. Schema surface
// ---------------------------------------------------------------------------

function definition(bundle, name) {
  const found = bundle.v2?.definitions?.[name]
  if (found === undefined) throw new Error(`definition ${name} is missing from the app-server schema bundle`)
  return found
}

/** Flatten enum/oneOf/anyOf/$ref into the string values a field accepts. */
function enumValues(bundle, schema, seen = new Set()) {
  if (schema === undefined || schema === null) return []
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/definitions/', '')
    if (seen.has(name)) return []
    seen.add(name)
    return enumValues(bundle, bundle.v2.definitions[name], seen)
  }
  const values = Array.isArray(schema.enum) ? schema.enum.filter(value => typeof value === 'string') : []
  for (const branch of [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])]) values.push(...enumValues(bundle, branch, seen))
  return values
}

function typeIncludes(schema, type) {
  if (schema === undefined) return false
  const declared = schema.type
  return declared === type || (Array.isArray(declared) && declared.includes(type))
}

/** Every check names the Notifai code that reads the field it guards. */
export const SCHEMA_CHECKS = [
  {
    check: 'client requests still include every method Notifai calls',
    guards: 'codex-native-control.ts CodexControlMethod',
    run: bundle => {
      const methods = new Set((bundle.clientRequest?.oneOf ?? []).flatMap(entry => entry.properties?.method?.enum ?? []))
      const missing = ['initialize', 'thread/loaded/list', 'thread/turns/list', 'turn/steer', 'thread/queue/list', 'thread/queue/add', 'thread/queue/delete']
        .filter(method => !methods.has(method))
      return missing.length === 0 ? null : `missing ${missing.join(', ')}`
    },
  },
  {
    check: 'initialize takes clientInfo and the experimentalApi capability',
    guards: 'codex-native-control.ts initialize',
    run: bundle => {
      const params = definition(bundle, 'InitializeParams')
      const capabilities = definition(bundle, 'InitializeCapabilities')
      if (!(params.required ?? []).includes('clientInfo')) return 'clientInfo is no longer required'
      if (!typeIncludes(capabilities.properties?.experimentalApi, 'boolean')) return 'experimentalApi is not a boolean capability'
      return null
    },
  },
  {
    check: 'thread/loaded/list returns thread ids in data with a nextCursor',
    guards: 'codex-native-control.ts loaded-thread stage',
    run: bundle => {
      const response = definition(bundle, 'ThreadLoadedListResponse')
      if (!(response.required ?? []).includes('data') || !typeIncludes(response.properties?.data, 'array')) return 'data is not a required array'
      if (!typeIncludes(response.properties?.data?.items, 'string')) return 'data items are not strings'
      if (response.properties?.nextCursor === undefined) return 'nextCursor is gone'
      return null
    },
  },
  {
    check: 'thread/turns/list accepts threadId, limit, sortDirection desc and itemsView notLoaded',
    guards: 'codex-answer-control.ts currentTurn',
    run: bundle => {
      const params = definition(bundle, 'ThreadTurnsListParams')
      if (!(params.required ?? []).includes('threadId')) return 'threadId is no longer required'
      for (const field of ['limit', 'sortDirection', 'itemsView']) if (params.properties?.[field] === undefined) return `${field} parameter is gone`
      if (!enumValues(bundle, params.properties.sortDirection).includes('desc')) return 'sortDirection no longer accepts desc'
      if (!enumValues(bundle, params.properties.itemsView).includes('notLoaded')) return 'itemsView no longer accepts notLoaded'
      return null
    },
  },
  {
    check: 'thread/turns/list returns turns with id, status inProgress and itemsView',
    guards: 'codex-answer-control.ts currentTurn',
    run: bundle => {
      const response = definition(bundle, 'ThreadTurnsListResponse')
      if (!(response.required ?? []).includes('data') || !typeIncludes(response.properties?.data, 'array')) return 'data is not a required array'
      const turn = definition(bundle, 'Turn')
      if (!typeIncludes(turn.properties?.id, 'string')) return 'Turn.id is not a string'
      if (!enumValues(bundle, turn.properties?.status).includes('inProgress')) return 'Turn.status no longer has inProgress'
      if (!enumValues(bundle, turn.properties?.itemsView).includes('notLoaded')) return 'Turn.itemsView no longer has notLoaded'
      return null
    },
  },
  {
    check: 'turn/steer requires threadId, expectedTurnId and text input',
    guards: 'codex-answer-control.ts steer',
    run: bundle => {
      const params = definition(bundle, 'TurnSteerParams')
      const missing = ['threadId', 'expectedTurnId', 'input'].filter(field => !(params.required ?? []).includes(field))
      if (missing.length > 0) return `${missing.join(', ')} no longer required`
      const input = definition(bundle, 'UserInput')
      const text = [...(input.oneOf ?? []), ...(input.anyOf ?? [])].find(branch => enumValues(bundle, branch.properties?.type).includes('text'))
      if (text === undefined || !typeIncludes(text.properties?.text, 'string')) return 'UserInput has no text variant with a string text'
      return null
    },
  },
  {
    check: 'turn/steer answers with the turnId it admitted',
    guards: 'codex-answer-control.ts steer receipt',
    run: bundle => {
      const response = definition(bundle, 'TurnSteerResponse')
      return (response.required ?? []).includes('turnId') && typeIncludes(response.properties?.turnId, 'string') ? null : 'turnId is not a required string'
    },
  },
  {
    check: 'card questions keep a string title and string options',
    guards: 'codex-question-hooks.ts routeCard, codex-native-turn.ts question emissions',
    run: bundle => {
      const question = definition(bundle, 'AsyncUserInputQuestion')
      if (!(question.required ?? []).includes('title') || !typeIncludes(question.properties?.title, 'string')) return 'title is not a required string'
      if (!typeIncludes(question.properties?.options, 'array') || !typeIncludes(question.properties?.options?.items, 'string')) return 'options are not an array of strings'
      return null
    },
  },
]

export function checkSchemaBundle(bundle) {
  return SCHEMA_CHECKS.map(({ check, guards, run }) => {
    try {
      const problem = run(bundle)
      return { phase: 'schema', check, guards, ok: problem === null, ...(problem === null ? {} : { detail: problem }) }
    } catch (error) {
      return { phase: 'schema', check, guards, ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  })
}

export function readSchemaBundle(directory) {
  const read = name => JSON.parse(readFileSync(path.join(directory, name), 'utf8'))
  return { v2: read('codex_app_server_protocol.v2.schemas.json'), clientRequest: read('ClientRequest.json') }
}

// ---------------------------------------------------------------------------
// 2. Mock Responses API provider
// ---------------------------------------------------------------------------

/** Which step of the round trip a model request belongs to. */
export function classifyProviderRequest(body, card = CANARY_CARD, steerText = CANARY_STEER_TEXT) {
  const input = Array.isArray(body?.input) ? body.input : []
  const texts = item => (Array.isArray(item?.content) ? item.content : []).map(part => (typeof part?.text === 'string' ? part.text : '')).join('\n')
  if (input.some(item => item?.type === 'message' && item.role === 'user' && texts(item).includes(steerText))) return 'after-steer'
  if (input.some(item => item?.type === 'function_call_output' && item.call_id === card.callId)) return 'after-card'
  return 'card'
}

/**
 * A minimal streaming Responses API. The first request gets the card call,
 * the request carrying that call's output stays open until `release()`, and a
 * request that carries the steer text gets a final message.
 */
export function startMockProvider({ card = CANARY_CARD, steerText = CANARY_STEER_TEXT } = {}) {
  const requests = []
  let releaseHeld = null
  const held = new Promise(resolve => { releaseHeld = resolve })
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { raw += chunk })
    request.on('end', async () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { body = {} }
      const kind = classifyProviderRequest(body, card, steerText)
      requests.push({ kind, url: request.url, originator: request.headers.originator, body })
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const id = `resp_canary_${requests.length}`
      const emit = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
      emit('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } })
      let item
      if (kind === 'card') {
        item = { type: 'function_call', id: 'fc_canary_1', call_id: card.callId, name: 'request_user_input_async', status: 'completed',
          arguments: JSON.stringify({ questions: card.questions }) }
      } else {
        if (kind === 'after-card') await held
        item = { type: 'message', id: `msg_canary_${requests.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Canary turn complete.' }] }
      }
      emit('response.output_item.added', { output_index: 0, item })
      emit('response.output_item.done', { output_index: 0, item })
      emit('response.completed', { response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
      response.end()
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    requests,
    release: () => releaseHeld(),
    close: () => new Promise(done => { releaseHeld(); server.closeAllConnections?.(); server.close(() => done()) }),
  })))
}

// ---------------------------------------------------------------------------
// 3. Live round trip
// ---------------------------------------------------------------------------

const HOOK_EVENTS = ['PreToolUse', 'PostToolUse']

function hookRecorderSource() {
  return [
    "import { appendFileSync } from 'node:fs'",
    "let data = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', chunk => { data += chunk })",
    "process.stdin.on('end', () => { appendFileSync(process.argv[2], JSON.stringify({ event: process.argv[3], payload: JSON.parse(data) }) + '\\n'); process.stdout.write('{}') })",
    '',
  ].join('\n')
}

async function installRecorderHooks(home, scratch, helpers) {
  const recorder = path.join(scratch, 'record-hook.mjs')
  const record = path.join(scratch, 'hook-events.jsonl')
  writeFileSync(recorder, hookRecorderSource())
  writeFileSync(record, '')
  const file = path.join(home, 'hooks.json')
  const handlers = HOOK_EVENTS.map(event => ({ event, matcher: 'request_user_input_async', groupIndex: 0, handlerIndex: 0,
    command: `"${process.execPath}" "${recorder}" "${record}" ${event}`, timeout: 30 }))
  writeFileSync(file, JSON.stringify({ hooks: Object.fromEntries(handlers.map(handler => [handler.event, [{ matcher: handler.matcher,
    hooks: [{ type: 'command', command: handler.command, timeout: handler.timeout }] }]])) }, null, 2))
  const trust = handlers.map(handler =>
    `[hooks.state.${JSON.stringify(helpers.codexTrustKey({ file, harness: 'codex', handlers }, handler))}]\ntrusted_hash = "${helpers.codexHookIdentityHash(handler)}"\n`).join('\n')
  return { record, trust }
}

function readHookRecord(record) {
  return readFileSync(record, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

class RpcClient {
  constructor(socket) { this.socket = socket; this.seq = 0; this.pending = new Map(); this.notifications = []; this.waiters = [] }
  static async connect(socketPath, connectUnixWebSocket, lifetimeMs) {
    const client = new RpcClient(null)
    client.socket = await connectUnixWebSocket(socketPath, {
      message: text => client.receive(text),
      closed: error => { for (const waiting of client.pending.values()) waiting.reject(error); client.pending.clear() },
    }, { maxPayload: 4 * 1024 * 1024, lifetimeMs })
    return client
  }
  receive(text) {
    let value
    try { value = JSON.parse(text) } catch { return }
    if (typeof value?.id === 'number' && this.pending.has(value.id)) {
      const waiting = this.pending.get(value.id)
      this.pending.delete(value.id)
      if (value.error !== undefined) waiting.reject(Object.assign(new Error(`${waiting.method}: ${JSON.stringify(value.error)}`), { rpc: value.error }))
      else waiting.resolve(value.result)
      return
    }
    if (typeof value?.method === 'string') {
      this.notifications.push(value)
      for (const waiter of this.waiters.splice(0)) {
        if (waiter.predicate(value)) waiter.resolve(value); else this.waiters.push(waiter)
      }
    }
  }
  call(method, params) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params })).catch(error => { this.pending.delete(id); reject(error) })
    })
  }
  notify(method, params) { return this.socket.send(JSON.stringify({ method, params })) }
  waitFor(description, predicate, timeoutMs) {
    const already = this.notifications.find(predicate)
    if (already !== undefined) return Promise.resolve(already)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter.resolve !== finish)
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${description}`))
      }, timeoutMs)
      const finish = value => { clearTimeout(timer); resolve(value) }
      this.waiters.push({ predicate, resolve: finish })
    })
  }
  close() { this.socket.terminate() }
}

async function killProcessesNaming(marker) {
  if (process.platform === 'win32') return
  let listing = ''
  try { listing = (await execute('ps', ['-axo', 'pid=,command='], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })).stdout } catch { return }
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    if (match === null || !match[2].includes(marker) || Number(match[1]) === process.pid) continue
    try { process.kill(Number(match[1]), 'SIGTERM') } catch { /* already gone */ }
  }
}

async function daemonVersion(env) {
  const { stdout } = await execute('codex', ['app-server', 'daemon', 'version'], { env, timeout: 15_000, maxBuffer: 64 * 1024 })
  return JSON.parse(stdout)
}

async function waitForDaemon(env, timeoutMs) {
  const until = Date.now() + timeoutMs
  let last = null
  while (Date.now() < until) {
    try {
      last = await daemonVersion(env)
      if (last.status === 'running' && typeof last.socketPath === 'string' && existsSync(last.socketPath)) return last
    } catch (error) { last = error instanceof Error ? error.message : String(error) }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`the daemon did not report running within ${timeoutMs} ms: ${JSON.stringify(last)}`)
}

/** Each step records one finding; the first failing step ends the round trip. */
export async function runRoundTrip({ env: baseEnv = process.env, keep = false, log = () => {} } = {}) {
  const findings = []
  const step = async (check, guards, work) => {
    try {
      const detail = await work()
      findings.push({ phase: 'round-trip', check, guards, ok: true, ...(detail === undefined ? {} : { detail }) })
      log(`ok   ${check}${detail === undefined ? '' : ` (${detail})`}`)
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      findings.push({ phase: 'round-trip', check, guards, ok: false, detail })
      log(`FAIL ${check}: ${detail}`)
      return false
    }
  }
  const helpers = {
    ...(await distModule('unix-websocket.js')),
    ...(await distModule('codex-answer-control.js')),
    ...(await distModule('codex-native-control.js')),
    ...(await distModule('codex-card-capability.js')),
    ...(await distModule('codex-native-turn.js')),
    ...(await distModule('install-hooks.js')),
  }
  // A Unix socket path is limited to about 104 bytes on macOS, and the daemon
  // puts its socket under CODEX_HOME, so the scratch root must stay short.
  const scratch = mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'nfcc-'))
  const home = path.join(scratch, 'codex-home')
  const project = path.join(scratch, 'project')
  mkdirSync(home); mkdirSync(project)
  const env = { ...baseEnv, CODEX_HOME: home, HOME: path.join(scratch, 'home'), XDG_STATE_HOME: path.join(scratch, 'state'), XDG_CONFIG_HOME: path.join(scratch, 'config') }
  for (const key of Object.keys(env)) if (key === 'CODEX_THREAD_ID' || key === 'OPENAI_API_KEY' || key.startsWith('NOTIFAI_ACTIVE_')) delete env[key]
  mkdirSync(env.HOME)
  const mock = await startMockProvider()
  let hooks
  let client = null
  let daemonStarted = false
  try {
    hooks = await installRecorderHooks(home, scratch, helpers)
    writeFileSync(path.join(home, 'config.toml'), [
      'model_provider = "notifai_canary"',
      'suppress_unstable_features_warning = true',
      '',
      '[model_providers.notifai_canary]',
      'name = "Notifai canary mock"',
      `base_url = "http://127.0.0.1:${mock.port}/v1"`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      '',
      hooks.trust,
    ].join('\n'))

    let version
    if (!await step('the daemon starts in an isolated CODEX_HOME and reports its version', 'codex-native-control.ts discovery', async () => {
      await execute('codex', ['app-server', 'daemon', 'start'], { env, timeout: 60_000, maxBuffer: 1024 * 1024 })
      daemonStarted = true
      version = await waitForDaemon(env, 30_000)
      const reported = version.appServerVersion ?? version.managedCodexVersion
      if (typeof reported !== 'string') throw new Error(`no appServerVersion or managedCodexVersion in ${JSON.stringify(version)}`)
      return `appServerVersion ${reported}`
    })) return findings

    await step('the newest app-server version satisfies the shipped card floor', 'codex-card-capability.ts codexCardVersionVerdict', async () => {
      const verdict = helpers.codexCardVersionVerdict(version.appServerVersion ?? version.managedCodexVersion)
      if (!verdict.supported) throw new Error(`${verdict.reason}: ${verdict.version ?? 'none'} against floor ${helpers.CODEX_CARD_VERSION_FLOOR}`)
      return `${verdict.version} >= ${helpers.CODEX_CARD_VERSION_FLOOR}`
    })

    await step("Notifai's control connection initializes before any other client and refuses an unloaded thread", 'codex-native-control.ts CODEX_CONTROL_CLIENT_INFO', async () => {
      let refusedAt = null
      const control = await helpers.connectCodexControl('00000000-0000-0000-0000-000000000000', env, performance.now() + 15_000, undefined, stage => { refusedAt = stage })
      control?.close()
      if (control !== null || refusedAt !== 'loaded-thread') throw new Error(`expected a refusal at loaded-thread, got ${control === null ? refusedAt : 'a connection'}`)
      return `as ${helpers.CODEX_CONTROL_CLIENT_INFO.name}`
    })

    let threadId
    let turnId
    if (!await step('initialize names this CODEX_HOME and a turn starts with the card available', 'codex-native-control.ts initialize/namespace', async () => {
      client = await RpcClient.connect(version.socketPath, helpers.connectUnixWebSocket, 120_000)
      const initialized = await client.call('initialize', { clientInfo: { name: 'notifai_canary', version: '1' }, capabilities: { experimentalApi: true } })
      if (typeof initialized?.codexHome !== 'string' || realpathSync(initialized.codexHome) !== realpathSync(home)) throw new Error(`initialize reported codexHome ${JSON.stringify(initialized?.codexHome)}`)
      await client.notify('initialized', {})
      const started = await client.call('thread/start', { cwd: project })
      threadId = started?.thread?.id
      if (typeof threadId !== 'string') throw new Error(`thread/start returned ${JSON.stringify(started).slice(0, 300)}`)
      const turn = await client.call('turn/start', { threadId, input: [{ type: 'text', text: 'Ask me which environment to use.' }] })
      turnId = turn?.turn?.id
      if (typeof turnId !== 'string' || turn.turn.status !== 'inProgress') throw new Error(`turn/start returned ${JSON.stringify(turn).slice(0, 300)}`)
      return `model ${started.thread?.model ?? 'unknown'}, thread ${threadId}, turn ${turnId}`
    })) return findings

    if (!await step('Codex emits the card as an async agent message with the questions the model gave', 'codex-question-hooks.ts card shape', async () => {
      const emitted = await client.waitFor('the card item', value => value.method === 'item/completed' && value.params?.item?.type === 'agentMessage' &&
        value.params.item.delivery === 'async' && value.params.item.id === CANARY_CARD.callId, 60_000)
      const questions = JSON.stringify(emitted.params.item.questions)
      if (questions !== JSON.stringify(CANARY_CARD.questions)) throw new Error(`questions were ${questions}`)
      if (emitted.params.threadId !== threadId || emitted.params.turnId !== turnId) throw new Error('the card belongs to another thread or turn')
      const held = Date.now() + 30_000
      while (!mock.requests.some(request => request.kind === 'after-card') && Date.now() < held) await new Promise(resolve => setTimeout(resolve, 100))
      if (!mock.requests.some(request => request.kind === 'after-card')) throw new Error('Codex never sent the accepted card result back to the model')
    })) return findings

    let control = null
    if (!await step('the shipped transport admits the in-progress turn through daemon discovery', 'codex-answer-control.ts connectCodexAnswerControl', async () => {
      const reports = []
      control = await helpers.connectCodexAnswerControl(threadId, turnId, env, performance.now() + 15_000, undefined, report => reports.push(report))
      if (control === null) throw new Error(`no answer transport: ${JSON.stringify(reports)}`)
      if (!await control.currentTurn(turnId)) throw new Error('thread/turns/list no longer shows the turn in progress')
      return `namespace ${control.namespace}`
    })) return findings

    if (!await step('turn/steer with the expected turn id is admitted and reaches the model as the next user input', 'codex-answer-control.ts steer', async () => {
      await control.steer(turnId, CANARY_STEER_TEXT)
      mock.release()
      const until = Date.now() + 60_000
      while (!mock.requests.some(request => request.kind === 'after-steer') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100))
      const steered = mock.requests.find(request => request.kind === 'after-steer')
      if (steered === undefined) throw new Error(`the steer never reached the model; requests seen: ${mock.requests.map(request => request.kind).join(', ')}`)
      await client.waitFor('turn completion', value => value.method === 'turn/completed' && value.params?.turn?.id === turnId, 60_000)
      return `requests ${mock.requests.map(request => request.kind).join(' -> ')}`
    })) return findings
    control.close()
    control = null

    await step('steering an idle thread is refused rather than starting a turn', 'codex-answer-control.ts steer precondition', async () => {
      try {
        const result = await client.call('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text: 'late canary answer' }] })
        throw new Error(`turn/steer accepted input on an idle thread: ${JSON.stringify(result)}`)
      } catch (error) {
        if (error?.rpc === undefined) throw error
        return `refused: ${error.rpc.message ?? JSON.stringify(error.rpc)}`
      }
    })

    // Codex lets the first ordinarily named client on an app-server label every
    // thread it creates. Notifai connected first above, so this proves Codex
    // still exempts the name Notifai initializes with.
    await step("the thread keeps its own client as originator although Notifai's control connected first", 'codex-native-control.ts CODEX_CONTROL_CLIENT_INFO', async () => {
      const file = helpers.findNativeTranscript(threadId, env)
      if (file === null) throw new Error('no rollout file for the thread')
      const meta = JSON.parse(readFileSync(file, 'utf8').split('\n', 1)[0])
      const recorded = meta?.type === 'session_meta' ? meta.payload?.originator : undefined
      const sent = [...new Set(mock.requests.map(request => request.originator))]
      if (recorded !== 'notifai_canary') throw new Error(`the rollout records originator ${JSON.stringify(recorded)}`)
      if (sent.length !== 1 || sent[0] !== 'notifai_canary') throw new Error(`model requests carried originator ${JSON.stringify(sent)}`)
      return 'rollout and model requests: notifai_canary'
    })

    await step("Notifai's transcript reader finds the accepted card in the rollout", 'codex-native-turn.ts readNativeQuestionSnapshot', async () => {
      const file = helpers.findNativeTranscript(threadId, env)
      if (file === null) throw new Error('no rollout file for the thread')
      const snapshot = helpers.readNativeQuestionSnapshot(file, threadId, env)
      if (snapshot === null) throw new Error('the rollout was not readable as an owned native transcript')
      const question = (snapshot.questions ?? []).find(entry => entry.call_id === CANARY_CARD.callId)
      if (question === undefined) throw new Error(`no question emission for ${CANARY_CARD.callId}; latest turn ${JSON.stringify(snapshot.latest)}`)
      if (question.turn_id !== turnId || !question.accepted || question.title !== CANARY_CARD.questions[0].title ||
          JSON.stringify(question.options) !== JSON.stringify(CANARY_CARD.questions[0].options)) throw new Error(`emission differs: ${JSON.stringify(question)}`)
      return `turn ${question.turn_id} ended=${snapshot.latest.ended}`
    })

    await step('PreToolUse and PostToolUse hooks carry the card fields the card hook reads', 'codex-question-hooks.ts routeCard envelope', async () => {
      const until = Date.now() + 15_000
      let events = []
      while (Date.now() < until) {
        events = readHookRecord(hooks.record)
        if (HOOK_EVENTS.every(event => events.some(entry => entry.event === event && entry.payload?.tool_name === 'request_user_input_async'))) break
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      for (const event of HOOK_EVENTS) {
        const entry = events.find(candidate => candidate.event === event && candidate.payload?.tool_name === 'request_user_input_async')
        if (entry === undefined) throw new Error(`no ${event} hook ran for the card; recorded ${JSON.stringify(events.map(candidate => [candidate.event, candidate.payload?.tool_name]))}`)
        const payload = entry.payload
        if (payload.hook_event_name !== event) throw new Error(`${event} payload names ${payload.hook_event_name}`)
        if (payload.session_id !== threadId || payload.turn_id !== turnId || payload.tool_use_id !== CANARY_CARD.callId) {
          throw new Error(`${event} identity differs: ${JSON.stringify({ session_id: payload.session_id, turn_id: payload.turn_id, tool_use_id: payload.tool_use_id })}`)
        }
        if (JSON.stringify(payload.tool_input?.questions) !== JSON.stringify(CANARY_CARD.questions)) throw new Error(`${event} tool_input.questions were ${JSON.stringify(payload.tool_input)}`)
        if (event === 'PostToolUse') {
          let response = payload.tool_response
          if (typeof response === 'string') { try { response = JSON.parse(response) } catch { /* reported below */ } }
          if (response?.accepted !== true) throw new Error(`PostToolUse tool_response was ${JSON.stringify(payload.tool_response)}`)
        }
      }
      return `${events.length} hook events recorded`
    })
    return findings
  } finally {
    client?.close()
    await mock.close()
    if (daemonStarted) {
      try { await execute('codex', ['app-server', 'daemon', 'stop'], { env, timeout: 30_000, maxBuffer: 1024 * 1024 }) } catch (error) {
        findings.push({ phase: 'round-trip', check: 'the daemon stops', guards: 'cleanup', ok: false, detail: error instanceof Error ? error.message : String(error) })
      }
      // `daemon stop` has left its pid-update helper behind; nothing from the
      // throwaway home may outlive the run, so end whatever still names it.
      await killProcessesNaming(scratch)
    }
    if (keep) log(`kept ${scratch}`)
    else rmSync(scratch, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function runCanary({ skipLive = false, keep = false, log = () => {} } = {}) {
  const started = new Date().toISOString()
  const { stdout } = await execute('codex', ['--version'], { timeout: 30_000 })
  const codexVersion = parseCodexVersion(stdout)
  log(`codex ${codexVersion ?? stdout.trim()}`)
  const schemaDir = mkdtempSync(path.join(os.tmpdir(), 'notifai-codex-schema-'))
  let findings
  try {
    await execute('codex', ['app-server', 'generate-json-schema', '--out', schemaDir, '--experimental'], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
    findings = checkSchemaBundle(readSchemaBundle(schemaDir))
  } finally { rmSync(schemaDir, { recursive: true, force: true }) }
  for (const finding of findings) log(`${finding.ok ? 'ok  ' : 'FAIL'} ${finding.check}${finding.detail === undefined ? '' : `: ${finding.detail}`}`)
  if (!skipLive && findings.every(finding => finding.ok)) findings.push(...await runRoundTrip({ keep, log }))
  else if (!skipLive) log('schema drift: the round trip did not run')
  return { started, codexVersion, ok: findings.every(finding => finding.ok), findings }
}

export function renderSummary(result) {
  const lines = [`## Codex card canary: ${result.ok ? 'green' : 'RED'} on Codex ${result.codexVersion ?? 'unknown'}`, '', '| Result | Check | Guards | Detail |', '| --- | --- | --- | --- |']
  for (const finding of result.findings) {
    lines.push(`| ${finding.ok ? 'ok' : 'FAIL'} | ${finding.check} | \`${finding.guards}\` | ${(finding.detail ?? '').replace(/\|/gu, '\\|')} |`)
  }
  return lines.join('\n') + '\n'
}

function parseArguments(argv) {
  const options = { skipLive: false, keep: false, summary: null, out: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--schema-only') options.skipLive = true
    else if (argument === '--keep') options.keep = true
    else if (argument === '--summary') options.summary = argv[++index]
    else if (argument === '--out') options.out = argv[++index]
    else throw new Error(`unknown argument ${argument}`)
  }
  return options
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2))
  const result = await runCanary({ skipLive: options.skipLive, keep: options.keep, log: line => console.error(line) })
  if (options.out !== null) writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n')
  if (options.summary !== null) writeFileSync(options.summary, renderSummary(result), { flag: 'a' })
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.ok ? 0 : 1
}
