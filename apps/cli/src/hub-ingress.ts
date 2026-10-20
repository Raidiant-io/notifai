/**
 * Hook ingress through the hub.
 *
 * Generated Claude Code and Codex hooks call the stable native launcher. On
 * macOS and Linux the launcher reads the hook's input itself and offers the
 * invocation to the running hub over the hub's socket (role `ingress`). The
 * hub runs the very same hook handler in-process, with the hook's own
 * environment, directory and input, and hands back what the hook prints.
 * Booting the full runtime for every prompt, turn end and tool call is what
 * this removes.
 *
 * The hub answers only what it can answer exactly as a fresh runtime would:
 * the frequent events of a quiet session (nothing asked, nothing answered,
 * nothing staged, nothing owed). Everything else it declines before doing
 * anything, and the launcher then starts the runtime with the same input,
 * exactly as before. A missing hub, another active build, an exiting hub and
 * any malformed request are declined the same way, so no hook event is lost.
 *
 * Protocol (frames as in `hub-ipc.ts`), after `hello` with role `ingress`:
 * - launcher → hub: one `hook` request (argv, cwd, environment, stdin, build);
 * - hub → launcher: `fallback` (nothing was done; run the runtime), or
 *   `accepted`, then `out` chunks for stdout and stderr, then `exit`.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { CommandDeps } from './commands-core.js'
import { inHookScope } from './hook-scope.js'
import { HOOK_INSTALLABLE_HARNESSES, type HookInstallableHarness } from './harnesses.js'
import { readSessionState, sessionHasEnded } from './hook-session-state.js'
import type { HookEnvelope, SessionState } from './hook-types.js'
import { spawnEndConfirmation, spawnHookMaintenance, spawnRetirement } from './hook-maintenance.js'
import { hookStepBudgets, OWNER_STEP_BUDGETS } from './hook-budgets.js'
import { bootstrapLogger } from './logging.js'
import { isSessionInputWake, readSessionMessagesFile } from './session-inputs.js'

/** The events the hub answers, per harness. Everything else always starts the runtime. */
export const INGRESS_EVENTS: Readonly<Record<'claude-code' | 'codex', readonly string[]>> = {
  // Claude Code's PostToolUse and PermissionRequest, and Codex's PreToolUse,
  // exist only for question pickers and cards; SessionEnd does the close
  // bookkeeping. All of them keep the runtime.
  'claude-code': ['session-start', 'subagent-start', 'user-prompt-submit', 'stop'],
  codex: ['session-start', 'subagent-start', 'user-prompt-submit', 'stop', 'post-tool-use'],
}

/** Largest hook input the hub takes; the runtime reads at most this much too. */
export const INGRESS_MAX_STDIN = 1_000_000
/** Largest piece of hook output in one frame (well inside the launcher's frame limit once encoded). */
const OUTPUT_CHUNK = 256 * 1024

/**
 * Session state fields that change nothing a quiet hook does: bookkeeping,
 * identity and observations. A state holding any other field (a question, an
 * answer, a picker, a wake, an owed acknowledgement, or a field this build does
 * not know) is not quiet, and its hooks keep the runtime.
 */
const QUIET_STATE_FIELDS: ReadonlySet<string> = new Set([
  'grok_activation_context', 'integration_observation', 'runtime_builds', 'codex_native_turn', 'codex_tool_hook',
  'harness', 'activation_cwd', 'codex_stop_definition_fingerprint', 'cursor_activation_claimed_at',
  'cursor_activation_confirmed_at', 'last_prompt_at', 'last_stop_at', 'question_history', 'harness_session_title',
  'codex_question_marker_counter', 'codex_card_tool', 'reopen_launch',
])

/** Variables the launcher scrubs before it starts the runtime, and the admission markers the runtime consumes. */
const RUNTIME_SCRUBBED = /^(BUN_|JSC_|DYLD_)|^(LD_PRELOAD|LD_LIBRARY_PATH|NOTIFAI_NATIVE_ENTRY|NOTIFAI_NATIVE_ROUTE|NOTIFAI_NATIVE_RETRY)$/

