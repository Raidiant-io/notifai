import {
  AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
  CAPABILITIES_V1,
  QUESTION_TEXT_MAX_LENGTH,
  REPLY_MAX_QUESTIONS,
  validateDraft,
  type NotificationDraftT,
  type QuestionT,
} from '@raidiant/notifai-protocol'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { claudeWakeRoute } from './claude-wake.js'
import { ApiCallError } from './client.js'
import { codexWakeRoute } from './codex-wake.js'
import { loadConfig, type CliConfig } from './config.js'
import { withTargetFileLock } from './file-lock.js'
import { HARNESS_CAPABILITIES, HARNESS_LABELS } from './harnesses.js'
import {
  inspectHookAdapter,
  installHookAdapter,
  isNpxAdapterTarget,
  type HookAdapterTarget,
} from './hook-adapter.js'
import {
  clearAcknowledgementObligation,
  claimCursorStopActivation,
  confirmCursorStopActivation,
  dropPendingQuestion,
  handleSessionEnd,
  handleStop,
  handleUserPromptSubmit,
  recordSessionStart,
  parkForRetirement,
  parseHookInput,
  pruneAbandonedSessions,
  readSessionState,
  resetCursorStopActivation,
  registerQuestion,
  withdrawUnpushedQuestions,
  type EscalationDeliveryRoute,
  type HookContext,
  type HookHarness,
  type PendingQuestion,
} from './hooks.js'
import {
  NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS,
  HARNESSES,
  applyPlan,
  buildCursorHookConfig,
  buildHookConfig,
  cleanupEmptiedCodexLayer,
  codexCoexistenceNotes,
  codexHomeNote,
  codexLayerDir,
  codexLayerPaths,
  codexRepresentationProblems,
  codexTrustProblems,
  detectHarness,
  detectedHarnesses,
  findInstallations,
  handlerEvent,
  hookDefinitionFiles,
  loadCursorSettings,
  loadSettings,
  mergeCursorHooks,
  mergeHooks,
  removeCursorHooks,
  removeHooks,
  settingsFile,
  withCodexLayerTransaction,
  type Harness,
  type Installation,
} from './install-hooks.js'
import { QUESTION_WAITER_CEILING_SECONDS } from './question-timing.js'
import { inferInvocationContext } from './invocation-context.js'
import { logConfigResolved, logSettingsFrom } from './logging.js'
import { isOurOpencodePlugin, opencodePluginSource } from './opencode-plugin.js'
import { packageVersion } from './release.js'
import { enableProject, projectBinding, projectEnabled } from './project-enablement.js'
import { rejectAccidentalEscapedNewlines } from './send.js'
import {
  cursorStopActivationOutput,
  sessionActivationOutput,
} from './session-activation.js'
import {
  CHOICE_USAGE,
  buildDraft,
  parseChoices,
  slugify,
  validateMediaInputs,
  type DraftInvocation,
} from './send.js'
import {
  EXIT,
  authedClient,
  diagnoseIgnoredOriginOverride,
  loadLoggedConfig,
  log,
  makeClient,
  rejectedPaths,
  reportError,
  type CommandDeps,
} from './commands-core.js'
import {
  claudeSessionPid,
  resolveActiveHarness,
  type ActiveHarnessSession,
} from './commands-harness-context.js'
import { stopShapeProblems } from './commands-hook-shape.js'
import {
  acknowledgementCommand,
  printAcknowledgementStatus,
  resolveDraftInvocation,
  uploadImage,
  waitForReply,
} from './commands-send-support.js'
import { resolveCommandSession } from './command-session.js'

// ---------------------------------------------------------------------------
// hook / ask / close — harness integration
// ---------------------------------------------------------------------------

