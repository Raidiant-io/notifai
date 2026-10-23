import { stampIntegrationSource, INTEGRATION_REVISION_PLACEHOLDER } from './integration-revision.js'
import { hookHostPlatform } from './hook-adapter.js'
import { OPENCODE2_ADAPTER_VERSION, OPENCODE_PLUGIN_MARKER, OPENCODE_QUESTION_EXTRA_PROPERTIES, type OpencodePluginOptions } from './opencode-plugin.js'
import { MISSING_LIFECYCLE_GUIDANCE_CONTEXT, WORKER_ACTIVATION_CONTEXT } from './session-activation.js'

/**
 * The OpenCode 2 adapter.
 *
 * OpenCode 2 replaced OpenCode 1's plugin API: its loader runs only a module
 * whose default export is `{ id, setup }` (anomalyco/opencode v2.1.3,
 * `packages/core/src/plugin/module.ts`), so the OpenCode 1 plugin does not
 * load there at all. This module is the same adapter written against the
 * OpenCode 2 API. It shells out to the same `notifai hook <event>` commands
 * and keeps every decision in the CLI, exactly like the OpenCode 1 plugin;
 * only the joints differ:
 *
 *   session hook "prompt"            -> user-prompt-submit, whose context
 *                                       reaches the next model request
 *   session hook "context"           -> session-start / subagent-start
 *                                       guidance, once per User prompt
 *   session.execution.* events       -> stop
 *   session.deleted event            -> session-end
 *
 * OpenCode 2 runs one plugin instance per directory, but its event stream is
 * shared by every instance. An instance acts on a session's events only once
 * one of its own hooks has served that session, so no turn end runs twice.
 * OpenCode also reloads a plugin file when it changes, and a reloaded instance
 * serves a session again from that session's next prompt or model request.
 *
 * The shell hook (`create.before`) carries no session ID. OpenCode puts
 * `OPENCODE_SESSION_ID` into the command's environment itself, after the hook.
 * The plugin records each session it serves through `opencode-session`, with
 * the OpenCode process that hosts it, and the CLI believes a shell's
 * `OPENCODE_SESSION_ID` only for a recorded live session whose host is that
 * shell's ancestor (see `opencode-shell-session.ts`).
 *
 * The question form is linked by wrapping OpenCode's own `question` tool. The
 * wrapper asks `opencode-question` about the form first, exactly as the
 * OpenCode 1 plugin does, then runs the native tool and races it against the
 * User's devices. OpenCode 2 gives plugins no form reply call, so a device
 * answer aborts the native call, which cancels the form in OpenCode, and the
 * wrapper returns the answer as the tool's own result. An answer or dismissal
 * in OpenCode settles the native call; it passes through unchanged and is
 * reported to the command. A form opened some other way than the model's
 * `question` call cannot be answered from outside, so it stays in OpenCode.
 */

/**
 * The `question` tool's input as OpenCode 2.1.3 offers it to models (captured
 * from its `context` hook), plus Notifai's optional fields. OpenCode strips
 * every field its registered schema does not declare before any plugin hook
 * sees the call, so the extended schema replaces the registered one, and only
 * while the tool's input is still exactly `questions`.
 */
export function opencode2QuestionJsonSchema() {
  return {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Complete question' },
            header: { type: 'string', description: 'Very short label (max 30 chars)' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Display text (1-5 words, concise)' },
                  description: { type: 'string', description: 'Explanation of choice' },
                },
                required: ['label', 'description'],
                additionalProperties: false,
              },
              description: 'Available choices',
            },
            multiple: { type: 'boolean' },
          },
          required: ['question', 'header', 'options'],
          additionalProperties: false,
        },
        minItems: 1,
        description: 'Questions to ask',
      },
      ...OPENCODE_QUESTION_EXTRA_PROPERTIES,
      images: {
        ...OPENCODE_QUESTION_EXTRA_PROPERTIES.images,
        items: { ...OPENCODE_QUESTION_EXTRA_PROPERTIES.images.items, additionalProperties: false },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  } as const
}

