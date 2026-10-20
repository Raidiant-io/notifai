import { stampIntegrationSource, INTEGRATION_REVISION_PLACEHOLDER } from './integration-revision.js'
import path from 'node:path'
import { hookHostPlatform, type HookHostPlatform } from './hook-adapter.js'
import { harnessAccountHome } from './install-hooks.js'
import {
  MISSING_LIFECYCLE_GUIDANCE_CONTEXT,
  WORKER_ACTIVATION_CONTEXT,
} from './session-activation.js'

/**
 * The OpenCode adapter.
 *
 * OpenCode's extension point is a TypeScript/JavaScript plugin module, not a
 * command hook, so it needs a different adapter rather than a different path
 * through the existing one. What it is *not* is different logic: the generated
 * plugin shells out to the same `notifai hook <event>` commands Claude Code and
 * Codex invoke, and every decision — presence, the grace window, the reply
 * wait, retirement — stays in one place.
 *
 * The three lifecycle joints map onto the same three events. OpenCode exposes
 * `chat.message` as a direct hook, while session lifecycle notifications arrive
 * through its generic `event` hook:
 *
 *   chat.message    -> user-prompt-submit   (the user is at the keyboard)
 *   session.idle    -> stop                 (the turn ended; escalate)
 *   session.deleted -> session-end          (retire local session state)
 *
 * Activation guidance enters through the system-prompt transform. It is
 * resolved once per User prompt and kept in the plugin for every model request
 * of that turn, instead of starting a CLI for each request.
 *
 * OpenCode's own question form (`question.asked`) is offered to the User's
 * devices through `opencode-question`, the one command that holds the Machine
 * Credential for it. The plugin settles the form in this process with
 * OpenCode's question list and reply API, through the client OpenCode handed
 * it, and passes an answer or dismissal given in OpenCode back to that
 * command. Permission prompts deliberately stay in OpenCode.
 */

/** Marker line; also how an install from another checkout is recognised. */
export const OPENCODE_PLUGIN_MARKER = '// notifai managed opencode plugin'

/** Filename we own inside whichever plugins directory is being written. */
export const OPENCODE_PLUGIN_FILENAME = 'notifai.js'

/** Bump when an installed generated file must be rewritten to remain functional. */
const OPENCODE_ADAPTER_VERSION = 14

/**
 * OpenCode's global config directory for the running installation.
 *
 * OpenCode resolves that directory through `xdg-basedir` (`Global.Path.config`
 * = `$XDG_CONFIG_HOME/opencode`, defaulting to `~/.config/opencode`).
 * `OPENCODE_CONFIG_DIR` remains the explicit override and wins, matching the
 * precedence this installer already gave that variable.
 */
export function opencodeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  const override = env['OPENCODE_CONFIG_DIR']
  if (override !== undefined && override !== '') return override
  const xdg = env['XDG_CONFIG_HOME']
  if (typeof xdg === 'string' && xdg !== '') return path.join(xdg, 'opencode')
  return path.join(harnessAccountHome(env, platform), '.config', 'opencode')
}

export function opencodePluginDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  return path.join(opencodeConfigDir(env, platform), 'plugins')
}

export function opencodePluginPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | HookHostPlatform = process.platform,
): string {
  return path.join(opencodePluginDir(env, platform), OPENCODE_PLUGIN_FILENAME)
}

export interface OpencodePluginOptions {
  integrationScope?: string
  /** The same stable user-level adapter every command-hook harness invokes. */
  adapterPath: string
  /**
   * Child-process lifetime for every short hook the plugin runs. OpenCode
   * cannot continue a session with a late answer, so no hook waits through a
   * reply window. A question form's command is bounded by the form instead.
   */
  timeoutSeconds: number
  platform?: NodeJS.Platform | HookHostPlatform
  /** Registered Node used to interpret the Windows adapter. Ignored on POSIX. */
  nodePath?: string
}