export const HOOK_EVENTS = [
  'session-start',
  'subagent-start',
  'activation-stop',
  'user-prompt-submit',
  'stop',
  'session-end',
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** Lifecycle handlers one installed harness must carry in this CLI build. */
export function requiredHookEvents(harness: Harness): readonly HookEvent[] {
  if (harness === 'opencode') return []
  return harness === 'cursor'
    ? ['session-start', 'activation-stop', 'user-prompt-submit', 'stop', 'session-end']
    : ['session-start', 'subagent-start', 'user-prompt-submit', 'stop', 'session-end']
}

/** SessionEnd cleanup must precede every diagnostic that can wait on a file lock. */
export function hookDefersDiagnosticsUntilAfterCleanup(
  event: unknown,
): event is 'session-end' {
  return event === 'session-end'
}

/**
 * Runs one harness hook. Contract with every harness: hook JSON arrives on
 * stdin, harness output (if any) goes to stdout, diagnostics go to stderr, and
 * exit 0 with no stdout means "no decision or added context — carry on as normal".
 *
 * Every failure path in here must reach that no-decision state. A hook that
 * throws, or that blocks past the harness's timeout, degrades the agent for a
 * feature the user only asked to make it more convenient.
 */
export async function hookRunCommand(
  deps: CommandDeps,
  event: string,
  readStdin: () => Promise<string>,
  harness?: HookHarness,
): Promise<number> {
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
    deps.io.err(`Unknown hook event "${event}". Valid: ${HOOK_EVENTS.join(', ')}`)
    return EXIT.usage
  }

  // One clock owns the complete Stop invocation, including stdin, config,
  // credentials, and client construction. Starting this inside `handleStop`
  // would grant slow setup a second budget and let the harness kill us before
  // an accepted answer is journaled or written to stdout.
  const now = deps.now ?? Date.now
  // One owner lifetime covers startup and the longest answer window. Claude
  // runs it detached; Codex holds the turn. The delivery mechanism does not
  // change how long the exact Agent Session remains reachable.
  const processDeadlineAt = now() + QUESTION_WAITER_CEILING_SECONDS * 1000

  const logger = log(deps)
  logger.bind({ cmd: `hook ${event}` })
  let started = false
  const start = (data: Record<string, unknown> = {}): void => {
    if (started) return
    started = true
    logger.info('hook.start', { hook: event, harness: harness ?? 'unknown', ...data })
  }
  const failureData = (err: unknown): Record<string, unknown> =>
    err instanceof ApiCallError
      ? { status: err.status, code: err.code, message: err.message, details: err.details }
      : { message: err instanceof Error ? err.message : String(err) }

  // Cursor may load ~/.claude/settings.json in addition to its own native
  // hooks. Cursor guarantees CURSOR_PROJECT_DIR to hook processes, so a Claude
  // compatibility copy becomes a no-op and the native Cursor definition is
  // the single owner. Real Claude hooks do not receive that hook-only marker.
  if (harness === 'claude-code' && deps.env['CURSOR_PROJECT_DIR']) {
    start({ outcome: 'cursor-compatibility-copy-skipped' })
    logger.info('hook.end', {
      hook: event,
      outcome: 'ignored',
      reason: 'cursor-native-handler-owns-event',
      decided: false,
    })
    return EXIT.ok
  }

  let raw: string
  try {
    raw = await readStdin()
  } catch (err) {
    start({ input: 'unavailable' })
    logger.error('hook.end', {
      hook: event,
      outcome: 'ignored',
      reason: 'input-read-failed',
      ...failureData(err),
    })
    return EXIT.ok
  }

  if (raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    } catch {
      start({ input: 'malformed' })
      logger.error('hook.end', { hook: event, outcome: 'ignored', reason: 'malformed-input' })
      deps.io.err('notifai: ignored malformed or truncated hook input; no routing action was taken')
      return EXIT.ok
    }
  }

  let envelope = parseHookInput(raw)
  if (harness === 'cursor') {
    const sessionId = envelope.session_id ?? envelope.conversation_id
    const cwd = envelope.cwd ?? envelope.workspace_roots?.[0]
    envelope = {
      ...envelope,
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      ...(cwd === undefined ? {} : { cwd }),
      stop_hook_active:
        envelope.stop_hook_active ??
        (typeof envelope.loop_count === 'number' && envelope.loop_count > 0),
    }
  }

  const cwd = envelope.cwd ?? deps.cwd
  const sessionEnd = hookDefersDiagnosticsUntilAfterCleanup(event)
  logger.bind({ session: envelope.session_id ?? null })
  const lifecycleEnabled = (): boolean => {
    try {
      const activationConfig = loadConfig({ cwd, env: deps.env, sessionId: envelope.session_id })
      return projectEnabled(projectBinding(cwd, deps.env, activationConfig.project.value))
    } catch (err) {
      logger.error('hook.end', { hook: event, outcome: 'enablement-unavailable', ...failureData(err) })
      return false
    }
  }
  // Installation only makes lifecycle hooks available. Model-visible
  // activation is a separate User-owned Project decision, checked anew on
  // every run so disabling takes effect without reinstalling anything.
  if (event === 'session-start' || event === 'subagent-start') {
    start({ cwd, source: envelope.source ?? null })
    if (!lifecycleEnabled()) {
      logger.info('hook.end', {
        hook: event,
        outcome: 'ignored',
        reason: 'project-disabled',
        decided: false,
      })
      return EXIT.ok
    }
    if (event === 'session-start' && harness === 'cursor' && envelope.session_id !== undefined) {
      try {
        resetCursorStopActivation(envelope.session_id, deps.env)
      } catch (err) {
        logger.error('hook.end', {
          hook: event,
          outcome: 'reset-failed',
          ...failureData(err),
        })
      }
    }
    const stdout = sessionActivationOutput(
      harness,
      event === 'session-start' ? 'SessionStart' : 'SubagentStart',
      cwd,
      deps.env,
    )
    if (stdout !== undefined) deps.io.out(stdout)
    if (event === 'session-start' && envelope.session_id !== undefined) {
      try {
        recordSessionStart(envelope.session_id, deps.env, harness, cwd)
      } catch (err) {
        logger.error('hook.end', {
          hook: event,
          outcome: 'record-failed',
          reason: 'session-state-failed',
          ...failureData(err),
        })
      }
    }
    logger.info('hook.end', {
      hook: event,
      outcome: stdout === undefined ? 'unsupported-harness' : 'context-added',
      decided: false,
    })
    return EXIT.ok
  }

  // Cursor has a confirmed host bug in which sessionStart.additional_context
  // is accepted but never reaches the model. A native Stop follow-up is the
  // host's guaranteed model-visible channel. Claim it once per conversation,
  // before config/auth/network, and leave the ordinary Stop handler separate
  // so question delivery is never displaced by activation.
  if (event === 'activation-stop') {
    start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
    if (harness !== 'cursor') {
      logger.info('hook.end', { hook: event, outcome: 'unsupported-harness', decided: false })
      return EXIT.ok
    }
    if (!lifecycleEnabled()) {
      logger.info('hook.end', {
        hook: event,
        outcome: 'ignored',
        reason: 'project-disabled',
        decided: false,
      })
      return EXIT.ok
    }
    if (envelope.status === 'aborted') {
      logger.info('hook.end', {
        hook: event,
        outcome: 'ignored',
        reason: `turn-${envelope.status}`,
        decided: false,
      })
      return EXIT.ok
    }
    if (envelope.session_id === undefined) {
      logger.info('hook.end', {
        hook: event,
        outcome: 'ignored',
        reason: 'missing-conversation-id',
        decided: false,
      })
      return EXIT.ok
    }
    if (
      envelope.session_id !== undefined &&
      typeof envelope.loop_count === 'number' &&
      envelope.loop_count > 0
    ) {
      let activationOwned = false
      try {
        activationOwned = confirmCursorStopActivation(envelope.session_id, deps.env, now())
      } catch (err) {
        logger.error('hook.end', {
          hook: event,
          outcome: 'confirm-failed',
          ...failureData(err),
        })
      }
      if (activationOwned) {
        logger.info('hook.end', { hook: event, outcome: 'confirmed', decided: false })
        return EXIT.ok
      }
    }
    const cursorState = readSessionState(envelope.session_id, deps.env)
    if (
      (cursorState.pending?.length ?? 0) > 0 ||
        cursorState.accepted !== undefined ||
        (cursorState.acknowledgement_due?.length ?? 0) > 0
    ) {
      logger.info('hook.end', {
        hook: event,
        outcome: 'deferred',
        reason: 'question-continuation-owns-stop',
        decided: false,
      })
      return EXIT.ok
    }
    let claimed = false
    try {
      claimed = claimCursorStopActivation(envelope.session_id, deps.env, now())
    } catch (err) {
      logger.error('hook.end', {
        hook: event,
        outcome: 'claim-failed',
        ...failureData(err),
      })
    }
    logger.info('hook.end', {
      hook: event,
      outcome: claimed ? 'followup-added' : 'already-activated',
      decided: claimed,
    })
    if (claimed) deps.io.out(cursorStopActivationOutput(cwd, deps.env))
    return EXIT.ok
  }

  let config: CliConfig | null = null
  let configFailure: unknown
  try {
    config = loadConfig({ cwd, env: deps.env, sessionId: envelope.session_id })
    // The hook's project is the session's, not this process's, and the log
    // settings that apply are that project's too. Keeping a mutable bootstrap
    // logger lets this more-specific layer turn logging back on.
    logger.adopt(logSettingsFrom(config))
    logger.bind({ project: config.project.value })
    if (!sessionEnd) {
      start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
      logConfigResolved(logger, config)
    }
  } catch (err) {
    configFailure = err
    if (!sessionEnd) {
      start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
      logger.error('hook.end', {
        hook: event,
        outcome: 'failed',
        reason: 'config-failed',
        ...failureData(err),
      })
      for (const line of describeHookFailure(err)) deps.io.err(`notifai: ${line}`)
      return EXIT.ok
    }
  }

  // Everything below is inside one fail-open boundary. Credential loading,
  // client construction and hook handling can all throw, and a hook that exits
  // non-zero makes the harness report a failure — strictly worse than skipping.
  try {
    if (sessionEnd) {
      // Codex gives SessionEnd one second total. Do every durable cleanup write
      // before lifecycle diagnostics: the log lock is deliberately allowed to
      // wait that long, and a busy log must never preserve ended-session state
      // or its inherited configuration. The resolved config above is retained
      // in memory so logging still uses the ending session's settings afterwards.
      const outcome = handleSessionEnd(deps.env, envelope, (deps.now ?? Date.now)())
      start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
      if (config !== null) logConfigResolved(logger, config)
      const data = { hook: event, decided: false, ...outcome.log }
      if (configFailure === undefined) logger.info('hook.end', data)
      else {
        logger.error('hook.end', {
          ...data,
          reason: 'config-failed',
          config_error: failureData(configFailure),
        })
      }
      for (const note of outcome.notes) deps.io.err(`notifai: ${note}`)
      return EXIT.ok
    }

    // Non-SessionEnd hooks cannot reach here without resolved configuration.
    const resolved = config!
    const credential = deps.store.load()
    if (!credential) {
      logger.error('hook.end', { hook: event, outcome: 'not-paired' })
      deps.io.err('notifai: hook skipped: this machine is not paired; run `notifai login`')
      return EXIT.ok
    }
    // Pin authenticated traffic to the origin the credential was issued for. A
    // repository can commit `.notifai/config.toml`, and honouring a base_url
    // from it would hand this machine's bearer token to whatever host it names.
    const baseUrl = credential.baseUrl
    diagnoseIgnoredOriginOverride(deps.io, resolved, credential)
    // UserPromptSubmit runs in front of the user's own prompt under a 15s
    // harness ceiling and can make two calls, so each gets a small slice of it;
    // Stop is allowed to block and keeps the ordinary budget.
    const client = makeClient(
      deps,
      baseUrl,
      `Bearer nfm_${credential.machineId}.${credential.secret}`,
      {
        timeoutMs: event === 'user-prompt-submit' ? 4_000 : 20_000,
        ...(event === 'stop' ? { deadlineAt: processDeadlineAt, now } : {}),
      },
    )
    const ctx: HookContext = {
      client,
      config: resolved,
      env: deps.env,
      now,
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      waitForFirstReply: async (requestId, timeoutSeconds) => {
        const result = await waitForReply(client, requestId, {
          timeoutSeconds,
          afterSeq: 0,
          now: deps.now,
          sleep: deps.sleep,
        })
        return {
          replies: result.response.replies,
          timedOut: result.timedOut,
          degraded: result.degraded,
        }
      },
      log: logger,
      ...(harness === undefined ? {} : { harness }),
    }

    // Real clock, deliberately, not `deps.now`. This compares against file
    // mtimes, which are wall-clock facts — handing it a virtual or skewed clock
    // would have it delete live session state as "abandoned".
    // Daily state pruning is housekeeping, not part of the Stop delivery
    // contract. Its directory scan has no useful bound, so keep it on the
    // short prompt path and never spend the answer owner's finite budget on it.
    if (event !== 'stop') pruneAbandonedSessions(deps.env)

    const outcome =
      event === 'user-prompt-submit'
        ? await handleUserPromptSubmit(ctx, envelope)
        : await handleStop(
            ctx,
            envelope,
            processDeadlineAt,
            stopWakeRoute(deps, harness, envelope.session_id, cwd),
          )
    // Answer diagnostics are already persisted once as hook.answer. Keep every
    // other note in the lifecycle record without duplicating the user's text.
    const notes = outcome.notes.filter((note) => !/^(?:late )?answer from /.test(note))
    logger.info('hook.end', {
      hook: event,
      decided: outcome.decided ?? outcome.stdout !== undefined,
      ...(notes.length === 0 ? {} : { notes }),
      ...outcome.log,
    })
    for (const note of outcome.notes) deps.io.err(`notifai: ${note}`)
    if (outcome.stdout !== undefined) {
      // No work, await, or diagnostic may sit between this cross-process
      // SessionEnd fence and the irreversible harness stdout write.
      if (outcome.commitStdout === undefined || outcome.commitStdout()) {
        deps.io.out(outcome.stdout)
      } else {
        deps.io.err('notifai: the Agent Session ended before answer delivery; no continuation was written')
      }
    }
    return EXIT.ok
  } catch (err) {
    // SessionEnd defers its start record until after cleanup; if cleanup itself
    // fails, begin the after-the-fact lifecycle here before recording why.
    if (sessionEnd) start({ cwd, stop_hook_active: envelope.stop_hook_active ?? null })
    // The hook still exits 0 — handing the terminal back is always right. What
    // this adds is that the reason survives, including the server's own words.
    logger.error('hook.end', {
      hook: event,
      outcome: 'failed',
      reason: 'execution-failed',
      ...failureData(err),
    })
    for (const line of describeHookFailure(err)) deps.io.err(`notifai: ${line}`)
    return EXIT.ok
  }
}