export interface IngressRequest {
  event: string
  harness: 'claude-code' | 'codex'
  integrationRevision: string | undefined
  cwd: string
  env: NodeJS.ProcessEnv
  stdin: Buffer
  build: string
  root: string
}

/** What a hub that can serve ingress knows about itself; null when it cannot (a source checkout). */
export interface IngressIdentity { build: string; root: string }

/** A well-formed request, or the reason it is declined. */
export function parseIngressRequest(frame: Record<string, unknown>): IngressRequest | string {
  if (frame['type'] !== 'hook') return 'unknown-request'
  const args = frame['args']
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return 'malformed'
  const parsed = parseHookArgs(args as string[])
  if (parsed === null) return 'arguments'
  const { event, harness, integrationRevision } = parsed
  if (harness !== 'claude-code' && harness !== 'codex') return 'harness'
  if (!INGRESS_EVENTS[harness].includes(event)) return 'event'
  const cwd = frame['cwd'], build = frame['build'], root = frame['root']
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof build !== 'string' || !/^[a-f0-9]{64}$/.test(build) ||
      typeof root !== 'string' || !path.isAbsolute(root)) return 'malformed'
  const stdin = decodeBase64(frame['stdin_b64'])
  const environ = decodeBase64(frame['env_b64'])
  if (stdin === null || environ === null || stdin.length > INGRESS_MAX_STDIN) return 'malformed'
  const env: NodeJS.ProcessEnv = {}
  for (const entry of environ.toString('utf8').split('\0')) {
    const equals = entry.indexOf('=')
    if (equals <= 0) continue
    const name = entry.slice(0, equals)
    // The first definition wins, as getenv() finds it.
    if (!RUNTIME_SCRUBBED.test(name) && !(name in env)) env[name] = entry.slice(equals + 1)
  }
  return { event, harness, integrationRevision, cwd, env, stdin, build, root }
}

/** `hook <event>` followed only by the options a generated hook carries. */
function parseHookArgs(args: string[]): { event: string; harness: HookInstallableHarness | undefined; integrationRevision: string | undefined } | null {
  if (args[0] !== 'hook' || args[1] === undefined || args[1].startsWith('-')) return null
  let harness: string | undefined
  let integrationRevision: string | undefined
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index]!
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    if (name !== '--owner' && name !== '--harness' && name !== '--integration-revision') return null
    const value = inline ?? args[++index]
    if (value === undefined) return null
    if (name === '--harness') harness = value
    else if (name === '--integration-revision') integrationRevision = value
  }
  const known = HOOK_INSTALLABLE_HARNESSES.find((candidate) => candidate === harness)
  return { event: args[1], harness: known, integrationRevision }
}

function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null
  return Buffer.from(value, 'base64')
}

/**
 * Why the hub must not answer this request itself, or null when it may. Every
 * check reads local state only, and nothing is changed by it.
 */
export function ingressRefusal(request: IngressRequest, identity: IngressIdentity | null): string | null {
  if (identity === null) return 'unmanaged-hub'
  if (request.build !== identity.build) return 'other-build'
  if (!sameDirectory(request.root, identity.root)) return 'other-installation'
  let envelope: HookEnvelope
  try {
    const parsed: unknown = JSON.parse(request.stdin.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'input'
    envelope = parsed as HookEnvelope
  } catch {
    return 'input'
  }
  const sessionId = envelope.session_id
  if (typeof sessionId !== 'string' || sessionId === '') return 'no-session'
  // A Codex card is registered (and its answer delivered) by the runtime.
  if (request.event === 'post-tool-use' && envelope.tool_name === 'request_user_input_async') return 'question-card'
  // A Notifai wake is the delivery of something staged; the runtime hands it in or blocks it.
  if (request.event === 'user-prompt-submit' && typeof envelope.prompt === 'string' &&
      (isSessionInputWake(envelope.prompt) || /^Notifai wake [0-9a-f-]{36}\. /.test(envelope.prompt))) return 'input-wake'
  const env = request.env
  if (sessionHasEnded(sessionId, env)) return 'session-ended'
  if (!stateQuiet(readSessionState(sessionId, env))) return 'session-busy'
  if (readSessionMessagesFile(sessionId, env).length > 0) return 'messages-staged'
  return null
}

/** Nothing asked, answered, staged, shown or owed, and nothing this build does not know. */
export function stateQuiet(state: SessionState): boolean {
  for (const [key, value] of Object.entries(state)) {
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) continue
    if (key === 'acknowledgement_blocks' && value === 0) continue
    if (!QUIET_STATE_FIELDS.has(key)) return false
  }
  return true
}

