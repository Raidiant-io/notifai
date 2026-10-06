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

const OPENCLAW_ADAPTER_VERSION = 6

export function openclawStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  const override = env['OPENCLAW_STATE_DIR']
  if (override !== undefined && override !== '') return override
  const profile = env['OPENCLAW_PROFILE']?.trim()
  if (profile && profile !== 'default' && !/^[a-zA-Z0-9_-]+$/.test(profile)) {
    throw new Error('OPENCLAW_PROFILE must be a simple profile name')
  }
  const directory = profile && profile !== 'default' ? `.openclaw-${profile}` : '.openclaw'
  const homeOverride = env['OPENCLAW_HOME']
  if (homeOverride !== undefined && homeOverride !== '') {
    return path.join(homeOverride, directory)
  }
  return path.join(harnessAccountHome(env, platform), directory)
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
let MESSAGE_JOURNAL_DIR = null
let pendingMessageJournals = null
let awaitingMessageContexts = new Map()
const GATEWAY_BOOT_ID = randomUUID()

// Persistent discovery, not a process lease. A host may use a state directory
// that the CLI's environment cannot reconstruct. Register before publishing
// journals; readiness deletion must never hide that directory from uninstall.
const registeredHostRoots = new Set()
const privateHostDirectories = new Set()
function privateHostDirectory(directory) {
  if (UNINSTALL_BARRIER === null || process.platform !== "win32") {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return
  }
  if (privateHostDirectories.has(directory)) return
  mkdirSync(path.dirname(directory), { recursive: true })
  execFileSync(ADAPTER, [existsSync(directory) ? "--internal-protect-existing-directory" : "--internal-private-directory", directory],
    { windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] })
  privateHostDirectories.add(directory)
}
function ownHostFile(file) {
  if (UNINSTALL_BARRIER !== null && process.platform === "win32") execFileSync(ADAPTER, ["--internal-own-created-file", file],
    { windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] })
}
let registeredHostStart = null
function hostProcessStart() {
  if (registeredHostStart !== null) return registeredHostStart
  const start = process.platform === "win32" && UNINSTALL_BARRIER !== null
    ? execFileSync(ADAPTER, ["--internal-process-info", String(process.pid)], {
      encoding: "utf8", timeout: 2_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    }).trim().split(/\\r?\\n/)[0]
    : execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
    encoding: "utf8", timeout: 2_000,
    env: { PATH: process.env.PATH ?? "/bin:/usr/bin", TZ: "UTC", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim().replace(/\\s+/g, " ")
  if (!start || (process.platform === "win32" && !/^windows-filetime:\\d+$/.test(start))) throw new Error("Host process identity unavailable")
  registeredHostStart = start
  return start
}
function recordHostRoot(directory) {
  if (UNINSTALL_BARRIER === null) return
  privateHostDirectory(directory)
  const root = realpathSync.native(directory)
  if (registeredHostRoots.has(root)) return
  const installation = path.dirname(UNINSTALL_BARRIER)
  const owner = JSON.parse(readFileSync(path.join(installation, "install.json"), "utf8"))
  if (owner?.schema !== 1 || owner.owner !== "notifai" ||
      typeof owner.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner.id)) {
    throw new Error("Cannot register native host state without installation ownership")
  }
  const index = path.join(installation, "openclaw-hosts")
  if (process.platform === "win32") execFileSync(ADAPTER, ["--internal-private-directory", index],
    { windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] })
  else mkdirSync(index, { recursive: true, mode: 0o700 })
  const info = lstatSync(index)
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid &&
      (info.uid !== process.getuid() || (info.mode & 0o022) !== 0))) throw new Error("Unsafe host index")
  const start = hostProcessStart()
  const key = root + String.fromCharCode(0) + process.pid + String.fromCharCode(0) + start
  const file = path.join(index, createHash("sha256").update(key).digest("hex") + ".json")
  const temp = file + "." + randomUUID() + ".tmp"
  writeFileSync(temp, JSON.stringify({ schema: 1, installation_id: owner.id, root, pid: process.pid, start }) + "\\n",
    { mode: 0o600, flag: "wx" })
  // Windows FlushFileBuffers requires a writable handle.
  const fd = openSync(temp, "r+")
  try { fsyncSync(fd) } finally { closeSync(fd) }
  ownHostFile(temp)
  renameSync(temp, file)
  try {
    const directory = openSync(index, "r")
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } catch { /* Directory fsync is unavailable on some hosts. */ }
  registeredHostRoots.add(root)
}

