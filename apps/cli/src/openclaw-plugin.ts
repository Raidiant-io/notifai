import path from 'node:path'
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  type JSONPath,
  type ParseError,
} from 'jsonc-parser'
import { hookHostPlatform, type HookHostPlatform } from './hook-adapter.js'
import { harnessAccountHome } from './install-hooks.js'
import {
  MISSING_LIFECYCLE_GUIDANCE_CONTEXT,
  WORKER_ACTIVATION_CONTEXT,
} from './session-activation.js'

/**
 * The OpenClaw adapter.
 *
 * OpenClaw's extension point is an in-process Gateway plugin, not a command
 * hook. The generated module shells out to the same `notifai hook <event>`
 * commands every other harness invokes, so presence, activation, and
 * retirement stay in the CLI.
 *
 *   session_start      -> openclaw-lifecycle              (generation observation)
 *   before_reset       -> openclaw-lifecycle              (retire the old generation)
 *   before_prompt_build -> session-start / subagent-start (context once per generation)
 *   message_received    -> user-prompt-submit              (User is present)
 *   agent_end           -> stop                            (the turn ended)
 *   session_end         -> session-end                     (retire local state)
 *   resolve_exec_env    -> NOTIFAI_ACTIVE_* markers        (exact Source Context)
 *
 * `command:stop` is a User abort and is deliberately not wired. The Gateway
 * service owns answer continuation after agent_end records its turn boundary.
 */

export const OPENCLAW_PLUGIN_MARKER = '// notifai managed openclaw plugin'
export const OPENCLAW_PLUGIN_ID = 'notifai'
export const OPENCLAW_PLUGIN_FILENAME = 'index.js'
export const OPENCLAW_PLUGIN_MANIFEST = 'openclaw.plugin.json'
export const OPENCLAW_PLUGIN_PACKAGE = 'package.json'

const OPENCLAW_ADAPTER_VERSION = 4

export function openclawStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  const override = env['OPENCLAW_STATE_DIR']
  if (override !== undefined && override !== '') return override
  const homeOverride = env['OPENCLAW_HOME']
  if (homeOverride !== undefined && homeOverride !== '') {
    return path.join(homeOverride, '.openclaw')
  }
  return path.join(harnessAccountHome(env, platform), '.openclaw')
}

export function openclawConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  const override = env['OPENCLAW_CONFIG_PATH']
  if (override !== undefined && override !== '') return override
  return path.join(openclawStateDir(env, platform), 'openclaw.json')
}

export function openclawPluginDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  return path.join(openclawStateDir(env, platform), 'extensions', OPENCLAW_PLUGIN_ID)
}

export function openclawPluginPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  return path.join(openclawPluginDir(env, platform), OPENCLAW_PLUGIN_FILENAME)
}

/** A Project-scoped plugin directory an older build wrote; removal only. */
export function legacyOpenclawProjectPluginDir(cwd: string): string {
  return path.join(cwd, '.openclaw', 'extensions', OPENCLAW_PLUGIN_ID)
}

export function legacyOpenclawProjectPluginPath(cwd: string): string {
  return path.join(legacyOpenclawProjectPluginDir(cwd), OPENCLAW_PLUGIN_FILENAME)
}

export interface OpenclawPluginOptions {
  adapterPath: string
  timeoutSeconds: number
  platform?: NodeJS.Platform | HookHostPlatform
  nodePath?: string
}