function sameDirectory(left: string, right: string): boolean {
  if (left === right) return true
  try { return realpathSync(left) === realpathSync(right) } catch { return false }
}

/** What the hub lends an in-process hook: its credential, its question owners, its logger setting. */
export interface IngressHost {
  deps: CommandDeps
  cachedStore: CommandDeps['store']
  clientFactory: NonNullable<CommandDeps['clientFactory']>
  settle(sessionId: string, harness: HookInstallableHarness, cwd: string | null, purpose: 'submission' | 'settlement'): void
  inputStaged(sessionId: string): void
}

export interface IngressResult { code: number; stdout: Buffer; stderr: Buffer }

/**
 * Run one accepted hook in this process, exactly as `notifai hook` would:
 * the hook's environment, directory, input and options, with its output
 * collected instead of written.
 */
export async function runIngressHook(host: IngressHost, request: IngressRequest): Promise<IngressResult> {
  const { hookRunCommand } = await import('./commands-hook-run.js')
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const env = request.env
  const budgets = hookStepBudgets(request.event, request.harness)
  let code: number
  try {
    // Everything, the logger's configuration read included, runs in the hook's
    // scope: Git sees the hook's environment and is asked each question once.
    code = await inHookScope(env, () => {
      const deps: CommandDeps = {
        ...host.deps,
        env,
        cwd: request.cwd,
        io: {
          // As `console.log`/`console.error` write one string.
          out: (line) => { stdout.push(Buffer.from(`${line}\n`, 'utf8')) },
          err: (line) => { stderr.push(Buffer.from(`${line}\n`, 'utf8')) },
          interactive: false,
          confirm: async (_question, fallback = false) => fallback,
          openUrl: () => undefined,
        },
        // The hub's one read of the credential store: a hook never runs a credential helper.
        store: host.cachedStore,
        clientFactory: host.clientFactory,
        // A logger of its own, under this hook's project settings, as the runtime starts one.
        logger: bootstrapLogger({ env, cwd: request.cwd,
          ...(budgets.logLockWaitMs === OWNER_STEP_BUDGETS.logLockWaitMs ? {} : { lockWaitMs: budgets.logLockWaitMs }) }),
        // Detached work starts from the hook's environment, as the runtime would start it.
        spawnHookMaintenance: (launch) => spawnHookMaintenance({ ...launch, env }),
        spawnRetirement: (launch) => spawnRetirement({ ...launch, env }),
        spawnEndConfirmation: (launch) => spawnEndConfirmation({ ...launch, env }),
        // The hub already owns question submission and answer waiting in-process.
        spawnQuestionSettlement: (launch) => host.settle(launch.envelope.session_id ?? '', launch.harness,
          launch.envelope.cwd ?? null, launch.purpose === 'submission' ? 'submission' : 'settlement'),
        onSessionInputStaged: (sessionId) => host.inputStaged(sessionId),
      }
      delete deps.questionOwnerRole
      delete deps.invokingNpmAdapterArtifact
      return hookRunCommand(deps, request.event, async () => request.stdin.toString('utf8'), request.harness, request.integrationRevision)
    })
  } catch {
    // A hook never fails its harness.
    code = 0
  }
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
}

/** The reply frames for one result: output in bounded chunks, then the exit status. */
export function resultFrames(result: IngressResult): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  for (const [fd, data] of [[1, result.stdout], [2, result.stderr]] as const) {
    for (let offset = 0; offset < data.length; offset += OUTPUT_CHUNK) {
      frames.push({ type: 'out', fd, data_b64: data.subarray(offset, offset + OUTPUT_CHUNK).toString('base64') })
    }
  }
  frames.push({ type: 'exit', code: result.code })
  return frames
}