/**
 * The last meter for an answer this Stop hook accepted, chosen by harness.
 *
 * Both wake adapters need the harness process that invoked this hook: Claude's
 * to prove exact own-child session ownership before it posts to the inbox
 * socket, Codex's to know whether its own stdout is still a live continuation
 * channel. Without an exact session id neither can prove anything, so the
 * waiter falls back to the plain blocking Stop continuation.
 */
function stopWakeRoute(
  deps: CommandDeps,
  harness: Harness | undefined,
  sessionId: string | undefined,
  cwd: string,
): EscalationDeliveryRoute | undefined {
  if (sessionId === undefined) return undefined
  const declaredSourcePid = declaredHookSourcePid(deps)
  if (harness === 'claude-code') {
    if ((deps.hookPlatform ?? process.platform) === 'win32') return undefined
    return claudeWakeRoute({
      sessionId,
      cwd,
      sourcePid: deps.claudeSourcePid ?? declaredSourcePid ?? claudeSessionPid(deps.env),
      ...(deps.claudeWake === undefined ? {} : { adapters: deps.claudeWake }),
    })
  }
  if (harness === 'codex') {
    return codexWakeRoute({
      threadId: sessionId,
      cwd,
      sourcePid: deps.codexSourcePid ?? declaredSourcePid ?? process.ppid,
      env: deps.env,
      ...(deps.codexWake === undefined ? {} : { adapters: deps.codexWake }),
    })
  }
  return undefined
}

/** Stable harness parent propagated by the managed adapter across child tools. */
function declaredHookSourcePid(deps: CommandDeps): number | undefined {
  const value = Number(deps.env['NOTIFAI_HOOK_SOURCE_PID'])
  return Number.isInteger(value) && value > 0 ? value : undefined
}


/**
 * What went wrong, in terms of what to do about it.
 *
 * On 2026-08-03 a contract change shipped without the server deploy that goes
 * with it. The CLI stamped `lifecycle` on every question draft, the deployed
 * server rejected the unknown field, and escalation stopped working entirely —
 * announced as "hook failed, deferring to the terminal", which reads like a
 * flaky network. The information needed to diagnose it in one second was
 * already in hand: a 422 whose details name the offending path. It was being
 * thrown away by `String(err)`.
 *
 * A hook still exits 0 whatever this says. Handing the terminal back is always
 * right; the only question is whether the user is told anything they can use.
 */
export function describeHookFailure(err: unknown): string[] {
  if (!(err instanceof ApiCallError)) {
    return [`hook failed, deferring to the terminal (${String(err)})`]
  }
  const lines = [`hook failed, deferring to the terminal (${err.code}: ${err.message})`]
  const paths = rejectedPaths(err.details)
  if (paths.length > 0) lines.push(`the server rejected: ${paths.join(', ')}`)
  // A 422 on a draft this CLI built is not a user error — this CLI's own
  // contract produced it. Either the server is behind, or the two disagree.
  if (err.status === 422) {
    lines.push(
      'this build sent a field the server did not accept, which usually means the server ' +
        'is older than this CLI — check with `notifai doctor`',
    )
  }
  return lines
}


export interface AskFlags {
  /** Emit the registration and its turn obligation as one JSON object. */
  json?: boolean
  choice?: string[]
  /** The single question is multi-select: several answers may be chosen. */
  multi?: boolean
  /** Optional Markdown context appended after the question block. */
  body?: string
  /** Allow visible backslash-n sequences in `--body`. */
  literalBackslashN?: boolean
  /** Raw JSON for a multi-question form; replaces the positional question. */
  form?: string
  image?: string[]
  imageAlt?: string[]
  project?: string
  sessionLabel?: string
}

export interface AskFailure {
  ok: false
  registered: false
  code: string
  check_id: string
  exit_code: number
  remedy: string
  message: string
}

/** One stable failure contract for every machine-readable ask refusal. */
export function reportAskFailure(
  deps: CommandDeps,
  flags: Pick<AskFlags, 'json'>,
  failure: Omit<AskFailure, 'ok' | 'registered'>,
): number {
  if (flags.json === true) {
    deps.io.out(JSON.stringify({ ok: false, registered: false, ...failure }, null, 2))
  } else {
    deps.io.err(failure.message)
    deps.io.err(`next: ${failure.remedy}`)
  }
  return failure.exit_code
}

function askFailure(
  deps: CommandDeps,
  flags: AskFlags,
  code: string,
  checkId: string,
  message: string,
  remedy: string,
  exitCode: number = EXIT.usage,
): number {
  return reportAskFailure(deps, flags, {
    code,
    check_id: checkId,
    exit_code: exitCode,
    remedy,
    message,
  })
}

/** The `--form` document: what an agent writes to ask several things at once. */
interface AskFormQuestion {
  text: string
  choices?: string[]
  multi?: boolean
}

export interface BuiltQuestions {
  questions: QuestionT[]
  /**
   * Canonical Markdown body. The question already travels as the notification
   * title and as structured questions, so the body carries only the context —
   * repeating the question there put it on the lock screen and the reply
   * screen twice. Only when there is no context does the question text stand
   * in, because the wire requires a body.
   */
  body: string
}

/**
 * Turn ask input into questions plus their canonical body. Everything is
 * validated at registration because a later hook failure is easy to miss.
 */
export function buildQuestions(
  flags: AskFlags,
  question: string | undefined,
): { ok: true; questions: QuestionT[]; body: string } | { ok: false; error: string } {
  if (flags.form !== undefined) {
    if (question !== undefined || flags.choice?.length || flags.multi) {
      return { ok: false, error: '--form replaces the positional question, --choice, and --multi.' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(flags.form)
    } catch {
      return {
        ok: false,
        error: '--form must be JSON: {"questions": [{"text", "choices"?, "multi"?}], "body"?}.',
      }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: `--form needs a "questions" array (1-${REPLY_MAX_QUESTIONS} entries).` }
    }
    const record = parsed as Record<string, unknown>
    const unknownKeys = Object.keys(record).filter((key) => key !== 'questions' && key !== 'body')
    if (unknownKeys.length > 0) {
      return {
        ok: false,
        error: `Unknown --form ${unknownKeys.length === 1 ? 'key' : 'keys'}: ${unknownKeys.join(', ')}. Use "body" for Markdown context.`,
      }
    }
    if (!Array.isArray(record['questions'])) {
      return { ok: false, error: `--form needs a "questions" array (1-${REPLY_MAX_QUESTIONS} entries).` }
    }
    const formQuestions = record['questions']
    if (formQuestions.length < 1 || formQuestions.length > REPLY_MAX_QUESTIONS) {
      return {
        ok: false,
        error: `A form asks 1-${REPLY_MAX_QUESTIONS} questions; this one has ${formQuestions.length}.`,
      }
    }
    if (record['body'] !== undefined && typeof record['body'] !== 'string') {
      return { ok: false, error: '"body" must be a Markdown string.' }
    }
    if (flags.body !== undefined && record['body'] !== undefined) {
      return { ok: false, error: 'Pass form context in either --body or the form "body" key, not both.' }
    }
    const questions: QuestionT[] = []
    const usedIds = new Set<string>()
    for (const [index, entry] of formQuestions.entries()) {
      if (typeof entry !== 'object' || entry === null || typeof (entry as AskFormQuestion).text !== 'string') {
        return { ok: false, error: `Question ${index + 1} needs a "text" string.` }
      }
      const spec = entry as AskFormQuestion
      const built = buildOneQuestion(spec.text, spec.choices, spec.multi === true, index, usedIds)
      if ('error' in built) return { ok: false, error: `Question ${index + 1}: ${built.error}` }
      questions.push(built.question)
    }
    const context = flags.body ?? (record['body'] as string | undefined)
    return {
      ok: true,
      questions,
      body:
        context !== undefined && context.trim() !== ''
          ? context
          : questions.map((entry, index) => `${index + 1}. ${entry.text}`).join('\n'),
    }
  }

  if (question === undefined || question.trim() === '') {
    return { ok: false, error: 'The question cannot be empty.' }
  }
  const built = buildOneQuestion(question, flags.choice, flags.multi === true, 0, new Set())
  if ('error' in built) return { ok: false, error: built.error }
  const context = flags.body
  return {
    ok: true,
    questions: [built.question],
    body: context !== undefined && context.trim() !== '' ? context : built.question.text,
  }
}

