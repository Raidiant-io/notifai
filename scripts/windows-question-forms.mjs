#!/usr/bin/env node
/**
 * Windows question forms: do Claude Code pickers and Codex cards link on
 * Windows, with the real harnesses running Notifai's own installed hooks?
 *
 * Each harness runs against a local mock model, in its own config home, on a
 * throwaway Windows runner. The machine holds a credential for a service
 * address nothing listens on, so registration and every local decision run
 * for real while nothing leaves the runner:
 *
 * - Codex (`codex app-server` over stdio, as its apps drive it), with
 *   recorder hooks in Notifai's exact Windows command shape: the process chain
 *   from Codex to a hook, and whether Codex keeps an async hook (the
 *   attendant's shape) alive while the thread stays loaded.
 * - Codex again, with the hooks `notifai hooks install` writes: the attendant
 *   records codex.exe as the session's process, the card hook proves that
 *   process from below, registers a card's question, refuses the card it
 *   cannot carry to the User's devices, and refuses a shape it cannot register.
 * - Claude Code's TUI in a Windows console, with the hooks `notifai hooks
 *   install` writes: a self-opened picker is registered and held, a terminal
 *   answer settles it, an unlinkable picker is refused, and `notifai ask
 *   --wait` hands back the picker that then links to the registered question.
 *
 * What it does not prove: a device answer returning through the picker or the
 * card (no service, no Companion App), or Codex's Windows daemon (a hosted
 * runner is elevated, and Codex refuses to start that daemon there). Exit 0
 * only when every check passed; the JSON record names each.
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(repositoryRoot, 'apps', 'cli', 'dist', 'main.js')
const distModule = name => import(pathToFileURL(path.join(repositoryRoot, 'apps', 'cli', 'dist', name)).href)
const DUMMY_KEY = 'sk-ant-forms-dummy-not-a-key-0000000000000000'
/** Nothing listens here: the credential is real in shape, and every request to it fails at once. */
const DEAD_SERVICE = 'http://127.0.0.1:9'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const PICKER = { questions: [{ question: 'Which environment should the deploy use?', header: 'Environment', multiSelect: false,
  options: [{ label: 'Staging', description: 'Deploy to staging first' }, { label: 'Production', description: 'Deploy straight to production' }] }] }
/** Labels Claude Code takes as distinct that name one answer once whitespace is normalized: no device question can carry them. */
const UNLINKABLE_PICKER = { questions: [{ question: 'Which region?', header: 'Region', multiSelect: false,
  options: [{ label: 'East', description: 'One' }, { label: 'East ', description: 'Two' }] }] }
const CARD = { questions: [{ title: 'Which branch should I release from?', options: ['main', 'release'] }] }
/** Two options that name the same answer once slugified. */
const UNLINKABLE_CARD = { questions: [{ title: 'Which queue?', options: ['fast', 'fast!'] }] }

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, ...(detail === undefined ? {} : { detail }) })
  process.stdout.write(`${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})`.slice(0, 1200)}\n`)
}

/** A harness run that leaves this event loop free: the mock model lives here. */
function run(program, args, options) {
  return new Promise(resolve => {
    const child = spawn(program, args, { ...options, windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { stdout += chunk }); child.stderr?.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => { killTree(child.pid); resolve({ status: null, timedOut: true, stdout, stderr }) }, options.timeout)
    child.on('error', error => { clearTimeout(timer); resolve({ status: null, error: error.message, stdout, stderr }) })
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
    child.stdin?.end()
  })
}

function killTree(pid) {
  if (pid !== undefined) spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
}

async function until(description, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${description}`)
    await sleep(500)
  }
}