/** Gateway-owned answer pointer delivery. The generated module stays standalone. */
function openclawContinuationServiceSource(): string {
  return `
let continuationService = null
let JOURNAL_DIR = null

function readinessPath() {
  return path.join(path.dirname(JOURNAL_DIR), "continuation-ready.json")
}

function writeReadiness(target) {
  const start = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
    encoding: "utf8", timeout: 2_000,
    env: { PATH: process.env.PATH ?? "/bin:/usr/bin", TZ: "UTC", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim().replace(/\\s+/g, " ")
  if (start === "") return false
  const file = readinessPath()
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = file + "." + randomUUID() + ".tmp"
  writeFileSync(temp, JSON.stringify({ pid: process.pid, start,
    script: target.script, script_mtime: statSync(target.script).mtimeMs }) + "\\n",
    { mode: 0o600, flag: "wx" })
  renameSync(temp, file)
  return true
}

function clearReadiness() {
  try { unlinkSync(readinessPath()) } catch { /* Already absent. */ }
}

function journalPath(deliveryId) {
  return path.join(JOURNAL_DIR, deliveryId + ".json")
}

function saveJournal(record) {
  mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 })
  const file = journalPath(record.delivery_id)
  const temp = file + "." + randomUUID() + ".tmp"
  writeFileSync(temp, JSON.stringify(record) + "\\n", { mode: 0o600, flag: "wx" })
  const fd = openSync(temp, "r")
  try { fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temp, file)
  try {
    const directory = openSync(JOURNAL_DIR, "r")
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } catch { /* Directory fsync is unavailable on some hosts. */ }
}

function readJournals() {
  try {
    return readdirSync(JOURNAL_DIR).filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        try {
          const record = JSON.parse(readFileSync(path.join(JOURNAL_DIR, name), "utf8"))
          return record && typeof record.delivery_id === "string" ? [record] : []
        } catch { return [] }
      })
  } catch { return [] }
}

function existingJournal(deliveryId) {
  try {
    return JSON.parse(readFileSync(journalPath(deliveryId), "utf8"))
  } catch { return null }
}

function openclawCliTarget(config) {
  if (process.env.OPENCLAW_SHELL === "exec") return null
  const gateway = config?.gateway ?? {}
  if (gateway.mode === "remote" || (gateway.bind !== undefined && gateway.bind !== "loopback")) return null
  let script
  try { script = realpathSync(process.argv[1]) } catch { return null }
  let folder = path.dirname(script)
  let packageVersion = null
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(folder, "package.json"), "utf8"))
      if (manifest.name === "openclaw" && typeof manifest.version === "string") {
        packageVersion = manifest.version
        break
      }
    } catch { /* Keep walking within this executable's ancestors. */ }
    const parent = path.dirname(folder)
    if (parent === folder) return null
    folder = parent
  }
  const explicit = []
  for (let i = 0; i < process.argv.length - 1; i += 1) {
    if (process.argv[i] === "--port") explicit.push(Number(process.argv[i + 1]))
  }
  if (explicit.length > 1) return null
  const configured = Number(gateway.port ?? process.env.OPENCLAW_GATEWAY_PORT ?? 18789)
  const port = explicit[0] ?? configured
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { script, port, packageVersion }
}

function openclawExec(target, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [target.script, ...args], {
      shell: false, windowsHide: true, timeout: 20_000, maxBuffer: 2_000_000,
      env: process.env,
    }, (error, stdout) => {
      if (error) reject(new Error("OpenClaw CLI call failed"))
      else resolve(stdout.trim())
    })
  })
}

async function gatewayCall(target, method, params) {
  const output = await openclawExec(target, ["gateway", "call", method,
    "--port", String(target.port), "--params", JSON.stringify(params), "--json"])
  return JSON.parse(output)
}

async function verifiedGatewayTarget(config, logger) {
  const target = openclawCliTarget(config)
  if (target === null) {
    logger?.warn?.("notifai continuation target: local CLI path or Gateway bind unavailable")
    return null
  }
  try {
    const banner = (await openclawExec(target, ["--version"])).trim()
    const cliVersion = /^OpenClaw ([0-9]+\\.[0-9]+\\.[0-9]+)(?: \\([0-9a-f]+\\))?$/.exec(banner)?.[1]
    const status = await gatewayCall(target, "status", {})
    if (cliVersion !== target.packageVersion || status?.runtimeVersion !== cliVersion) {
      logger?.warn?.("notifai continuation target: CLI and Gateway versions differ")
      return null
    }
    if (status?.pid !== process.pid) {
      logger?.warn?.("notifai continuation target: Gateway process identity differs")
      return null
    }
    return target
  } catch {
    logger?.warn?.("notifai continuation target: local CLI status unavailable")
    return null
  }
}

function submissionKey(record) {
  return "notifai-" + record.delivery_id + "-a" + record.attempt
}

function submissionIdentity(message) {
  const meta = message?.metadata ?? message?.__openclaw ?? {}
  return message?.idempotencyKey ?? meta.idempotencyKey ?? null
}

async function inspectSubmission(target, record) {
  let offset = 0
  let before
  let pendingFinished = false
  let interrupted = false
  for (let page = 0; page < 1000; page += 1) {
    const params = { sessionKey: record.session_key, limit: 200, offset,
      ...(before === undefined ? {} : { pendingBefore: before }) }
    const history = await gatewayCall(target, "chat.history", params)
    if (history?.kind === "reset" || history?.truncationReason ||
        (record.openclaw_session_id && history?.sessionInfo?.sessionId &&
          history.sessionInfo.sessionId !== record.openclaw_session_id)) return "unconfirmed"
    const messages = history?.messages
    if (!Array.isArray(messages)) return "unconfirmed"
    if (messages.some((entry) => entry?.role === "user" &&
        submissionIdentity(entry) === submissionKey(record) + ":user")) return "transcript"
    const pending = history?.pendingInputs
    if (!pending || !Array.isArray(pending.items) ||
        !Number.isInteger(pending.total) || pending.total < pending.items.length ||
        typeof history.hasMore !== "boolean") return "unconfirmed"
    for (const item of pending.items) {
      if (item?.runId !== submissionKey(record) &&
          item?.idempotencyKey !== submissionKey(record)) continue
      if (item.state === "queued" || item.state === "running") return "pending"
      if (item.state === "interrupted" || item.state === "cancelled") interrupted = true
      else return "unconfirmed"
    }
    const nextOffset = history.nextOffset
    const hasMore = history.hasMore === true
    const nextBefore = pending.nextBefore
    if (!pendingFinished && typeof nextBefore === "string" && nextBefore !== before) {
      before = nextBefore
      continue
    }
    if (!pendingFinished && pending.total > pending.items.length) return "unconfirmed"
    pendingFinished = true
    if (hasMore && Number.isInteger(nextOffset) && nextOffset > offset) {
      offset = nextOffset
      before = undefined
      continue
    }
    if (hasMore) return "unconfirmed"
    return interrupted ? "interrupted" : "absent"
  }
  return "unconfirmed"
}

function pointerMessage(record) {
  return "A Notifai reply is waiting for this session. " +
    record.request_ids.map((id) => "Run notifai replies " + id +
      " --json, then notifai acknowledge " + id +
      " with the concrete work you will do.").join(" ")
}

function spawnOwnedHook(event, envelope, extraFds = false) {
  const child = spawn(HOOK_COMMAND, [...HOOK_PREFIX, "hook", event,
    "--owner", "notifai", "--harness", "openclaw"], {
    cwd: envelope.cwd,
    env: { ...process.env, NOTIFAI_HOOK_SOURCE_PID: String(process.pid) },
    shell: false, windowsHide: true,
    stdio: extraFds ? ["pipe", "ignore", "ignore", "pipe", "pipe"] : ["pipe", "ignore", "ignore"],
  })
  child.stdin.end(JSON.stringify(envelope))
  return child
}

function makeContinuationService(config, logger) {
  const active = new Map()
  const delivering = new Set()
  const reported = new Map()
  let stopped = false
  let timer = null
  let scanning = false
  let ready = false

  function report(record, reason) {
    if (reported.get(record.delivery_id) === reason) return
    reported.set(record.delivery_id, reason)
    logger?.warn?.("notifai continuation " + record.delivery_id + ": " + reason)
  }

  async function deliver(record) {
    if (delivering.has(record.delivery_id) || record.phase === "transcript") return
    delivering.add(record.delivery_id)
    try {
      const envelope = { session_id: record.session_key, cwd: record.cwd,
        openclaw_session_id: record.openclaw_session_id }
      const generation = (await runHook("openclaw-generation", envelope))?.trim()
      if (generation !== record.generation) { report(record, "generation-fenced"); return }
      if (record.phase === "prepared") {
        const proved = await runHook("openclaw-verify-prepared", {
          ...envelope, openclaw_request_ids: record.request_ids })
        if (proved?.trim() !== "committed") return
        record = { ...record, phase: "committed" }
        saveJournal(record)
      }
      const target = await verifiedGatewayTarget(config, logger)
      if (target === null) { report(record, "gateway-target-unverified"); return }
      const state = await inspectSubmission(target, record)
      if (state === "unconfirmed") { report(record, "history-unconfirmed"); return }
      if (state === "transcript") {
        saveJournal({ ...record, phase: "transcript" })
        return
      }
      if (state === "pending") {
        if (record.phase !== "admitted") saveJournal({ ...record, phase: "admitted" })
        return
      }
      if (state === "interrupted" || (state === "absent" && record.phase === "admitted")) {
        record = { ...record, attempt: record.attempt + 1, phase: "committed" }
        saveJournal(record)
      }
      if (state !== "absent" && state !== "interrupted") return
      saveJournal({ ...record, phase: "submitting" })
      report(record, "submitting-pointer")
      await gatewayCall(target, "chat.send", { sessionKey: record.session_key,
        message: pointerMessage(record), queueMode: "followup",
        idempotencyKey: submissionKey(record) })
      saveJournal({ ...record, phase: "admitted" })
      report(record, "pointer-admitted")
    } catch {
      // An uncertain RPC is reconciled by identity before any retry.
      report(record, "rpc-or-journal-unconfirmed")
    } finally {
      delivering.delete(record.delivery_id)
    }
  }

  function startSettlement(session, entry) {
    const envelope = { session_id: session.session_key, cwd: session.cwd,
      openclaw_session_id: session.session_id, hook_event_name: "SessionStart" }
    const child = spawnOwnedHook("openclaw-settlement", envelope, true)
    entry.child = child
    let buffer = ""
    let prepared = null
    child.stdio[3].setEncoding("utf8")
    child.stdio[3].on("data", (chunk) => {
      buffer += chunk
      for (;;) {
        const end = buffer.indexOf("\\n")
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let payload
        try { payload = JSON.parse(line) } catch { continue }
        if (payload.type === "prepare") {
          const ids = payload.request_ids
          if (payload.session_key !== session.session_key ||
              payload.generation !== session.generation || !Array.isArray(ids) ||
              ids.length < 1 || ids.some((id) => typeof id !== "string" ||
                !/^req_[A-Za-z0-9_-]+$/.test(id))) continue
          const deliveryId = createHash("sha256")
            .update(session.generation + "\\0" + ids.join("\\0"))
            .digest("hex").slice(0, 32)
          const existing = existingJournal(deliveryId)
          if (existing === null && existsSync(journalPath(deliveryId))) continue
          if (existing !== null && (existing.session_key !== session.session_key ||
              existing.generation !== session.generation ||
              JSON.stringify(existing.request_ids) !== JSON.stringify(ids))) continue
          prepared = existing ?? { delivery_id: deliveryId, session_key: session.session_key,
            cwd: session.cwd, generation: session.generation,
            openclaw_session_id: session.session_id, request_ids: ids,
            attempt: 1, phase: "prepared" }
          if (existing === null) saveJournal(prepared)
          child.stdio[4].write('{"type":"prepared"}\\n')
        } else if (payload.type === "committed" && prepared !== null) {
          if (prepared.phase === "prepared") {
            prepared = { ...prepared, phase: "committed" }
            saveJournal(prepared)
          }
          void deliver(prepared)
        }
      }
    })
    child.on("close", () => {
      const current = active.get(session.session_key)
      if (current?.child === child) {
        current.child = null
      }
    })
  }

  function startSession(session) {
    const envelope = { session_id: session.session_key, cwd: session.cwd,
      openclaw_session_id: session.session_id, hook_event_name: "SessionStart" }
    const entry = { generation: session.generation,
      attendant: spawnOwnedHook("attend", envelope), child: null }
    active.set(session.session_key, entry)
    startSettlement(session, entry)
  }

  async function tick() {
    if (stopped || scanning) return
    scanning = true
    try {
      if (!ready) {
        const target = await verifiedGatewayTarget(config, logger)
        if (target === null || !writeReadiness(target)) return
        ready = true
      }
      const raw = await runHook("openclaw-list-pending", { cwd: process.cwd() })
      const pending = raw === null ? [] : JSON.parse(raw)
      if (Array.isArray(pending)) for (const session of pending) {
        if (typeof session?.session_key !== "string" ||
            typeof session?.cwd !== "string" ||
            typeof session?.generation !== "string") continue
        const current = active.get(session.session_key)
        if (current?.generation === session.generation) {
          if (current.attendant.exitCode !== null) {
            active.delete(session.session_key)
            if (current.child !== null) current.child.kill("SIGTERM")
            startSession(session)
          } else if (current.child === null) {
            const ready = await runHook("openclaw-attendance-ready", {
              session_id: session.session_key, cwd: session.cwd,
              openclaw_session_id: session.session_id })
            if (ready?.trim() === "ready") startSettlement(session, current)
          }
          continue
        }
        if (current) {
          if (current.child !== null) current.child.kill("SIGTERM")
          current.attendant.kill("SIGTERM")
        }
        startSession(session)
      }
      for (const record of readJournals()) void deliver(record)
    } catch { /* The next Gateway tick retries discovery. */ }
    finally { scanning = false }
  }

  return {
    start() { timer = setInterval(() => { void tick() }, 2_000); void tick() },
    stop() {
      stopped = true
      clearReadiness()
      if (timer !== null) clearInterval(timer)
      for (const entry of active.values()) {
        if (entry.child !== null) entry.child.kill("SIGTERM")
        entry.attendant.kill("SIGTERM")
      }
      active.clear()
    },
  }
}
`
}