function buildOneQuestion(
  text: string,
  choiceLabels: string[] | undefined,
  multi: boolean,
  index: number,
  usedIds: Set<string>,
): { question: QuestionT } | { error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { error: 'the question text cannot be empty.' }
  if (trimmed.length > QUESTION_TEXT_MAX_LENGTH) {
    return {
      error:
        `a question must be readable where it is answered: keep it within ` +
        `${QUESTION_TEXT_MAX_LENGTH} characters and put the longer context in --body.`,
    }
  }
  const choices = parseChoices(choiceLabels)
  if (choices === 'invalid') return { error: CHOICE_USAGE }
  if (multi && choices === null) {
    return { error: '--multi needs answers to select between; add --choice.' }
  }
  let id = slugify(trimmed)
  if (id === '' || usedIds.has(id)) id = `q${index + 1}`
  usedIds.add(id)
  return {
    question: {
      id,
      text: trimmed,
      ...(choices !== null ? { choices } : {}),
      ...(multi ? { multi: true } : {}),
    },
  }
}

function buildAskDraft(
  config: CliConfig,
  built: BuiltQuestions,
  flags: AskFlags,
  invocation: DraftInvocation,
  mediaIds: string[],
): { ok: true; draft: NotificationDraftT } | { ok: false; error: string } {
  const result = buildDraft(
    config,
    {
      title: built.questions[0]!.text,
      body: built.body,
      ...(flags.project !== undefined ? { project: flags.project } : {}),
      ...(mediaIds.length > 0 ? { image: mediaIds } : {}),
      ...(flags.imageAlt !== undefined ? { imageAlt: flags.imageAlt } : {}),
      reply: true,
      questions: built.questions,
    },
    invocation,
  )
  if (!result.ok) return result
  const capabilities = CAPABILITIES_V1.describe(result.platform)
  if (capabilities === null) return { ok: false, error: 'No iOS capability contract is available.' }
  const validation = validateDraft(result.draft, capabilities)
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join('\n'),
    }
  }
  return { ok: true, draft: result.draft }
}

function recordRegisteredQuestion(
  deps: CommandDeps,
  sessionId: string,
  built: BuiltQuestions,
  draft: NotificationDraftT,
  json = false,
): number {
  let questionId: string
  try {
    questionId = registerQuestion(
      sessionId,
      deps.env,
      {
        question: built.questions[0]!.text,
        questions: built.questions,
        body: draft.presentation.body,
        ...(draft.project !== undefined ? { project: draft.project } : {}),
        ...(draft.source !== undefined ? { source: draft.source } : {}),
        ...(draft.presentation.media !== undefined ? { media: draft.presentation.media } : {}),
      },
      (deps.now ?? Date.now)(),
    )
  } catch (err) {
    log(deps).error('ask.registered', { ok: false, session: sessionId, message: String(err) })
    return askFailure(
      deps,
      { json },
      'registration_failed',
      'question_registration',
      `Could not register the question: ${err instanceof Error ? err.message : String(err)}`,
      'retire an older pending question if the limit was reached, then retry the same ask',
      EXIT.failed,
    )
  }
  log(deps).info('ask.registered', {
    ok: true,
    session: sessionId,
    question_id: questionId,
    questions: built.questions.length,
    text_chars: built.questions[0]!.text.length,
    choices: built.questions[0]!.choices?.length ?? 0,
    media: draft.presentation.media?.length ?? 0,
  })
  // The block below is the densest guidance this CLI prints, and until now it
  // was prose only: an agent could not read back the choice ids it must branch
  // on without asking the server for them. The JSON form carries the same
  // obligation as data.
  if (json) {
    deps.io.out(
      JSON.stringify(
        {
          registered: true,
          question_id: questionId,
          questions: built.questions.map((entry) => ({
            id: entry.id,
            text: entry.text,
            ...(entry.choices === undefined ? {} : { choices: entry.choices }),
            ...(entry.multi === true ? { multi: true } : {}),
          })),
          close: `notifai close ${questionId}`,
          next: {
            end_turn: true,
            in_this_turn:
              'Ask the question in the conversation and say what concrete work each possible answer will make you resume, then end the turn.',
            route_neutral:
              'Never say where the answer must arrive; it returns by whatever route the harness supports.',
            on_answer:
              'Acknowledge it, then resume the committed work without asking the user to confirm again.',
            answered_outside_notifai: `If they answer in the conversation instead, run \`notifai close ${questionId}\` before ending the turn so a later Stop will not send this question.`,
          },
        },
        null,
        2,
      ),
    )
    return EXIT.ok
  }
  for (const [index, entry] of built.questions.entries()) {
    const prefix = built.questions.length > 1 ? `${index + 1}. ` : ''
    if (entry.choices !== undefined) {
      const kind = entry.multi === true ? 'answers offered (several may be chosen)' : 'answers offered'
      deps.io.out(`${prefix}${entry.text} — ${kind}: ${entry.choices.map((choice) => choice.label).join(' / ')}`)
    } else if (built.questions.length > 1) {
      deps.io.out(`${prefix}${entry.text} — free text`)
    }
  }
  deps.io.out(
    built.questions.length > 1
      ? `${built.questions.length} questions registered as one form (${questionId}). Ask them in the conversation, state the concrete work you will resume for their answers, then end your turn.`
      : `Question registered (${questionId}). Ask it in the conversation, state the concrete work you will resume when the answer arrives, then end your turn.`,
  )
  deps.io.out('Before ending this turn, pre-commit in your own words to the work you will resume:')
  for (const [index, entry] of built.questions.entries()) {
    const questionPrefix = built.questions.length > 1 ? `Question ${index + 1}, ` : ''
    if (entry.choices !== undefined) {
      for (const choice of entry.choices) {
        deps.io.out(
          `- ${questionPrefix}If the answer is ${JSON.stringify(choice.label)}: state the concrete work you will resume.`,
        )
      }
      deps.io.out(
        `- ${questionPrefix}For an unexpected typed answer: state how it will determine the concrete work you resume.`,
      )
    } else {
      deps.io.out(
        `- ${questionPrefix}For the free-text answer: state how its content will determine the concrete work you resume.`,
      )
    }
  }
  deps.io.out(
    'When the answer arrives, resume the matching work without asking the user to confirm again. Frame this as work you will resume, not as approval you receive.',
  )
  deps.io.out(
    'A Notifai answer cannot answer a harness permission prompt or interactive picker; leave those to the harness and user.',
  )
  deps.io.out(
    `If they answer in this conversation instead, retire it with \`notifai close ${questionId}\` so a later Stop will not send it.`,
  )
  return EXIT.ok
}

async function uploadAskMedia(
  deps: CommandDeps,
  config: CliConfig,
  sessionId: string,
  built: BuiltQuestions,
  flags: AskFlags,
  invocation: DraftInvocation,
): Promise<number> {
  const authed = authedClient(deps, config)
  if (!authed) {
    return askFailure(
      deps,
      flags,
      'auth_required',
      'credential',
      'Question routing is not paired on this machine.',
      'run `notifai init --json`',
      EXIT.auth,
    )
  }
  const mediaIds: string[] = []
  for (const image of flags.image ?? []) {
    if (image.startsWith('med_')) {
      mediaIds.push(image)
      continue
    }
    const uploaded = await uploadImage(deps, authed.client, image, config.media_origins.value)
    if (!uploaded.ok) {
      if (uploaded.error !== null) deps.io.err(uploaded.error)
      return askFailure(
        deps,
        flags,
        'media_upload_failed',
        'media',
        uploaded.error ?? 'The image upload failed.',
        'fix the reported image or network problem, then retry the same ask',
        uploaded.exit,
      )
    }
    mediaIds.push(uploaded.mediaId)
  }
  const ready = buildAskDraft(config, built, flags, invocation, mediaIds)
  if (!ready.ok) {
    return askFailure(deps, flags, 'invalid_draft', 'draft', ready.error, 'fix the reported field and retry')
  }
  return recordRegisteredQuestion(deps, sessionId, built, ready.draft, flags.json === true)
}

/**
 * Registers a question for turn-end routing. Returns immediately so the agent
 * can ask in prose and end its turn; the terminal keeps the question to itself
 * for `ask_grace_seconds` before it reaches any device.
 */