/** Anthropic Messages and OpenAI Responses, answered by a per-scenario script. */
function startMockModel() {
  let script = { anthropic: () => ({ text: 'Done.' }), responses: () => ({ text: 'Done.' }) }
  let count = 0
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { body = {} }
      count += 1
      const route = new URL(request.url, 'http://mock').pathname.replace(/^\/v1/, '')
      const sendJson = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
      const sse = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      if (request.method === 'GET') return sendJson({ object: 'list', data: [] })
      if (route === '/messages/count_tokens') return sendJson({ input_tokens: 10 })
      if (route === '/messages') {
        const reply = script.anthropic(body)
        const content = reply.tool ? [{ type: 'tool_use', id: `toolu_forms_${count}`, name: reply.tool.name, input: reply.tool.input }]
          : [{ type: 'text', text: reply.text }]
        const message = { id: `msg_forms_${count}`, type: 'message', role: 'assistant', model: body.model ?? 'mock', content,
          stop_reason: reply.tool ? 'tool_use' : 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
        if (!body.stream) return sendJson(message)
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' })
        sse('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } })
        content.forEach((block, index) => {
          if (block.type === 'text') {
            sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
            sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
          } else {
            sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
            sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
          }
          sse('content_block_stop', { type: 'content_block_stop', index })
        })
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } })
        sse('message_stop', { type: 'message_stop' })
        return response.end()
      }
      if (route === '/responses') {
        const reply = script.responses(body)
        const item = reply.card
          ? { type: 'function_call', id: `fc_forms_${count}`, call_id: reply.card.callId, name: 'request_user_input_async', status: 'completed',
              arguments: JSON.stringify(reply.card.input) }
          : { type: 'message', id: `msg_forms_${count}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply.text, annotations: [] }] }
        const done = { id: `resp_forms_${count}`, object: 'response', status: 'completed', output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        sse('response.created', { type: 'response.created', response: { ...done, status: 'in_progress', output: [] } })
        sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item })
        sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item })
        sse('response.completed', { type: 'response.completed', response: done })
        return response.end()
      }
      response.writeHead(404); response.end()
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    use: next => { script = next },
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()) }),
  })))
}

/** The last user turn of an Anthropic request: its text, or the tool results it carries. */
function lastUserTurn(body) {
  const messages = body.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []
    const results = content.filter(part => part.type === 'tool_result')
    if (results.length > 0) return { toolResults: results }
    return { text: content.filter(part => part.type === 'text').map(part => part.text).join('\n') }
  }
  return {}
}

function toolResultText(result) {
  const content = result.content
  return typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('\n') : JSON.stringify(content)
}

/** The runner's own account, minus anything a real session or vendor key would bring. */
function baseEnv(extra) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|NOTIFAI)/.test(key)) delete env[key]
  return { ...env, NOTIFAI_CREDENTIALS: 'file', NOTIFAI_NO_INPUT: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...extra }
}

function notifai(env, args, cwd) {
  return run(process.execPath, [CLI, ...args], { cwd, env, timeout: 120_000 })
}

/** A recorder for the process chain Codex starts a hook in. */
function recorderSource() {
  return String.raw`
const { appendFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const event = process.argv[3]
function chain() {
  const ps = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    const rows = JSON.parse(execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; exe = $_.ExecutablePath; created = [string]$_.CreationDate.ToFileTimeUtc() } } | ConvertTo-Json -Compress"],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000 }))
    const byPid = new Map(rows.map(row => [row.pid, row]))
    const out = []
    for (let pid = process.pid, depth = 0; depth < 8 && byPid.has(pid); depth++) { const row = byPid.get(pid); out.push(row); pid = row.ppid }
    return out
  } catch (error) { return String(error) }
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', async () => {
  const write = extra => appendFileSync(process.env.NOTIFAI_FORMS_RECORD, JSON.stringify({ event, at: Date.now(), ...extra }) + '\n')
  write({ phase: 'start', chain: chain() })
  if (event === 'attend') {
    await new Promise(resolve => setTimeout(resolve, 20000))
    write({ phase: 'held-20s', chain: chain() })
  }
  process.stdout.write('{}')
})
`
}

/** Codex's trust record for exactly the handlers on disk, as a `/hooks` approval stores it. */
function codexTrust(env, helpers) {
  return helpers.findInstallations(env, undefined, 'win32').filter(installation => installation.harness === 'codex')
    .flatMap(installation => installation.handlers.map(handler =>
      `[hooks.state.${JSON.stringify(helpers.codexTrustKey(installation, handler))}]\ntrusted_hash = "${helpers.codexHookIdentityHash(handler)}"\n`)).join('\n')
}

function codexConfig(mock, project, extra = '') {
  return ['model_provider = "forms"', 'approval_policy = "never"', 'sandbox_mode = "danger-full-access"', 'check_for_update_on_startup = false',
    'suppress_unstable_features_warning = true', '', '[model_providers.forms]', 'name = "forms"', `base_url = "${mock.url}/v1"`,
    'wire_api = "responses"', 'env_key = "FORMS_OPENAI_KEY"', 'request_max_retries = 0', 'stream_max_retries = 0', '',
    `[projects.${JSON.stringify(project)}]`, 'trust_level = "trusted"', '', extra].join('\n')
}

/** Newline-delimited JSON-RPC over a child's stdio, as Codex's apps speak to `codex app-server`. */
function rpcOver(child) {
  let buffer = ''
  let next = 1
  const waiting = new Map()
  const notifications = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.id !== undefined && message.method === undefined && waiting.has(message.id)) {
        const { resolve, reject } = waiting.get(message.id); waiting.delete(message.id)
        if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result)
      } else if (message.method !== undefined && message.id !== undefined) {
        // Approvals and other server requests: Notifai never answers them, and neither does this client.
        child.stdin.write(`${JSON.stringify({ id: message.id, result: { decision: 'decline' } })}\n`)
      } else if (message.method !== undefined) notifications.push(message)
    }
  })
  return {
    notifications,
    call: (method, params) => new Promise((resolve, reject) => {
      const id = next++
      waiting.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      setTimeout(() => { if (waiting.delete(id)) reject(new Error(`${method} timed out`)) }, 60_000)
    }),
    notify: (method, params) => child.stdin.write(`${JSON.stringify({ method, params })}\n`),
    close: () => { try { child.stdin.end() } catch { /* gone */ } },
  }
}

async function codexSession(env, project) {
  const server = spawn('cmd.exe', ['/d', '/c', 'codex app-server'], { cwd: project, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  server.stderr.setEncoding('utf8'); server.stderr.on('data', chunk => { stderr += chunk })
  const rpc = rpcOver(server)
  await rpc.call('initialize', { clientInfo: { name: 'notifai_forms', title: 'Notifai forms', version: '1' }, capabilities: { experimentalApi: true } })
  rpc.notify('initialized', {})
  const thread = (await rpc.call('thread/start', { cwd: project })).thread.id
  return {
    thread,
    stderr: () => stderr,
    turn: async text => {
      const started = await rpc.call('turn/start', { threadId: thread, input: [{ type: 'text', text }] })
      await until(`the turn "${text}" to complete`, () => rpc.notifications.some(item => item.method === 'turn/completed' && item.params?.turn?.id === started.turn.id), 120_000)
    },
    close: () => { rpc.close(); killTree(server.pid) },
  }
}

const basename = file => path.win32.basename(file ?? '?').toLowerCase()

async function codexChain(mock, scratch, helpers) {
  const home = path.join(scratch, 'codex-chain')
  const project = path.join(scratch, 'codex-chain-project')
  const record = path.join(scratch, 'chain.jsonl')
  mkdirSync(home, { recursive: true }); mkdirSync(project, { recursive: true })
  const recorder = path.join(scratch, 'recorder.cjs')
  writeFileSync(recorder, recorderSource())
  const config = helpers.buildHookConfig({ adapterPath: recorder, harness: 'codex', platform: 'win32', nodePath: process.execPath })
  writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: config.SessionStart } }, null, 2))
  const env = baseEnv({ CODEX_HOME: home, FORMS_OPENAI_KEY: 'forms-dummy', NOTIFAI_FORMS_RECORD: record })
  writeFileSync(path.join(home, 'config.toml'), codexConfig(mock, project, codexTrust(env, helpers)))
  mock.use({ responses: () => ({ text: 'Chain turn complete.' }), anthropic: () => ({ text: 'unused' }) })
  const session = await codexSession(env, project)
  try {
    await session.turn('hello')
    const entries = await until('the attend-shaped hook after 20 seconds', () => {
      const lines = existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
      return lines.some(entry => entry.phase === 'held-20s') ? lines : null
    }, 90_000)
    // The attend-shaped handler: Notifai's exact command, with a lifetime long enough for a cold process-table read.
    const start = entries.find(entry => entry.event === 'attend' && entry.phase === 'start')
    const names = Array.isArray(start?.chain) ? start.chain.map(row => basename(row.exe)) : start?.chain
    check('Codex runs a Windows hook as codex.exe, then its session shell, then the system PowerShell Notifai names, then the adapter',
      Array.isArray(names) && path.win32.normalize(start.chain[1].exe).toLowerCase() === helpers.windowsCodexHookShell(env).toLowerCase() &&
      names.slice(2, 4).includes('codex.exe'), names)
    const held = entries.find(entry => entry.phase === 'held-20s')
    check('Codex keeps an async hook, and the chain to codex.exe, alive while the thread stays loaded',
      Array.isArray(held?.chain) && held.chain.some(row => basename(row.exe) === 'codex.exe'), Array.isArray(held?.chain) ? held.chain.map(row => basename(row.exe)) : held)
    return { chain: start?.chain }
  } finally {
    session.close()
  }
}

async function codexCards(mock, scratch, helpers) {
  const home = path.join(scratch, 'codex')
  const project = path.join(scratch, 'codex-project')
  mkdirSync(home, { recursive: true }); mkdirSync(project, { recursive: true })
  const env = baseEnv({ CODEX_HOME: home, FORMS_OPENAI_KEY: 'forms-dummy' })
  writeFileSync(path.join(home, 'config.toml'), codexConfig(mock, project))
  const installed = await notifai(env, ['hooks', 'install', '--harness', 'codex'], project)
  check('notifai hooks install writes the Codex hooks on Windows', installed.status === 0, installed.status === 0 ? undefined : `${installed.stdout} ${installed.stderr}`.slice(-1500))
  const installation = helpers.findInstallations(env, undefined, 'win32').find(item => item.harness === 'codex')
  const events = (installation?.handlers ?? []).map(handler => helpers.handlerEvent(handler.command))
  check('the Codex installation carries the attendant and both card handlers', ['attend', 'pre-tool-use', 'post-tool-use'].every(event => events.includes(event)), events)
  // The approval a User gives in /hooks, computed with the CLI's own identity functions.
  writeFileSync(path.join(home, 'config.toml'), codexConfig(mock, project, codexTrust(env, helpers)))
  check('Notifai reads every installed Codex card hook as trusted', helpers.codexCardHooksReady({ env, hookPlatform: 'win32' }) === true)

  const outputs = new Map()
  mock.use({
    anthropic: () => ({ text: 'unused' }),
    responses: body => {
      const input = body.input ?? []
      const last = input.at(-1)
      if (last?.type === 'function_call_output') {
        outputs.set(last.call_id, typeof last.output === 'string' ? last.output : JSON.stringify(last.output))
        return { text: 'Noted.' }
      }
      const text = JSON.stringify(last ?? '')
      if (text.includes('TK-CARD')) return { card: { callId: 'call_forms_card', input: CARD } }
      if (text.includes('TK-BADCARD')) return { card: { callId: 'call_forms_badcard', input: UNLINKABLE_CARD } }
      return { text: 'Ready.' }
    },
  })
  const session = await codexSession(env, project)
  const { thread } = session
  try {
    await session.turn('TK-HELLO')
    const owner = await until('the Codex attendant to record its harness process', () => helpers.readSessionIncarnation(thread, env)?.harness_process, 60_000).catch(() => null)
    const link = owner === null ? null : helpers.readWindowsProcessLink(owner.pid)
    check('the Windows attendant records codex.exe as the session\'s harness process', link !== null && basename(link.executable) === 'codex.exe',
      { owner, executable: link?.executable })

    await session.turn('TK-CARD')
    const state = helpers.readSessionState(thread, env)
    check('the card hook proves its Codex process: the card tool is recorded for this session\'s owner',
      state.codex_card_tool !== undefined && state.codex_card_tool.key === helpers.readSessionIncarnation(thread, env)?.key, state.codex_card_tool ?? state)
    const binding = (state.codex_question_bindings ?? []).find(item => item.card_call_id === 'call_forms_card')
    check('the card\'s question is registered for the User\'s devices', binding !== undefined && (state.pending ?? []).some(item => item.question_id === binding.question_id),
      binding === undefined ? state : { question_id: binding.question_id, card_allowed: binding.card_allowed })
    const cardOutput = outputs.get('call_forms_card') ?? ''
    check('a card that cannot receive a device answer is refused, and the agent asks the registered question instead',
      binding !== undefined && cardOutput.includes(`registered as ${binding.question_id}`) && cardOutput.includes('plain conversation text'), cardOutput.slice(0, 600))

    await session.turn('TK-BADCARD')
    const refused = outputs.get('call_forms_badcard') ?? ''
    check('a card Notifai cannot carry is refused before it opens, with notifai ask as the remedy',
      refused.includes("Notifai cannot carry this card to the User's devices") && refused.includes('notifai ask'), refused.slice(0, 600))
    check('the refused card registers nothing', !(helpers.readSessionState(thread, env).codex_question_bindings ?? []).some(item => item.card_call_id === 'call_forms_badcard'))
  } catch (error) {
    check('the Codex card scenario ran', false, `${error instanceof Error ? error.message : String(error)} ${session.stderr().slice(-1500)}`)
  } finally {
    session.close()
  }
  const logs = await notifai(env, ['logs', '--json', '--all-projects', '--all', '--session', thread], project)
  return { thread, log: logs.stdout.split('\n').filter(Boolean).slice(-60) }
}

/** Drives Claude Code's TUI in a ConPTY. Commands arrive as JSON lines in one file; the screen goes to another. */
const PTY_DRIVER = String.raw`
import json, sys, time, threading
from winpty import PtyProcess
cfg = json.loads(sys.argv[1])
proc = PtyProcess.spawn(cfg['command'], cwd=cfg['cwd'], env=cfg['env'], dimensions=(50, 200))
def reader():
    while True:
        try:
            chunk = proc.read(4096)
        except EOFError:
            return
        except Exception:
            time.sleep(0.2)
            continue
        if chunk:
            with open(cfg['screen'], 'a', encoding='utf8') as f:
                f.write(chunk)