export function openclawPluginManifest(): string {
  return `${JSON.stringify(
    {
      id: OPENCLAW_PLUGIN_ID,
      name: 'Notifai',
      description: 'Notifai lifecycle activation, Source Context, and session observation.',
      activation: { onStartup: true },
      configSchema: { type: 'object', additionalProperties: false },
    },
    null,
    2,
  )}\n`
}

export function openclawPluginPackage(): string {
  return `${JSON.stringify(
    {
      name: 'notifai-openclaw',
      version: '1.0.0',
      type: 'module',
      openclaw: { extensions: [`./${OPENCLAW_PLUGIN_FILENAME}`] },
    },
    null,
    2,
  )}\n`
}

export function openclawPluginSource(options: OpenclawPluginOptions): string {
  const { adapterPath, timeoutSeconds } = options
  const win32 = hookHostPlatform(options.platform) === 'win32'
  const nodeConstant = win32
    ? `const NODE = ${JSON.stringify(options.nodePath ?? process.execPath)}\n`
    : ''
  const spawnArguments = win32
    ? 'NODE, [ADAPTER, "hook", event, "--owner", "notifai", "--harness", "openclaw"]'
    : 'ADAPTER, ["hook", event, "--owner", "notifai", "--harness", "openclaw"]'
  const windowsHide = win32 ? '\n        windowsHide: true,' : ''
  return `${OPENCLAW_PLUGIN_MARKER}
// Generated by \`notifai hooks install --harness openclaw\`. Edits are lost on
// the next install; change the CLI instead, which is where the logic lives.
import { spawn, execFile, execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

${nodeConstant}const ADAPTER = ${JSON.stringify(adapterPath)}
const HOOK_COMMAND = ${JSON.stringify(win32 ? options.nodePath ?? process.execPath : adapterPath)}
const HOOK_PREFIX = ${JSON.stringify(win32 ? [adapterPath] : [])}
const TIMEOUT_MS = ${timeoutSeconds * 1000}
const ADAPTER_VERSION = ${OPENCLAW_ADAPTER_VERSION}
const MISSING_LIFECYCLE_GUIDANCE_CONTEXT = ${JSON.stringify(MISSING_LIFECYCLE_GUIDANCE_CONTEXT)}
const WORKER_ACTIVATION_CONTEXT = ${JSON.stringify(WORKER_ACTIVATION_CONTEXT)}

function runHook(event, envelope) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(${spawnArguments}, {
        env: process.env,
        shell: false,${windowsHide}
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch {
      resolve(null)
      return
    }

    let stdout = ""
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      finish(null)
    }, TIMEOUT_MS)

    child.stdout?.setEncoding("utf-8")
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.resume()
    child.on("error", () => finish(null))
    child.on("close", (code) => finish(code === 0 ? stdout : null))

    try {
      child.stdin?.end(JSON.stringify(envelope))
    } catch {
      finish(null)
    }
  })
}

function sessionKeyOf(event, ctx) {
  const key = ctx?.sessionKey ?? event?.sessionKey ?? event?.context?.sessionKey
  return typeof key === "string" ? key.trim() : ""
}

function sessionIdOf(event, ctx) {
  const id = event?.sessionId ?? ctx?.sessionId
  return typeof id === "string" && id.length > 0 ? id : undefined
}

function resumedFromOf(event) {
  return typeof event?.resumedFrom === "string" && event.resumedFrom.length > 0
    ? event.resumedFrom : undefined
}

function reasonOf(event) {
  return typeof event?.reason === "string" && event.reason.length > 0
    ? event.reason : undefined
}

function workspaceDirOf(event, ctx) {
  const dir = ctx?.workspaceDir ?? event?.workspaceDir ?? event?.context?.workspaceDir
  return typeof dir === "string" && dir.length > 0 ? dir : process.cwd()
}

function isWorkerSession(sessionKey, ctx) {
  if (sessionKey === "") return true
  if (sessionKey.includes(":subagent:")) return true
  if (sessionKey.includes(":acp:")) return true
  if (ctx?.targetKind === "acp" || ctx?.dispatchKind === "acp") return true
  if (typeof ctx?.parentSessionKey === "string" && ctx.parentSessionKey.length > 0) return true
  return false
}

function isUserMessage(event, ctx) {
  const from = event?.from ?? event?.context?.from ?? ctx?.senderId
  if (typeof from !== "string" || from.trim().length === 0) return false
  const trigger = ctx?.trigger ?? event?.trigger
  if (trigger === "cron" || trigger === "heartbeat") return false
  return true
}

function envelopeFor(sessionKey, event, ctx, hookEventName) {
  return {
    session_id: sessionKey,
    cwd: workspaceDirOf(event, ctx),
    hook_event_name: hookEventName,
    openclaw_session_id: sessionIdOf(event, ctx),
    openclaw_reason: reasonOf(event),
    openclaw_resumed_from: resumedFromOf(event),
  }
}

function onIfSupported(api, name, handler) {
  try {
    api.on(name, handler)
  } catch {
    // Older OpenClaw builds may reject a typed hook. The prompt fallback
    // remains available, while unobserved rotations cannot be guessed.
  }
}

${openclawContinuationServiceSource()}

function register(api) {
  api.registerService?.({
    id: "notifai-continuation",
    start(ctx) {
      if (typeof ctx.stateDir !== "string" || !path.isAbsolute(ctx.stateDir)) return
      JOURNAL_DIR = path.join(ctx.stateDir, "notifai", "continuation-journal")
      continuationService = makeContinuationService(ctx.config, ctx.logger)
      continuationService.start()
    },
    stop() {
      continuationService?.stop()
      continuationService = null
    },
  })
  onIfSupported(api, "session_start", async (event, ctx) => {
    const sessionKey = sessionKeyOf(event, ctx)
    if (sessionKey === "") return
    await runHook("openclaw-lifecycle", envelopeFor(sessionKey, event, ctx, "SessionStart"))
  })

  onIfSupported(api, "before_reset", async (event, ctx) => {
    const sessionKey = sessionKeyOf(event, ctx)
    if (sessionKey === "") return
    await runHook("openclaw-lifecycle", envelopeFor(sessionKey, event, ctx, "BeforeReset"))
  })

  api.on("before_prompt_build", async (event, ctx) => {
    const sessionKey = sessionKeyOf(event, ctx)
    if (sessionKey === "") return { prependContext: WORKER_ACTIVATION_CONTEXT }
    const worker = isWorkerSession(sessionKey, ctx)
    const resolved = await runHook(worker ? "subagent-start" : "session-start",
      envelopeFor(sessionKey, event, ctx, worker ? "SubagentStart" : "SessionStart"))
    // chat.send does not emit message_received on this supported Gateway path.
    // The prompt build is the exact session's authoritative turn-start seam.
    await runHook("openclaw-turn-start", envelopeFor(sessionKey, event, ctx, "BeforePromptBuild"))
    // Successful empty output means this Project is disabled or this
    // generation was already activated. A later prompt rechecks enablement.
    if (resolved !== null && resolved.trim().length === 0) return
    const context = typeof resolved === "string" && resolved.trim().length > 0
      ? resolved.trim()
      : worker ? WORKER_ACTIVATION_CONTEXT : MISSING_LIFECYCLE_GUIDANCE_CONTEXT
    return { prependContext: context }
  })

  api.on("message_received", async (event, ctx) => {
    if (!isUserMessage(event, ctx)) return
    const sessionKey = sessionKeyOf(event, ctx)
    if (sessionKey === "") return
    await runHook("user-prompt-submit", {
      session_id: sessionKey,
      cwd: workspaceDirOf(event, ctx),
      hook_event_name: "UserPromptSubmit",
    })
  })

  api.on("agent_end", async (event, ctx) => {
    const sessionKey = sessionKeyOf(event, ctx)
    if (sessionKey === "") return
    await runHook("openclaw-turn-end", envelopeFor(sessionKey, event, ctx, "Stop"))
  })

  api.on("session_end", async (event, ctx) => {
    const sessionKey = sessionKeyOf(event, ctx)
    if (sessionKey === "") return
    await runHook("session-end", envelopeFor(sessionKey, event, ctx, "SessionEnd"))
  })

  api.on("resolve_exec_env", async (event, ctx) => {
    const sessionKey = sessionKeyOf(event, ctx)
    if (sessionKey === "") return
    const generation = await runHook("openclaw-generation",
      envelopeFor(sessionKey, event, ctx, "ResolveExecEnv"))
    if (generation === null || !/^[0-9a-f-]{36}$/i.test(generation.trim())) return
    return {
      NOTIFAI_ACTIVE_HARNESS: "openclaw",
      NOTIFAI_ACTIVE_SESSION_ID: sessionKey,
      NOTIFAI_ACTIVE_OPENCLAW_GENERATION: generation.trim(),
    }
  })
}

export default {
  id: ${JSON.stringify(OPENCLAW_PLUGIN_ID)},
  name: "Notifai",
  register,
}
`
}