export function askCommand(
  deps: CommandDeps,
  question: string | undefined,
  flags: AskFlags,
): number | Promise<number> {
  // Validate before route discovery. A malformed question belongs to the
  // caller and should not be hidden behind whichever harness setup issue
  // happens to exist on this machine.
  const escapedBody = rejectAccidentalEscapedNewlines(flags.body, flags.literalBackslashN)
  if (escapedBody !== null) {
    return askFailure(deps, flags, 'invalid_input', 'body', escapedBody, 'fix the body and retry')
  }
  const built = buildQuestions(flags, question)
  if (!built.ok) {
    return askFailure(deps, flags, 'invalid_input', 'questions', built.error, 'fix the question input and retry')
  }
  const mediaInputError = validateMediaInputs(flags.image, flags.imageAlt)
  if (mediaInputError !== null) {
    return askFailure(deps, flags, 'invalid_input', 'media', mediaInputError, 'fix the media flags and retry')
  }
  let explicitUseConfig: CliConfig
  try {
    explicitUseConfig = loadConfig({ cwd: deps.cwd, env: deps.env })
  } catch (err) {
    return askFailure(deps, flags, 'config_invalid', 'configuration', `Question routing configuration is invalid: ${String(err)}`, 'fix the reported Notifai configuration and retry')
  }
  const explicitProject = flags.project ?? explicitUseConfig.project.value ?? inferInvocationContext(deps.cwd).project
  if (explicitProject !== null) {
    const binding = projectBinding(deps.cwd, deps.env, explicitProject)
    if (binding !== null) enableProject(binding)
  }
  if (deps.store.load() === null) {
    return askFailure(
      deps,
      flags,
      'auth_required',
      'credential',
      'Question routing is not paired on this machine.',
      'run `notifai init --json`',
      EXIT.auth,
    )
  }
  // An agent calling this gets no hook payload. Harness-native environment
  // markers identify the active owner, while UserPromptSubmit adds the hook's
  // canonical id to the directory's concurrent-session index.
  const now = (deps.now ?? Date.now)()
  const { active, contested } = resolveActiveHarness(deps.env, deps.cwd, now)
  let sessionId: string | undefined
  if (active !== null) {
    if (contested.length > 1) {
      return askFailure(
        deps,
        flags,
        'session_identity_ambiguous',
        'exact_session',
        `Several harness sessions could own this shell (${contested.map((candidate) => candidate.label).join(', ')}).`,
        'run the ask from a shell with one exact active harness session',
      )
    }
    const exactState = active.sessionId === undefined
      ? null
      : readSessionState(active.sessionId, deps.env)
    const installationCwd = exactState?.activation_cwd ?? deps.cwd
    const installationDeps = installationCwd === deps.cwd ? deps : { ...deps, cwd: installationCwd }
    const installations = findInstallations(installationCwd, deps.env, deps.hookAdapterHome, deps.hookPlatform)
    const activeInstalled = installations.some(
      (installation) => installation.harness === active.harness,
    )
    if (!activeInstalled) {
      return askFailure(
        deps,
        flags,
        'hooks_not_installed',
        'hook_installation',
        `Notifai ${active.label} hooks are not installed for this project.`,
        `run \`notifai init --json\` from this ${active.label} session`,
      )
    }
    if (active.sessionId === undefined) {
      return askFailure(
        deps,
        flags,
        'session_identity_missing',
        'exact_session',
        `The active ${active.label} shell does not expose an exact session id.`,
        'use a blocking `notifai send --reply` question',
      )
    }
    const routeProblems = activeQuestionRouteProblems(installationDeps, active, installations)
    if (routeProblems.length > 0) {
      return askFailure(
        deps,
        flags,
        'question_routing_unavailable',
        'hook_contract',
        `Question routing is not ready: ${routeProblems.join('; ')}`,
        'run `notifai init --json` and follow its question-routing remedy',
      )
    }
    const state = exactState ?? readSessionState(active.sessionId, deps.env)
    if (state.harness !== active.harness || state.last_prompt_at === undefined) {
      return askFailure(
        deps,
        flags,
        'session_not_activated',
        'user_prompt_submit',
        `This exact ${active.label} session has not fired UserPromptSubmit.`,
        `send one prompt in this ${active.label} session, then retry \`notifai ask --json\``,
      )
    }
    if (state.last_stop_at === undefined) {
      return askFailure(
        deps,
        flags,
        'stop_not_observed',
        'stop_hook',
        `This exact ${active.label} session has fired UserPromptSubmit, but its Stop hook has not been observed.`,
        `end one harmless turn, send a new prompt, then retry \`notifai ask --json\``,
      )
    }
    sessionId = active.sessionId
  } else {
    return askFailure(
      deps,
      flags,
      'session_identity_missing',
      'exact_session',
      'Could not prove which live Agent Session owns this command.',
      'run it from a supported harness with exact Agent Session identity, or use a blocking `notifai send --reply` question',
    )
  }
  if (!sessionId) {
    return askFailure(deps, flags, 'session_identity_missing', 'exact_session', 'No exact active Agent Session is available.', 'use a blocking `notifai send --reply` question')
  }
  let routingConfig: CliConfig
  try {
    routingConfig = loadConfig({ cwd: deps.cwd, env: deps.env, sessionId })
  } catch (err) {
    return askFailure(
      deps,
      flags,
      'config_invalid',
      'configuration',
      `Question routing configuration is invalid: ${String(err)}`,
      'fix the reported Notifai configuration and retry',
    )
  }
  if (!routingConfig.ask_notifications.value) {
    return askFailure(
      deps,
      flags,
      'question_routing_disabled',
      'ask_notifications',
      'Question routing is disabled by ask_notifications=false.',
      'enable question routing or use a blocking `notifai send --reply` question',
    )
  }
  const source = resolveDraftInvocation(deps, flags, active)
  if (!source.ok) {
    return askFailure(deps, flags, 'invalid_source', 'source_context', source.error, 'remove the conflicting source override and retry')
  }
  if (source.invocation.source?.session_id !== sessionId) {
    return askFailure(
      deps,
      flags,
      'session_identity_mismatch',
      'exact_session',
      `The inferred session does not match the exact active ${active.label} session.`,
      'remove NOTIFAI_SESSION_ID and retry from the exact active session',
    )
  }

  // Placeholders let every body, source, project, media, and payload limit fail
  // before an upload starts. The real ids replace them only after this passes.
  const placeholders = (flags.image ?? []).map((_, index) => `med_pending_${index + 1}`)
  const preflight = buildAskDraft(routingConfig, built, flags, source.invocation, placeholders)
  if (!preflight.ok) {
    return askFailure(deps, flags, 'invalid_draft', 'draft', preflight.error, 'fix the reported field and retry')
  }
  if ((flags.image?.length ?? 0) > 0) {
    return uploadAskMedia(
      deps,
      routingConfig,
      sessionId,
      built,
      flags,
      source.invocation,
    )
  }
  return recordRegisteredQuestion(deps, sessionId, built, preflight.draft, flags.json === true)
}


/**
 * One fail-closed admission gate shared by every active harness route.
 * Finding a file is not readiness: the exact session, one current definition,
 * the stable adapter, a long enough Stop owner, and (for Codex) trust must all
 * be true before `ask` is allowed to create an answerable notification.
 */
export function activeQuestionRouteProblems(
  deps: CommandDeps,
  active: ActiveHarnessSession,
  installations: Installation[],
): string[] {
  const problems: string[] = []
  if (active.sessionId === undefined) {
    problems.push(
      `the active ${active.label} shell does not expose an exact session id; a project-level last-writer pointer can cross-wire two sessions. Use a blocking \`notifai send --reply\` question`,
    )
  }
  const capability = HARNESS_CAPABILITIES[active.harness]
  if (capability.stopContinuation === 'unsupported') {
    problems.push(`${active.label}: ${capability.deliveryContract}`)
  }
  const matching = installations.filter(
    (installation) => installation.harness === active.harness,
  )
  if (matching.length > 1) {
    problems.push(
      `${matching.length} ${active.label} definitions are active (${matching.map((entry) => entry.file).join(', ')}); keep either project or global routing`,
    )
  }
  for (const installation of matching) {
    for (const problem of installation.problems ?? []) {
      problems.push(`${installation.file}: ${problem}`)
    }
    for (const handler of installation.handlers) {
      const event = handlerEvent(handler.command)
      if (event !== null && !(HOOK_EVENTS as readonly string[]).includes(event)) {
        problems.push(
          `${handler.event} in ${installation.file} names the unsupported event ${event}; reinstall the ${active.label} hooks`,
        )
      }
    }
  }
  for (const problem of inspectHookAdapter(deps.hookAdapterHome, deps.hookPlatform).problems) {
    problems.push(problem)
  }
  for (const installation of matching) problems.push(...stopShapeProblems(installation, deps.hookPlatform))
  problems.push(...codexTrustProblems(matching, deps.env))
  return [...new Set(problems)]
}

/** The least disruptive verified way to make each installed adapter run once. */
export function hookActivationAdvice(installations: Installation[]): string {
  const harnesses = new Set(installations.map((installation) => installation.harness))
  const advice: string[] = []
  if (
    installations.some(
      (installation) => installation.harness === 'claude-code' && !installation.global,
    )
  ) {
    advice.push('Claude Code: start one fresh session, send one prompt, then run `notifai doctor`')
  }
  if (
    installations.some(
      (installation) => installation.harness === 'claude-code' && installation.global,
    )
  ) {
    advice.push('Claude Code global hooks: start one fresh session, send one prompt, then run `notifai doctor`')
  }
  if (
    installations.some(
      (installation) => installation.harness === 'cursor' && !installation.global,
    )
  ) {
    advice.push(
      'Cursor: start one fresh conversation, send one prompt, finish its first turn, then run `notifai doctor`',
    )
  }
  if (
    installations.some(
      (installation) => installation.harness === 'cursor' && installation.global,
    )
  ) {
    advice.push('Cursor global hooks: start one fresh conversation, send one prompt, finish its first turn, then run `notifai doctor`')
  }
  if (harnesses.has('codex')) {
    advice.push(
      'Codex: approve the Notifai handlers in `/hooks` if asked, start one fresh session, send one prompt, then run `notifai doctor`',
    )
  }
  if (harnesses.has('opencode')) {
    advice.push(
      'OpenCode: restart it, then send one prompt; plugins load at startup, but non-blocking question continuation is intentionally unsupported',
    )
  }
  return `${advice.join('. ')}.`
}