/**
 * The generated module.
 *
 * Written as a string rather than compiled from a source file because OpenCode
 * loads a plugin module rather than a command definition. It embeds only the
 * stable user-level adapter path; mutable runtime and CLI targets live behind
 * that adapter exactly as they do for every other harness.
 *
 * Everything it does is build the hook envelope OpenCode's event gives it and
 * hand that to the CLI on stdin. It deliberately fails open: an adapter error
 * never changes OpenCode's own behavior.
 */
/**
 * The plugin body, which is the same on every platform except for how it
 * reaches the adapter.
 *
 * It was two near-identical copies — about a hundred and twenty lines each,
 * differing only in the spawn call — so every fix to the plugin had to be made
 * twice or silently apply to one platform.
 */
export function opencodePluginSource(options: OpencodePluginOptions): string {
  const { adapterPath, timeoutSeconds } = options
  // Native Windows commands execute directly. Source/development adapters
  // explicitly supply their interpreter. Both suppress console windows.
  const win32 = hookHostPlatform(options.platform) === 'win32'
  const scripted = win32 && options.nodePath !== undefined
  const nodeConstant = scripted
    ? `const NODE = ${JSON.stringify(options.nodePath)}\n`
    : ''
  const spawnArguments = scripted
    ? 'NODE, [ADAPTER, "hook", event, "--owner", "notifai", "--harness", "opencode", "--integration-revision", NOTIFAI_INTEGRATION_REVISION]'
    : 'ADAPTER, ["hook", event, "--owner", "notifai", "--harness", "opencode", "--integration-revision", NOTIFAI_INTEGRATION_REVISION]'
  const windowsHide = win32 ? '\n        windowsHide: true,' : ''
  return stampIntegrationSource(`${OPENCODE_PLUGIN_MARKER}
// Generated by \`notifai hooks install --harness opencode\`. Edits are lost on
// the next install; change the CLI instead, which is where the logic lives.
import { spawn } from "node:child_process"

const NOTIFAI_INTEGRATION_REVISION = "${INTEGRATION_REVISION_PLACEHOLDER}"
${nodeConstant}const ADAPTER = ${JSON.stringify(adapterPath)}
const TIMEOUT_MS = ${timeoutSeconds * 1000}
const ADAPTER_VERSION = ${OPENCODE_ADAPTER_VERSION}
const MISSING_LIFECYCLE_GUIDANCE_CONTEXT = ${JSON.stringify(MISSING_LIFECYCLE_GUIDANCE_CONTEXT)}
const WORKER_ACTIVATION_CONTEXT = ${JSON.stringify(WORKER_ACTIVATION_CONTEXT)}
const PENDING_SESSION_TITLE =
  /^New session(?: *- *[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?Z)?$/i

/** Starts \`notifai hook <event>\` with pipes; null when it cannot start. */
function startHook(event) {
  try {
    return spawn(${spawnArguments}, {
        env: process.env,
        shell: false,${windowsHide}
        stdio: ["pipe", "pipe", "pipe"],
      })
  } catch {
    return null
  }
}

/**
 * Runs \`notifai hook <event>\`, feeding it the same JSON envelope the other
 * harnesses send. Resolves to stdout, or null if anything at all went wrong.
 */
function runHook(event, envelope) {
  return new Promise((resolve) => {
    const child = startHook(event)
    if (child === null) {
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
    // Hook stderr is diagnostics, not plugin output; discard it here.
    child.stderr?.resume()
    // A hook that exits before reading its input must not crash OpenCode.
    child.stdin?.on("error", () => {})
    child.on("error", () => finish(null))
    child.on("close", (code) => finish(code === 0 ? stdout : null))

    try {
      child.stdin?.end(JSON.stringify(envelope))
    } catch {
      finish(null)
    }
  })
}

function sameAnswers(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export const NotifAIPlugin = async ({ directory, client }) => {
  const cwd = typeof directory === "string" && directory.length > 0 ? directory : process.cwd()

  // OpenCode's own question API, called in this process through the client
  // OpenCode gave the plugin: the same server, directory and credentials the
  // session itself uses. Absent on releases without that API.
  const transport = client?._client
  const questionApi = transport !== null && typeof transport === "object" &&
    typeof transport.get === "function" && typeof transport.post === "function" ? transport : null

  async function pendingRequest(requestID, sessionID) {
    try {
      const response = await questionApi.get({ url: "/question" })
      const pending = response?.data
      return Array.isArray(pending) &&
        pending.some((item) => item?.id === requestID && item?.sessionID === sessionID)
    } catch {
      return false
    }
  }

  async function replyRequest(requestID, answers) {
    try {
      const response = await questionApi.post({
        url: "/question/{requestID}/reply",
        path: { requestID },
        body: { answers },
        headers: { "Content-Type": "application/json" },
      })
      return response?.error === undefined && response?.response?.ok !== false
    } catch {
      return false
    }
  }

  async function sessionInfo(sessionID) {
    // OpenCode represents delegated work as child sessions. Missing or
    // malformed relationship data must fail closed as worker context: it is
    // safe to suppress a notification, never safe to let a child duplicate
    // its parent's User-visible request.
    try {
      const response = await client.session.get({ path: { id: sessionID } })
      const session = response?.data
      if (session !== null && typeof session === "object") {
        return {
          worker: typeof session.parentID === "string" && session.parentID.length > 0,
          title: typeof session.title === "string" ? session.title.trim() : "",
        }
      }
    } catch {
      // Keep the safe worker classification.
    }
    return { worker: true, title: "" }
  }

  async function isWorker(sessionID) {
    return (await sessionInfo(sessionID)).worker
  }

  // Activation is resolved once per User prompt rather than once per model
  // request: one turn can make many requests, and each used to start a CLI.
  // A User prompt clears it, so enabling a Project applies from the next one.
  const activations = new Map()
  // An acknowledgement the agent owes for a device answer, shown once.
  const owedAcknowledgements = new Map()
  // OpenCode question requests whose device question is open, by request id.
  const forms = new Map()

  function resolveActivation(sessionID) {
    return (async () => {
      const worker = await isWorker(sessionID)
      const resolved = await runHook(worker ? "subagent-start" : "session-start", {
        session_id: sessionID,
        cwd,
        hook_event_name: worker ? "SubagentStart" : "SessionStart",
      })
      return { worker, resolved }
    })()
  }

  function send(form, frame) {
    try {
      const stdin = form.child.stdin
      if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.write(JSON.stringify(frame) + "\\n")
    } catch {
      // The command ends on its own when its pipe fails.
    }
  }

  function endForm(form) {
    forms.delete(form.requestID)
    try { form.child.stdin?.end() } catch { /* already closed */ }
  }

  /** The device answer arrived: return it through OpenCode's own form, exactly once. */
  async function applyDeviceAnswer(form, frame) {
    if (form.settled || !Array.isArray(frame.answers) || !(await pendingRequest(form.requestID, form.sessionID))) {
      send(form, { type: "stale" })
      return
    }
    form.applying = frame.answers
    // OpenCode can start the next model request before the reply call
    // returns, so the acknowledgement it owes is in place first.
    const owed = typeof frame.acknowledgement === "string" && frame.acknowledgement.length > 0
      ? "Notifai: the answer to your question came from the user's device, for request " + frame.request_id +
        ". Before the work it causes, run \`" + frame.acknowledgement + "\` saying what you will do because of it."
      : null
    const earlier = owedAcknowledgements.get(form.sessionID)
    if (owed !== null) owedAcknowledgements.set(form.sessionID, owed)
    if (await replyRequest(form.requestID, frame.answers)) {
      form.settled = true
      send(form, { type: "applied" })
    } else {
      form.applying = null
      if (owed !== null && owedAcknowledgements.get(form.sessionID) === owed) {
        if (earlier === undefined) owedAcknowledgements.delete(form.sessionID)
        else owedAcknowledgements.set(form.sessionID, earlier)
      }
      send(form, { type: "stale" })
    }
  }

  function startForm(request, title) {
    if (questionApi === null || typeof request?.id !== "string" || typeof request?.sessionID !== "string") return
    if (forms.has(request.id)) return
    const child = startHook("opencode-question")
    if (child === null) return
    const form = { requestID: request.id, sessionID: request.sessionID, child, settled: false, applying: null }
    forms.set(request.id, form)
    // Writing to a command that already ended must never crash OpenCode.
    child.stdin?.on("error", () => {})
    child.on("error", () => forms.delete(request.id))
    child.on("close", () => forms.delete(request.id))
    child.stderr?.resume()
    child.stdout?.setEncoding("utf-8")
    let buffered = ""
    child.stdout?.on("data", (chunk) => {
      buffered += chunk
      if (buffered.length > 2 * 1024 * 1024) {
        child.kill("SIGTERM")
        return
      }
      let newline
      while ((newline = buffered.indexOf("\\n")) >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (frame?.type === "answer") void applyDeviceAnswer(form, frame)
        else if (frame?.type === "terminal" || frame?.type === "done") endForm(form)
      }
    })
    const label = title.length === 0 ? {} : PENDING_SESSION_TITLE.test(title) ? { session_label_pending: true } : { session_label: title }
    send(form, { type: "ask", session_id: request.sessionID, cwd, request, ...label })
  }

  return {
    /** Model-visible activation, independent of CLI setup and delivery state. */
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input?.sessionID
      if (typeof sessionID !== "string" || sessionID.length === 0) return
      let pending = activations.get(sessionID)
      if (pending === undefined) {
        pending = resolveActivation(sessionID)
        activations.set(sessionID, pending)
      }
      const { worker, resolved } = await pending
      // A failed lookup is retried on the next request instead of remembered.
      if (resolved === null && activations.get(sessionID) === pending) activations.delete(sessionID)
      const owed = owedAcknowledgements.get(sessionID)
      if (owed !== undefined) {
        owedAcknowledgements.delete(sessionID)
        output.system.push(owed)
      }
      // Successful empty output is the runtime's deliberate disabled-Project no-op.
      if (resolved !== null && resolved.trim().length === 0) return
      const context = typeof resolved === "string" && resolved.trim().length > 0
        ? resolved.trim()
        : worker ? WORKER_ACTIVATION_CONTEXT : MISSING_LIFECYCLE_GUIDANCE_CONTEXT
      // OpenCode rebuilds system[] per model request, so the context is added
      // to every request; only deduplicate callbacks sharing this same array.
      if (output.system.some((part) => part.includes(context))) return
      if (output.system.length === 0) {
        output.system.push(context)
      } else {
        output.system[0] = output.system[0] + "\\n\\n" + context
      }
    },

    /** Exact active-harness identity and first-party title for agent shell commands. */
    "shell.env": async (input, output) => {
      output.env.NOTIFAI_ACTIVE_HARNESS = "opencode"
      const sessionID = input?.sessionID
      if (typeof sessionID === "string" && sessionID.length > 0) {
        output.env.NOTIFAI_ACTIVE_SESSION_ID = sessionID
        try {
          const response = await client.session.get({ path: { id: sessionID } })
          const title = response?.data?.title
          if (typeof title === "string" && title.trim().length > 0) {
            if (PENDING_SESSION_TITLE.test(title.trim())) {
              output.env.NOTIFAI_ACTIVE_SESSION_LABEL_PENDING = "1"
            } else {
              output.env.NOTIFAI_ACTIVE_SESSION_LABEL = title
            }
          }
        } catch {
          // Identity remains useful when this OpenCode build cannot expose a title.
        }
      }
    },

    /**
     * Presence. The user typing is the signal every harness shares, and it is
     * also what publishes the project -> session pointer \`notifai ask\` reads.
     */
    /** Publishes the session pointer; the CLI returns no content to inject. */
    "chat.message": async (input) => {
      const sessionID = input?.sessionID ?? input?.info?.sessionID
      if (typeof sessionID === "string") activations.delete(sessionID)
      await runHook("user-prompt-submit", {
        session_id: sessionID,
        cwd,
        hook_event_name: "UserPromptSubmit",
      })
    },

    /** Session lifecycle and question events are delivered through OpenCode's event bus. */
    event: async ({ event }) => {
      if (event?.type === "question.asked") {
        // A worker's form stays in OpenCode: the device answer would be owed
        // to the agent that owns the session's Notification Requests.
        const request = event?.properties
        if (typeof request?.sessionID !== "string") return
        const session = await sessionInfo(request.sessionID)
        if (!session.worker) startForm(request, session.title)
      } else if (event?.type === "question.replied") {
        const form = forms.get(event?.properties?.requestID)
        if (form === undefined || form.sessionID !== event?.properties?.sessionID) return
        // The device answer this plugin just returned comes back as the same event.
        if (form.applying !== null && sameAnswers(form.applying, event?.properties?.answers)) return
        form.settled = true
        send(form, { type: "native", answers: event?.properties?.answers })
      } else if (event?.type === "question.rejected") {
        const form = forms.get(event?.properties?.requestID)
        if (form === undefined || form.sessionID !== event?.properties?.sessionID) return
        form.settled = true
        send(form, { type: "dismissed" })
      } else if (event?.type === "session.idle") {
        await runHook("stop", {
          session_id: event?.properties?.sessionID,
          cwd,
          hook_event_name: "Stop",
        })
      } else if (event?.type === "session.deleted") {
        const sessionID = event?.properties?.info?.id
        activations.delete(sessionID)
        owedAcknowledgements.delete(sessionID)
        for (const form of [...forms.values()]) if (form.sessionID === sessionID) endForm(form)
        await runHook("session-end", {
          session_id: sessionID,
          cwd,
          hook_event_name: "SessionEnd",
        })
      }
    },
  }
}
`, options.integrationScope)
}