export function isOurOpenclawPlugin(contents: string): boolean {
  return contents.includes(OPENCLAW_PLUGIN_MARKER)
}

export function openclawPluginTarget(
  contents: string,
): { adapter: string; current: boolean; timeoutSeconds?: number; nodePath?: string } | null {
  if (!isOurOpenclawPlugin(contents)) return null
  const adapter = /^const ADAPTER = (".*")$/m.exec(contents)?.[1]
  const node = /^const NODE = (".*")$/m.exec(contents)?.[1]
  const version = Number(/^const ADAPTER_VERSION = (\d+)$/m.exec(contents)?.[1] ?? 0)
  const timeoutMs = Number(/^const TIMEOUT_MS = (\d+)$/m.exec(contents)?.[1] ?? Number.NaN)
  if (adapter === undefined) return null
  try {
    return {
      adapter: JSON.parse(adapter) as string,
      current: version === OPENCLAW_ADAPTER_VERSION,
      ...(Number.isFinite(timeoutMs) ? { timeoutSeconds: timeoutMs / 1000 } : {}),
      ...(node === undefined ? {} : { nodePath: JSON.parse(node) as string }),
    }
  } catch {
    return null
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseOpenclawConfig(
  source: string,
  configFile = 'OpenClaw config',
): Record<string, unknown> {
  const errors: ParseError[] = []
  const parsed: unknown = parse(source, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    const problems = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(', ')
    throw new Error(`${configFile} contains invalid JSONC (${problems}); refusing to write`)
  }
  if (isJsonObject(parsed)) return parsed
  throw new Error(`${configFile} is not a JSON object; refusing to write`)
}

function openclawFormattingOptions(source: string) {
  const indentation = /(?:^|\r?\n)([\t ]+)(?=")/.exec(source)?.[1] ?? '  '
  return {
    insertSpaces: !indentation.includes('\t'),
    tabSize: indentation.length,
    eol: source.includes('\r\n') ? '\r\n' : '\n',
  }
}

/** Apply one JSONC edit while leaving unrelated source ranges intact. */
export function editOpenclawConfigText(
  source: string,
  configFile: string,
  location: JSONPath,
  value: unknown,
): string {
  parseOpenclawConfig(source, configFile)
  return applyEdits(
    source,
    modify(source, location, value, { formattingOptions: openclawFormattingOptions(source) }),
  )
}

function objectAt(value: unknown): Record<string, unknown> | null {
  return isJsonObject(value) ? value : null
}

/** Install or refresh Notifai's entry with a JSONC parser edit. */
export function enableOpenclawNotifaiConfigText(source: string, configFile: string): string {
  const config = parseOpenclawConfig(source, configFile)
  const merged = mergeOpenclawNotifaiEntry(config)
  const mergedPlugins = objectAt(merged.plugins)!
  const mergedEntries = objectAt(mergedPlugins['entries'])!
  const plugins = objectAt(config.plugins)

  if (plugins === null) {
    return editOpenclawConfigText(source, configFile, ['plugins'], merged.plugins)
  }
  if (Object.hasOwn(plugins, 'entries') && !isJsonObject(plugins['entries'])) {
    return editOpenclawConfigText(source, configFile, ['plugins', 'entries'], mergedEntries)
  }
  return editOpenclawConfigText(
    source,
    configFile,
    ['plugins', 'entries', OPENCLAW_PLUGIN_ID],
    mergedEntries[OPENCLAW_PLUGIN_ID],
  )
}

interface JsoncGap {
  comma: number | null
  hasComment: boolean
}

// jsonc-parser's SyntaxKind is an ambient const enum, unavailable with
// verbatimModuleSyntax. Keep the scanner token values local to this helper.
const COMMA_TOKEN = 5
const LINE_COMMENT_TOKEN = 12
const BLOCK_COMMENT_TOKEN = 13
const EOF_TOKEN = 17

function jsoncGap(source: string, from: number, to: number): JsoncGap {
  const scanner = createScanner(source)
  scanner.setPosition(from)
  let comma: number | null = null
  let hasComment = false
  while (scanner.getPosition() < to) {
    const token = scanner.scan()
    const offset = scanner.getTokenOffset()
    if (offset >= to || token === EOF_TOKEN) break
    if (token === COMMA_TOKEN) comma = offset
    if (token === LINE_COMMENT_TOKEN || token === BLOCK_COMMENT_TOKEN) {
      hasComment = true
    }
  }
  return { comma, hasComment }
}

function removeJsoncItem(source: string, path: JSONPath): string {
  const root = parseTree(source)
  if (root === undefined) return source
  const value = findNodeAtLocation(root, path)
  if (value === undefined) return source
  const item = value.parent?.type === 'property' ? value.parent : value
  const container = item.parent
  const siblings = container?.children
  if (container === undefined || siblings === undefined) return source
  const index = siblings.indexOf(item)
  if (index < 0) return source
  const end = item.offset + item.length
  const ranges: Array<[number, number]> = []

  if (index < siblings.length - 1) {
    const gap = jsoncGap(source, end, siblings[index + 1]!.offset)
    if (gap.comma === null) return source
    if (gap.hasComment) {
      ranges.push([item.offset, end], [gap.comma, gap.comma + 1])
    } else {
      ranges.push([item.offset, gap.comma + 1])
    }
  } else {
    const trailing = jsoncGap(source, end, container.offset + container.length - 1)
    if (trailing.comma !== null) ranges.push([trailing.comma, trailing.comma + 1])
    if (index > 0) {
      const previous = siblings[index - 1]!
      const gap = jsoncGap(source, previous.offset + previous.length, item.offset)
      if (gap.comma === null) return source
      if (gap.hasComment) {
        ranges.push([gap.comma, gap.comma + 1], [item.offset, end])
      } else {
        ranges.push([gap.comma, end])
      }
    } else {
      // An inserted sole property occupies a line of its own. Recover the
      // original commented-empty object by removing that added line.
      const lineStart = source.lastIndexOf('\n', item.offset - 1) + 1
      const lineEndOffset = source.indexOf('\n', end)
      const lineEnd = lineEndOffset < 0 ? source.length : lineEndOffset
      const onOwnLine = source.slice(lineStart, item.offset).trim() === '' &&
        source.slice(end, lineEnd).trim() === (trailing.comma === null ? '' : ',')
      const lineBreakStart = source[lineStart - 2] === '\r' ? lineStart - 2 : lineStart - 1
      ranges.push([onOwnLine && lineStart > 0 ? lineBreakStart : item.offset, end])
    }
  }

  let text = source
  for (const [start, stop] of ranges.sort((a, b) => b[0] - a[0])) {
    text = text.slice(0, start) + text.slice(stop)
  }
  return text
}

function removeOpenclawLoadPathText(source: string, pluginDir: string): string {
  let text = source
  for (;;) {
    const config = parseOpenclawConfig(text)
    const paths = objectAt(objectAt(config.plugins)?.['load'])?.['paths']
    if (!Array.isArray(paths)) return text
    const index = paths.findIndex((value) => value === pluginDir)
    if (index < 0) return text
    const next = removeJsoncItem(text, ['plugins', 'load', 'paths', index])
    if (next === text) throw new Error('Could not remove the OpenClaw load path')
    text = next
  }
}

/** Remove only the entry and explicit load path owned by this installation. */
export function removeOpenclawNotifaiConfigText(
  source: string,
  configFile: string,
  pluginDir: string,
): string {
  const config = parseOpenclawConfig(source, configFile)
  const entries = objectAt(objectAt(config.plugins)?.['entries'])
  const withoutEntry = entries !== null && Object.hasOwn(entries, OPENCLAW_PLUGIN_ID)
    ? removeJsoncItem(source, ['plugins', 'entries', OPENCLAW_PLUGIN_ID])
    : source
  return removeOpenclawLoadPathText(withoutEntry, pluginDir)
}

/** Remove one older Project load path while leaving the shared entry alone. */
export function removeOpenclawLoadPathConfigText(
  source: string,
  configFile: string,
  pluginDir: string,
): string {
  parseOpenclawConfig(source, configFile)
  return removeOpenclawLoadPathText(source, pluginDir)
}

export interface OpenclawPluginLoadBlocker {
  key: 'plugins.allow' | 'plugins.deny'
  action: 'add' | 'remove'
}

export function openclawPluginLoadBlockers(
  config: Record<string, unknown>,
): OpenclawPluginLoadBlocker[] {
  const plugins = objectAt(config.plugins)
  if (plugins === null) return []
  const blockers: OpenclawPluginLoadBlocker[] = []
  const allow = plugins['allow']
  if (Array.isArray(allow) && allow.length > 0 && !allow.includes(OPENCLAW_PLUGIN_ID)) {
    blockers.push({ key: 'plugins.allow', action: 'add' })
  }
  const deny = plugins['deny']
  if (Array.isArray(deny) && deny.includes(OPENCLAW_PLUGIN_ID)) {
    blockers.push({ key: 'plugins.deny', action: 'remove' })
  }
  return blockers
}

export function openclawPluginLoadRemedy(blocker: OpenclawPluginLoadBlocker): string {
  return blocker.action === 'add'
    ? `add \"${OPENCLAW_PLUGIN_ID}\" to ${blocker.key}`
    : `remove \"${OPENCLAW_PLUGIN_ID}\" from ${blocker.key}`
}

export function openclawPluginLoadWarning(blockers: OpenclawPluginLoadBlocker[]): string | null {
  if (blockers.length === 0) return null
  return `OpenClaw will not load Notifai: ${blockers.map(openclawPluginLoadRemedy).join('; ')}.`
}

export function mergeOpenclawNotifaiEntry(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const plugins =
    config.plugins !== null && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
      ? { ...(config.plugins as Record<string, unknown>) }
      : {}
  const entries =
    plugins.entries !== null && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
      ? { ...(plugins.entries as Record<string, unknown>) }
      : {}
  const existing =
    entries[OPENCLAW_PLUGIN_ID] !== null &&
    typeof entries[OPENCLAW_PLUGIN_ID] === 'object' &&
    !Array.isArray(entries[OPENCLAW_PLUGIN_ID])
      ? { ...(entries[OPENCLAW_PLUGIN_ID] as Record<string, unknown>) }
      : {}
  const hooks =
    existing.hooks !== null && typeof existing.hooks === 'object' && !Array.isArray(existing.hooks)
      ? { ...(existing.hooks as Record<string, unknown>) }
      : {}
  entries[OPENCLAW_PLUGIN_ID] = {
    ...existing,
    enabled: true,
    hooks: { ...hooks, allowConversationAccess: true },
  }
  plugins.entries = entries
  return { ...config, plugins }
}

/**
 * Drop a Project-scoped plugin directory from OpenClaw's explicit load paths,
 * leaving the shared `entries` record — and therefore the Machine plugin —
 * exactly as it was.
 */
export function removeOpenclawLoadPath(
  config: Record<string, unknown>,
  pluginDir: string,
): Record<string, unknown> {
  const currentPlugins = objectAt(config.plugins)
  const currentLoad = objectAt(currentPlugins?.['load'])
  if (currentPlugins === null || currentLoad === null || !Array.isArray(currentLoad['paths'])) {
    return config
  }
  const load = { ...currentLoad }
  const originalPaths = currentLoad['paths'] as unknown[]
  const paths = originalPaths.filter((value) => value !== pluginDir)
  if (paths.length === originalPaths.length) return config
  load.paths = paths
  return { ...config, plugins: { ...currentPlugins, load } }
}

export function removeOpenclawNotifaiEntry(
  config: Record<string, unknown>,
  pluginDir: string,
): Record<string, unknown> {
  if (!isJsonObject(config.plugins)) return config
  const currentPlugins = config.plugins as Record<string, unknown>
  const currentEntries = objectAt(currentPlugins['entries'])
  const currentLoad = objectAt(currentPlugins['load'])
  const removesEntry =
    currentEntries !== null && Object.hasOwn(currentEntries, OPENCLAW_PLUGIN_ID)
  const removesLoadPath =
    currentLoad !== null &&
    Array.isArray(currentLoad['paths']) &&
    currentLoad['paths'].includes(pluginDir)
  if (!removesEntry && !removesLoadPath) return config
  const plugins = { ...currentPlugins }
  if (removesEntry) {
    const entries = { ...currentEntries }
    delete entries[OPENCLAW_PLUGIN_ID]
    plugins.entries = entries
  }
  if (removesLoadPath) {
    plugins.load = {
      ...currentLoad,
      paths: (currentLoad['paths'] as unknown[]).filter((value) => value !== pluginDir),
    }
  }
  return { ...config, plugins }
}

/** Config-directory presence is not ownership. These files mean OpenClaw is actually configured. */
export function openclawHasGlobalEvidence(
  exists: (file: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): boolean {
  const state = openclawStateDir(env, platform)
  return (
    exists(openclawConfigPath(env, platform)) ||
    exists(path.join(state, 'agents')) ||
    exists(path.join(state, 'workspace'))
  )
}