/**
 * Record the one Agent Acknowledgement associated with a replied-to request.
 *
 * `--text` is optional here because the acknowledgement is not: an account may
 * turn the agent's written reply off, and the receipt must still be recorded so
 * the user sees that an agent read the answer. The service holds the account's
 * snapshot, so it — not this process — decides whether text was owed.
 */
export async function acknowledgeCommand(
  deps: CommandDeps,
  requestId: string,
  flags: { text?: string; json?: boolean },
): Promise<number> {
  const text = flags.text?.trim() ?? ''
  if (flags.text !== undefined && text.length === 0) {
    deps.io.err('--text must contain non-whitespace text. Drop it to acknowledge without text.')
    return EXIT.usage
  }
  if (text.length > AGENT_ACKNOWLEDGEMENT_MAX_LENGTH) {
    deps.io.err(
      `--text must be at most ${AGENT_ACKNOWLEDGEMENT_MAX_LENGTH} characters after trimming. Shorten it: an acknowledgement is a receipt, not a report.`,
    )
    return EXIT.usage
  }

  const logger = log(deps)
  const lifecycleSession = resolveCommandSession(deps, requestId)
  const config = loadLoggedConfig(deps, {
    cwd: deps.cwd,
    env: deps.env,
    ...(lifecycleSession === null ? {} : { sessionId: lifecycleSession.sessionId }),
  })
  logger.info('acknowledgement.attempted', {
    request_id: requestId,
    characters: text.length,
  })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const result = await authed.client.putAgentAcknowledgement(
      requestId,
      text.length > 0 ? { text } : {},
    )
    const output = {
      request_id: requestId,
      outcome: result.status,
      acknowledgement: result.agent_acknowledgement,
      agent_acknowledgement_required: true,
    }
    logger.info('acknowledgement.outcome', {
      request_id: requestId,
      outcome: result.status,
      text_chars: result.agent_acknowledgement.text.length,
      created_at: result.agent_acknowledgement.created_at,
      agent_acknowledgement_required: true,
    })
    if (lifecycleSession !== null) {
      clearAcknowledgementObligation(lifecycleSession.sessionId, deps.env, requestId)
    }
    if (flags.json) deps.io.out(JSON.stringify(output, null, 2))
    else {
      deps.io.out(
        `Agent Acknowledgement ${result.status} for ${requestId} at ${result.agent_acknowledgement.created_at}.`,
      )
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err, { operation: 'agent_acknowledgement', request_id: requestId })
  }
}

/** Retire a question so a late answer is rejected rather than silently lost. */
export async function closeCommand(
  deps: CommandDeps,
  requestId: string | undefined,
  flags: { json?: boolean; pending?: boolean } = {},
): Promise<number> {
  if (flags.pending === true && requestId !== undefined) {
    deps.io.err('Pass a request id or --pending, not both.')
    return EXIT.usage
  }
  if (flags.pending !== true && requestId === undefined) {
    deps.io.err('Pass a request id or --pending.')
    return EXIT.usage
  }

  if (flags.pending === true) {
    return closePendingQuestions(deps, flags.json === true)
  }

  const local = await closeLocalQuestion(deps, requestId!, flags.json === true)
  if (local !== null) return local

  const lifecycleSession = resolveCommandSession(deps, requestId!)
  const config = loadLoggedConfig(deps, {
    cwd: deps.cwd,
    env: deps.env,
    ...(lifecycleSession === null ? {} : { sessionId: lifecycleSession.sessionId }),
  })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const response = await authed.client.closeReplies(requestId!)
    forgetClosedQuestion(deps, requestId!)
    if (flags.json) {
      deps.io.out(
        JSON.stringify(
          {
            ...response,
            acknowledgement_command: acknowledgementCommand(
              response.request_id,
              response.agent_acknowledgement_required,
              response.agent_acknowledgement_text_required,
              response.agent_acknowledgement,
              response.replies.length > 0,
            ),
          },
          null,
          2,
        ),
      )
    } else {
      deps.io.out(`Closed the reply window for ${requestId}.`)
      if (response.replies.length > 0) printAcknowledgementStatus(deps, response)
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err)
  }
}

/**
 * Retire this session's outstanding questions, including registrations the
 * Stop hook has not pushed yet. Unpushed entries only exist locally: dropping
 * them is the whole retirement. Live ones still need their reply window closed.
 */
async function closePendingQuestions(deps: CommandDeps, json: boolean): Promise<number> {
  const lifecycleSession = resolveCommandSession(deps)
  if (lifecycleSession === null) {
    deps.io.err('No active session pointer is available in this directory.')
    return EXIT.noReply
  }
  const sessionId = lifecycleSession.sessionId
  const pending = readSessionState(sessionId, deps.env).pending ?? []
  if (pending.length === 0) {
    if (json) {
      deps.io.out(
        JSON.stringify({ session_id: sessionId, withdrawn: [], closed: [] }, null, 2),
      )
    } else {
      deps.io.err(`Session ${sessionId} has no registered question pending.`)
    }
    return EXIT.noReply
  }

  const withdrawn = withdrawUnpushedQuestions(sessionId, deps.env)
  const live = (readSessionState(sessionId, deps.env).pending ?? []).filter(
    (entry): entry is PendingQuestion & { request_id: string } =>
      entry.request_id !== undefined,
  )

  const closed: string[] = []
  if (live.length > 0) {
    const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env, sessionId })
    const authed = authedClient(deps, config)
    if (!authed) return EXIT.auth
    for (const entry of live) {
      try {
        await authed.client.closeReplies(entry.request_id)
        parkClosedQuestion(sessionId, deps.env, entry)
        dropPendingQuestion(sessionId, deps.env, entry)
        closed.push(entry.request_id)
      } catch (err) {
        return reportError(deps, err, { operation: 'close', request_id: entry.request_id })
      }
    }
  }

  const output = {
    session_id: sessionId,
    withdrawn: withdrawn.map((entry) => ({
      question: entry.question,
      ...(entry.question_id === undefined ? {} : { question_id: entry.question_id }),
    })),
    closed,
  }
  if (json) deps.io.out(JSON.stringify(output, null, 2))
  else {
    if (withdrawn.length > 0) {
      deps.io.out(
        withdrawn.length === 1
          ? 'Withdrew 1 unpushed question so a later Stop will not send it.'
          : `Withdrew ${withdrawn.length} unpushed questions so a later Stop will not send them.`,
      )
    }
    for (const requestId of closed) {
      deps.io.out(`Closed the reply window for ${requestId}.`)
    }
  }
  return EXIT.ok
}

/**
 * Close one outstanding question by the stable id `notifai ask` returned, or
 * by a request id already on a device. Unpushed entries only exist locally.
 * Returns null when this directory's session has no matching registration, so
 * the caller can still close a live request id against the service.
 */
async function closeLocalQuestion(
  deps: CommandDeps,
  id: string,
  json: boolean,
): Promise<number | null> {
  const lifecycleSession = resolveCommandSession(deps, id)
  if (lifecycleSession === null) return null
  const sessionId = lifecycleSession.sessionId
  const entry = (readSessionState(sessionId, deps.env).pending ?? []).find(
    (candidate) => candidate.question_id === id || candidate.request_id === id,
  )
  if (entry === undefined) return null

  if (entry.request_id === undefined) {
    dropPendingQuestion(sessionId, deps.env, entry)
    const output = {
      session_id: sessionId,
      withdrawn: [
        {
          question: entry.question,
          ...(entry.question_id === undefined ? {} : { question_id: entry.question_id }),
        },
      ],
      closed: [] as string[],
    }
    if (json) deps.io.out(JSON.stringify(output, null, 2))
    else {
      deps.io.out(
        `Withdrew unpushed question ${entry.question_id ?? id} so a later Stop will not send it.`,
      )
    }
    return EXIT.ok
  }

  const config = loadLoggedConfig(deps, { cwd: deps.cwd, env: deps.env, sessionId })
  const authed = authedClient(deps, config)
  if (!authed) return EXIT.auth
  try {
    const response = await authed.client.closeReplies(entry.request_id)
    parkClosedQuestion(sessionId, deps.env, entry)
    dropPendingQuestion(sessionId, deps.env, entry)
    if (json) {
      deps.io.out(
        JSON.stringify(
          {
            ...response,
            question_id: entry.question_id,
            acknowledgement_command: acknowledgementCommand(
              response.request_id,
              response.agent_acknowledgement_required,
              response.agent_acknowledgement_text_required,
              response.agent_acknowledgement,
              response.replies.length > 0,
            ),
          },
          null,
          2,
        ),
      )
    } else {
      deps.io.out(`Closed the reply window for ${entry.request_id}.`)
      if (response.replies.length > 0) printAcknowledgementStatus(deps, response)
    }
    return EXIT.ok
  } catch (err) {
    return reportError(deps, err, { operation: 'close', request_id: entry.request_id })
  }
}