/** True when a plugin file on disk is one of ours, whoever installed it. */
export function isOurOpencodePlugin(contents: string): boolean {
  return contents.includes(OPENCODE_PLUGIN_MARKER)
}

/**
 * The interpreter and script a generated plugin will actually run.
 *
 * A plugin is a module rather than a command line, so which *build* it invokes
 * is not visible in the way it is for a settings-file handler — it is baked
 * into the two constants at the top. `doctor` needs it to answer the question
 * it exists to answer ("are two checkouts both installed?"), and without it
 * the plugin's own path stands in for the build and every OpenCode install
 * looks like a second one.
 *
 * Returns null for a plugin we did not generate, or one whose constants have
 * been edited out of recognisable shape.
 */
export function opencodePluginTarget(
  contents: string,
): { adapter: string; current: boolean; timeoutSeconds?: number; nodePath?: string } | null {
  if (!isOurOpencodePlugin(contents)) return null
  const adapter = /^const ADAPTER = (".*")$/m.exec(contents)?.[1]
  const legacyScript = /^const SCRIPT = (".*")$/m.exec(contents)?.[1]
  const node = /^const NODE = (".*")$/m.exec(contents)?.[1]
  const version = Number(/^const ADAPTER_VERSION = (\d+)$/m.exec(contents)?.[1] ?? 1)
  const timeoutMs = Number(/^const TIMEOUT_MS = (\d+)$/m.exec(contents)?.[1] ?? Number.NaN)
  if (adapter === undefined && legacyScript === undefined) return null
  try {
    return {
      adapter: JSON.parse(adapter ?? legacyScript!) as string,
      current: version === OPENCODE_ADAPTER_VERSION,
      ...(Number.isFinite(timeoutMs) ? { timeoutSeconds: timeoutMs / 1000 } : {}),
      ...(node === undefined ? {} : { nodePath: JSON.parse(node) as string }),
    }
  } catch {
    return null
  }
}