function readinessPath() {
  return path.join(path.dirname(JOURNAL_DIR), "continuation-ready.json")
}

function writeReadiness(target) {
  recordHostRoot(path.dirname(JOURNAL_DIR))
  const start = hostProcessStart()
  const file = readinessPath()
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = file + "." + randomUUID() + ".tmp"
  writeFileSync(temp, JSON.stringify({ pid: process.pid, start, boot_id: GATEWAY_BOOT_ID,
    script: target.script, script_mtime: statSync(target.script).mtimeMs }) + "\\n",
    { mode: 0o600, flag: "wx" })
  ownHostFile(temp)
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
  recordHostRoot(path.dirname(JOURNAL_DIR))
  privateHostDirectory(JOURNAL_DIR)
  const file = journalPath(record.delivery_id)
  const temp = file + "." + randomUUID() + ".tmp"
  writeFileSync(temp, JSON.stringify(record) + "\\n", { mode: 0o600, flag: "wx" })
  const fd = openSync(temp, "r+")
  try { fsyncSync(fd) } finally { closeSync(fd) }
  ownHostFile(temp)
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

function messageJournalPath(deliveryId) {
  return path.join(MESSAGE_JOURNAL_DIR, deliveryId + ".json")
}

function messageContextMarkerPath(deliveryId) {
  return path.join(MESSAGE_JOURNAL_DIR, deliveryId + ".context-used")
}

function saveMessageJournal(record) {
  recordHostRoot(path.dirname(MESSAGE_JOURNAL_DIR))
  privateHostDirectory(MESSAGE_JOURNAL_DIR)
  const file = messageJournalPath(record.delivery_id)
  const temp = file + "." + randomUUID() + ".tmp"
  const { text: _text, ...withoutText } = record
  const stored = existsSync(messageContextMarkerPath(record.delivery_id)) ? withoutText : record
  writeFileSync(temp, JSON.stringify(stored) + "\\n", { mode: 0o600, flag: "wx" })
  const fd = openSync(temp, "r+")
  try { fsyncSync(fd) } finally { closeSync(fd) }
  ownHostFile(temp)
  renameSync(temp, file)
  if (pendingMessageJournals !== null) {
    if (stored.phase === "transcript" || stored.phase === "unconfirmed") pendingMessageJournals.delete(stored.delivery_id)
    else pendingMessageJournals.set(stored.delivery_id, stored)
  }
  if (stored.phase === "transcript" && stored.text !== undefined) {
    awaitingMessageContexts.set(stored.delivery_id, stored)
  } else {
    awaitingMessageContexts.delete(stored.delivery_id)
  }
  try {
    const directory = openSync(MESSAGE_JOURNAL_DIR, "r")
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } catch { /* Directory fsync is unavailable on some hosts. */ }
  // The prompt hook runs in another plugin process. If it consumed the context
  // during this synchronous save, its marker wins and text is redacted again.
  if (stored.text !== undefined && existsSync(messageContextMarkerPath(record.delivery_id))) {
    saveMessageJournal(withoutText)
  }
}

function readMessageJournal(deliveryId) {
  try {
    const record = JSON.parse(readFileSync(messageJournalPath(deliveryId), "utf8"))
    if (!record || record.delivery_id !== deliveryId) throw new Error("Invalid message journal")
    return record
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

function retryMessageJournals() {
  if (pendingMessageJournals === null) {
    let names
    try { names = readdirSync(MESSAGE_JOURNAL_DIR) }
    catch (error) { if (error?.code !== "ENOENT") throw error; names = [] }
    const pending = new Map()
    awaitingMessageContexts = new Map()
    for (const name of names.filter((value) => value.endsWith(".json"))) {
      const record = readMessageJournal(name.slice(0, -5))
      if (record !== null && record.boot_id !== GATEWAY_BOOT_ID) {
        if (record.text !== undefined) {
          settleMessageJournal(record, record.phase === "transcript" ? "transcript" : "unconfirmed")
        }
        continue
      }
      if (record !== null && record.phase !== "transcript" && record.phase !== "unconfirmed") {
        pending.set(record.delivery_id, record)
      } else if (record !== null && record.phase === "transcript" &&
          record.text !== undefined) {
        awaitingMessageContexts.set(record.delivery_id, record)
      }
    }
    pendingMessageJournals = pending
  }
  return [...pendingMessageJournals.values()]
}

function settleMessageJournal(record, phase) {
  const { text: _text, ...rest } = record
  // A committed pointer can begin its model turn after chat.history sees the
  // user transcript. Keep context until that exact turn claims it once.
  saveMessageJournal(phase === "transcript" && record.boot_id === GATEWAY_BOOT_ID &&
    !existsSync(messageContextMarkerPath(record.delivery_id))
    ? { ...record, phase } : { ...rest, phase })
}

function nativeSessionRevision(api, sessionKey, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return null
  try {
    const entry = api.runtime?.agent?.session?.getSessionEntry?.({
      sessionKey, readConsistency: "latest",
    })
    return entry?.sessionId === sessionId &&
      typeof entry.lifecycleRevision === "string" && entry.lifecycleRevision !== ""
      ? entry.lifecycleRevision : null
  } catch { return null }
}

function claimTimeAvailable(record) {
  return typeof record.deadline_ns === "string" &&
    record.deadline_ns.length <= 32 && /^[0-9]+$/.test(record.deadline_ns) &&
    BigInt(record.deadline_ns) > process.hrtime.bigint()
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

function messagePointer(record) {
  return "Notifai Session Message " + record.message_id +
    " should appear in this turn's context. If its full context is absent, " +
    "say that this Session Message is missing and do not acknowledge it. " +
    "If present, read it and run notifai acknowledge " + record.message_id +
    " with the concrete work you will do when text is required."
}

/** Attach private text only to the admitted pointer turn of its native generation. */
async function messageContextForPointer(api, event, ctx, sessionKey, nativeRevision) {
  if (MESSAGE_JOURNAL_DIR === null || JOURNAL_DIR === null || nativeRevision === null) return null
  const prompt = typeof event?.currentUserMessage === "string"
    ? event.currentUserMessage : event?.prompt
  if (typeof prompt !== "string" || !prompt.startsWith("Notifai Session Message ")) return null
  const messageId = prompt.slice("Notifai Session Message ".length).split(" ", 1)[0]
  if (!/^sm_[A-Za-z0-9_-]+$/.test(messageId)) return null
  const envelope = { ...envelopeFor(sessionKey, event, ctx, "BeforePromptBuild"),
    openclaw_lifecycle_revision: nativeRevision }
  const generation = (await runHook("openclaw-generation", envelope))?.trim()
  if (typeof generation !== "string" || !/^[0-9a-f-]{36}$/i.test(generation)) return null
  const deliveryId = createHash("sha256").update(generation + "\\0" + messageId)
    .digest("hex").slice(0, 32)
  try {
    const record = readMessageJournal(deliveryId)
    const readiness = JSON.parse(readFileSync(readinessPath(), "utf8"))
    if (record === null || record.message_id !== messageId ||
        record.session_key !== sessionKey || record.generation !== generation ||
        record.native_revision !== nativeRevision ||
        record.openclaw_session_id !== sessionIdOf(event, ctx) ||
        record.boot_id !== readiness?.boot_id ||
        typeof record.text !== "string" ||
        (record.phase !== "submitting" && record.phase !== "admitted" &&
          record.phase !== "transcript") ||
        prompt !== messagePointer(record) ||
        existsSync(messageContextMarkerPath(deliveryId)) ||
        nativeSessionRevision(api, sessionKey, sessionIdOf(event, ctx)) !== nativeRevision) return null
    ctx?.hookInvocation?.assertActive?.()
    writeFileSync(messageContextMarkerPath(deliveryId), "used\\n", { mode: 0o600, flag: "wx" })
    ownHostFile(messageContextMarkerPath(record.delivery_id))
    saveMessageJournal(record)
    return record.text
  } catch { return null }
}

async function gatewaySessions(target) {
  let offset = 0
  const sessions = new Map()
  for (let page = 0; page < 1000; page += 1) {
    const result = await gatewayCall(target, "sessions.list", { limit: 200, offset })
    if (!Array.isArray(result?.sessions) || typeof result?.hasMore !== "boolean") return null
    for (const session of result.sessions) {
      if (typeof session?.key === "string") sessions.set(session.key, session)
    }
    if (!result.hasMore) return sessions
    if (!Number.isInteger(result.nextOffset) || result.nextOffset <= offset) return null
    offset = result.nextOffset
  }
  return null
}

async function currentSession(target, record) {
  const sessions = await gatewaySessions(target)
  const session = sessions?.get(record.session_key)
  return typeof record.openclaw_session_id === "string" &&
    session?.sessionId === record.openclaw_session_id &&
    session.archived !== true ? session : null
}

function spawnOwnedHook(event, envelope, extraFds = false) {
  const child = spawn(HOOK_COMMAND, [...HOOK_PREFIX, "hook", event,
    "--owner", "notifai", "--harness", "openclaw"], {
    cwd: envelope.cwd,
    env: { ...process.env, NOTIFAI_HOOK_SOURCE_PID: String(process.pid),
      ...(event === "attend" && extraFds ? { NOTIFAI_OPENCLAW_MESSAGE_BRIDGE: "1" } : {}) },
    shell: false, windowsHide: true,
    stdio: extraFds ? ["pipe", "ignore", "ignore", "pipe", "pipe"] : ["pipe", "ignore", "ignore"],
  })
  child.stdin.end(JSON.stringify(envelope))
  return child
}

function makeContinuationService(config, logger, api) {
  const active = new Map()
  const delivering = new Set()
  const reported = new Map()
  const deliveringMessages = new Map()
  let stopped = false
  let timer = null
  let scanning = false
  let ready = false
  let gatewayTarget = null

  function report(record, reason) {
    if (reported.get(record.delivery_id) === reason) return
    reported.set(record.delivery_id, reason)
    logger?.warn?.("notifai continuation " + record.delivery_id + ": " + reason)
  }

  async function deliver(record) {
    if (uninstallPending() || delivering.has(record.delivery_id) || record.phase === "transcript") return
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

  async function deliverMessageOnce(record) {
    if (uninstallPending()) return false
    try {
      if (record.boot_id !== GATEWAY_BOOT_ID) {
        settleMessageJournal(record, "unconfirmed")
        return false
      }
      if (!claimTimeAvailable(record) && record.phase !== "admitted" &&
          record.phase !== "transcript") {
        settleMessageJournal(record, "unconfirmed")
        return false
      }
      const envelope = { session_id: record.session_key, cwd: record.cwd,
        openclaw_session_id: record.openclaw_session_id,
        openclaw_lifecycle_revision: record.native_revision }
      if (nativeSessionRevision(api, record.session_key, record.openclaw_session_id) !==
          record.native_revision) {
        settleMessageJournal(record, "unconfirmed")
        return false
      }
      const generation = (await runHook("openclaw-generation", envelope))?.trim()
      if (generation !== record.generation) {
        settleMessageJournal(record, "unconfirmed")
        return false
      }
      const attendance = (await runHook("openclaw-attendance-ready", envelope))?.trim()
      if (attendance !== "ready") return false
      const target = await verifiedGatewayTarget(config, logger)
      if (target === null) return false
      const session = await currentSession(target, record)
      if (session === null) return false
      const state = await inspectSubmission(target, record)
      if (state === "transcript") {
        settleMessageJournal(record, "transcript")
        return true
      }
      if (state === "pending") return true
      if (state !== "absent" || record.phase === "admitted" ||
          record.phase === "submitting") {
        settleMessageJournal(record, "unconfirmed")
        return false
      }
      if (!claimTimeAvailable(record)) {
        settleMessageJournal(record, "unconfirmed")
        return false
      }
      if ((await runHook("openclaw-generation", envelope))?.trim() !== record.generation) {
        settleMessageJournal(record, "unconfirmed")
        return false
      }
      if (nativeSessionRevision(api, record.session_key, record.openclaw_session_id) !==
          record.native_revision) {
        settleMessageJournal(record, "unconfirmed")
        return false
      }
      if (await currentSession(target, record) === null) return false
      saveMessageJournal({ ...record, phase: "submitting" })
      await gatewayCall(target, "chat.send", {
        sessionKey: record.session_key, message: messagePointer(record),
        queueMode: "followup",
        idempotencyKey: submissionKey(record),
      })
      saveMessageJournal({ ...record, phase: "admitted" })
      return true
    } catch {
      // An uncertain admission is reconciled by identity, never blindly replayed.
      return false
    } finally { /* The wrapper removes the in-flight entry. */ }
  }

  function deliverMessage(record) {
    if (record.phase === "transcript" || record.phase === "unconfirmed") return Promise.resolve(false)
    const existing = deliveringMessages.get(record.delivery_id)
    if (existing) return existing
    const run = deliverMessageOnce(record).finally(() => deliveringMessages.delete(record.delivery_id))
    deliveringMessages.set(record.delivery_id, run)
    return run
  }

  function startMessageBridge(session, child) {
    let buffer = ""
    let queue = Promise.resolve()
    child.stdio[4].on("error", () => { /* A closed attendant cannot accept a result. */ })
    child.stdio[3].setEncoding("utf8")
    child.stdio[3].on("data", (chunk) => {
      buffer += chunk
      if (buffer.length > 100_000) { child.kill("SIGTERM"); return }
      for (;;) {
        const end = buffer.indexOf("\\n")
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let payload
        try { payload = JSON.parse(line) } catch { continue }
        if (payload?.type !== "message" ||
            !/^sm_[A-Za-z0-9_-]+$/.test(payload.message_id) ||
            payload.session_key !== session.session_key ||
            payload.generation !== session.generation ||
            typeof payload.text !== "string" || payload.text.length > 32768 ||
            typeof payload.deadline_ns !== "string" ||
            payload.deadline_ns.length > 32 ||
            !/^[0-9]+$/.test(payload.deadline_ns)) continue
        queue = queue.then(async () => {
          const deliveryId = createHash("sha256")
            .update(session.generation + "\\0" + payload.message_id)
            .digest("hex").slice(0, 32)
          const record = { delivery_id: deliveryId, message_id: payload.message_id,
            session_key: session.session_key, cwd: session.cwd,
            openclaw_session_id: session.session_id, generation: session.generation,
            native_revision: nativeSessionRevision(api, session.session_key, session.session_id),
            boot_id: GATEWAY_BOOT_ID, text: payload.text, deadline_ns: payload.deadline_ns,
            attempt: 1, phase: "prepared" }
          const existing = readMessageJournal(deliveryId)
          const current = active.get(session.session_key)
          let written = false
          if (current?.attendant === child && record.native_revision !== null &&
              (existing === null ||
                (existing.message_id === record.message_id &&
                  existing.session_key === record.session_key &&
                  existing.generation === record.generation))) {
            if (existing === null) saveMessageJournal(record)
            written = await deliverMessage(existing ?? record)
          }
          child.stdio[4].write(JSON.stringify({ message_id: payload.message_id,
            status: written ? "written" : "unconfirmed" }) + "\\n")
        }).catch(() => {
          child.stdio[4].write(JSON.stringify({ message_id: payload.message_id,
            status: "unconfirmed" }) + "\\n")
        })
      }
    })
  }

  function startSettlement(session, entry) {
    if (uninstallPending()) return
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
    if (uninstallPending()) return
    const envelope = { session_id: session.session_key, cwd: session.cwd,
      openclaw_session_id: session.session_id, hook_event_name: "SessionStart" }
    const entry = { generation: session.generation,
      attendant: spawnOwnedHook("attend", envelope, true), child: null }
    active.set(session.session_key, entry)
    startMessageBridge(session, entry.attendant)
    startSettlement(session, entry)
  }

  function sendActivity(entry, session) {
    if (entry && entry.attendant.exitCode === null && entry.attendant.stdio[4].writable) {
      entry.attendant.stdio[4].write(JSON.stringify({ type: "activity",
        activity: session.hasActiveRun === true ? "working" : "idle" }) + "\\n")
    }
  }

  async function tick() {
    if (stopped || scanning) return
    // Native children observe the same barrier and report withdrawn through
    // their gates. Never turn uninstall into an ended signal to the harness.
    if (uninstallPending()) {
      ready = false
      clearReadiness()
      for (const [key, entry] of active) {
        if (entry.attendant.exitCode !== null && (entry.child === null || entry.child.exitCode !== null)) active.delete(key)
      }
      return
    }
    scanning = true
    try {
      if (!ready) {
        const target = await verifiedGatewayTarget(config, logger)
        if (target === null || !writeReadiness(target)) return
        gatewayTarget = target
        ready = true
      }
      const raw = await runHook("openclaw-list-pending", { cwd: process.cwd() })
      if (raw === null || uninstallPending()) return
      const pending = JSON.parse(raw)
      const sessions = await gatewaySessions(gatewayTarget)
      if (sessions === null || uninstallPending()) return
      const seen = new Set()
      if (Array.isArray(pending)) for (const session of pending) {
        if (typeof session?.session_key !== "string" ||
            typeof session?.cwd !== "string" ||
            typeof session?.generation !== "string") continue
        const gatewaySession = sessions.get(session.session_key)
        if (typeof session.session_id !== "string" ||
            gatewaySession?.sessionId !== session.session_id ||
            gatewaySession.archived === true) continue
        seen.add(session.session_key)
        const current = active.get(session.session_key)
        if (current?.generation === session.generation) {
          if (current.attendant.exitCode !== null) {
            active.delete(session.session_key)
            if (current.child !== null) current.child.kill("SIGTERM")
            startSession(session)
            sendActivity(active.get(session.session_key), gatewaySession)
          } else if (current.child === null) {
            const ready = await runHook("openclaw-attendance-ready", {
              session_id: session.session_key, cwd: session.cwd,
              openclaw_session_id: session.session_id })
            if (ready?.trim() === "ready") startSettlement(session, current)
          }
          if (active.get(session.session_key) === current) sendActivity(current, gatewaySession)
          continue
        }
        if (current) {
          if (current.child !== null) current.child.kill("SIGTERM")
          current.attendant.kill("SIGTERM")
        }
        startSession(session)
        sendActivity(active.get(session.session_key), gatewaySession)
      }
      for (const [key, entry] of active) {
        if (seen.has(key)) continue
        if (entry.child !== null) entry.child.kill("SIGTERM")
        entry.attendant.kill("SIGTERM")
        active.delete(key)
      }
      for (const record of readJournals()) void deliver(record)
      for (const [deliveryId] of awaitingMessageContexts) {
        const record = readMessageJournal(deliveryId)
        if (record === null || record.text === undefined) {
          awaitingMessageContexts.delete(deliveryId)
        } else if (record.boot_id !== GATEWAY_BOOT_ID ||
            nativeSessionRevision(api, record.session_key, record.openclaw_session_id) !==
              record.native_revision) {
          const { text: _text, ...withoutText } = record
          saveMessageJournal(withoutText)
        }
      }
      for (const pending of retryMessageJournals()) {
        const record = readMessageJournal(pending.delivery_id)
        if (record === null) continue
        if (record.phase === "transcript" || record.phase === "unconfirmed") {
          pendingMessageJournals?.delete(record.delivery_id)
          continue
        }
        void deliverMessage(record)
      }
    } catch { /* The next Gateway tick retries discovery. */ }
    finally { scanning = false }
  }

  return {
    start() { pendingMessageJournals = null; timer = setInterval(() => { void tick() }, 2_000); void tick() },
    stop() {
      stopped = true
      clearReadiness()
      if (timer !== null) clearInterval(timer)
      if (!uninstallPending()) for (const entry of active.values()) {
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
  const scripted = win32 && options.nodePath !== undefined
  const nodeConstant = scripted
    ? `const NODE = ${JSON.stringify(options.nodePath)}\n`
    : ''
  const spawnArguments = scripted
    ? 'NODE, [ADAPTER, "hook", event, "--owner", "notifai", "--harness", "openclaw"]'
    : 'ADAPTER, ["hook", event, "--owner", "notifai", "--harness", "openclaw"]'
  const windowsHide = win32 ? '\n        windowsHide: true,' : ''
  return `${OPENCLAW_PLUGIN_MARKER}
// Generated by \`notifai hooks install --harness openclaw\`. Edits are lost on
// the next install; change the CLI instead, which is where the logic lives.
import { spawn, execFile, execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

${nodeConstant}const ADAPTER = ${JSON.stringify(adapterPath)}
const HOOK_COMMAND = ${JSON.stringify(scripted ? options.nodePath : adapterPath)}
const HOOK_PREFIX = ${JSON.stringify(scripted ? [adapterPath] : [])}
const TIMEOUT_MS = ${timeoutSeconds * 1000}
const ADAPTER_VERSION = ${OPENCLAW_ADAPTER_VERSION}
const MISSING_LIFECYCLE_GUIDANCE_CONTEXT = ${JSON.stringify(MISSING_LIFECYCLE_GUIDANCE_CONTEXT)}
const WORKER_ACTIVATION_CONTEXT = ${JSON.stringify(WORKER_ACTIVATION_CONTEXT)}

// The managed native command has one fixed installation root. Source adapters
// and externally owned wrappers do not acquire uninstall authority here.
const UNINSTALL_BARRIER = path.basename(ADAPTER) === (process.platform === "win32" ? "notifai.exe" : "notifai") &&
  path.basename(path.dirname(ADAPTER)) === "bin" &&
  path.basename(path.dirname(path.dirname(ADAPTER))) === ".notifai"
  ? path.join(path.dirname(path.dirname(ADAPTER)), "uninstall.json") : null
function uninstallPending() {
  if (UNINSTALL_BARRIER === null) return false
  try { lstatSync(UNINSTALL_BARRIER); return true }
  catch (error) { return error?.code !== "ENOENT" }
}

function runHook(event, envelope) {
  if (uninstallPending()) return Promise.resolve(null)
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
  try {
    const stateDir = api.runtime?.state?.resolveStateDir?.()
    if (typeof stateDir === "string" && path.isAbsolute(stateDir)) {
      JOURNAL_DIR = path.join(stateDir, "notifai", "continuation-journal")
      MESSAGE_JOURNAL_DIR = path.join(stateDir, "notifai", "message-journal")
    }
  } catch { /* No private journal is available in this plugin instance. */ }
  api.registerService?.({
    id: "notifai-continuation",
    start(ctx) {
      if (typeof ctx.stateDir !== "string" || !path.isAbsolute(ctx.stateDir)) return
      JOURNAL_DIR = path.join(ctx.stateDir, "notifai", "continuation-journal")
      MESSAGE_JOURNAL_DIR = path.join(ctx.stateDir, "notifai", "message-journal")
      continuationService = makeContinuationService(ctx.config, ctx.logger, api)
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
    const nativeRevision = nativeSessionRevision(api, sessionKey, sessionIdOf(event, ctx))
    await runHook("openclaw-lifecycle", { ...envelopeFor(sessionKey, event, ctx, "BeforeReset"),
      ...(nativeRevision === null ? {} : { openclaw_lifecycle_revision: nativeRevision }) })
  })

  api.on("before_prompt_build", async (event, ctx) => {
    const sessionKey = sessionKeyOf(event, ctx)
    if (sessionKey === "") return { prependContext: WORKER_ACTIVATION_CONTEXT }
    const worker = isWorkerSession(sessionKey, ctx)
    const nativeRevision = nativeSessionRevision(api, sessionKey, sessionIdOf(event, ctx))
    const envelope = { ...envelopeFor(sessionKey, event, ctx, "BeforePromptBuild"),
      ...(nativeRevision === null ? {} : { openclaw_lifecycle_revision: nativeRevision }) }
    const resolved = await runHook(worker ? "subagent-start" : "session-start",
      { ...envelope, hook_event_name: worker ? "SubagentStart" : "SessionStart" })
    // chat.send does not emit message_received on this supported Gateway path.
    // The prompt build is the exact session's authoritative turn-start seam.
    await runHook("openclaw-turn-start", envelope)
    const messageContext = worker ? null :
      await messageContextForPointer(api, event, ctx, sessionKey, nativeRevision)
    // Successful empty output means this Project is disabled or this
    // generation was already activated. A later prompt rechecks enablement.
    if (resolved !== null && resolved.trim().length === 0 && messageContext === null) return
    const context = typeof resolved === "string" && resolved.trim().length > 0
      ? resolved.trim()
      : resolved === null ? worker ? WORKER_ACTIVATION_CONTEXT : MISSING_LIFECYCLE_GUIDANCE_CONTEXT : ""
    return { prependContext: [context, messageContext].filter(Boolean).join("\\n\\n") }
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