/** The generated OpenCode 2 module; see `opencodePluginSource` for the OpenCode 1 one. */
export function opencode2PluginSource(options: OpencodePluginOptions): string {
  const { adapterPath, timeoutSeconds } = options
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
// Generated by \`notifai hooks install --harness opencode\` for OpenCode 2. Edits
// are lost on the next install; change the CLI instead, which is where the logic lives.
import { spawn } from "node:child_process"

const NOTIFAI_INTEGRATION_REVISION = "${INTEGRATION_REVISION_PLACEHOLDER}"
const OPENCODE_MAJOR = 2
${nodeConstant}const ADAPTER = ${JSON.stringify(adapterPath)}
const TIMEOUT_MS = ${timeoutSeconds * 1000}
const ADAPTER_VERSION = ${OPENCODE2_ADAPTER_VERSION}
const MISSING_LIFECYCLE_GUIDANCE_CONTEXT = ${JSON.stringify(MISSING_LIFECYCLE_GUIDANCE_CONTEXT)}
const WORKER_ACTIVATION_CONTEXT = ${JSON.stringify(WORKER_ACTIVATION_CONTEXT)}
const QUESTION_JSON_SCHEMA = ${JSON.stringify(opencode2QuestionJsonSchema())}
const QUESTION_EXTRAS = ${JSON.stringify(Object.keys(OPENCODE_QUESTION_EXTRA_PROPERTIES))}
// How long a form waits for Notifai's decision before it opens in OpenCode alone.
const VERDICT_TIMEOUT_MS = 10000
const PENDING_SESSION_TITLE =
  /^New session(?: *- *[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?Z)?$/i
// How a turn ends. An execution another prompt superseded is not one.
const TURN_ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

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

/** OpenCode's own wording for answered questions, so a device answer reads the same. */
function answeredContent(questions, answers) {
  const formatted = questions
    .map((question, index) => '"' + question.question + '"="' + (answers[index]?.length ? answers[index].join(", ") : "Unanswered") + '"')
    .join(", ")
  return "User has answered your questions: " + formatted + ". You can now continue with the user's answers in mind."
}

function nativeAnswers(result) {
  const answers = result?.output?.answers ?? result?.metadata?.answers
  return Array.isArray(answers) && answers.every((answer) => Array.isArray(answer)) ? answers : null
}

export default {
  id: "notifai",
  async setup(ctx) {
    const here = typeof ctx?.location?.directory === "string" && ctx.location.directory.length > 0
      ? ctx.location.directory : process.cwd()

    // Sessions one of this instance's own hooks served. Every instance sees
    // every session's events; only these are this instance's to act on.
    const served = new Set()
    // Activation is resolved once per User prompt rather than once per model
    // request. A User prompt clears it, so enabling a Project applies from the next one.
    const activations = new Map()
    // Context the agent is owed in its next model request, shown once.
    const owed = new Map()
    // Commands of forms whose device question may be open.
    const forms = new Set()
    // Native forms this plugin waits to see open, by tool call id.
    const opening = new Map()
    // Event ids already handled: an event can arrive more than once.
    const handled = new Set()
    // Hooks that must not overlap run in order, per session, off the event stream.
    const chains = new Map()

    function owe(sessionID, text) {
      if (typeof text !== "string" || text.trim().length === 0) return
      const earlier = owed.get(sessionID)
      owed.set(sessionID, earlier === undefined ? text.trim() : earlier + "\\n\\n" + text.trim())
    }

    function inOrder(key, run) {
      const next = (chains.get(key) ?? Promise.resolve()).then(run, run).catch(() => {})
      chains.set(key, next)
      void next.then(() => { if (chains.get(key) === next) chains.delete(key) })
      return next
    }

    async function sessionInfo(sessionID) {
      // OpenCode represents delegated work as child sessions. Missing or
      // malformed relationship data must fail closed as worker context: it is
      // safe to suppress a notification, never safe to let a child duplicate
      // its parent's User-visible request.
      try {
        const response = await ctx.session.get({ sessionID })
        const session = response?.data?.id === sessionID ? response.data : response
        if (session !== null && typeof session === "object" && session.id === sessionID) {
          const directory = session.location?.directory
          return {
            worker: session.parentID !== undefined && session.parentID !== null &&
              (typeof session.parentID !== "string" || session.parentID.length > 0),
            title: typeof session.title === "string" ? session.title.trim() : "",
            cwd: typeof directory === "string" && directory.length > 0 ? directory : here,
          }
        }
      } catch {
        // Keep the safe worker classification.
      }
      return { worker: true, title: "", cwd: here }
    }

    function sessionLabel(title) {
      return title.length === 0 || PENDING_SESSION_TITLE.test(title) ? { session_label_pending: true } : { session_label: title }
    }

    /**
     * Records the session for its agent shells, which know only \`OPENCODE_SESSION_ID\`.
     * Recordings of one session run in order, so the latest title is the one kept.
     */
    function recordSession(sessionID, session) {
      return inOrder("record " + sessionID, () => runHook("opencode-session", {
        session_id: sessionID,
        cwd: session.cwd,
        hook_event_name: "OpencodeSession",
        worker: session.worker,
        ...sessionLabel(session.title),
      }))
    }

    function resolveActivation(sessionID) {
      return (async () => {
        const session = await sessionInfo(sessionID)
        const [resolved] = await Promise.all([
          runHook(session.worker ? "subagent-start" : "session-start", {
            session_id: sessionID,
            cwd: session.cwd,
            hook_event_name: session.worker ? "SubagentStart" : "SessionStart",
          }),
          recordSession(sessionID, session),
        ])
        return { worker: session.worker, resolved }
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
      forms.delete(form)
      if (opening.get(form.callID) === form.onOpened) opening.delete(form.callID)
      try { form.child.stdin?.end() } catch { /* already closed */ }
    }

    /** Starts a form's command. Its first decision goes to onVerdict; null when it ends without one. */
    function startCommand(sessionID, callID, onVerdict) {
      const child = startHook("opencode-question")
      if (child === null) return null
      const form = { sessionID, callID, child, onVerdict, onDevice: null, onOpened: null }
      const verdict = (frame) => {
        const resolve = form.onVerdict
        form.onVerdict = null
        resolve?.(frame)
      }
      const gone = () => {
        verdict(null)
        endForm(form)
      }
      // Writing to a command that already ended must never crash OpenCode.
      child.stdin?.on("error", () => {})
      child.on("error", gone)
      child.on("close", gone)
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
          if (frame?.type === "accepted" || frame?.type === "refused" || frame?.type === "terminal") verdict(frame)
          if ((frame?.type === "answer" && Array.isArray(frame.answers)) ||
              (frame?.type === "expired" && typeof frame.context === "string")) {
            const resolve = form.onDevice
            form.onDevice = null
            if (resolve === null) send(form, { type: "stale" })
            else resolve(frame)
          } else if (frame?.type === "terminal" || frame?.type === "refused" || frame?.type === "done") endForm(form)
        }
      })
      forms.add(form)
      return form
    }

    /**
     * Notifai's decision on a root session's form before it opens: carried to
     * the User's devices, left in OpenCode, or refused. No decision in time
     * leaves it in OpenCode.
     */
    function decideForm(sessionID, callID, questions, extras, session) {
      return new Promise((resolve) => {
        let form = null
        const timer = setTimeout(() => {
          if (form !== null) {
            form.onVerdict = null
            endForm(form)
          }
          resolve({ verdict: null, form: null })
        }, VERDICT_TIMEOUT_MS)
        form = startCommand(sessionID, callID, (verdict) => {
          clearTimeout(timer)
          resolve({ verdict, form })
        })
        if (form === null) {
          clearTimeout(timer)
          resolve({ verdict: null, form: null })
          return
        }
        send(form, { type: "form", session_id: sessionID, cwd: session.cwd, call_id: callID, questions, extras, ...sessionLabel(session.title) })
      })
    }

    /**
     * An accepted form: the native one runs, and whichever answer comes first
     * settles it. A device answer aborts the native call, which closes the
     * form in OpenCode, and becomes the tool's result.
     */
    async function carryForm(form, native, input, context) {
      const controller = new AbortController()
      const signal = context?.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal
      form.onOpened = (opened) => {
        if (opened.sessionID !== form.sessionID) return
        opening.delete(form.callID)
        form.onOpened = null
        send(form, { type: "opened", request: {
          id: opened.id, sessionID: opened.sessionID, questions: input.questions,
          tool: { messageID: opened.metadata.tool.messageID, callID: form.callID },
        } })
      }
      opening.set(form.callID, form.onOpened)
      const device = new Promise((resolve) => { form.onDevice = resolve })
      const run = Promise.resolve()
        .then(() => native(input, { ...context, signal }))
        .then((result) => ({ result }), (error) => ({ error }))
      const first = await Promise.race([run.then((outcome) => ({ outcome })), device.then((frame) => ({ frame }))])
      if (first.outcome === undefined) controller.abort()
      // A future native executor may ignore abort. Give it a short grace
      // period to reveal a terminal answer already committed, then continue.
      let timer
      const outcome = first.outcome ?? await Promise.race([
        run,
        new Promise((resolve) => { timer = setTimeout(() => resolve({}), 3000) }),
      ]).finally(() => clearTimeout(timer))
      if (opening.get(form.callID) === form.onOpened) opening.delete(form.callID)
      form.onDevice = null
      const answers = "result" in outcome ? nativeAnswers(outcome.result) : null
      if (first.outcome === undefined && answers === null) {
        // The device settled first and the native form closed unanswered.
        const frame = first.frame
        send(form, { type: "applied" })
        if (frame.type === "expired") {
          const unanswered = input.questions.map(() => [])
          return { output: { answers: unanswered }, content: frame.context, metadata: { answers: unanswered } }
        }
        // Each form owes its own acknowledgement: parallel forms add to, never replace, what is owed.
        if (typeof frame.acknowledgement_context === "string" && frame.acknowledgement_context.length > 0) {
          owe(form.sessionID, frame.acknowledgement_context)
        } else if (typeof frame.acknowledgement === "string" && frame.acknowledgement.length > 0) {
          owe(form.sessionID, "Notifai: the answer to your question came from the user's device, for request " + frame.request_id +
            ". Before the work it causes, run \`" + frame.acknowledgement + "\` exactly as shown, giving any --text the work you will do because of it.")
        }
        return { output: { answers: frame.answers }, content: answeredContent(input.questions, frame.answers), metadata: { answers: frame.answers } }
      }
      // Answered or dismissed in OpenCode: the native outcome stands.
      if (answers !== null) send(form, { type: "native", answers })
      else send(form, { type: "dismissed" })
      if ("error" in outcome) throw outcome.error
      return outcome.result
    }

    /** The \`question\` tool, offered to the User's devices before it opens. */
    async function askQuestion(native, input, context) {
      const sessionID = context?.sessionID
      const callID = context?.id
      if (input === null || typeof input !== "object" || !Array.isArray(input.questions)) return native(input, context)
      const extras = {}
      const asked = { ...input }
      for (const key of QUESTION_EXTRAS) {
        if (key in asked) {
          if (asked[key] !== null && asked[key] !== undefined) extras[key] = asked[key]
          delete asked[key]
        }
      }
      if (typeof sessionID !== "string" || typeof callID !== "string") return native(asked, context)
      // A worker's form stays in OpenCode: the device answer would be owed
      // to the agent that owns the session's Notification Requests.
      const session = await sessionInfo(sessionID)
      if (session.worker) return native(asked, context)
      const { verdict, form } = await decideForm(sessionID, callID, asked.questions, extras, session)
      if (verdict?.type === "refused" && typeof verdict.message === "string") throw new Error(verdict.message)
      if (verdict?.type !== "accepted" || form === null) return native(asked, context)
      return carryForm(form, native, asked, context)
    }

    async function onEvent(event) {
      if (typeof event?.id === "string") {
        if (handled.has(event.id)) return
        handled.add(event.id)
        if (handled.size > 1000) handled.delete(handled.values().next().value)
      }
      const type = event?.type
      const data = event?.data
      if (type === "form.created") {
        const opened = data?.form
        const callID = opened?.metadata?.kind === "question" ? opened?.metadata?.tool?.id : undefined
        if (typeof callID === "string" && typeof opened?.id === "string" && typeof opened?.sessionID === "string") opening.get(callID)?.(opened)
        return
      }
      const sessionID = data?.sessionID
      if (typeof sessionID !== "string" || !served.has(sessionID)) return
      if (TURN_ENDS.has(type)) {
        if (data?.reason === "superseded") return
        void inOrder(sessionID, async () => {
          const session = await sessionInfo(sessionID)
          await runHook("stop", { session_id: sessionID, cwd: session.cwd, hook_event_name: "Stop" })
        })
      } else if (type === "session.renamed") {
        void sessionInfo(sessionID).then((session) => recordSession(sessionID, session))
      } else if (type === "session.deleted") {
        served.delete(sessionID)
        activations.delete(sessionID)
        owed.delete(sessionID)
        for (const form of [...forms]) if (form.sessionID === sessionID) endForm(form)
        void inOrder(sessionID, () => runHook("session-end", { session_id: sessionID, cwd: here, hook_event_name: "SessionEnd" }))
      }
    }

    const events = new AbortController()
    void (async () => {
      while (!events.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: events.signal })) {
            try { await onEvent(event) } catch { /* one bad event never stops the stream */ }
          }
        } catch {
          // Reconnect below.
        }
        if (!events.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    })()

    /**
     * Presence. The user typing is the signal every harness shares, and it is
     * also what publishes the project -> session pointer \`notifai ask\` reads.
     * Whatever context the CLI returns reaches the next model request.
     */
    await ctx.session.hook("prompt", async (event) => {
      const sessionID = event?.sessionID
      if (typeof sessionID !== "string" || sessionID.length === 0) return
      served.add(sessionID)
      activations.delete(sessionID)
      const session = await sessionInfo(sessionID)
      owe(sessionID, await runHook("user-prompt-submit", { session_id: sessionID, cwd: session.cwd, hook_event_name: "UserPromptSubmit" }))
    })

    /** Model-visible activation, independent of CLI setup and delivery state. */
    await ctx.session.hook("context", async (event) => {
      const sessionID = event?.sessionID
      if (typeof sessionID !== "string" || sessionID.length === 0 || !Array.isArray(event.system)) return
      if (!served.has(sessionID)) {
        // A freshly reloaded plugin has no owed map. The CLI retains answer
        // acknowledgements; recover them even without another User prompt.
        served.add(sessionID)
        const session = await sessionInfo(sessionID)
        owe(sessionID, await runHook("user-prompt-submit", { session_id: sessionID, cwd: session.cwd, hook_event_name: "UserPromptSubmit" }))
      }
      served.add(sessionID)
      let pending = activations.get(sessionID)
      if (pending === undefined) {
        pending = resolveActivation(sessionID)
        activations.set(sessionID, pending)
      }
      const { worker, resolved } = await pending
      // A failed lookup is retried on the next request instead of remembered.
      if (resolved === null && activations.get(sessionID) === pending) activations.delete(sessionID)
      const due = owed.get(sessionID)
      if (due !== undefined) {
        owed.delete(sessionID)
        event.system.push({ type: "text", text: due })
      }
      // Successful empty output is the runtime's deliberate guidance-off no-op.
      if (resolved !== null && resolved.trim().length === 0) return
      const context = typeof resolved === "string" && resolved.trim().length > 0
        ? resolved.trim()
        : worker ? WORKER_ACTIVATION_CONTEXT : MISSING_LIFECYCLE_GUIDANCE_CONTEXT
      // OpenCode rebuilds the system parts per model request, so the context is
      // added to every request; only deduplicate callbacks sharing this array.
      if (event.system.some((part) => typeof part?.text === "string" && part.text.includes(context))) return
      event.system.push({ type: "text", text: context })
    })

    /** Agent shells: this harness's marker. OpenCode adds the session's own ID after this hook. */
    await ctx.shell.hook("create.before", (event) => {
      if (event?.env === null || typeof event?.env !== "object") return
      event.env.NOTIFAI_ACTIVE_HARNESS = "opencode"
      event.env.NOTIFAI_OPENCODE_PLUGIN = String(OPENCODE_MAJOR)
    })

    /** Offers Notifai's optional title, Body, images and source on OpenCode's own form, and links the form. */
    await ctx.tool.transform((editor) => editor.update("question", (tool) => {
      const native = tool.execute
      if (typeof native !== "function") return
      const fields = tool.input?.fields
      if (fields !== null && typeof fields === "object" && Object.keys(fields).join(",") === "questions") tool.input = QUESTION_JSON_SCHEMA
      tool.execute = (input, context) => askQuestion(native, input, context)
    }))

    // OpenCode reloads a changed plugin file in place. A form this instance
    // carries keeps its command and its native call, so a reload withdraws
    // nothing; when OpenCode itself exits, the closed pipes end the commands.
    return () => events.abort()
  },
}
`, options.integrationScope)
}