function forgetClosedQuestion(deps: CommandDeps, requestId: string): void {
  const lifecycleSession = resolveCommandSession(deps, requestId)
  if (lifecycleSession === null) return
  const sessionId = lifecycleSession.sessionId
  const entry = (readSessionState(sessionId, deps.env).pending ?? []).find(
    (candidate) => candidate.request_id === requestId,
  )
  if (entry === undefined) return
  parkClosedQuestion(sessionId, deps.env, entry)
  dropPendingQuestion(sessionId, deps.env, entry)
}

function parkClosedQuestion(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  entry: PendingQuestion,
): void {
  try {
    parkForRetirement(sessionId, env, entry, 'expired')
  } catch {
    // Incomplete identifiers cannot be retired on a device; dropping the
    // local record is still the right way to stop a later Stop from waiting.
  }
}

export interface HooksInstallFlags {
  harness?: string
  global?: boolean
  /** Init owns the final setup result and suppresses per-harness close narration. */
  narrate?: boolean
  /** Test seam; production resolves the running CLI. */
  execPath?: string
  scriptPath?: string
}

/** True when this process is `npx` / `npm exec`, not a global or linked install. */
export function runningViaNpx(env: NodeJS.ProcessEnv, scriptPath: string): boolean {
  if (env['npm_command'] === 'exec') return true
  return scriptPath.includes(`${path.sep}_npx${path.sep}`)
}

function fileHookInstallTarget(
  target: HookAdapterTarget | undefined,
): { execPath: string; scriptPath: string } | undefined {
  if (target === undefined || isNpxAdapterTarget(target)) return undefined
  return target
}

function resolveHookAdapterTarget(deps: CommandDeps, flags: HooksInstallFlags): HookAdapterTarget {
  if (deps.hookInstallTarget !== undefined && isNpxAdapterTarget(deps.hookInstallTarget)) {
    return deps.hookInstallTarget
  }
  const fileTarget = fileHookInstallTarget(deps.hookInstallTarget)
  const execPath = flags.execPath ?? fileTarget?.execPath ?? process.execPath
  const scriptPath = flags.scriptPath ?? fileTarget?.scriptPath ?? process.argv[1] ?? 'notifai'
  if (runningViaNpx(deps.env, scriptPath)) {
    const version = packageVersion()
    const npmCli = deps.env['npm_execpath']
    if (version === null) {
      throw new Error(
        'Could not read this CLI version, so an npx hook target cannot be pinned. Install `@raidiant/notifai` globally and rerun `notifai hooks install`.',
      )
    }
    if (typeof npmCli !== 'string' || npmCli === '') {
      throw new Error(
        'This process looks like npx but npm_execpath is missing. Install `@raidiant/notifai` globally and rerun `notifai hooks install`.',
      )
    }
    return { kind: 'npx', execPath, npmCli, spec: `@raidiant/notifai@${version}` }
  }
  return { execPath, scriptPath }
}

function printHooksInstallClose(deps: CommandDeps, harness: Harness, file: string): void {
  const label = HARNESS_LABELS[harness]
  const activation =
    harness === 'codex'
      ? 'Approve the Notifai handlers in `/hooks` if Codex asks, then start one fresh Codex session, send one prompt, and run `notifai doctor`.'
      : harness === 'cursor'
        ? 'Start one fresh Cursor conversation, send one prompt, finish its first turn, then run `notifai doctor`.'
        : harness === 'opencode'
          ? 'Restart OpenCode, start one fresh session, send one prompt, then run `notifai doctor`.'
          : `Start one fresh ${label} session, send one prompt, then run \`notifai doctor\`.`
  if (deps.io.interactive === true && deps.io.note) {
    void deps.io.note(`${file}\n${activation}`, `${label} hooks installed`)
    return
  }
  deps.io.out(`Installed ${harness} hooks in ${file}`)
  deps.io.out(activation)
}

export function hooksInstallCommand(deps: CommandDeps, flags: HooksInstallFlags): number {
  if (flags.harness === undefined) {
    const detected = detectedHarnesses(deps.cwd, deps.env)
    if (detected.length === 0) {
      deps.io.err(`Could not tell which harness you mean — pass --harness <${HARNESSES.join('|')}>.`)
      return EXIT.usage
    }
    let ok = true
    for (const harness of detected) {
      if (hooksInstallCommand(deps, { ...flags, harness }) !== EXIT.ok) ok = false
    }
    return ok ? EXIT.ok : EXIT.failed
  }
  const harness = resolveHarness(deps, flags.harness)
  if (!harness) return EXIT.usage
  const adapterTarget = resolveHookAdapterTarget(deps, flags)
  const scriptPath =
    flags.scriptPath ?? fileHookInstallTarget(adapterTarget)?.scriptPath ?? process.argv[1] ?? 'notifai'
  const hookPlatform = deps.hookPlatform ?? process.platform
  const nodePath = adapterTarget.execPath
  let adapterPath: string
  try {
    adapterPath = installHookAdapter(adapterTarget, deps.hookAdapterHome, hookPlatform).path
  } catch (err) {
    deps.io.err(`Could not prepare the stable hook adapter: ${String(err)}`)
    return EXIT.failed
  }
  const wantGlobal = flags.global === true
  const existing = findInstallations(deps.cwd, deps.env, deps.hookAdapterHome, deps.hookPlatform).filter(
    (installation) => installation.harness === harness,
  )
  const otherScope = existing.filter((installation) => installation.global !== wantGlobal)
  if (!wantGlobal && otherScope.some((installation) => installation.global)) {
    const globalInstallations = otherScope.filter((installation) => installation.global)
    const globalInstallation = globalInstallations[0]
    const installedEvents = new Set(
      globalInstallation?.handlers
        .map((handler) => handlerEvent(handler.command))
        .filter((event): event is HookEvent =>
          event !== null && (HOOK_EVENTS as readonly string[]).includes(event),
        ) ?? [],
    )
    if (
      globalInstallations.length !== 1 ||
      globalInstallations.some((installation) => (installation.problems?.length ?? 0) > 0) ||
      globalInstallations.some(
        (installation) => stopShapeProblems(installation, deps.hookPlatform).length > 0,
      ) ||
      !requiredHookEvents(harness).every((event) => installedEvents.has(event))
    ) {
      return hooksInstallCommand(deps, { ...flags, global: true, harness })
    }
    const globalFile = globalInstallation?.file
    if (flags.narrate !== false) {
      deps.io.out(
        `${HARNESS_LABELS[harness]} hooks already cover this machine (${globalFile}). This project does not need its own copy. To wire only this project: notifai hooks uninstall --harness ${harness} --global && notifai hooks install --harness ${harness}`,
      )
    }
    return EXIT.ok
  }
  if (wantGlobal && otherScope.some((installation) => !installation.global)) {
    if (hooksUninstallCommand(deps, { ...flags, global: false, harness }) !== EXIT.ok) {
      return EXIT.failed
    }
  }
  const codexPaths =
    harness === 'codex'
      ? codexLayerPaths(wantGlobal, deps.cwd, deps.env, hookPlatform)
      : null
  const settingsTarget =
    codexPaths?.configToml ?? settingsFile(harness, wantGlobal, deps.cwd, deps.env, hookPlatform)

  // OpenCode's adapter is a generated plugin module rather than a handler
  // merged into a settings document, so it owns the whole file.
  if (harness === 'opencode') {
    return installOpencodePlugin(deps, settingsTarget, {
      adapterPath,
      timeoutSeconds: NON_ROUTING_BLOCKING_STOP_TIMEOUT_SECONDS,
      platform: hookPlatform,
      nodePath,
      ...(flags.narrate === undefined ? {} : { narrate: flags.narrate }),
    })
  }

  if (harness === 'cursor') {
    try {
      withTargetFileLock(settingsTarget, () => {
        const document = loadCursorSettings(settingsTarget)
        const result = mergeCursorHooks(
          document,
          buildCursorHookConfig({
            adapterPath,
            harness: 'cursor',
            platform: hookPlatform,
            nodePath,
          }),
          scriptPath,
        )
        applyPlan(settingsTarget, result.document)
        return result
      })
    } catch (err) {
      deps.io.err(String(err))
      return EXIT.failed
    }
    if (flags.narrate !== false) printHooksInstallClose(deps, harness, settingsTarget)
    return EXIT.ok
  }

  const installInto = (file: string): { file: string; foreignStopCount: number } => {
    const document = loadSettings(file)
    const foreignStopCount = foreignStopHandlers(document).length
    const result = mergeHooks(
      document,
      buildHookConfig({
        adapterPath,
        harness,
        platform: hookPlatform,
        nodePath,
      }),
      scriptPath,
    )
    applyPlan(file, result.document)
    return { file, foreignStopCount }
  }

  let installed: { file: string; foreignStopCount: number }
  try {
    installed =
      codexPaths === null
        ? withTargetFileLock(settingsTarget, () => installInto(settingsTarget))
        : withCodexLayerTransaction(codexPaths, (inspection) => {
            const staleTarget =
              inspection.writeTarget === inspection.paths.hooksJson
                ? inspection.paths.configToml
                : inspection.paths.hooksJson
            const staleEvents =
              staleTarget === inspection.paths.hooksJson
                ? inspection.ourJsonEvents
                : inspection.ourTomlEvents
            if (staleEvents.length > 0) {
              const staleDocument = loadSettings(staleTarget)
              const stripped = removeHooks(staleDocument, scriptPath)
              if (stripped.replaced.length > 0) applyPlan(staleTarget, stripped.document)
            }
            return installInto(inspection.writeTarget)
          })
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }

  if (harness === 'codex') {
    const layer = flags.global ? null : codexLayerDir(deps.cwd)
    if (layer !== null) mkdirSync(layer, { recursive: true })
  }
  if (flags.narrate !== false) printHooksInstallClose(deps, harness, installed.file)
  if (installed.foreignStopCount > 0) {
    deps.io.out(
      "This layer already has a Stop handler. Codex runs every matching handler, so Notifai's Stop and the existing one will both fire.",
    )
  }
  if (harness === 'codex') {
    for (const problem of codexRepresentationProblems(deps.cwd, deps.env, hookPlatform)) {
      deps.io.out(problem)
    }
    for (const note of codexCoexistenceNotes(deps.cwd, deps.env, hookPlatform)) {
      deps.io.out(note)
    }
    if (flags.global) {
      const home = codexHomeNote(deps.env, hookPlatform)
      if (home !== null) deps.io.out(home)
    }
  }
  return EXIT.ok
}