threading.Thread(target=reader, daemon=True).start()
done = 0
while proc.isalive():
    time.sleep(0.3)
    with open(cfg['commands'], encoding='utf8') as f:
        lines = [line for line in f if line.strip()]
    for line in lines[done:]:
        command = json.loads(line)
        done += 1
        if command.get('quit'):
            proc.terminate(force=True)
            sys.exit(0)
        for ch in command.get('type', ''):
            proc.write(ch)
            time.sleep(0.03)
        if command.get('enter'):
            time.sleep(0.6)
            proc.write('\r')
`

async function claudePickers(mock, scratch, helpers) {
  const config = path.join(scratch, 'claude-config')
  const project = path.join(scratch, 'claude-project')
  mkdirSync(config, { recursive: true }); mkdirSync(project, { recursive: true })
  // Only the onboarding, trust and permission state a person clicks through once.
  const projectState = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 5, allowedTools: [] }
  writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.308', theme: 'dark', numStartups: 10,
    customApiKeyResponses: { approved: [DUMMY_KEY.slice(-20)], rejected: [] }, bypassPermissionsModeAccepted: true, hasSeenTasksHint: true, autoUpdates: false,
    projects: { [project]: projectState, [project.replaceAll('\\', '/')]: projectState } }, null, 2))
  writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ env: { DISABLE_AUTOUPDATER: '1' }, skipDangerousModePermissionPrompt: true }, null, 2))
  const env = baseEnv({ CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: DUMMY_KEY,
    CLAUDE_CODE_GIT_BASH_PATH: process.env.NOTIFAI_FORMS_GIT_BASH ?? 'C:\\Program Files\\Git\\bin\\bash.exe' })
  const installed = await notifai(env, ['hooks', 'install', '--harness', 'claude-code'], project)
  check('notifai hooks install writes the Claude Code hooks on Windows', installed.status === 0, installed.status === 0 ? undefined : `${installed.stdout} ${installed.stderr}`.slice(-1500))
  const installation = helpers.findInstallations(env, undefined, 'win32').find(item => item.harness === 'claude-code')
  const pickerHandlers = (installation?.handlers ?? []).filter(handler => handler.matcher === 'AskUserQuestion').map(handler => helpers.handlerEvent(handler.command))
  check('the Claude Code installation carries both picker handlers', pickerHandlers.includes('permission-request') && pickerHandlers.includes('post-tool-use'), pickerHandlers)

  const ask = [process.execPath, CLI].map(part => `"${part.replaceAll('\\', '/')}"`).join(' ') +
    ' ask --wait "Which region should the cache use?" --title "Cache region" --choice East --choice West --json'
  const results = []
  mock.use({
    responses: () => ({ text: 'unused' }),
    anthropic: body => {
      const offered = (body.tools ?? []).some(tool => tool.name === 'AskUserQuestion')
      const last = lastUserTurn(body)
      if (last.toolResults !== undefined) {
        for (const result of last.toolResults) results.push({ error: result.is_error === true, text: toolResultText(result) })
        const text = toolResultText(last.toolResults[0])
        if (text.includes('"open_form"')) {
          try {
            const output = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
            return { tool: { name: output.open_form.tool, input: output.open_form.input } }
          } catch { return { text: 'The hand-back could not be read.' } }
        }
        return { text: 'Noted.' }
      }
      if (!offered) return { text: 'Ready.' }
      if (last.text?.includes('TK-PICKER')) return { tool: { name: 'AskUserQuestion', input: PICKER } }
      if (last.text?.includes('TK-REFUSE')) return { tool: { name: 'AskUserQuestion', input: UNLINKABLE_PICKER } }
      if (last.text?.includes('TK-WAIT')) return { tool: { name: 'Bash', input: { command: ask, description: 'Ask the User' } } }
      return { text: 'Ready.' }
    },
  })
  const commands = path.join(scratch, 'pty-commands.jsonl')
  const screen = path.join(scratch, 'pty-screen.txt')
  writeFileSync(commands, ''); writeFileSync(screen, '')
  const send = command => appendFileSync(commands, `${JSON.stringify(command)}\n`)
  const driver = spawn('python', ['-c', PTY_DRIVER, JSON.stringify({ cwd: project, env, commands, screen,
    command: 'claude --model claude-sonnet-4-5 --dangerously-skip-permissions' })], { cwd: project, env, windowsHide: true, stdio: 'ignore' })
  const visible = () => readFileSync(screen, 'utf8').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  const descriptor = () => {
    const sessions = path.join(config, 'sessions')
    if (!existsSync(sessions)) return null
    for (const name of readdirSync(sessions).filter(file => /^\d+\.json$/.test(file))) {
      try { return JSON.parse(readFileSync(path.join(sessions, name), 'utf8')) } catch { /* being written */ }
    }
    return null
  }
  let session = null
  const answerInTerminal = async (description, match, from) => {
    send({ enter: true })
    return until(description, async () => {
      const found = results.slice(from).find(match)
      if (found === undefined) { await sleep(5_000); if (!results.slice(from).some(match)) send({ enter: true }) }
      return results.slice(from).find(match)
    }, 60_000).catch(() => null)
  }
  try {
    const started = await until('the Claude Code session descriptor', descriptor, 60_000)
    session = started.sessionId
    await until('the session to be admitted', () => helpers.readSessionState(session, env).harness === 'claude-code', 60_000)
    const owner = await until('the attendant to record its harness process', () => helpers.readSessionIncarnation(session, env)?.harness_process, 60_000).catch(() => null)
    check('the Windows attendant records claude.exe, the process its descriptor names, as the session\'s harness process',
      owner !== null && owner.pid === started.pid && helpers.descriptorStartMatches(started.procStart, owner, null, 'win32'), { owner, descriptor: { pid: started.pid, procStart: started.procStart } })
    await sleep(3_000)

    // A self-opened picker: registered, held, then answered in the terminal.
    let from = results.length
    send({ type: 'TK-PICKER open the picker', enter: true })
    const held = await until('the picker to be registered and held', () => helpers.readSessionState(session, env).claude_picker ?? null, 90_000).catch(() => null)
    const registered = held === null ? undefined : (helpers.readSessionState(session, env).pending ?? []).find(item => item.question_id === held.question_id)
    check('a self-opened picker is registered as a device question and held by its PermissionRequest hook', held !== null && registered !== undefined,
      held === null ? visible().slice(-1500) : { question_id: held.question_id, title: registered?.title, waiter: held.waiter })
    check('the picker\'s waiter is a live process, named by its start time', held !== null && helpers.processIdentityLiveness(held.waiter) === 'alive')
    await sleep(2_000)
    const answered = await answerInTerminal('the terminal answer to reach the model', result => result.text.includes('Staging'), from)
    check('a terminal answer closes the picker and reaches the model', answered !== null, answered ?? visible().slice(-1500))
    const settled = held === null ? null : await until('Notifai to settle the answered picker', () => {
      const state = helpers.readSessionState(session, env)
      const recorded = (state.native_answer_operations ?? []).some(operation => operation.question_id === held.question_id)
      const withdrawn = !(state.pending ?? []).some(item => item.question_id === held.question_id)
      return state.claude_picker === undefined && (recorded || withdrawn) ? { recorded, withdrawn } : null
    }, 30_000).catch(() => null)
    check('Notifai settles the picker once the terminal answered it: the answer is recorded for the devices, or the question withdrawn', settled !== null,
      settled ?? helpers.readSessionState(session, env))

    // A picker Notifai cannot carry is refused, so it never sits in the terminal unseen by the devices.
    from = results.length
    send({ type: 'TK-REFUSE open the other picker', enter: true })
    const refusal = await until('the refusal to reach the model', () => results.slice(from).find(result => result.text.includes('cannot carry this picker')), 60_000).catch(() => null)
    check('a picker Notifai cannot carry is refused, with notifai ask --wait as the remedy', refusal !== null && refusal.text.includes('notifai ask --wait'),
      refusal ?? results.slice(from))

    // `ask --wait` hands back the picker, and the picker links to the question it registered.
    from = results.length
    send({ type: 'TK-WAIT ask and wait', enter: true })
    const handBack = await until('ask --wait to hand back the picker', () => results.slice(from).find(result => result.text.includes('"open_form"')), 90_000).catch(() => null)
    let asked = null
    try { asked = handBack === null ? null : JSON.parse(handBack.text.slice(handBack.text.indexOf('{'), handBack.text.lastIndexOf('}') + 1)).question_id ?? null } catch { asked = null }
    check('notifai ask --wait hands back the picker on Windows', handBack !== null && asked !== null, handBack ?? results.slice(from))
    const linked = await until('the handed-back picker to link', () => {
      const picker = helpers.readSessionState(session, env).claude_picker
      return picker !== undefined && picker.question_id === asked ? picker : null
    }, 60_000).catch(() => null)
    check('the handed-back picker links to the question ask registered, and nothing is registered twice', linked !== null &&
      (helpers.readSessionState(session, env).pending ?? []).filter(item => item.title === 'Cache region').length === 1,
    linked ?? { picker: helpers.readSessionState(session, env).claude_picker, results: results.slice(from) })
    await sleep(1_500)
    const waited = await answerInTerminal('the handed-back picker\'s answer to reach the model', result => result.text.includes('East'), results.length)
    check('the handed-back picker\'s terminal answer reaches the model', waited !== null, waited ?? visible().slice(-1500))
  } catch (error) {
    check('the Claude Code picker scenario ran', false, `${error instanceof Error ? error.message : String(error)} ${visible().slice(-2000)}`)
  } finally {
    send({ quit: true })
    await sleep(2_000)
    killTree(driver.pid)
  }
  const logs = await notifai(env, ['logs', '--json', '--all-projects', '--all', ...(session === null ? [] : ['--session', session])], project)
  return { session, log: logs.stdout.split('\n').filter(Boolean).slice(-80), screen: visible().slice(-4000) }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This proof runs on Windows only')
  const scratch = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nfwf-')))
  const helpers = {
    ...(await distModule('install-hooks.js')),
    ...(await distModule('hook-session-state.js')),
    ...(await distModule('process-identity.js')),
    ...(await distModule('windows-hook-source.js')),
    ...(await distModule('windows-codex-command.js')),
    ...(await distModule('codex-card-capability.js')),
  }
  // One credential on this runner's own account, for a service address nothing listens on.
  const credentials = new (await distModule('credentials.js')).FileStore(baseEnv({}), { platform: 'win32' })
  credentials.save({ machineId: 'mch_windows_forms', secret: 'windows-forms-not-a-secret', baseUrl: DEAD_SERVICE, machineName: 'windows-forms-runner' })
  const mock = await startMockModel()
  const report = { started: new Date().toISOString(), node: process.version }
  for (const tool of ['codex', 'claude']) report[`${tool}_version`] = (spawnSync('cmd.exe', ['/d', '/c', `${tool} --version`], { encoding: 'utf8', windowsHide: true }).stdout ?? '').trim()
  for (const [name, scenario] of [['codex_chain', () => codexChain(mock, scratch, helpers)], ['codex_cards', () => codexCards(mock, scratch, helpers)],
    ['claude_pickers', () => claudePickers(mock, scratch, helpers)]]) {
    try { report[name] = await scenario() } catch (error) { check(`the ${name} scenario ran`, false, error instanceof Error ? error.stack : String(error)) }
  }
  await mock.close()
  credentials.clear()
  report.checks = checks
  report.ok = checks.length > 0 && checks.every(item => item.ok)
  writeFileSync(process.argv[2] ?? 'windows-question-forms.json', JSON.stringify(report, null, 2))
  process.stdout.write(`${report.ok ? 'PASS' : 'FAIL'}: ${checks.filter(item => item.ok).length}/${checks.length} checks\n`)
  process.exit(report.ok ? 0 : 1)
}

await main()