function foreignStopHandlers(document: { hooks?: Record<string, { hooks?: { command: string }[] }[]> }): { command: string }[] {
  const groups = document.hooks?.['Stop']
  if (!Array.isArray(groups)) return []
  return groups
    .flatMap((group) => group.hooks ?? [])
    .filter(
      (handler) =>
        !/ hook (session-start|subagent-start|activation-stop|user-prompt-submit|stop|session-end)\b/.test(
          handler.command,
        ),
    )
}

/**
 * Writes the OpenCode plugin, replacing any Notifai plugin already there —
 * including one a different checkout wrote, matched on the managed marker for
 * the same reason command hooks are.
 */
function installOpencodePlugin(
  deps: CommandDeps,
  file: string,
  options: {
    adapterPath: string
    timeoutSeconds: number
    platform?: NodeJS.Platform
    nodePath?: string
    narrate?: boolean
  },
): number {
  try {
    withTargetFileLock(file, () => {
      if (existsSync(file)) {
        assertOwnedRegularFile(file)
        const existing = readFileSync(file, 'utf8')
        if (!isOurOpencodePlugin(existing)) {
          throw new Error(`${file} exists and was not written by Notifai; move it aside first.`)
        }
      }
      atomicWriteFileSync(file, opencodePluginSource(options), {
        mode: 0o600,
        preserveMode: false,
        requireCurrentUserOwner: true,
      })
    })
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
  if (options.narrate !== false) printHooksInstallClose(deps, 'opencode', file)
  return EXIT.ok
}

export function hooksUninstallCommand(deps: CommandDeps, flags: HooksInstallFlags): number {
  const harness = resolveHarness(deps, flags.harness)
  if (!harness) return EXIT.usage
  const scriptPath = flags.scriptPath ?? process.argv[1] ?? 'notifai'
  const global = flags.global ?? false
  const codexPaths =
    harness === 'codex'
      ? codexLayerPaths(global, deps.cwd, deps.env, deps.hookPlatform)
      : null
  const file =
    codexPaths?.configToml ?? settingsFile(harness, global, deps.cwd, deps.env, deps.hookPlatform)
  if (harness === 'opencode') {
    try {
      return withTargetFileLock(file, () => {
        if (!existsSync(file)) {
          deps.io.out(`Nothing to remove: ${file} does not exist.`)
          return EXIT.ok
        }
        assertOwnedRegularFile(file)
        // We own the whole file, but only if we wrote it.
        if (!isOurOpencodePlugin(readFileSync(file, 'utf8'))) {
          deps.io.out(`Left ${file} alone: Notifai did not write it.`)
          return EXIT.ok
        }
        rmSync(file, { force: true })
        deps.io.out(`Removed the Notifai OpenCode plugin at ${file}`)
        return EXIT.ok
      })
    } catch (err) {
      deps.io.err(String(err))
      return EXIT.failed
    }
  }
  if (harness === 'cursor') {
    let stripped: ReturnType<typeof removeCursorHooks> | null
    try {
      stripped = withTargetFileLock(file, () => {
        if (!existsSync(file)) return null
        const document = loadCursorSettings(file)
        const result = removeCursorHooks(document, scriptPath)
        applyPlan(file, result.document)
        return result
      })
    } catch (err) {
      deps.io.err(String(err))
      return EXIT.failed
    }
    if (stripped === null) {
      deps.io.out(`Nothing to remove: ${file} does not exist.`)
      return EXIT.ok
    }
    deps.io.out(
      stripped.replaced.length > 0
        ? `Removed Notifai hooks (${stripped.replaced.join(', ')}) from ${file}`
        : `No Notifai hooks found in ${file}`,
    )
    return EXIT.ok
  }
  const removeInstalledHooks = (): { existing: string[]; removedAny: boolean } => {
    const files =
      codexPaths === null
        ? hookDefinitionFiles(harness, global, deps.cwd, deps.env, deps.hookPlatform)
        : [codexPaths.hooksJson, codexPaths.configToml]
    const existing = files.filter((candidate) => existsSync(candidate))
    let removedAny = false
    for (const candidate of existing) {
      const removeFromCandidate = () => {
        const document = loadSettings(candidate)
        const result = removeHooks(document, scriptPath)
        if (result.replaced.length > 0) applyPlan(candidate, result.document)
        return result
      }
      const stripped =
        codexPaths === null
          ? withTargetFileLock(candidate, removeFromCandidate)
          : removeFromCandidate()
      if (stripped.replaced.length > 0) {
        removedAny = true
        deps.io.out(`Removed Notifai hooks (${stripped.replaced.join(', ')}) from ${candidate}`)
      }
    }
    return { existing, removedAny }
  }

  let result: { existing: string[]; removedAny: boolean }
  try {
    result =
      codexPaths === null
        ? removeInstalledHooks()
        : withCodexLayerTransaction(codexPaths, (inspection) => {
            const stripped = removeInstalledHooks()
            cleanupEmptiedCodexLayer(inspection.paths)
            return stripped
          })
  } catch (err) {
    deps.io.err(String(err))
    return EXIT.failed
  }
  if (result.existing.length === 0) {
    deps.io.out(`Nothing to remove: ${file} does not exist.`)
    return EXIT.ok
  }
  if (!result.removedAny) {
    deps.io.out(`No Notifai hooks found in ${result.existing.join(', ')}`)
  }
  return EXIT.ok
}

function assertOwnedRegularFile(file: string): void {
  const stat = lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${file} is not a regular file; refusing to read or replace it.`)
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${file} is owned by uid ${stat.uid}, not the current user.`)
  }
}

function resolveHarness(deps: CommandDeps, requested: string | undefined): Harness | null {
  if (requested !== undefined) {
    if ((HARNESSES as readonly string[]).includes(requested)) return requested as Harness
    deps.io.err(
      `Unknown harness "${requested}". Supported: ${HARNESSES.join(', ')}.`,
    )
    return null
  }
  const detected = detectHarness(deps.cwd, deps.env)
  if (!detected) {
    deps.io.err(`Could not tell which harness to install for — pass --harness <${HARNESSES.join('|')}>.`)
    return null
  }
  return detected
}

/**
 * Which harnesses to wire. An explicit `--harness` still wins as a singleton.
 * Otherwise: every detected harness, or a human picker when detection is empty
 * or names more than one.
 */
export async function pickHarnessesToInstall(
  deps: CommandDeps,
  requested?: string,
): Promise<Harness[] | null> {
  if (requested !== undefined) {
    const harness = resolveHarness(deps, requested)
    return harness === null ? null : [harness]
  }
  const detected = detectedHarnesses(deps.cwd, deps.env)
  if (detected.length === 1) return detected
  if (deps.io.interactive === true && deps.io.multiselect) {
    const picked = await deps.io.multiselect(
      'Which agent harnesses should Notifai wire here?',
      HARNESSES.map((name) => ({
        value: name,
        label: HARNESS_LABELS[name],
        ...(detected.includes(name) ? { hint: 'detected on this machine' } : {}),
      })),
      detected,
    )
    if (picked === null) return null
    const unknown = picked.filter((name) => !(HARNESSES as readonly string[]).includes(name))
    if (unknown.length > 0) {
      deps.io.err(`Unknown harness "${unknown[0]}". Supported: ${HARNESSES.join(', ')}.`)
      return null
    }
    return picked as Harness[]
  }
  if (detected.length === 0) {
    deps.io.err(
      `Could not tell which harness to wire. Run: notifai hooks install --harness <${HARNESSES.join('|')}>`,
    )
    return null
  }
  return detected
}
